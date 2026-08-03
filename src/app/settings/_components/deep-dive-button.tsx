"use client";
/** 主题“深挖”触发按钮：受理后按 trace 查询持久化调度状态。 */
import { useEffect, useRef, useState } from "react";

interface Status {
  status: "running" | "done" | "failed" | "partial" | "cancelled";
  dispatch: { state: string; attempt: number; last_error_reason?: string | null };
}

const POLL_MS = 5000;
const MAX_POLL_MS = 20 * 60 * 1000; // 20 min 兜底，超时停轮询（深挖名义上限 15min）

const terminal = (status: Status["status"]): boolean => ["done", "failed", "partial", "cancelled"].includes(status);

export function DeepDiveButton({
  topicId,
  topicName,
  enabled,
}: {
  topicId: string;
  topicName: string;
  enabled: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const startedAtMs = useRef(0);

  // 轮询：since 一旦设定（触发成功）即起；报告出现 / 失败 / 超时清掉。
  useEffect(() => {
    if (traceId === null) return;
    const activeTraceId: string = traceId;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/generation-traces/${encodeURIComponent(activeTraceId)}`);
        if (!alive) return;
        if (res.ok) {
          const s = (await res.json()) as Status;
          setStatus(s);
          if (terminal(s.status)) return;
        }
      } catch {
        /* 瞬时网络错误：忽略，下一拍重试 */
      }
      if (!alive) return;
      if (Date.now() - startedAtMs.current > MAX_POLL_MS) return; // 超时兜底
      timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [traceId]);

  if (!enabled) return <span className="muted" style={{ fontSize: ".85rem" }}>· 停用中（不可深挖）</span>;

  async function trigger(): Promise<void> {
    if (!confirm(`对主题"${topicName}"启动深挖？\n预计 5-15 分钟、消耗 ~$0.5–2 LLM 成本。`)) return;
    setBusy(true);
    setErr(null);
    setStatus(null);
    setTraceId(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/deep-dive`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 202 || res.status === 200) {
        startedAtMs.current = Date.now();
        setTraceId(body.trace_id as string);
      } else {
        setErr(`HTTP ${res.status} · ${body.message ?? body.error ?? "未知"}`);
      }
    } catch (e) {
      setErr((e as Error).message.slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  const polling = traceId != null && (
    (status == null && err == null) ||
    (status != null && !terminal(status.status))
  );

  return (
    <span style={{ marginLeft: ".5rem" }}>
      <button
        type="button"
        className="ppt-btn ppt-btn-secondary"
        onClick={trigger}
        disabled={busy || polling}
        title="对该主题触发 analyze → validate → report-gen（type=deep_dive，14 天窗口 / 25 条）"
      >
        {busy ? "启动中…" : polling ? "深挖中…" : "深挖"}
      </button>

      {err ? (
        <span className="muted deepdive-msg deepdive-err">❌ {err}</span>
      ) : status ? (
        <span className="deepdive-progress">
          {terminal(status.status) ? (
            status.status === "done" ? <span>● 深挖完成</span> :
            <span className="deepdive-err">
              {status.dispatch.last_error_reason ?? "深挖失败"} ·{" "}
              <a href="/admin">去 /admin 看详情 / 重试</a>
            </span>
          ) : (
            <span className="muted deepdive-hint">{status.dispatch.state}（尝试 {status.dispatch.attempt}，约 5–15 分钟）</span>
          )}
        </span>
      ) : traceId ? (
        <span className="muted deepdive-msg">✅ 已启动 · 正在获取进度…</span>
      ) : null}
    </span>
  );
}
