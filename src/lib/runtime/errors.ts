/** 中转站/SDK 瞬时基础设施错误的分类——区分"该拆批隔离"和"该抛上去"：
 *  - **瞬时基础设施**（连接错误 / 超时 / 限流 / 5xx）→ 应抛上（runJob 标 failed + 告警钩子）；
 *    这是中转站抽风，**不是模型拒答**——拆批只会把数据连续丢光（实测 security 0 洞察就是这样）。
 *  - **模型层错误**（stop_reason=refusal、Zod 解析失败、max_tokens）→ 现有拆批隔离仍正确处理。
 *  SDK 已内部 maxRetries=2 重试；到达本层仍失败 = 真瞬时挂掉。 */
import Anthropic from "@anthropic-ai/sdk";

export function isTransientApiError(e: unknown): boolean {
  // SDK 类型化错误（首选；APIConnectionError 涵盖其子类 APIConnectionTimeoutError）
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true;
  // 兜底：基于消息关键词（部分错误未走 SDK 类型 / 中转站包装不一致）
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /Connection error|Request timed out|aborted|ETIMEDOUT|ECONNRESET|socket hang up|ENETUNREACH|EAI_AGAIN/i.test(msg);
}
