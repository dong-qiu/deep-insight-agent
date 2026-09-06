/** staleness 纯判定逻辑单测（in-memory DB，无 LLM/网络）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDailyTopicStaleness, checkStaleness, dailyTopicStalenessNotification, getFreshness,
  maybeAlertDailyTopicStaleness, maybeAlertStale, resetStalenessAlertState,
  stalenessNotification, stalenessThresholdHours, type StalenessResult,
} from "./staleness.js";
import { closeDb, openDb, type DB } from "../db/index.js";
import { insertSource, insertTopic } from "../db/repos.js";

const NOW = Date.parse("2026-06-12T00:00:00Z");
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

let db: DB;
beforeEach(() => {
  delete process.env.STALENESS_ALERT_HOURS;
  db = openDb(":memory:");
  insertSource(db, {
    id: "src1", name: "S", type: "rss", endpoint: "https://x/feed", industry: "ai-swe",
    topic_ids: ["t1"], fetch_interval: "6h", backfill: null, enabled: true,
  } as never);
  insertTopic(db, {
    id: "t1", name: "T", keywords: [], industry: "ai-swe", language: "zh",
    brief_schedule: "daily", enabled: true,
  } as never);
});
afterEach(() => closeDb());

function report(id: string, generatedAt: string, status = "done"): void {
  db.prepare(
    `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,citation_count,cost)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, "brief", "t1", status, generatedAt, "T", `/tmp/${id}`, 0, "{}");
}
function content(id: string, fetchedAt: string): void {
  db.prepare(
    `INSERT INTO content_item (id,source_id,url,title,author,published_at,fetched_at,language,topic_ids,tags,body,raw_ref,content_hash,fetch_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, "src1", `https://x/${id}`, "t", null, null, fetchedAt, "zh", "[]", "[]", "b", "r", "h"+id, "ok");
}

describe("getFreshness", () => {
  it("取最新 done 报告 + 最新采集，算距今小时", () => {
    report("r1", hoursAgo(50));
    report("r2", hoursAgo(5)); // 最新
    content("c1", hoursAgo(8));
    const f = getFreshness(db, NOW);
    expect(f.reportAgeHours).toBeCloseTo(5);
    expect(f.contentAgeHours).toBeCloseTo(8);
    expect(f.latestReportAt).toBe(hoursAgo(5));
  });

  it("忽略非 done 报告", () => {
    report("r1", hoursAgo(2), "failed");
    report("r2", hoursAgo(40), "done");
    expect(getFreshness(db, NOW).reportAgeHours).toBeCloseTo(40);
  });
});

describe("checkStaleness", () => {
  it("最新报告在阈值内 → fresh", () => {
    report("r1", hoursAgo(10));
    const s = checkStaleness(db, NOW, 26);
    expect(s).toMatchObject({ stale: false, reason: "fresh" });
  });

  it("最新报告超阈值 → stale", () => {
    report("r1", hoursAgo(150)); // 6 天前（复刻本次停摆）
    const s = checkStaleness(db, NOW, 26);
    expect(s).toMatchObject({ stale: true, reason: "stale" });
    expect(s.reportAgeHours).toBeCloseTo(150);
  });

  it("空库（无任何报告）→ no_data，不告警", () => {
    const s = checkStaleness(db, NOW, 26);
    expect(s).toMatchObject({ stale: false, reason: "no_data", reportAgeHours: null });
  });

  it("阈值默认 26h，可被 STALENESS_ALERT_HOURS 覆盖", () => {
    expect(stalenessThresholdHours()).toBe(26);
    process.env.STALENESS_ALERT_HOURS = "12";
    expect(stalenessThresholdHours()).toBe(12);
    report("r1", hoursAgo(18));
    expect(checkStaleness(db, NOW).stale).toBe(true); // 18 > 12
  });
});

describe("checkDailyTopicStaleness", () => {
  it("一个新鲜 topic 不得掩盖另一个连续漏报的 daily topic", () => {
    report("fresh", hoursAgo(1));
    insertTopic(db, {
      id: "t2", name: "Missing", keywords: [], industry: "ai-swe", language: "zh",
      brief_schedule: "daily", enabled: true,
    } as never);
    db.prepare("UPDATE topic SET created_at=? WHERE id='t2'").run(hoursAgo(30));

    const result = checkDailyTopicStaleness(db, NOW, 26);

    expect(result.topics).toEqual(expect.arrayContaining([
      expect.objectContaining({ topicId: "t1", state: "fresh" }),
      expect.objectContaining({ topicId: "t2", state: "stale", latestReportAt: null }),
    ]));
    expect(result.staleTopics.map((topic) => topic.topicId)).toEqual(["t2"]);
  });

  it("新建 topic 在首报宽限期内是 pending，不触发陈旧", () => {
    db.prepare("UPDATE topic SET created_at=? WHERE id='t1'").run(hoursAgo(2));
    const result = checkDailyTopicStaleness(db, NOW, 26);
    expect(result.topics).toEqual([expect.objectContaining({ topicId: "t1", state: "pending_initial_report" })]);
    expect(result.staleTopics).toEqual([]);
  });

  it("已有日报超过阈值时，该 topic 单独进入 stale", () => {
    report("old-daily", hoursAgo(27));

    const result = checkDailyTopicStaleness(db, NOW, 26);

    expect(result.staleTopics).toEqual([
      expect.objectContaining({ topicId: "t1", latestReportAt: hoursAgo(27), state: "stale" }),
    ]);
  });

  it("日报聚合命中 topic/type/status/generated_at 覆盖索引", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT MAX(r.generated_at) AS latest_report_at
      FROM topic t
      LEFT JOIN report r ON r.topic_id=t.id AND r.type='brief' AND r.status='done'
      WHERE t.enabled=1 AND t.brief_schedule='daily'
      GROUP BY t.id,t.name,t.created_at
    `).all() as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_report_daily_topic_freshness"))).toBe(true);
  });
});

describe("stalenessNotification", () => {
  it("含两类年龄 + 阈值 + 排查指引，高优", () => {
    report("r1", hoursAgo(150));
    content("c1", hoursAgo(150));
    const n = stalenessNotification(checkStaleness(db, NOW, 26));
    expect(n.priority).toBe("high");
    expect(n.title).toContain("数据陈旧");
    expect(n.text).toContain("阈值 26h");
    expect(n.text).toContain("supercronic");
  });
});

describe("maybeAlertStale 去重", () => {
  const staleResult: StalenessResult = {
    latestReportAt: hoursAgo(150), latestContentAt: hoursAgo(150),
    reportAgeHours: 150, contentAgeHours: 150, stale: true, thresholdHours: 26, reason: "stale",
  };
  beforeEach(() => {
    resetStalenessAlertState();
    delete process.env.STALENESS_REALERT_HOURS;
  });

  it("fresh → 不告警", () => {
    const send = vi.fn();
    maybeAlertStale({ ...staleResult, stale: false, reason: "fresh" }, NOW, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("陈旧 → 告警一次；去重窗口内重复心跳不再发", () => {
    const send = vi.fn();
    maybeAlertStale(staleResult, NOW, send);
    maybeAlertStale(staleResult, NOW + 60_000, send); // 1 分钟后再次心跳
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("超过 STALENESS_REALERT_HOURS 后再次告警", () => {
    const send = vi.fn();
    maybeAlertStale(staleResult, NOW, send);
    maybeAlertStale(staleResult, NOW + 25 * 3_600_000, send); // 25h 后（>默认 24h 窗口）
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("maybeAlertDailyTopicStaleness", () => {
  const stale = {
    thresholdHours: 26,
    topics: [{ topicId: "t1", topicName: "T", latestReportAt: hoursAgo(30), reportAgeHours: 30, state: "stale" as const }],
    staleTopics: [{ topicId: "t1", topicName: "T", latestReportAt: hoursAgo(30), reportAgeHours: 30, state: "stale" as const }],
  };

  beforeEach(() => resetStalenessAlertState());

  it("每个 stale topic 独立告警、在窗口内去重，并在恢复后重置", () => {
    const send = vi.fn();
    maybeAlertDailyTopicStaleness(stale, NOW, send);
    maybeAlertDailyTopicStaleness(stale, NOW + 60_000, send);
    expect(send).toHaveBeenCalledTimes(1);

    maybeAlertDailyTopicStaleness({ thresholdHours: 26, topics: [], staleTopics: [] }, NOW + 120_000, send);
    maybeAlertDailyTopicStaleness(stale, NOW + 180_000, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("通知包含 topic 身份和排查方向", () => {
    const notification = dailyTopicStalenessNotification(stale.staleTopics[0]!, 26);
    expect(notification.title).toContain("日报主题陈旧");
    expect(notification.text).toContain("t1");
    expect(notification.text).toContain("generation trace");
  });
});
