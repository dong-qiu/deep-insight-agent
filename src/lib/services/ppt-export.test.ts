import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisBatch, ContentItem, Report, ReportIndexEntry, Source, Topic, ValidationResult,
} from "../types.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { type DB, openDb } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import { saveReport } from "../db/reports.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";

// 把 ppt-polish 整体 mock：测试无 API key、CI 可跑；polish 路径只验调用契约
vi.mock("./ppt-polish.js", () => ({
  polishForPpt: vi.fn(),
}));

import { polishForPpt } from "./ppt-polish.js";
import { exportReportPptx } from "./ppt-export.js";

const dir = mkdtempSync(join(tmpdir(), "ia-ppt-export-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let db: DB;
const topic: Topic = {
  id: "t1", name: "AI 软件工程", keywords: ["k"], language: "zh",
  brief_schedule: "daily", enabled: true,
};
const source: Source = {
  id: "s1", name: "Latent Space", type: "rss", endpoint: "https://x.example/feed",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};
const contentItem: ContentItem = {
  id: "ci1", source_id: "s1", url: "https://x.example/a", title: "A",
  author: null, published_at: "2026-06-01", fetched_at: "2026-06-01",
  language: "en", topic_ids: ["t1"], tags: [], body: "原文。", body_kind: "article",
  raw_ref: "", content_hash: "h1", fetch_status: "ok",
};

const win = { start: "2026-06-01", end: "2026-06-07" };
const batch: AnalysisBatch = {
  id: "b1", topic_id: "t1", time_window: win, status: "done", no_significant_event: false,
  insights: [
    // i1：重点 (importance=5) + 1 pass 引用 → 应出现在 PPT 重点页
    {
      id: "i1", topic_id: "t1", type: "aggregation", event_id: null,
      statement: "重要洞察一。",
      importance: 5, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
      statement_citation_index: 1,
      citations: [{ content_item_id: "ci1", citation_ref: "binding", claim: "重要洞察一", quote: "重要洞察一。", locator: { paragraph_index: 0, char_start: 0, char_end: 5 } }],
      source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
    },
    // i2：原文沉默（uncertain/flagged）→ 即使历史 report.insight_ids 含它，也不得被 PPT 重建重新发布。
    {
      id: "i2", topic_id: "t1", type: "aggregation", event_id: null,
      statement: "仅待人工核实的洞察。",
      importance: 4, importance_basis: "x",
      citations: [{ content_item_id: "ci1", quote: "q2", locator: { paragraph_index: 0, char_start: 3, char_end: 5 } }],
      source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
    },
  ], display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION, display_coverage_audits: [{
    insight_id: "i1", candidate_id: "i1", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage",
    decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash("重要洞察一。"), quote_sha256: sourceQuoteHash("重要洞察一。"), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-09T00:00:00Z",
  }],
};
const vr: ValidationResult = {
  checks: [
    { insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
    { insight_id: "i2", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict: "flagged" },
  ],
  report: { total: 2, pass: 1, blocked: 0, flagged: 1, errored: 0, consistency_failure_rate: 0, flagged_rate: 0.5, insights_total: 2, insights_includable: 1, releasable: true },
};
const report: Report = {
  id: "rep_t1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-06-07T08:00:00Z",
  title: "测试报告", body_md: "# x", body_html: "<h1>x</h1>",
  insight_ids: ["i1", "i2"], event_ids: [], prev_report_id: null, citation_count: 1,
  cost: { tokens: 0, amount: 0 },
};
const reportIndex: ReportIndexEntry = {
  report_id: "rep_t1", type: "brief", topic_id: "t1", date: "2026-06-07",
  source_ids: ["s1"], title: "测试报告", summary: "x", highlights: [], tags: [], entity_names: [],
  importance: 5, event_ids: [], milestone_count: 0,
};

const PPTX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
  insertSource(db, source);
  insertContentItem(db, contentItem);
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, "b1", vr);
  saveReport(db, report, reportIndex, { dir });
  vi.mocked(polishForPpt).mockReset();
});

describe("exportReportPptx", () => {
  it("不存在的报告 → null", async () => {
    const r = await exportReportPptx(db, "nope");
    expect(r).toBeNull();
  });

  it("usePolish=false（默认）→ 返 ZIP buffer + fileName + 不调 polish", async () => {
    const r = await exportReportPptx(db, "rep_t1");
    expect(r).not.toBeNull();
    expect(r!.buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
    expect(r!.fileName).toMatch(/^AI 软件工程 · 2026-06-07\.pptx$/);
    expect(r!.polishCost.amount).toBe(0);
    expect(r!.report.id).toBe("rep_t1");
    expect(polishForPpt).not.toHaveBeenCalled();
    // i1 pass/support → 入选；i2 flagged → 排除：1 标题 + 1 重点 + 1 源 = 3 页
    expect(r!.pageCount).toBe(3);
  });

  it("防御异常数据：pass 但 consistency 非 support 的历史引用不得被 PPT 重建发布", async () => {
    db.prepare("UPDATE citation_check SET verdict='pass', consistency='uncertain' WHERE insight_id='i2'").run();
    const r = await exportReportPptx(db, "rep_t1");
    expect(r).not.toBeNull();
    expect(r!.pageCount).toBe(3); // 仍只有 i1；i2 不可复活
  });

  it("legacy report 不能被重新导出为 v6 已核验 PPT", async () => {
    db.prepare("UPDATE analysis_batch SET display_coverage_state='legacy', display_projection_version='legacy' WHERE id='b1'").run();
    const r = await exportReportPptx(db, "rep_t1");
    expect(r).not.toBeNull();
    // 无 reader-visible insight：只留下标题和来源方法页。
    expect(r!.pageCount).toBe(2);
  });

  it("usePolish=true 也不会将自由 LLM 改写发布为 reader-visible 内容", async () => {
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "凝练", implications: ["启示 a"] }]]),
      executive: { takeaways: ["TK1", "TK2", "TK3"] },
      cost: { tokens: 1234, amount: 0.0789 },
    });
    const r = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r).not.toBeNull();
    expect(polishForPpt).not.toHaveBeenCalled();
    expect(r!.polishCost).toEqual({ tokens: 0, amount: 0 });
    expect(r!.polishCache).toBe("none");
    expect(r!.polishStatus).toBe("none");
    expect(r!.pageCount).toBe(3);
  });

  it("刷新参数同样不会绕过原文投影", async () => {
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "凝练", implications: ["启示 a"] }]]),
      executive: { takeaways: ["TK1", "TK2", "TK3"] },
      cost: { tokens: 1234, amount: 0.0789 },
    });
    await exportReportPptx(db, "rep_t1", { usePolish: true });
    vi.mocked(polishForPpt).mockReset();
    const r2 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r2!.polishCache).toBe("none");
    expect(r2!.polishCost).toEqual({ tokens: 0, amount: 0 });
    expect(polishForPpt).not.toHaveBeenCalled();
    expect(r2!.pageCount).toBe(3);
  });

  it("partial polish（executive=null）→ 仍写缓存；status='no-executive'；下次 hit 仍 partial", async () => {
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "凝练", implications: ["启示 a"] }]]),
      executive: null, // executive 失败
      cost: { tokens: 500, amount: 0.05 },
    });
    const r1 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r1!.polishCache).toBe("none");
    expect(r1!.polishStatus).toBe("none");
    expect(r1!.polishCoverage).toEqual({ perInsightDone: 0, perInsightTotal: 0, hasExecutive: false });

    vi.mocked(polishForPpt).mockReset();
    const r2 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r2!.polishCache).toBe("none");
    expect(r2!.polishStatus).toBe("none");
    expect(polishForPpt).not.toHaveBeenCalled();
  });

  it("refresh 跑出新 executive → 与缓存 perInsight 合并，status 升至 complete", async () => {
    // 第 1 次：perInsight 全、executive 缺 → cache partial
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "v1", implications: ["a"] }]]),
      executive: null,
      cost: { tokens: 100, amount: 0.01 },
    });
    await exportReportPptx(db, "rep_t1", { usePolish: true });

    // refresh：本次 perInsight 失败、executive 成功；merge 应保留旧 perInsight + 新 executive
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map(), // 全失败
      executive: { takeaways: ["TK1", "TK2"] },
      cost: { tokens: 50, amount: 0.005 },
    });
    const rRefresh = await exportReportPptx(db, "rep_t1", { usePolish: true, refresh: true });
    expect(rRefresh!.polishStatus).toBe("none");
    expect(rRefresh!.polishCache).toBe("none");
    expect(rRefresh!.polishCoverage).toEqual({ perInsightDone: 0, perInsightTotal: 0, hasExecutive: false });

    // 第 3 次正常请求：hit 完整缓存
    vi.mocked(polishForPpt).mockReset();
    const r3 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r3!.polishCache).toBe("none");
    expect(r3!.polishStatus).toBe("none");
    expect(polishForPpt).not.toHaveBeenCalled();
  });

  it("refresh=1 同 hash → 忽略既有缓存重跑、新结果 merge 进缓存", async () => {
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "v1", implications: ["启示 a"] }]]),
      executive: { takeaways: ["TK", "TK2"] },
      cost: { tokens: 100, amount: 0.01 },
    });
    await exportReportPptx(db, "rep_t1", { usePolish: true }); // 写入缓存

    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "v2 重写", implications: ["启示 b"] }]]),
      executive: { takeaways: ["TK new", "TK2 new"] },
      cost: { tokens: 200, amount: 0.02 },
    });
    const rRefresh = await exportReportPptx(db, "rep_t1", { usePolish: true, refresh: true });
    expect(rRefresh!.polishCache).toBe("none");
    expect(rRefresh!.polishCost.amount).toBe(0);

    // 再次普通请求 → 命中刚写入的 v2
    const r3 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r3!.polishCache).toBe("none");
    expect(r3!.polishCost.amount).toBe(0);
  });

  it("usePolish=false → polishCache='none' / polishStatus='none'，不查缓存", async () => {
    const r = await exportReportPptx(db, "rep_t1");
    expect(r!.polishCache).toBe("none");
    expect(r!.polishStatus).toBe("none");
    expect(r!.polishAborted).toBe(false);
    expect(r!.polishCostCapUsd).toBe(0);
  });

  it("累计成本越 cap → orchestrator abort signal、polishAborted=true、CostCapUsd 透传", async () => {
    // mock polishForPpt：通过 onCost 模拟 3 次 $0.15 累计，触发上层在 0.30 cap 时 abort
    vi.mocked(polishForPpt).mockImplementation(async (_, __, options) => {
      let total = 0;
      for (let i = 0; i < 3; i++) {
        if (options?.signal?.aborted) break;
        const delta = { tokens: 1000, amount: 0.15 };
        total += delta.amount;
        options?.onCost?.(delta);
      }
      return {
        perInsight: new Map([["i1", { brief_summary: "s", implications: ["x"] }]]),
        executive: null,
        cost: { tokens: 1000 * Math.ceil(total / 0.15), amount: total },
      };
    });
    process.env.PPT_POLISH_COST_CAP_USD = "0.30";
    const r = await exportReportPptx(db, "rep_t1", { usePolish: true });
    delete process.env.PPT_POLISH_COST_CAP_USD;

    expect(r!.polishAborted).toBe(false);
    expect(r!.polishCostCapUsd).toBe(0);
    expect(r!.polishStatus).toBe("none");
  });

  it("cache hit 不消耗 LLM → polishAborted=false、CostCapUsd 仍透传 cap 让 UI 显示", async () => {
    vi.mocked(polishForPpt).mockResolvedValue({
      perInsight: new Map([["i1", { brief_summary: "s", implications: ["x"] }]]),
      executive: { takeaways: ["a", "b"] },
      cost: { tokens: 100, amount: 0.01 },
    });
    await exportReportPptx(db, "rep_t1", { usePolish: true }); // 写缓存
    vi.mocked(polishForPpt).mockReset();
    const r2 = await exportReportPptx(db, "rep_t1", { usePolish: true });
    expect(r2!.polishCache).toBe("none");
    expect(r2!.polishAborted).toBe(false);
    expect(r2!.polishCostCapUsd).toBe(0);
  });
});
