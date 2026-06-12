/** followup_qa 持久化 + getInsightsByIds 单测（in-memory DB，无 API key）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInsightsByIds, saveAnalysisBatch } from "./analysis.js";
import { listFollowups, saveFollowup } from "./followup.js";
import { closeDb, openDb, type DB } from "./index.js";
import { insertSource, insertTopic } from "./repos.js";
import type { AnalysisBatch, FollowupQA, Source, Topic } from "../types.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  insertSource(db, {
    id: "src1", name: "S", type: "rss", endpoint: "https://x/feed", industry: "ai-swe",
    topic_ids: ["t1"], fetch_interval: "6h", backfill: null, enabled: true,
  } as Source);
  insertTopic(db, {
    id: "t1", name: "T", keywords: [], industry: "ai-swe", language: "zh",
    brief_schedule: "daily", enabled: true,
  } as Topic);
});
afterEach(() => closeDb());

/** 插一行最小 report（满足 followup_qa.report_id 外键）。 */
function bareReport(id: string): void {
  db.prepare(
    `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,citation_count,cost)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, "brief", "t1", "done", "2026-06-08T00:00:00Z", "T", `/tmp/${id}`, 0, "{}");
}

const batch: AnalysisBatch = {
  id: "ab1", topic_id: "t1", time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
  status: "done", no_significant_event: false,
  insights: [
    {
      id: "ins_1", topic_id: "t1", type: "aggregation", event_id: null, statement: "S1",
      importance: 3, importance_basis: "b", source_count: 1, multi_source: false,
      citations: [{ content_item_id: "ci_1", quote: "q1", locator: { paragraph_index: 0, char_start: 0, char_end: 2 } }],
      time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" }, confidence: null, language: "zh",
    },
    {
      id: "ins_2", topic_id: "t1", type: "trend", event_id: null, statement: "S2",
      importance: 4, importance_basis: "b", source_count: 1, multi_source: false,
      citations: [], time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
      confidence: "high", language: "zh",
    },
  ],
};

function qa(overrides: Partial<FollowupQA> = {}): FollowupQA {
  return {
    id: "fup_1", report_id: "rep_1", thread_id: "fup_1", turn_index: 0,
    question: "Q?", answer_md: "A [1]。", citations_used: [
      { ref: 1, content_item_id: "ci_1", quote: "q1", source_name: "S", url: "https://x/a", published_at: null },
    ],
    validation: { total: 1, reachable: 1, consistent: 1, blocked: 0, errored: 0 },
    cost: { tokens: 10, amount: 0.001 }, status: "done", created_at: "2026-06-08T00:00:00Z",
    ...overrides,
  };
}

describe("getInsightsByIds", () => {
  it("按 id 顺序取洞察 + 引用；缺失 id 跳过", () => {
    saveAnalysisBatch(db, batch);
    const got = getInsightsByIds(db, ["ins_2", "ins_1", "missing"]);
    expect(got.map((i) => i.id)).toEqual(["ins_2", "ins_1"]); // 保持传入顺序
    expect(got[1].citations).toHaveLength(1);
    expect(got[1].citations[0]).toMatchObject({ content_item_id: "ci_1", quote: "q1" });
  });
});

describe("followup_qa 持久化", () => {
  it("saveFollowup → listFollowups round-trip（JSON 字段还原）", () => {
    bareReport("rep_1");
    saveFollowup(db, qa());
    const list = listFollowups(db, "rep_1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "fup_1", question: "Q?", status: "done" });
    expect(list[0].citations_used[0]).toMatchObject({ ref: 1, source_name: "S" });
    expect(list[0].validation).toMatchObject({ consistent: 1 });
    expect(list[0].cost).toMatchObject({ amount: 0.001 });
  });

  it("listFollowups 按 created_at 升序、按 report 过滤", () => {
    bareReport("rep_1");
    bareReport("rep_2");
    saveFollowup(db, qa({ id: "fup_a", created_at: "2026-06-08T01:00:00Z" }));
    saveFollowup(db, qa({ id: "fup_b", created_at: "2026-06-08T00:00:00Z" }));
    saveFollowup(db, qa({ id: "fup_c", report_id: "rep_2", created_at: "2026-06-08T02:00:00Z" }));
    const list = listFollowups(db, "rep_1");
    expect(list.map((q) => q.id)).toEqual(["fup_b", "fup_a"]); // 升序、只含 rep_1
  });
});
