/** P1b-2 controlled late-data alert calls. The generic notifier is intentionally non-blocking. */
import { notify } from "./alert.js";

export function notifyMetricLateFact(input: { factKind: "funnel" | "cost" | "validator"; eventId: string; occurredAt: string }): void {
  notify({
    title: "⚠️ 指标迟到数据已隔离",
    text: `${input.factKind} 事实 ${input.eventId}（业务时间 ${input.occurredAt}）超过 7 天受控回填窗，已进入 quarantine；请由管理员显式对账后决定回填或拒绝。`,
    priority: "high", tags: ["warning"],
  });
}

export function notifyMetricLateReconciliation(input: { eventId: string; action: "backfilled" | "declined"; actorId: string }): void {
  notify({
    title: "ℹ️ 指标迟到数据已对账",
    text: `迟到事实 ${input.eventId} 已由 ${input.actorId} 显式${input.action === "backfilled" ? "回填并重算对应桶" : "拒绝回填"}。`,
    priority: "default", tags: ["information_source"],
  });
}
