"use client";
/** 受控单主题日报入口：只登记标准 brief，进度由 trace 读模型展示。 */
import { useEffect, useRef, useState } from "react";

interface Status {
  status: "running" | "done" | "failed" | "partial" | "cancelled";
  dispatch: { state: string; attempt: number; last_error_reason?: string | null };
}

const POLL_MS = 5000;
const MAX_POLL_MS = 20 * 60 * 1000;
const terminal = (status: Status["status"]): boolean => ["done", "failed", "partial", "cancelled"].includes(status);

/** Trace API 是当前管理员可读的权威溯源入口；参数始终来自服务端受理响应，仍做 path escaping。 */
export const generationTraceHref = (traceId: string): string => `/api/generation-traces/${encodeURIComponent(traceId)}`;

export function TopicBriefButton({
  topicId,
  topicName,
  enabled,
}: {
  topicId: string;
  topicName: string;
  enabled: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const startedAtMs = useRef(0);

  useEffect(() => {
    if (!traceId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const activeTraceId = traceId;
    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/generation-traces/${encodeURIComponent(activeTraceId)}`);
        if (!alive) return;
        if (response.ok) {
          const next = await response.json() as Status;
          setStatus(next);
          if (terminal(next.status)) return;
        }
      } catch {
        // 瞬时网络问题不把已受理的日报误标为失败，下一拍继续读持久 trace。
      }
      if (alive && Date.now() - startedAtMs.current <= MAX_POLL_MS) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [traceId]);

  if (!enabled) return <span className="muted" style={{ fontSize: ".85rem" }}>· 停用中（不可生成日报）</span>;

  const polling = traceId != null && (status == null || !terminal(status.status));
  async function trigger(): Promise<void> {
    if (!confirm(`为主题“${topicName}”生成一份标准日报？\n将使用当前日报窗口与条数配置，并消耗一次分析/校验/报告生成成本。`)) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setTraceId(null);
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(topicId)}/brief`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const body = await response.json() as Record<string, unknown>;
      if (response.status === 202 || response.status === 200) {
        startedAtMs.current = Date.now();
        setTraceId(body.trace_id as string);
      } else if (response.status === 409 && typeof body.active_trace_id === "string") {
        startedAtMs.current = Date.now();
        setTraceId(body.active_trace_id);
      } else {
        setError(`HTTP ${response.status} · ${body.message ?? body.error ?? "未知错误"}`);
      }
    } catch (cause) {
      setError((cause as Error).message.slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ marginLeft: ".5rem" }}>
      <button
        type="button"
        className="ppt-btn ppt-btn-secondary"
        onClick={trigger}
        disabled={busy || polling}
        title="对该主题登记一份标准 Daily Brief（当前日报窗口和条数；由 worker 异步执行）"
      >
        {busy ? "受理中…" : polling ? "日报生成中…" : "生成日报"}
      </button>
      {error ? <span className="muted deepdive-msg deepdive-err">❌ {error}</span> : null}
      {!error && traceId ? (
        <span className="deepdive-progress" aria-live="polite">
          <span className="muted">Trace <code>{traceId}</code></span>
          <a className="deepdive-link" href={generationTraceHref(traceId)} target="_blank" rel="noreferrer">
            查看生成溯源
          </a>
        </span>
      ) : null}
      {!error && status ? (
        <span className="deepdive-progress">
          {terminal(status.status) ? (
            status.status === "done" ? <span>● 日报完成</span> :
            <span className="deepdive-err">{status.dispatch.last_error_reason ?? "日报未完成"} · <a href="/admin">去 /admin 查看 / 重试</a></span>
          ) : <span className="muted deepdive-hint">{status.dispatch.state}（尝试 {status.dispatch.attempt}）</span>}
        </span>
      ) : !error && traceId ? <span className="muted deepdive-msg">✅ 已受理 · 正在获取进度…</span> : null}
    </span>
  );
}
