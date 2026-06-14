"use client";
/** 主题"深挖"触发按钮（C-1）：POST /api/topics/[id]/deep-dive，202 fire-and-forget。
 *  体验缺口 3.3：触发后原地轮询 /deep-dive/status 渲染步进器（分析→校验→生成报告），
 *  完成给报告直链，不必跳 /admin 数 Run 表。轮询每 5s，报告出现 / 失败 / 超时（20min）即停。 */
import { useEffect, useRef, useState } from "react";

type StepState = "pending" | "running" | "done" | "failed";
interface Step {
  kind: string;
  label: string;
  state: StepState;
}
interface Status {
  steps: Step[];
  report: { id: string; title: string; type: string } | null;
  done: boolean;
  failed: boolean;
}

const POLL_MS = 5000;
const MAX_POLL_MS = 20 * 60 * 1000; // 20 min 兜底，超时停轮询（深挖名义上限 15min）

const DOT: Record<StepState, string> = { pending: "○", running: "◐", done: "●", failed: "✕" };

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
  const [since, setSince] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const startedAtMs = useRef(0);

  // 轮询：since 一旦设定（触发成功）即起；报告出现 / 失败 / 超时清掉。
  useEffect(() => {
    if (!since) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/topics/${topicId}/deep-dive/status?since=${encodeURIComponent(since!)}`);
        if (!alive) return;
        if (res.ok) {
          const s = (await res.json()) as Status;
          setStatus(s);
          if (s.done || s.failed) return; // 终态，停止
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
  }, [since, topicId]);

  if (!enabled) return <span className="muted" style={{ fontSize: ".85rem" }}>· 停用中（不可深挖）</span>;

  async function trigger(): Promise<void> {
    if (!confirm(`对主题"${topicName}"启动深挖？\n预计 5-15 分钟、消耗 ~$0.5–2 LLM 成本。`)) return;
    setBusy(true);
    setErr(null);
    setStatus(null);
    setSince(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/deep-dive`, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 202) {
        startedAtMs.current = Date.now();
        setSince(body.started_at as string); // 触发轮询
      } else {
        setErr(`HTTP ${res.status} · ${body.message ?? body.error ?? "未知"}`);
      }
    } catch (e) {
      setErr((e as Error).message.slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  const polling = since != null && !status?.done && !status?.failed;

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
          {status.steps.map((s) => (
            <span key={s.kind} className={`deepdive-step deepdive-step-${s.state}`} title={s.kind}>
              {DOT[s.state]} {s.label}
            </span>
          ))}
          {status.done && status.report ? (
            <a className="deepdive-link" href={`/reports/${status.report.id}`}>查看报告 →</a>
          ) : status.failed ? (
            <span className="deepdive-err">
              某段失败 ·{" "}
              <a href="/admin">去 /admin 看详情 / 重试</a>
            </span>
          ) : (
            <span className="muted deepdive-hint">运行中（约 5–15 分钟，可离开本页）</span>
          )}
        </span>
      ) : since ? (
        <span className="muted deepdive-msg">✅ 已启动 · 正在获取进度…</span>
      ) : null}
    </span>
  );
}
