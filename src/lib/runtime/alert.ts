/** 失败告警（运维 · DCP-3 附条件②）：Run 失败时发到可配置 webhook。
 *  - `ALERT_WEBHOOK` 未配置 → no-op（失败已落 Run + error 日志，告警是 opt-in 增强）。
 *  - payload 为 Slack 兼容 `{text}` + 结构化字段，通用 webhook 同样可收。
 *  - operator 配置、非用户输入，故直连 fetch（不走 SSRF safe-fetch，那是给不可信源 URL 的）。
 *  - **非阻塞、永不抛/拒**：告警自身失败绝不连累管线（fire-and-forget + 超时 + 全捕获）。 */
import { runLogger } from "./logger.js";

export interface FailureAlert {
  runId: string;
  kind: string;
  target: unknown;
  errorType: string;
  message: string;
}

/** 纯函数：构造告警 payload（Slack 兼容 text + 结构化）。可测，不触发任何 IO。 */
export function failureAlertPayload(a: FailureAlert): Record<string, unknown> {
  const text = `🔴 Run 失败：${a.kind} · ${a.errorType}：${a.message}`.slice(0, 500);
  return { text, runId: a.runId, kind: a.kind, target: a.target, error: { type: a.errorType, message: a.message } };
}

/** 发送一条告警到 webhook —— 超时 + 全捕获，**永不抛/拒**（resolve 即可，失败只 warn 日志）。 */
export async function sendAlert(url: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) runLogger({ stage: "alert" }).warn({ status: res.status }, "失败告警 webhook 返回非 2xx");
  } catch (e) {
    runLogger({ stage: "alert" }).warn({ err: e instanceof Error ? e.message : String(e) }, "失败告警发送失败（已忽略）");
  } finally {
    clearTimeout(timer);
  }
}

/** Run 失败时调用：ALERT_WEBHOOK 配置则 fire-and-forget 发送（不 await、不阻塞调用方的抛出）。 */
export function notifyFailure(a: FailureAlert): void {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return; // 未配置 → no-op（失败已在 Run / error 日志里）
  const timeoutMs = Number(process.env.ALERT_TIMEOUT_MS) || 5000;
  void sendAlert(url, failureAlertPayload(a), timeoutMs);
}
