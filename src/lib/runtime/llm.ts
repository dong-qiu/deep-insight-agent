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

const client = new Anthropic(); // ANTHROPIC_API_KEY from env

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
  const res = await client.messages.parse({
    model: MODELS[opts.role],
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

  if (!res.parsed_output) {
    throw new Error(
      `结构化输出解析失败（role=${opts.role} stop_reason=${res.stop_reason}）`,
    );
  }
  return { data: res.parsed_output, usage: res.usage };
}
