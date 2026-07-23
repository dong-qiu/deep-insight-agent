"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TechLeadStatus } from "../../../lib/types.js";

export function LeadActions({ id, status }: { id: string; status: TechLeadStatus }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function setStatus(next: TechLeadStatus): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!res.ok) throw new Error();
      router.refresh();
    } finally { setBusy(false); }
  }
  return <span className="lead-actions">
    {status !== "watching" ? <button className="ppt-btn-link" disabled={busy} onClick={() => void setStatus("watching")}>关注</button> : null}
    {status !== "dismissed" ? <button className="ppt-btn-link" disabled={busy} onClick={() => void setStatus("dismissed")}>忽略</button> : null}
  </span>;
}
