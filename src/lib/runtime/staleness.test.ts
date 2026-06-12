/** staleness 纯判定逻辑单测（in-memory DB，无 LLM/网络）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkStaleness, getFreshness, maybeAlertStale, resetStalenessAlertState,
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
