/** 数据陈旧检测 + 告警（运维可观测性）。
 *
 *  动机（2026-06-11 dogfood）：生产管线静默停摆 6 天无人知——cron 容器的 supercronic 卡死
 *  （本机 ARM 跑 amd64 镜像、QEMU 模拟下 Go 定时器不触发），既不报错也不退出，而健康检查只看
 *  "app 活没活"、不看"今天有没有产出"。教训：调度可能静默死亡，必须有独立于调度的"数据新鲜度"看门狗。
 *
 *  触发机制：由 /api/health 处理器调 maybeAlertStale——Docker healthcheck 每 30s 用 node fetch 打
 *  /api/health（这正是容器 "healthy" 的来源），是个**独立于 supercronic** 的现成心跳：cron 死了 app 仍被
 *  探活，故能发现"调度本身停了"。不另起 setInterval（避免 instrumentation 把 better-sqlite3 拉进 edge bundle）。
 *
 *  纯判定（getFreshness/checkStaleness）与副作用（notify）分离，前者可无 key 单测；db 由调用方注入。 */
import { notify, type Notification } from "./alert.js";
import { runLogger } from "./logger.js";
import type { DB } from "../db/index.js";

const MS_PER_HOUR = 3_600_000;

export interface Freshness {
  latestReportAt: string | null;
  latestContentAt: string | null;
  reportAgeHours: number | null; // null = 无任何报告（空库/全新部署）
  contentAgeHours: number | null;
}

/** 读最新 done 报告 + 最新采集内容的时间，算距今小时数（纯读，无 LLM）。 */
export function getFreshness(db: DB, now: number = Date.now()): Freshness {
  const r = db.prepare("SELECT MAX(generated_at) AS m FROM report WHERE status='done'").get() as { m: string | null };
  const c = db.prepare("SELECT MAX(fetched_at) AS m FROM content_item").get() as { m: string | null };
  const ageH = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? (now - t) / MS_PER_HOUR : null;
  };
  return {
    latestReportAt: r.m ?? null,
    latestContentAt: c.m ?? null,
    reportAgeHours: ageH(r.m ?? null),
    contentAgeHours: ageH(c.m ?? null),
  };
}

export interface StalenessResult extends Freshness {
  stale: boolean;
  thresholdHours: number;
  reason: "fresh" | "stale" | "no_data";
}

/** 告警阈值（小时）。默认 26h：daily 节奏下，>26h 意味着至少漏了一天 + 缓冲。env 可调，挡 NaN/≤0。 */
export function stalenessThresholdHours(): number {
  const v = Number(process.env.STALENESS_ALERT_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 26;
}

/** 以"最新报告距今"为主判据（daily 产出节奏）。无任何报告 → no_data（空库/全新部署，不告警）。 */
export function checkStaleness(
  db: DB,
  now: number = Date.now(),
  threshold: number = stalenessThresholdHours(),
): StalenessResult {
  const f = getFreshness(db, now);
  if (f.reportAgeHours == null) return { ...f, stale: false, thresholdHours: threshold, reason: "no_data" };
  const stale = f.reportAgeHours > threshold;
  return { ...f, stale, thresholdHours: threshold, reason: stale ? "stale" : "fresh" };
}

/** 陈旧 → 中性通知（复用渠道层）。内联两类年龄 + 排查指引便于回查。 */
export function stalenessNotification(r: StalenessResult): Notification {
  const h = (x: number | null): string => (x == null ? "N/A" : `${x.toFixed(1)}h`);
  const text = [
    `最新报告距今 ${h(r.reportAgeHours)}（阈值 ${r.thresholdHours}h）`,
    `最新采集距今 ${h(r.contentAgeHours)}`,
    `最新报告时间：${r.latestReportAt ?? "无"}`,
    "排查：cron/调度是否在跑（supercronic / /api/cron），或手动触发 ops/trigger.mjs。",
  ].join("\n");
  return { title: "🟠 数据陈旧：管线可能停摆", text, priority: "high", tags: ["warning"] };
}

// ── 告警触发（去重 + 副作用），由 /api/health 心跳调用 ──
let lastAlertAt = 0;

/** 仅供测试重置去重状态。 */
export function resetStalenessAlertState(): void {
  lastAlertAt = 0;
}

/** 陈旧则告警，自带去重：同一陈旧期最多每 STALENESS_REALERT_HOURS（默认 24）告一次，不随每 30s 心跳刷屏。
 *  fire-and-forget、永不抛（由 health 处理器调用，绝不能影响探针响应）。send 可注入便于单测。 */
export function maybeAlertStale(
  r: StalenessResult,
  now: number = Date.now(),
  send: (n: Notification) => void = notify,
): void {
  if (!r.stale) return;
  const reAlertHours = Math.max(1, Number(process.env.STALENESS_REALERT_HOURS) || 24);
  if (now - lastAlertAt < reAlertHours * MS_PER_HOUR) return; // 去重窗口内
  lastAlertAt = now;
  try {
    runLogger({ stage: "staleness" }).warn(
      { reportAgeHours: r.reportAgeHours, threshold: r.thresholdHours },
      "数据陈旧——触发告警",
    );
    send(stalenessNotification(r));
  } catch {
    /* 绝不抛进 health 处理器 */
  }
}
