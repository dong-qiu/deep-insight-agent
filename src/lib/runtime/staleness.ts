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

/** 单一全局最新报告会掩盖某个 daily topic 连续漏报；逐 topic 投影供
 * health/alert 使用。新 topic 在阈值内尚未首报时是 pending，不制造告警噪音。 */
export interface DailyTopicFreshness {
  topicId: string;
  topicName: string;
  latestReportAt: string | null;
  reportAgeHours: number | null;
  state: "fresh" | "stale" | "pending_initial_report";
}

export interface DailyTopicStalenessResult {
  thresholdHours: number;
  topics: DailyTopicFreshness[];
  staleTopics: DailyTopicFreshness[];
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

/** 每个启用 daily topic 都必须独立满足日报新鲜度。没有首报时按 topic
 * 创建时间给予与正常日报相同的缓冲；超过阈值仍未产生 done brief 才告警。 */
export function checkDailyTopicStaleness(
  db: DB,
  now: number = Date.now(),
  threshold: number = stalenessThresholdHours(),
): DailyTopicStalenessResult {
  const rows = db.prepare(`
    SELECT t.id AS topic_id,t.name AS topic_name,t.created_at AS topic_created_at,
      MAX(r.generated_at) AS latest_report_at
    FROM topic t
    LEFT JOIN report r ON r.topic_id=t.id AND r.type='brief' AND r.status='done'
    WHERE t.enabled=1 AND t.brief_schedule='daily'
    GROUP BY t.id,t.name,t.created_at
    ORDER BY t.id ASC
  `).all() as Array<{ topic_id: string; topic_name: string; topic_created_at: string; latest_report_at: string | null }>;
  const topics = rows.map((row): DailyTopicFreshness => {
    const reference = row.latest_report_at ?? row.topic_created_at;
    // topic.created_at 的 SQLite 默认值是无时区的 `YYYY-MM-DD HH:MM:SS`，
    // 该默认值按 UTC 解释，避免 host TZ 改变首报宽限的告警结果。
    const normalized = reference.includes("T") ? reference : `${reference.replace(" ", "T")}Z`;
    const parsed = new Date(normalized).getTime();
    const age = Number.isFinite(parsed) ? (now - parsed) / MS_PER_HOUR : null;
    if (row.latest_report_at == null && (age == null || age <= threshold)) {
      return { topicId: row.topic_id, topicName: row.topic_name, latestReportAt: null, reportAgeHours: null, state: "pending_initial_report" };
    }
    const stale = age == null || age > threshold;
    return {
      topicId: row.topic_id, topicName: row.topic_name, latestReportAt: row.latest_report_at,
      reportAgeHours: row.latest_report_at == null ? null : age,
      state: stale ? "stale" : "fresh",
    };
  });
  return { thresholdHours: threshold, topics, staleTopics: topics.filter((topic) => topic.state === "stale") };
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
const dailyTopicLastAlertAt = new Map<string, number>();

/** 仅供测试重置去重状态。 */
export function resetStalenessAlertState(): void {
  lastAlertAt = 0;
  dailyTopicLastAlertAt.clear();
}

export function dailyTopicStalenessNotification(topic: DailyTopicFreshness, thresholdHours: number): Notification {
  const age = topic.reportAgeHours == null ? "尚未生成首份日报" : `最新日报距今 ${topic.reportAgeHours.toFixed(1)}h`;
  return {
    title: "🟠 日报主题陈旧",
    text: [
      `主题：${topic.topicName}（${topic.topicId}）`,
      `${age}（阈值 ${thresholdHours}h）`,
      "排查该主题的 generation trace、调度队列、LLM/引用校验与部署 drain 状态。",
    ].join("\n"),
    priority: "high",
    tags: ["warning", "daily-topic-staleness"],
  };
}

/** 按 topic 去重，恢复后删除该 topic 的 incident 状态；一个健康 topic
 * 不会掩盖另一个 stale topic。 */
export function maybeAlertDailyTopicStaleness(
  result: DailyTopicStalenessResult,
  now: number = Date.now(),
  send: (n: Notification) => void = notify,
): void {
  const reAlertHours = Math.max(1, Number(process.env.STALENESS_REALERT_HOURS) || 24);
  const staleIds = new Set(result.staleTopics.map((topic) => topic.topicId));
  for (const topicId of dailyTopicLastAlertAt.keys()) {
    if (!staleIds.has(topicId)) dailyTopicLastAlertAt.delete(topicId);
  }
  for (const topic of result.staleTopics) {
    const previous = dailyTopicLastAlertAt.get(topic.topicId);
    if (previous != null && now - previous < reAlertHours * MS_PER_HOUR) continue;
    dailyTopicLastAlertAt.set(topic.topicId, now);
    try {
      runLogger({ stage: "daily_topic_staleness" }).warn(
        { topicId: topic.topicId, reportAgeHours: topic.reportAgeHours, thresholdHours: result.thresholdHours },
        "日报主题陈旧——触发告警",
      );
      send(dailyTopicStalenessNotification(topic, result.thresholdHours));
    } catch {
      /* health probe must not fail because notification delivery failed */
    }
  }
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
