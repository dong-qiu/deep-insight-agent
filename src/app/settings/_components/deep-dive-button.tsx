"use client";
/** 主题"深挖"触发按钮（C-1）：POST /api/topics/[id]/deep-dive，202 fire-and-forget。
 *  成功后显示提示文案（含 /admin 看进度 + /reports 等新报告的引导）。 */
import { useState } from "react";

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
  const [msg, setMsg] = useState<string | null>(null);

  if (!enabled) return <span className="muted" style={{ fontSize: ".85rem" }}>· 停用中（不可深挖）</span>;

  async function trigger(): Promise<void> {
    if (!confirm(`对主题"${topicName}"启动深挖？\n预计 5-15 分钟、消耗 ~$0.5–2 LLM 成本。`)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/deep-dive`, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 202) {
        setMsg(
          `✅ 已启动（${(body.started_at as string).slice(11, 19)}）· 看 /admin 进度 · 新报告会进 /reports`,
        );
      } else {
        setMsg(`❌ HTTP ${res.status} · ${body.message ?? body.error ?? "未知"}`);
      }
    } catch (e) {
      setMsg(`❌ ${(e as Error).message.slice(0, 80)}`);
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
        disabled={busy}
        title="对该主题触发 analyze → validate → report-gen（type=deep_dive，14 天窗口 / 25 条）"
      >
        {busy ? "启动中…" : "深挖"}
      </button>
      {msg ? <span className="muted" style={{ marginLeft: ".5rem", fontSize: ".85rem" }}>{msg}</span> : null}
    </span>
  );
}
