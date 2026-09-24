/** 中转站/SDK 瞬时基础设施错误的分类——区分"该拆批隔离"和"该抛上去"：
 *  - **瞬时基础设施**（连接错误 / 超时 / 限流 / 5xx）→ 应抛上（runJob 标 failed + 告警钩子）；
 *    这是中转站抽风，**不是模型拒答**——拆批只会把数据连续丢光（实测 security 0 洞察就是这样）。
 *  - **模型层错误**（stop_reason=refusal、Zod 解析失败、max_tokens）→ 现有拆批隔离仍正确处理。
 *  SDK 已内部 maxRetries=2 重试；到达本层仍失败 = 真瞬时挂掉。 */
import Anthropic from "@anthropic-ai/sdk";
import { VolcengineResponsesError } from "./volcengine-responses.js";

export function isTransientApiError(e: unknown): boolean {
  // The Responses adapter only marks a stream that ended before its mandatory completion event
  // retryable. It is still rejected by that attempt; this merely permits the bounded fresh
  // request used for connection-level faults, without widening retries to schema/model errors.
  if (e instanceof VolcengineResponsesError && e.retryable) return true;
  // Provider-neutral HTTP fallback. The Responses adapter intentionally exposes only a status
  // (not a response body, which can echo source/prompt material), so classify standard retryable
  // infrastructure statuses before checking Anthropic SDK classes.
  const status = typeof e === "object" && e !== null && "status" in e ? (e as { status?: unknown }).status : undefined;
  if (status === 429 || (typeof status === "number" && status >= 500 && status <= 599)) return true;
  // SDK 类型化错误（首选；APIConnectionError 涵盖其子类 APIConnectionTimeoutError）
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true;
  // 兜底：基于消息关键词（部分错误未走 SDK 类型 / 中转站包装不一致）
  const msg = e instanceof Error ? e.message : String(e ?? "");
  // `callStructured` owns an additional wall-clock AbortController because an SSE relay may keep
  // streaming heartbeats after the SDK timeout. Its explicit timeout is infrastructure evidence,
  // never a content refusal: classifying it as a refusal makes analyzer recursively split one
  // unavailable batch into many costly requests.
  return /Connection error|Request timed out|\btimeout\b|aborted|Unexpected event order|\bfetch failed\b|ETIMEDOUT|ECONNRESET|socket hang up|ENETUNREACH|EAI_AGAIN/i.test(msg);
}
