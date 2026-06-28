import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisBatch, Entity, Insight, Topic } from "../types.js";
import { saveAnalysisBatch } from "./analysis.js";
import { buildTopicGraph, insightsCooccurring, insightsMentioningEntity, loadTopicInsights, reportLinkMap } from "./graph.js";
import { type DB, openDb } from "./index.js";
import { insertTopic } from "./repos.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], language: "zh", brief_schedule: "daily", enabled: true,
};
const org = (name: string): Entity => ({ name, type: "organization" });

function mkInsight(id: string, entities: Entity[]): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement: `S-${id}`, headline: "",
    importance: 3, importance_basis: "b",
    citations: [{ content_item_id: `ci-${id}`, quote: "q", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
    source_count: 1, multi_source: false, time_window: { start: "2026-05-01", end: "2026-05-07" },
    confidence: "high", language: "zh", is_followup: false, entities, tags: [],
  };
}
function saveBatch(id: string, insights: Insight[]) {
  const batch: AnalysisBatch = {
    id, topic_id: "t1", time_window: { start: "2026-05-01", end: "2026-05-07" },
    status: "done", no_significant_event: false, insights,
  };
  saveAnalysisBatch(db, batch);
}

beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
});

describe("buildTopicGraph", () => {
  it("共现 2 条 → 边 + 计数（自适应阈值=2）", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1");
    expect(r.insightCount).toBe(2);
    expect(r.withEntities).toBe(2);
    expect(r.minEdgeWeight).toBe(2);
    expect(r.graph.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 2, strength: 1 }]);
  });

  it("withEntities 排除无实体洞察", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")]), mkInsight("i2", [])]);
    saveBatch("b2", [mkInsight("i3", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1");
    expect(r.insightCount).toBe(3);
    expect(r.withEntities).toBe(2);
  });

  it("显式 minEdgeWeight 覆盖自适应", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1", { minEdgeWeight: 1 });
    expect(r.minEdgeWeight).toBe(1);
    expect(r.graph.edges).toEqual([{ a: "Cursor", b: "OpenAI", weight: 1, strength: 1 }]);
  });

  it("metric=association：返回 metric、支持度下限固定 2、边带 strength", () => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Cursor")])]);
    const r = buildTopicGraph(db, "t1", { metric: "association" });
    expect(r.metric).toBe("association");
    expect(r.minEdgeWeight).toBe(2);
    expect(r.graph.edges[0].strength).toBe(1);
  });

  it("since 限定时间窗：旧 batch 的洞察被排除", () => {
    saveBatch("bold", [mkInsight("iold", [org("OpenAI"), org("Cursor")])]);
    saveBatch("bnew", [mkInsight("inew", [org("OpenAI"), org("Cursor")])]);
    db.prepare("UPDATE analysis_batch SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:00", "bold");
    const r = buildTopicGraph(db, "t1", { since: "2026-05-01" });
    expect(r.insightCount).toBe(1); // 只剩 bnew
  });
});

describe("溯源查询", () => {
  beforeEach(() => {
    saveBatch("b1", [mkInsight("i1", [org("OpenAI"), org("Cursor")])]);
    saveBatch("b2", [mkInsight("i2", [org("OpenAI"), org("Anthropic")])]);
  });

  it("loadTopicInsights 带 citations 锚回原文", () => {
    const ins = loadTopicInsights(db, "t1");
    expect(ins.length).toBe(2);
    expect(ins[0].citations[0].content_item_id).toBe("ci-i1");
  });

  it("insightsMentioningEntity：提及该实体的全部洞察", () => {
    expect(insightsMentioningEntity(db, "t1", "OpenAI").map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(insightsMentioningEntity(db, "t1", "Cursor").map((i) => i.id)).toEqual(["i1"]);
  });

  it("insightsCooccurring：只返两实体同条共现的洞察", () => {
    expect(insightsCooccurring(db, "t1", "OpenAI", "Cursor").map((i) => i.id)).toEqual(["i1"]);
    expect(insightsCooccurring(db, "t1", "Cursor", "Anthropic")).toEqual([]); // 从未同条
  });
});

describe("reportLinkMap", () => {
  /** 直插一份已发布报告（report + report_index）含给定 insight_ids */
  function saveReport(rid: string, date: string, insightIds: string[]) {
    db.prepare(
      `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(rid, "brief", "t1", "done", date, `R-${rid}`, `/p/${rid}`, JSON.stringify(insightIds), "[]", 0, "{}");
    db.prepare(
      `INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES (?,?,?,?,?,?,?)`,
    ).run(rid, "brief", "t1", date, `R-${rid}`, "", 3);
  }

  it("反查 insight_id → 报告；未入报告的洞察无链接", () => {
    saveReport("r1", "2026-06-01", ["i1", "i2"]);
    const m = reportLinkMap(db, "t1");
    expect(m.get("i1")).toEqual({ report_id: "r1", date: "2026-06-01" });
    expect(m.get("i2")?.report_id).toBe("r1");
    expect(m.get("i_blocked")).toBeUndefined(); // 未入任何报告 → 无链接
  });

  it("洞察在多份报告时取最新（date 升序覆盖取最新）", () => {
    saveReport("rOld", "2026-06-01", ["i1"]);
    saveReport("rNew", "2026-06-05", ["i1"]); // 续报再次包含 i1
    expect(reportLinkMap(db, "t1").get("i1")).toEqual({ report_id: "rNew", date: "2026-06-05" });
  });

  it("只算 status='done' 的报告", () => {
    db.prepare(
      `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
       VALUES ('rDraft','brief','t1','generating','2026-06-02','D','/p',?,'[]',0,'{}')`,
    ).run(JSON.stringify(["i9"]));
    db.prepare(
      `INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES ('rDraft','brief','t1','2026-06-02','D','',3)`,
    ).run();
    expect(reportLinkMap(db, "t1").get("i9")).toBeUndefined(); // 非 done 不计
  });
});
