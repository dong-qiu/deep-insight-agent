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
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import type { Cost } from "../types.js";
import { costUSD, type TokenUsage } from "./cost.js";

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
  const c = costUSD(model, u as TokenUsage);
  if (c === null) agg.unpriced = true;
  else agg.usd += c;
  meter.set(model, agg);
}

export function getCostReport(): CostReport {
  const byModel = [...meter.entries()].map(([model, m]) => ({ model, ...m }));
  return { byModel, totalUSD: byModel.reduce((s, m) => s + m.usd, 0) };
}

export function resetCostMeter(): void {
  meter.clear();
}

/** 单次调用的 token/成本（按返回值透传给调用方做 per-Run 记账，避免读全局 meter 做差——并发不隔离）。 */
function usageToCost(model: string, u: Anthropic.Usage): Cost {
  const tokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return { tokens, amount: costUSD(model, u as TokenUsage) ?? 0 };
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
}

export interface StructuredResult<T> {
  data: T;
  usage: Anthropic.Usage;
  /** 本次（含内部重试）累计成本 */
  cost: Cost;
}

export async function callStructured<T extends z.ZodType>(
  opts: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  const model = MODELS[opts.role];
  // 默认对稳定 system 前缀打 prompt cache；PROMPT_CACHE=0 时关闭——某些第三方中转站只写不读，
  // 缓存从不命中却仍计写入开销（见 a1-runs），此时关闭更省。
  const useCache = process.env.PROMPT_CACHE !== "0";
  const params = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    // system 作为稳定前缀缓存；user 永远在断点之后（prompt-caching 前缀匹配）
    system: [
      { type: "text" as const, text: opts.system, ...(useCache ? { cache_control: { type: "ephemeral" as const } } : {}) },
    ],
    messages: [{ role: "user" as const, content: opts.user }],
    output_config: {
      format: zodOutputFormat(opts.schema),
      ...(opts.thinking ? { effort: "high" as const } : {}),
    },
    ...(opts.thinking ? { thinking: { type: "adaptive" as const } } : {}),
  };

  let cost: Cost = { tokens: 0, amount: 0 };
  // 每次底层调用：累计全局 meter（eval 总额）+ 本次 cost + 透传 onCost（per-Run 记账）
  const account = (u: Anthropic.Usage): void => {
    record(model, u);
    const c = usageToCost(model, u);
    cost = { tokens: cost.tokens + c.tokens, amount: cost.amount + c.amount };
    opts.onCost?.(c);
  };

  // 流式生成（messages.stream + finalMessage）：长输出（dense 批 / 高 max_tokens）下避免中转站
  // 缓冲整段响应再返回导致的网关超时；SDK 在 output_config.format 下从流尾解析出 parsed_output。
  // 敏感领域内容偶发安全拒答（stop_reason=refusal）——多为非确定性，重试至多 3 次。
  let res = await getClient().messages.stream(params).finalMessage();
  account(res.usage);
  for (let attempt = 1; res.stop_reason === "refusal" && attempt < 3; attempt++) {
    res = await getClient().messages.stream(params).finalMessage();
    account(res.usage);
  }

  // 输出触顶被截断：JSON 多半残缺→下方 parsed_output 缺失而抛错（由 analyzeWithSplit 拆批兜底）；
  // 即便侥幸解析成功，末条 statement 也常半句（isCompleteStatement 守卫丢弃）。显式告警以暴露，避免静默丢洞察。
  if (res.stop_reason === "max_tokens") {
    console.warn(`  ⚠️ 输出达 max_tokens(${params.max_tokens}) 截断（role=${opts.role}）——可能漏洞察，建议提高预算或缩小批`);
  }
  if (!res.parsed_output) {
    throw new Error(
      `结构化输出解析失败（role=${opts.role} stop_reason=${res.stop_reason}）`,
    );
  }
  return { data: res.parsed_output, usage: res.usage, cost };
}
