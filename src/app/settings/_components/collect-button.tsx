"use client";
/** 数据源"立即抓取"按钮（C-3 · data-collection AC8）：
 *  POST /api/admin/sources/[id]/collect → 202 fire-and-forget → UI 显示启动时间 + 引导到 /admin 看进度。 */
import { useState } from "react";

export function CollectButton({
  sourceId,
  sourceName,
  enabled,
}: {
  sourceId: string;
  sourceName: string;
  enabled: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!enabled) return <span className="muted" style={{ fontSize: ".85rem" }}>· 停用中（不可抓取）</span>;

  async function trigger(): Promise<void> {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/admin/sources/${sourceId}/collect`, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 202) {
        setMsg(`✅ 已启动（${(body.started_at as string).slice(11, 19)}）· 看 /admin 进度`);
      } else {
        setMsg(`❌ HTTP ${res.status} · ${body.error ?? body.message ?? "未知"}`);
      }
    } catch (e) {
      setMsg(`❌ ${(e as Error).message.slice(0, 100)}`);
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
        title={`不等定时周期，立即对 "${sourceName}" 跑一次 RSS/arXiv/API 抓取（fire-and-forget；进度看 /admin）`}
      >
        {busy ? "启动中…" : "立即抓取"}
      </button>
      {msg ? <span className="muted" style={{ marginLeft: ".5rem", fontSize: ".85rem" }}>{msg}</span> : null}
    </span>
  );
}
