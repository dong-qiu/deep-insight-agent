/** Dispatch queue-age alerting is intentionally separate from public app
 * liveness.  The worker health endpoint invokes this module on every Docker
 * probe, so a running app cannot hide a stalled dispatch queue. */
import {
  GENERATION_DISPATCH_ALERT_AGE_MS,
  type GenerationDispatchHealth,
} from "../db/provenance.js";
import { notify, type Notification } from "./alert.js";
import { runLogger } from "./logger.js";

let unhealthySince: number | null = null;
let lastAlertAt = 0;

export function generationDispatchHealthNotification(health: GenerationDispatchHealth): Notification {
  const minutes = health.oldestActionableAgeMs == null ? "N/A" : `${(health.oldestActionableAgeMs / 60_000).toFixed(1)} min`;
  return {
    title: "🔴 生成调度队列积压",
    text: [
      `最老可执行任务年龄：${minutes}（告警阈值 ${(GENERATION_DISPATCH_ALERT_AGE_MS / 60_000).toFixed(0)} min）`,
      `queued：${health.queuedCount}；已过期 claimed：${health.expiredClaimedCount}`,
      `最早任务创建时间：${health.oldestActionableAt ?? "无"}`,
      "排查 generation-dispatch-worker、SQLite 锁、LLM/外部调用与部署 drain 状态。",
    ].join("\n"),
    priority: "high",
    tags: ["warning", "generation-dispatch"],
  };
}

/** Reset is test-only; a recovered queue must alert again immediately if it
 * later becomes unhealthy, rather than inheriting a prior incident's window. */
export function resetGenerationDispatchHealthAlertState(): void {
  unhealthySince = null;
  lastAlertAt = 0;
}

export function maybeAlertGenerationDispatchHealth(
  health: GenerationDispatchHealth,
  now: number = Date.now(),
  send: (notification: Notification) => void = notify,
): void {
  if (health.oldestActionableAgeMs == null || health.oldestActionableAgeMs <= GENERATION_DISPATCH_ALERT_AGE_MS) {
    unhealthySince = null;
    lastAlertAt = 0;
    return;
  }
  if (unhealthySince == null) unhealthySince = now;
  const reAlertHours = Math.max(1, Number(process.env.GENERATION_DISPATCH_REALERT_HOURS) || 1);
  if (lastAlertAt !== 0 && now - lastAlertAt < reAlertHours * 3_600_000) return;
  lastAlertAt = now;
  try {
    runLogger({ stage: "generation_dispatch_health" }).warn(
      { ...health, unhealthySince: new Date(unhealthySince).toISOString() },
      "generation dispatch queue age exceeded alert threshold",
    );
    send(generationDispatchHealthNotification(health));
  } catch {
    // Health/readiness must never fail because alert delivery failed.
  }
}
