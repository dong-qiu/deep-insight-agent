"use client";
/** Reader-visible v6 PPT export. The deck is deterministic: it carries one audited source
 * quote and controlled system metadata, never a free LLM rewrite. */
import { useState } from "react";

export function ExportPptButton({ reportId }: { reportId: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/pptx`);
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = `${res.status} · ${body.error}`;
        } catch {
          // A non-JSON error still has a useful HTTP status above.
        }
        throw new Error(msg);
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename\*=UTF-8''([^;]+)/);
      const fileName = match ? decodeURIComponent(match[1]) : `report-${reportId}.pptx`;
      const objectUrl = URL.createObjectURL(await res.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <span className="export-ppt">
    <button
      type="button"
      className="ppt-btn"
      disabled={busy}
      onClick={download}
      title="原文证据模式：每条洞察只展示一次已核验原文及来源。"
    >
      {busy ? "生成中…" : "导出 PPT"}
    </button>
    {err ? <span className="export-ppt-err"> · 失败：{err}</span> : null}
  </span>;
}
