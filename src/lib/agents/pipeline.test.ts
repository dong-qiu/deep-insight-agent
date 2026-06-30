/** 管线编排集成测试（质量 Q4）：覆盖 pipeline.ts 的 runAnalysis/runValidation/runReportGen 接线——
 *  此前零测试。mock LLM agents（analyze/validateBatch）+ buildReport + FS/alert 副作用，
 *  保留**真 runJob + 真落库（内存 DB）**，验：Run 生命周期、跨阶段数据流、成本透传、失败传播。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalysisBatch, getValidationResult, saveAnalysisBatch } from "../db/analysis.js";
import { type DB, openDb } from "../db/index.js";
import { insertTopic, listRuns } from "../db/repos.js";
import type { AnalysisBatch, Insight, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";

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

import { runAnalysis, runReportGen, runValidation } from "./pipeline.js";

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
function mkValidation(): ValidationResult {
  return {
    checks: [{
      insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok",
      consistency: "support", consistency_reason: "ok", verdict: "pass",
    }],
    report: {
      total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0,
      consistency_failure_rate: 0, flagged_rate: 0,
      insights_total: 1, insights_includable: 1, releasable: true,
    },
  };
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
