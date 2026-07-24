"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TechnologyOpportunityStatus } from "../../../lib/types.js";

const ACTIONS: Array<{ status: TechnologyOpportunityStatus; label: string }> = [
  { status: "watching", label: "关注" }, { status: "research_candidate", label: "列为研究候选" },
  { status: "poc_ready", label: "准备 PoC" }, { status: "project_candidate", label: "列为立项候选" },
  { status: "rejected", label: "排除" },
];

export function OpportunityActions({ id, status }: { id: string; status: TechnologyOpportunityStatus }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function decide(next: TechnologyOpportunityStatus): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/opportunities/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!res.ok) throw new Error("保存状态失败");
      router.refresh();
    } finally { setBusy(false); }
  }
  return <span className="lead-actions">{ACTIONS.filter((action) => action.status !== status).map((action) => <button className="ppt-btn-link" disabled={busy} key={action.status} onClick={() => void decide(action.status)}>{action.label}</button>)}</span>;
}
