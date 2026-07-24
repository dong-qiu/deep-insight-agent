"use client";
import { useState, type ReactNode } from "react";

/** 把阅读机会池与维护规划规则分开，避免同一屏同时承担浏览和编辑两种任务。 */
export function PlanningTabs({ opportunityPool, directionWorkbench }: { opportunityPool: ReactNode; directionWorkbench: ReactNode }): React.ReactElement {
  const [tab, setTab] = useState<"pool" | "directions">("pool");
  return <>
    <div className="planning-tabs" role="tablist" aria-label="技术规划视图">
      <button role="tab" aria-selected={tab === "pool"} className={tab === "pool" ? "planning-tab-active" : ""} onClick={() => setTab("pool")}>机会池</button>
      <button role="tab" aria-selected={tab === "directions"} className={tab === "directions" ? "planning-tab-active" : ""} onClick={() => setTab("directions")}>管理方向</button>
    </div>
    {tab === "pool" ? opportunityPool : directionWorkbench}
  </>;
}
