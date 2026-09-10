/** LLM-交互运行时 env 旋钮的**单一来源**（质量 Q6）：消除散落 + 重复默认。
 *
 * 此前 `VALIDATOR_RETRIES ?? 2` / `VALIDATOR_RETRY_BACKOFF_MS ?? 800` 各读 2 处、
 * `VALIDATOR_THINKING !== "0"` 读 4 处（validator×3 + analyzer×1）——改默认须同步多处、易漂移。
 *
 * 每个 getter **原样搬运** call site 的表达式（含 Math.max / `??` vs `||` 各自语义不动）→ 行为中性；
 * 且 **call-time 读 process.env**（不在 import 期定值），保证测试动态 set env 仍生效。 */

/** 校验器思考模式：默认开，VALIDATOR_THINKING=0 关。analyzer 补引校验与 judge 同源。 */
export const validatorThinking = (): boolean => process.env.VALIDATOR_THINKING !== "0";

/**
 * 独立 quote 自足性 countercheck 的思考开关。
 *
 * 缺失时刻意继承 VALIDATOR_THINKING，保持拆分该旋钮前的生产语义；一旦显式配置，
 * 只影响 role=coverage，绝不能改变主 validator 的一致性或展示覆盖裁决。基线/DCP
 * 配置会同时记录有效值和该值来自显式配置还是继承，避免把迁移期行为误当作已冻结策略。
 */
export const coverageThinkingSource = (): "explicit" | "inherited" =>
  process.env.COVERAGE_THINKING == null || process.env.COVERAGE_THINKING === "" ? "inherited" : "explicit";

export const coverageThinking = (): boolean =>
  coverageThinkingSource() === "inherited" ? validatorThinking() : process.env.COVERAGE_THINKING !== "0";

/** 校验器重试次数（指数退避），默认 2。 */
export const validatorRetries = (): number => Math.max(0, Number(process.env.VALIDATOR_RETRIES ?? 2));

/** 校验器重试退避基数 ms，默认 800。 */
export const validatorBackoffMs = (): number => Math.max(0, Number(process.env.VALIDATOR_RETRY_BACKOFF_MS ?? 800));

/** 一致性大面积失败告警阈值（errored/total），默认 0.5。 */
export const validationDegradedRate = (): number => Number(process.env.VALIDATION_DEGRADED_ALERT_RATE ?? 0.5);

/** 批量校验开关（kill-switch）：VALIDATOR_BATCH=0 回退逐条（精度回归/排障）。 */
export const validatorBatchOn = (): boolean => process.env.VALIDATOR_BATCH !== "0";

/** LLM 单次调用超时 ms，默认 120000。 */
export const llmTimeoutMs = (): number => Number(process.env.LLM_TIMEOUT_MS) || 120_000;

/** LLM SDK 内置重试次数，默认 2。0 是有效配置，用于排障时禁用 SDK 重试。 */
export const llmMaxRetries = (): number => {
  const value = Number(process.env.LLM_MAX_RETRIES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
};

/**
 * SDK 无法重试本地 AbortController 触发的 SSE 墙钟超时；这是该类瞬态错误的应用层额外尝试次数。
 * 上限 2，避免单条任务因 relay 持续异常无限占用分析槽位。
 */
export const llmTransientRetries = (): number => {
  const value = Number(process.env.LLM_TRANSIENT_RETRIES ?? 1);
  return Number.isFinite(value) && value >= 0 ? Math.min(2, Math.floor(value)) : 1;
};

/** 应用层瞬态重试的固定退避，限制在 10 秒内，避免把背压误伪装成任务卡死。 */
export const llmTransientRetryBackoffMs = (): number => {
  const value = Number(process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS ?? 750);
  return Number.isFinite(value) && value >= 0 ? Math.min(10_000, Math.floor(value)) : 750;
};

/** Prompt caching 开关：PROMPT_CACHE=0 关（治中转站只写不读的白付溢价）。 */
export const promptCacheOn = (): boolean => process.env.PROMPT_CACHE !== "0";

/** 覆盖度补引开关：COVERAGE_BACKFILL=0 关。 */
export const coverageBackfillOff = (): boolean => process.env.COVERAGE_BACKFILL === "0";
