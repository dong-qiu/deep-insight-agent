/** LLM-交互运行时 env 旋钮的**单一来源**（质量 Q6）：消除散落 + 重复默认。
 *
 * 此前 `VALIDATOR_RETRIES ?? 2` / `VALIDATOR_RETRY_BACKOFF_MS ?? 800` 各读 2 处、
 * `VALIDATOR_THINKING !== "0"` 读 4 处（validator×3 + analyzer×1）——改默认须同步多处、易漂移。
 *
 * 每个 getter **原样搬运** call site 的表达式（含 Math.max / `??` vs `||` 各自语义不动）→ 行为中性；
 * 且 **call-time 读 process.env**（不在 import 期定值），保证测试动态 set env 仍生效。 */

/** 校验器思考模式：默认开，VALIDATOR_THINKING=0 关。analyzer 补引校验与 judge 同源。 */
export const validatorThinking = (): boolean => process.env.VALIDATOR_THINKING !== "0";

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

/** LLM SDK 内置重试次数，默认 2。 */
export const llmMaxRetries = (): number => Number(process.env.LLM_MAX_RETRIES) || 2;

/** Prompt caching 开关：PROMPT_CACHE=0 关（治中转站只写不读的白付溢价）。 */
export const promptCacheOn = (): boolean => process.env.PROMPT_CACHE !== "0";

/** 覆盖度补引开关：COVERAGE_BACKFILL=0 关。 */
export const coverageBackfillOff = (): boolean => process.env.COVERAGE_BACKFILL === "0";
