/**
 * 最小 LLM Client —— A1 切片版。
 * 后续建骨架时扩为完整 runtime（重试 / 限流 / token 计量 / Job Runner），见 architecture「Agent 运行时」。
 *
 * 当前职责：
 *  - 模型可配（按子任务分别指定，默认 分析=sonnet-4-6 / 校验=opus-4-7）
 *  - 结构化输出（messages.parse + zodOutputFormat）
 *  - prompt caching（稳定 system 前缀打 cache_control）
 *  - 启动校验「校验模型 ID ≠ 分析模型 ID」（同源偏差约束）
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
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
  // 经第三方中转站偶发卡死：用较短超时 + 多次重试，让卡住的请求快速失败并重试，
  // 而非默认 10min 超时干等一次。正常调用 4-9s 完成，60s 足够宽松。
  return (_client ??= new Anthropic({ timeout: 60_000, maxRetries: 3 })); // key from env
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
}

export interface StructuredResult<T> {
  data: T;
  usage: Anthropic.Usage;
}

export async function callStructured<T extends z.ZodType>(
  opts: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  const model = MODELS[opts.role];
  const res = await getClient().messages.parse({
    model,
    max_tokens: opts.maxTokens ?? 16000,
    // system 作为稳定前缀缓存；user 永远在断点之后（prompt-caching 前缀匹配）
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: {
      format: zodOutputFormat(opts.schema),
      ...(opts.thinking ? { effort: "high" as const } : {}),
    },
    ...(opts.thinking ? { thinking: { type: "adaptive" as const } } : {}),
  });

  record(model, res.usage);
  if (!res.parsed_output) {
    throw new Error(
      `结构化输出解析失败（role=${opts.role} stop_reason=${res.stop_reason}）`,
    );
  }
  return { data: res.parsed_output, usage: res.usage };
}
