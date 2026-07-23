/** 管线编排集成测试（质量 Q4）：覆盖 pipeline.ts 的 runAnalysis/runValidation/runReportGen 接线——
 *  此前零测试。mock LLM agents（analyze/validateBatch）+ buildReport + FS/alert 副作用，
 *  保留**真 runJob + 真落库（内存 DB）**，验：Run 生命周期、跨阶段数据流、成本透传、失败传播。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalysisBatch, getValidationResult, saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { type DB, openDb } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic, listRuns } from "../db/repos.js";
import { listTechLeads } from "../db/tech-leads.js";
import type { AnalysisBatch, ContentItem, Insight, Report, ReportIndexEntry, Source, Topic, ValidationResult } from "../types.js";

// vi.hoisted：vi.mock 工厂被提升到文件顶部，须用 hoisted 让 mock fns 在工厂运行时已初始化
const { analyzeMock, validateBatchMock, buildReportMock, saveReportMock } = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  validateBatchMock: vi.fn(),
  buildReportMock: vi.fn(),
  saveReportMock: vi.fn(),
}));
vi.mock("./analyzer.js", async (orig) => ({
  ...(await orig<typeof import("./analyzer.js")>()),
  analyze: analyzeMock,
}));
vi.mock("./validator.js", async (orig) => ({
  ...(await orig<typeof import("./validator.js")>()),
  validateBatch: validateBatchMock,
}));
vi.mock("./report-gen.js", async (orig) => ({
  ...(await orig<typeof import("./report-gen.js")>()),
  buildReport: buildReportMock,
}));
vi.mock("../db/reports.js", async (orig) => ({
  ...(await orig<typeof import("../db/reports.js")>()),
  saveReport: saveReportMock,
}));
vi.mock("../runtime/alert.js", async (orig) => ({
  ...(await orig<typeof import("../runtime/alert.js")>()),
  notifyFailure: vi.fn(),
  notifyReport: vi.fn(),
}));

import { runAnalysis, runReportGen, runTechLeadExtraction, runValidation } from "./pipeline.js";

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], language: "zh", brief_schedule: "daily", enabled: true,
  facets: ["domain:software-engineering"],
};
const win = { start: "2026-06-01", end: "2026-06-07" };

function mkInsight(id: string): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement: `S-${id}`, headline: "",
    importance: 3, importance_basis: "b",
    citations: [{ content_item_id: "ci1", quote: "q", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
    source_count: 1, multi_source: false, time_window: win, confidence: "high", language: "zh",
    is_followup: false, entities: [], tags: [],
  };
}
function mkBatch(): AnalysisBatch {
  return { id: "b1", topic_id: "t1", time_window: win, status: "done", no_significant_event: false, insights: [mkInsight("i1")] };
}
function mkValidation(insightId = "i1"): ValidationResult {
  return {
    checks: [{
      insight_id: insightId, citation_index: 0, reachability: "pass", reachability_reason: "ok",
      consistency: "support", consistency_reason: "ok", verdict: "pass",
    }],
    report: {
      total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0,
      consistency_failure_rate: 0, flagged_rate: 0,
      insights_total: 1, insights_includable: 1, releasable: true,
    },
  };
}

/** 落一份真实的 initial_digest + validation，确保 runReportGen 从 DB 读取历史成功证据，
 * 而不是仅依赖 buildReport 纯函数调用方手工传参。正文不在本测试路径读取，故 body_path 可为占位。 */
function seedPublishedInitialDigest(eventId: string, contentItemId: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const insight = {
    ...mkInsight("i_history"), event_id: eventId,
    citations: [{ content_item_id: contentItemId, quote: "published evidence", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
  };
  const batch: AnalysisBatch = {
    id: "b_history", topic_id: topic.id, time_window: { start: date, end: date },
    status: "done", no_significant_event: false, insights: [insight],
  };
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, batch.id, mkValidation(insight.id));
  db.prepare(`INSERT INTO report
    (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "rep_history", "initial_digest", topic.id, "done", `${date}T08:00:00Z`, "历史首版", "/tmp/history-report",
    JSON.stringify([insight.id]), JSON.stringify([eventId]), null, 1, JSON.stringify({ tokens: 0, amount: 0 }),
  );
  db.prepare(`INSERT INTO report_index
    (report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "rep_history", "initial_digest", topic.id, JSON.stringify(topic.facets), date, "[]", "历史首版", "", "[]", "[]", "[]", 3,
    JSON.stringify([eventId]), 0,
  );
}
function mkReportIndex(): ReportIndexEntry {
  return {
    report_id: "r1", type: "brief", topic_id: "t1", facets: ["domain:software-engineering"], date: "2026-06-07",
    source_ids: ["s1"], title: "R", summary: "sum", highlights: [], tags: [], entity_names: [],
    importance: 3, event_ids: [], milestone_count: 0,
  };
}
function mkReport(): Report {
  return {
    id: "r1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-06-07T00:00:00Z",
    title: "R", body_md: "body", body_html: "<p>body</p>", insight_ids: ["i1"], event_ids: [],
    prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 },
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
  analyzeMock.mockReset();
  validateBatchMock.mockReset();
  buildReportMock.mockReset();
  saveReportMock.mockReset();
});

describe("runAnalysis", () => {
  it("落 batch + analyze Run(done) + 透传 analyze 的成本", async () => {
    analyzeMock.mockImplementation(async (_t, _i, _w, recordCost) => {
      recordCost({ tokens: 100, amount: 0.05 });
      return mkBatch();
    });
    const batch = await runAnalysis(db, topic, [], win);
    expect(batch.id).toBe("b1");
    expect(getAnalysisBatch(db, "b1")?.insights).toHaveLength(1); // 真落库
    const run = listRuns(db, { kind: "analyze" }).find((r) => r.target.topic_id === "t1")!;
    expect(run.status).toBe("done");
    expect(run.cost?.amount).toBe(0.05); // ctx.recordCost → Run.cost
  });

  it("analyze 抛错 → runAnalysis reject + analyze Run 标 failed（失败传播）", async () => {
    analyzeMock.mockRejectedValue(new Error("boom"));
    await expect(runAnalysis(db, topic, [], win)).rejects.toThrow("boom");
    const run = listRuns(db, { kind: "analyze" })[0];
    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("boom");
  });
});

describe("runValidation", () => {
  it("落 validation + validate Run(done)，按 batch.id 关联", async () => {
    saveAnalysisBatch(db, mkBatch()); // 先落 batch（validation_result/citation_check 需 FK 到 batch/insight）
    validateBatchMock.mockResolvedValue(mkValidation());
    const vr = await runValidation(db, mkBatch(), []);
    expect(vr.report.releasable).toBe(true);
    expect(getValidationResult(db, "b1")?.report.pass).toBe(1); // 真落库
    const run = listRuns(db, { kind: "validate" }).find((r) => r.target.batch_id === "b1")!;
    expect(run.status).toBe("done");
  });
});

describe("runReportGen", () => {
  it("建报告 + report-gen Run(done)；buildReport 收到 batch+validation、saveReport 被调", async () => {
    buildReportMock.mockReturnValue({ report: mkReport(), index: mkReportIndex() });
    const batch = mkBatch();
    const validation = mkValidation();
    const report = await runReportGen(db, { topic, batch, validation, type: "brief" });
    expect(report.id).toBe("r1");
    expect(buildReportMock).toHaveBeenCalledWith(expect.objectContaining({ batch, validation, type: "brief" }));
    expect(saveReportMock).toHaveBeenCalledTimes(1);
    const run = listRuns(db, { kind: "report-gen" }).find((r) => r.target.batch_id === "b1")!;
    expect(run.status).toBe("done");
  });

  it("Daily Brief 从 initial_digest 读取已发布成功证据，并传给 buildReport 去重", async () => {
    seedPublishedInitialDigest("evt_cached", "ci1");
    buildReportMock.mockReturnValue({ report: mkReport(), index: mkReportIndex() });
    const batch = mkBatch();
    batch.insights[0].event_id = "evt_cached";

    await runReportGen(db, { topic, batch, validation: mkValidation(), type: "brief" });

    expect(buildReportMock).toHaveBeenCalledWith(expect.objectContaining({
      publishedEventEvidence: [expect.objectContaining({
        event_id: "evt_cached", content_item_ids: ["ci1"],
      })],
    }));
  });
});

describe("runTechLeadExtraction", () => {
  it("真实 batch + validation + DB content 接线后，只把 pass 证据持久化为线索", () => {
    insertSource(db, { id: "s1", name: "Source", type: "rss", endpoint: "https://x", topic_ids: [topic.id], fetch_interval: "6h", backfill: null, enabled: true } as Source);
    const content: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/ci1", title: "Agent tool", author: null, published_at: "2026-06-07T00:00:00Z", fetched_at: "2026-06-07T00:00:00Z", language: "en", topic_ids: [topic.id], tags: [], body: "q", body_kind: "article", raw_ref: "", content_hash: "h", fetch_status: "ok" };
    insertContentItem(db, content);
    const batch = mkBatch();
    batch.insights[0].headline = "Agent tool";
    batch.insights[0].tags = ["tool"];
    saveAnalysisBatch(db, batch); saveValidationResult(db, batch.id, mkValidation());
    const leads = runTechLeadExtraction(db, batch, mkValidation(), "2026-06-07T01:00:00Z");
    expect(leads).toHaveLength(1);
    expect(listTechLeads(db)[0]).toMatchObject({ topic_id: topic.id, title: "Agent tool" });
  });
});

describe("端到端编排", () => {
  it("runAnalysis → runValidation → runReportGen 串起来，3 个 Run 都 done、数据贯穿", async () => {
    analyzeMock.mockResolvedValue(mkBatch());
    validateBatchMock.mockResolvedValue(mkValidation());
    buildReportMock.mockReturnValue({ report: mkReport(), index: mkReportIndex() });

    const batch = await runAnalysis(db, topic, [], win);
    const validation = await runValidation(db, batch, []);
    const report = await runReportGen(db, { topic, batch, validation, type: "brief" });

    expect(report.insight_ids).toEqual(["i1"]); // 报告引到分析的洞察
    const kinds = listRuns(db, {}).map((r) => r.kind).sort();
    expect(kinds).toEqual(["analyze", "report-gen", "validate"]);
    expect(listRuns(db, {}).every((r) => r.status === "done")).toBe(true);
  });
});
