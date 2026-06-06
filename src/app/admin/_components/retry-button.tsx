"use client";
/** /admin 失败 Run 重试按钮（B-4）：仅显示在 status=failed 的 Run 上。
 *  - kind=ingest：POST → 后端重跑单源；成功后用 router.refresh() 让看板拉新 Run 列表；
 *  - kind 其他：button 直接显示 "管线任务"，点击给提示链接 /api/cron 整体重跑。 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function RetryButton({
  runId,
  kind,
}: {
  runId: string;
  kind: "ingest" | "analyze" | "validate" | "report-gen";
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (kind !== "ingest") {
    return (
      <span className="muted" style={{ fontSize: ".85rem" }}>
        · 管线任务（需 <code>POST /api/cron</code> 整体重跑）
      </span>
    );
  }

  async function retry(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/runs/${runId}/retry`, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.ok) {
        setMsg(
          `✅ 新 Run ${body.new_run_id} · fetched=${body.fetched} inserted=${body.inserted}`,
        );
        // 等 500ms 让用户看到结果再 refresh
        setTimeout(() => router.refresh(), 500);
      } else {
        setMsg(`❌ HTTP ${res.status} · ${body.error ?? "未知"}`);
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
        disabled={busy}
        onClick={retry}
        title="复用 retry_of 链路重跑单源采集"
      >
        {busy ? "重试中…" : "重试"}
      </button>
      {msg ? <span className="muted" style={{ marginLeft: ".5rem", fontSize: ".85rem" }}>{msg}</span> : null}
    </span>
  );
}
