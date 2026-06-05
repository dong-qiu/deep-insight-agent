/**
 * 最小 LLM Client —— A1 切片版。
 * 后续建骨架时扩为完整 runtime（重试 / 限流 / token 计量 / Job Runner），见 architecture「Agent 运行时」。
 *
 * 当前职责：
 *  - 模型可配（按子任务分别指定，默认 分析=sonnet-4-6 / 校验=opus-4-7）
 *  - 结构化输出（messages.stream + finalMessage + zodOutputFormat；流式避免长输出网关超时）
 *  - prompt caching（稳定 system 前缀打 cache_control）
 *  - 启动校验「校验模型 ID ≠ 分析模型 ID」（同源偏差约束）
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import type { Cost } from "../types.js";
import { FALLBACK_PRICING, costUSD, type TokenUsage } from "./cost.js";

// 已警告过的未知模型集合（每模型仅警告一次，防日志刷屏）
const warnedUnpriced = new Set<string>();
function fallbackCostUSD(model: string, u: TokenUsage): number {
  if (!warnedUnpriced.has(model)) {
    warnedUnpriced.add(model);
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️ 未知模型「${model}」不在价目表（PRICING）；按已知最贵价（input $${FALLBACK_PRICING.input}/M, output $${FALLBACK_PRICING.output}/M）保守估算成本。补全 src/lib/runtime/cost.ts 的 PRICING。`,
    );
  }
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const inputUSD =
    (u.input_tokens * FALLBACK_PRICING.input +
      cacheWrite * FALLBACK_PRICING.input * 1.25 +
      cacheRead * FALLBACK_PRICING.input * 0.1) /
    1_000_000;
  const outputUSD = (u.output_tokens * FALLBACK_PRICING.output) / 1_000_000;
  return inputUSD + outputUSD;
}

export type Role = "analyzer" | "validator";

export const MODELS: Record<Role, string> = {
  analyzer: process.env.ANALYZER_MODEL ?? "claude-sonnet-4-6",
  validator: process.env.VALIDATOR_MODEL ?? "claude-opus-4-7",
};

/** 同源偏差约束：校验模型必须独立于分析模型（citation-validation 行为规约 3 / AC7） */
export function assertModelSeparation(): void {
  if (MODELS.analyzer === MODELS.validator) {
    throw new Error(
      `校验模型必须独立于分析模型（同源偏差约束）：` +
        `analyzer=${MODELS.analyzer} validator=${MODELS.validator}`,
    );
  }
}

// 懒加载：首次调用时才构造客户端，确保 .env.local 已被注入 process.env
// （模块 import 早于 run-a1 的 loadEnvLocal，过早 new Anthropic() 会拿不到 key）
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  // 超时取舍：原 45s 是为快速失败中转站「卡死」；但 Opus 生成 8k token 输出的合法调用可能 >45s，
  // 且每次重试也只等 45s → 合法慢生成永远成功不了（F4 live 确认暴露）。改 120s（env LLM_TIMEOUT_MS 可配），
  // 让合法慢生成跑完；中转站现已支持长响应（带思考已验证），不再需要 45s 那么激进。
  const timeout = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
  return (_client ??= new Anthropic({ timeout, maxRetries: 2 })); // key from env
}

// ── Cost Meter（进程内累计本次运行的 token / 成本） ──
export interface ModelUsage {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number;
  unpriced: boolean; // 命中未在价目表里的模型
}
export interface CostReport {
  byModel: Array<{ model: string } & ModelUsage>;
  totalUSD: number;
}

const meter = new Map<string, ModelUsage>();

function record(model: string, u: Anthropic.Usage): void {
  const agg = meter.get(model) ?? {
    calls: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    usd: 0,
    unpriced: false,
  };
  agg.calls += 1;
  agg.input += u.input_tokens ?? 0;
  agg.output += u.output_tokens ?? 0;
  agg.cacheWrite += u.cache_creation_input_tokens ?? 0;
  agg.cacheRead += u.cache_read_input_tokens ?? 0;
  // 未知模型：标 unpriced 同时**走保守估算**（不静默 $0）。曾因 VALIDATOR_MODEL 配为
  // 未入表型号致 amount=0、56 万 token 被记成 \$0，掩盖真实成本（2026-06-03）。
  const c = costUSD(model, u as TokenUsage);
  if (c === null) {
    agg.unpriced = true;
    agg.usd += fallbackCostUSD(model, u as TokenUsage);
  } else {
    agg.usd += c;
  }
  meter.set(model, agg);
}

export function getCostReport(): CostReport {
  const byModel = [...meter.entries()].map(([model, m]) => ({ model, ...m }));
  return { byModel, totalUSD: byModel.reduce((s, m) => s + m.usd, 0) };
}

export function resetCostMeter(): void {
  meter.clear();
}

/** 单次调用的 token/成本（按返回值透传给调用方做 per-Run 记账，避免读全局 meter 做差——并发不隔离）。
 *  未知模型用 fallbackCostUSD 保守估算（最贵已知价），不静默 \$0。 */
function usageToCost(model: string, u: Anthropic.Usage): Cost {
  const tokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const known = costUSD(model, u as TokenUsage);
  return { tokens, amount: known ?? fallbackCostUSD(model, u as TokenUsage) };
}

export interface StructuredCall<T extends z.ZodType> {
  role: Role;
  /** 稳定指令前缀 —— 命中 prompt cache */
  system: string;
  /** 每请求变化的内容 */
  user: string;
  schema: T;
  maxTokens?: number;
  /** 启用自适应思考 + effort=high（校验等精度敏感子任务建议开） */
  thinking?: boolean;
  /** 每次底层调用（含重试）的成本回调 —— 调用方据此做 per-Run 记账（并发隔离） */
  onCost?: (cost: Cost) => void;
  /** AbortSignal——透传到 SDK 流式请求，用于"成本上限到达 → 取消未完成调用"等场景。
   *  abort 后 SDK 抛 AbortError；调用方应当外层 catch 并按"失败"路径处理（保留已成功子结果）。 */
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: Anthropic.Usage;
  /** 本次（含内部重试）累计成本 */
  cost: Cost;
}

const STRUCTURED_TOOL_NAME = "respond_with_structured_output";

export async function callStructured<T extends z.ZodType>(
  opts: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  const model = MODELS[opts.role];
  // 默认对稳定 system 前缀打 prompt cache；PROMPT_CACHE=0 时关闭——某些第三方中转站只写不读，
  // 缓存从不命中却仍计写入开销（见 a1-runs），此时关闭更省。
  const useCache = process.env.PROMPT_CACHE !== "0";
  // 中转站兼容性（2026-06-03）：yibuapi 不再接受 SDK 0.98 的 output_config.format 字段。
  // 改走通用 tool_use：把目标 schema 包装成单个强制工具调用（tool_choice 锁定），从工具
  // 调用块取 input 当结构化输出。tool_use 是 Anthropic 长稳定接口，被所有中转站支持。
  const jsonSchema = z.toJSONSchema(opts.schema) as { type?: string };
  if (jsonSchema.type !== "object") {
    throw new Error(`callStructured schema 根类型必须是 object（当前 ${jsonSchema.type ?? "<未知>"}）`);
  }
  const tools = [
    {
      name: STRUCTURED_TOOL_NAME,
      description: "Return the structured result strictly matching the input_schema. Do not include any text outside the tool call.",
      input_schema: jsonSchema as Anthropic.Messages.Tool.InputSchema,
    },
  ];
  const params = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: [
      { type: "text" as const, text: opts.system, ...(useCache ? { cache_control: { type: "ephemeral" as const } } : {}) },
    ],
    messages: [{ role: "user" as const, content: opts.user }],
    tools,
    tool_choice: { type: "tool" as const, name: STRUCTURED_TOOL_NAME },
    ...(opts.thinking ? { thinking: { type: "adaptive" as const } } : {}),
  };

  let cost: Cost = { tokens: 0, amount: 0 };
  const account = (u: Anthropic.Usage): void => {
    record(model, u);
    const c = usageToCost(model, u);
    cost = { tokens: cost.tokens + c.tokens, amount: cost.amount + c.amount };
    opts.onCost?.(c);
  };

  // 流式生成（messages.stream + finalMessage）：长输出（dense 批 / 高 max_tokens）下避免中转站
  // 缓冲整段响应再返回导致的网关超时。流尾内容块中找 tool_use → 取 input 当结构化输出。
  // 敏感领域内容偶发安全拒答（stop_reason=refusal）——多为非确定性，重试至多 3 次。
  // signal 透传到 SDK 选项，调用方 abort 时 SDK 抛 AbortError、由外层 catch 走"失败"路径。
  const reqOpts = opts.signal ? { signal: opts.signal } : undefined;
  let res = await getClient().messages.stream(params, reqOpts).finalMessage();
  account(res.usage);
  for (let attempt = 1; res.stop_reason === "refusal" && attempt < 3; attempt++) {
    res = await getClient().messages.stream(params, reqOpts).finalMessage();
    account(res.usage);
  }

  if (res.stop_reason === "max_tokens") {
    console.warn(`  ⚠️ 输出达 max_tokens(${params.max_tokens}) 截断（role=${opts.role}）——可能漏洞察，建议提高预算或缩小批`);
  }

  // 找 tool_use 内容块；模型可能先输出文本块再调用工具，遍历全部块取第一个 tool_use。
  const toolUse = res.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
  );
  if (!toolUse) {
    throw new Error(
      `结构化输出解析失败（role=${opts.role} stop_reason=${res.stop_reason}）：模型未调用 ${STRUCTURED_TOOL_NAME} 工具`,
    );
  }
  // zod 校验：模型偶发产出不符 schema（如多余字段被 additionalProperties:false 拒）；
  // 走 safeParse 拿明确错误而非 ZodError 黑盒。
  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `结构化输出 schema 校验失败（role=${opts.role}）：${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return { data: parsed.data, usage: res.usage, cost };
}
