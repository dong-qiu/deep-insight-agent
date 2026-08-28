/** 管线编排集成测试（质量 Q4）：覆盖 pipeline.ts 的 runAnalysis/runValidation/runReportGen 接线——
 *  此前零测试。mock LLM agents（analyze/validateBatch）+ buildReport + FS/alert 副作用，
 *  保留**真 runJob + 真落库（内存 DB）**，验：Run 生命周期、跨阶段数据流、成本透传、失败传播。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalysisBatch, getValidationResult, saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { type DB, openDb } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic, listRuns } from "../db/repos.js";
import { listTechLeadEvidence, listTechLeads } from "../db/tech-leads.js";
import { createTopicDirection, listOpportunityLeads, listTechnologyOpportunities } from "../db/planning.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import { contentItemRef } from "../db/provenance-revisions.js";
import type { AnalysisBatch, ContentItem, Insight, Report, ReportIndexEntry, Source, Topic, ValidationResult } from "../types.js";

// vi.hoisted：vi.mock 工厂被提升到文件顶部，须用 hoisted 让 mock fns 在工厂运行时已初始化
const { analyzeMock, validateBatchMock, buildReportMock, saveReportMock, seedDefaultDirectionsMock, upsertTechnologyOpportunitiesMock } = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  validateBatchMock: vi.fn(),
  buildReportMock: vi.fn(),
  saveReportMock: vi.fn(),
  seedDefaultDirectionsMock: vi.fn(),
  upsertTechnologyOpportunitiesMock: vi.fn(),
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
vi.mock("../db/planning.js", async (orig) => {
  const actual = await orig<typeof import("../db/planning.js")>();
  return {
    ...actual,
    seedDefaultDirections: (...args: Parameters<typeof actual.seedDefaultDirections>) => {
      seedDefaultDirectionsMock(...args);
      return actual.seedDefaultDirections(...args);
    },
    upsertTechnologyOpportunities: (...args: Parameters<typeof actual.upsertTechnologyOpportunities>) => {
      upsertTechnologyOpportunitiesMock(...args);
      return actual.upsertTechnologyOpportunities(...args);
    },
  };
});
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

function seedConflictingContentRevision(item: ContentItem): void {
  const ref = contentItemRef(item);
  captureRevision(db, {
    entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision,
    snapshot: { url: item.url, source_id: item.source_id, published_at: item.published_at, body_length: item.body.length + 1, content_hash: item.content_hash },
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
  analyzeMock.mockReset();
  validateBatchMock.mockReset();
  buildReportMock.mockReset();
  saveReportMock.mockReset();
  seedDefaultDirectionsMock.mockReset();
  upsertTechnologyOpportunitiesMock.mockReset();
});

describe("runAnalysis", () => {
  it("trace 模式为真实输入与 batch 输出追加最小溯源事实", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    const source: Source = { id: "s1", name: "S", type: "rss", endpoint: "https://x", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    insertSource(db, source);
    const item: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/a", title: "A", author: null, published_at: null, fetched_at: "2026-06-07T00:00:00Z", language: "zh", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw", content_hash: "hash_ci1", fetch_status: "ok" };
    insertContentItem(db, item);
    analyzeMock.mockResolvedValue(mkBatch());
    await runAnalysis(db, topic, [item], win, { traceId: "trace_1" });
    expect(db.prepare("SELECT stage,event_type FROM generation_event ORDER BY sequence").all()).toEqual([
      { stage: "analyze", event_type: "started" }, { stage: "analyze", event_type: "completed" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provenance_revision").get()).toEqual({ count: 2 });
  });

  it("历史 content-v2 元数据冲突不阻塞 content-v3 分析恢复", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-08-28T05:00:00Z')`).run();
    const source: Source = { id: "s_first", name: "First", type: "rss", endpoint: "https://first/feed", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    insertSource(db, source);
    const item: ContentItem = { id: "ci_shared", source_id: source.id, url: "https://shared.example/article", title: "A", author: null, published_at: "2026-08-26T11:00:00.000Z", fetched_at: "2026-08-28T05:00:00.000Z", language: "zh", topic_ids: ["t1"], tags: [], body: "current body", body_kind: "article", raw_ref: "raw", content_hash: "hash_current", fetch_status: "ok" };
    insertContentItem(db, item);
    const legacyRef: EntityRef = { type: "content_item", locator: { kind: "id", id: item.id }, revision: `content-v2:${item.content_hash}`, role: "input" };
    captureRevision(db, {
      entity_type: legacyRef.type, entity_key: entityKey(legacyRef), revision: legacyRef.revision,
      snapshot: { url: item.url, source_id: "s_second", published_at: "2026-08-26T14:00:00.000Z", body_length: item.body.length, content_hash: item.content_hash },
    });
    analyzeMock.mockResolvedValue(mkBatch());

    await expect(runAnalysis(db, topic, [item], win, { traceId: "trace_1" })).resolves.toMatchObject({ id: "b1" });
    const currentRef = contentItemRef(item);
    expect(db.prepare("SELECT 1 FROM provenance_revision WHERE entity_type=? AND entity_key=? AND revision=?")
      .get(currentRef.type, entityKey(currentRef), currentRef.revision)).toBeTruthy();
    expect(db.prepare("SELECT stage,event_type FROM generation_event ORDER BY sequence").all()).toEqual([
      { stage: "analyze", event_type: "started" }, { stage: "analyze", event_type: "completed" },
    ]);
  });

  it("同一正文被重复抓取时，fetched_at 变化不改变 content-v3 revision", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_2','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-08T00:00:00Z')`).run();
    const source: Source = { id: "s1", name: "S", type: "rss", endpoint: "https://x", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    insertSource(db, source);
    const item: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/a", title: "A", author: null, published_at: null, fetched_at: "2026-06-07T00:00:00Z", language: "zh", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw", content_hash: "hash_ci1", fetch_status: "ok" };
    insertContentItem(db, item);
    // 生产已有的 v1 快照带 fetched_at；v3 必须新建稳定 revision，而非覆盖旧事实。
    const legacyRef: EntityRef = { type: "content_item", locator: { kind: "id", id: item.id }, revision: item.content_hash, role: "input" };
    captureRevision(db, {
      entity_type: legacyRef.type, entity_key: entityKey(legacyRef), revision: legacyRef.revision,
      snapshot: { url: item.url, source_id: item.source_id, fetched_at: item.fetched_at, published_at: item.published_at, body_length: item.body.length, content_hash: item.content_hash },
    });
    analyzeMock
      .mockResolvedValueOnce(mkBatch())
      .mockResolvedValueOnce({ ...mkBatch(), id: "b2", insights: [mkInsight("i2")] });

    await runAnalysis(db, topic, [item], win, { traceId: "trace_1" });
    const refetched = { ...item, fetched_at: "2026-06-08T00:00:00Z" };
    await runAnalysis(db, topic, [refetched], win, { traceId: "trace_2" });

    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT revision,snapshot FROM provenance_revision WHERE entity_type='content_item' ORDER BY revision").all()).toEqual([
      {
        revision: contentItemRef(item).revision,
        snapshot: JSON.stringify({ body_length: 4, content_hash: "hash_ci1", published_at: null, source_id: "s1", url: "https://x/a" }),
      },
      {
        revision: "hash_ci1",
        snapshot: JSON.stringify({ body_length: 4, content_hash: "hash_ci1", fetched_at: "2026-06-07T00:00:00Z", published_at: null, source_id: "s1", url: "https://x/a" }),
      },
    ]);
  });

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

  it("外部分析返回前若 worker 已失去 fencing，结果不得落库", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    let writable = true;
    analyzeMock.mockImplementation(async () => {
      writable = false; // 模拟外部 LLM 返回前 lease 已被新 worker 接管
      return mkBatch();
    });
    await expect(runAnalysis(db, topic, [], win, { traceId: "trace_1", assertWrite: () => {
      if (!writable) throw new Error("generation_fence_lost");
    } })).rejects.toThrow("generation_fence_lost");
    expect(getAnalysisBatch(db, "b1")).toBeNull();
    expect(db.prepare("SELECT stage,event_type FROM generation_event ORDER BY sequence").all()).toEqual([
      { stage: "analyze", event_type: "started" },
    ]);
  });

  it("输入 revision 冲突时追加失败事件；快照原子回滚且重试幂等", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    const source: Source = { id: "s1", name: "S", type: "rss", endpoint: "https://x", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    insertSource(db, source);
    const item: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/a", title: "A", author: null, published_at: null, fetched_at: "2026-06-07T00:00:00Z", language: "zh", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw", content_hash: "hash_ci1", fetch_status: "ok" };
    const newItem: ContentItem = { ...item, id: "ci2", url: "https://x/b", content_hash: "hash_ci2" };
    insertContentItem(db, item);
    insertContentItem(db, newItem);
    seedConflictingContentRevision(item);

    await expect(runAnalysis(db, topic, [newItem, item], win, { traceId: "trace_1" })).rejects.toThrow("provenance_revision_conflict");
    await expect(runAnalysis(db, topic, [newItem, item], win, { traceId: "trace_1" })).rejects.toThrow("provenance_revision_conflict");

    expect(analyzeMock).not.toHaveBeenCalled();
    expect(getAnalysisBatch(db, "b1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM provenance_revision").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT stage,event_type,error FROM generation_event ORDER BY sequence").all()).toEqual([
      { stage: "analyze", event_type: "started", error: null },
      { stage: "analyze", event_type: "failed", error: '{"reason_code":"provenance_revision_conflict"}' },
    ]);
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: "failed" });
  });
});

describe("runValidation", () => {
  it("落 validation + validate Run(done)，按 batch.id 关联", async () => {
    applyProvenanceMigrations(db);
    const source: Source = { id: "s1", name: "S", type: "rss", endpoint: "https://x", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    const item: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/a", title: "A", author: null, published_at: null, fetched_at: "2026-06-07T00:00:00.000Z", language: "zh", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw", content_hash: "hash_ci1", fetch_status: "ok" };
    insertSource(db, source); insertContentItem(db, item);
    saveAnalysisBatch(db, mkBatch()); // 先落 batch（validation_result/citation_check 需 FK 到 batch/insight）
    validateBatchMock.mockResolvedValue(mkValidation());
    const vr = await runValidation(db, mkBatch(), [item]);
    expect(vr.report.releasable).toBe(true);
    expect(getValidationResult(db, "b1")?.report.pass).toBe(1); // 真落库
    const run = listRuns(db, { kind: "validate" }).find((r) => r.target.batch_id === "b1")!;
    expect(run.status).toBe("done");
    expect(db.prepare("SELECT COUNT(*) AS count FROM funnel_event WHERE stage='validated'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM validator_result_fact WHERE validator='citation'").get()).toEqual({ count: 1 });
  });

  it("输入 revision 冲突时追加可审计失败事件，不调用校验器", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    const source: Source = { id: "s1", name: "S", type: "rss", endpoint: "https://x", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
    insertSource(db, source);
    const item: ContentItem = { id: "ci1", source_id: "s1", url: "https://x/a", title: "A", author: null, published_at: null, fetched_at: "2026-06-07T00:00:00Z", language: "zh", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw", content_hash: "hash_ci1", fetch_status: "ok" };
    insertContentItem(db, item);
    seedConflictingContentRevision(item);

    await expect(runValidation(db, mkBatch(), [item], { traceId: "trace_1" })).rejects.toThrow("provenance_revision_conflict");

    expect(validateBatchMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT stage,event_type,error FROM generation_event ORDER BY sequence").all()).toEqual([
      { stage: "validate", event_type: "started", error: null },
      { stage: "validate", event_type: "failed", error: '{"reason_code":"provenance_revision_conflict"}' },
    ]);
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: "failed" });
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

  it("trace 记录日报选择漏斗，较早未发布 event 的补充发现与主通道过滤可审计", async () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    buildReportMock.mockReturnValue({ report: mkReport(), index: mkReportIndex() });
    saveReportMock.mockImplementation((_db, _report, _index, hooks) => hooks?.afterPublish?.());
    const freshness = { since: "2026-06-06T00:00:00Z", content_item_ids: ["ci_new"], freshest_candidate_at: "2026-06-07T00:00:00Z" };
    const batch = mkBatch();
    batch.insights[0].event_id = "event_unpublished";

    await runReportGen(db, { topic, batch, validation: mkValidation(), type: "brief", traceId: "trace_1", briefFreshness: freshness });

    const event = db.prepare(`SELECT reason_code,metrics FROM generation_event
      WHERE trace_id='trace_1' AND stage='generate_report' AND event_type='completed'`).get() as { reason_code: string | null; metrics: string };
    expect(event.reason_code).toBeNull();
    expect(JSON.parse(event.metrics)).toMatchObject({
      includable_insight_count: 1, freshness_filtered_insight_count: 1,
      supplemental_candidate_count: 1, supplemental_published_insight_count: 1,
      published_insight_count: 1, published_citation_count: 1,
    });
  });

  it("非空但无可放行洞察：report-gen Run 失败，并保留不可公开的 failed Report", async () => {
    const validation = mkValidation();
    validation.report.releasable = false;
    validation.report.insights_includable = 0;

    await expect(runReportGen(db, { topic, batch: mkBatch(), validation, type: "brief" }))
      .rejects.toThrow("no_releasable_insight");
    expect(buildReportMock).not.toHaveBeenCalled();
    expect(listRuns(db, { kind: "report-gen" })[0]?.status).toBe("failed");
    expect(db.prepare("SELECT status FROM report").all()).toEqual([{ status: "failed" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM report_index").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM report_fts").get()).toEqual({ count: 0 });
  });
});

describe("runTechLeadExtraction", () => {
  function seedLeadInput(): { batch: AnalysisBatch; validation: ValidationResult } {
    insertSource(db, { id: "s1", name: "Source", type: "rss", endpoint: "https://x", topic_ids: [topic.id], fetch_interval: "6h", backfill: null, enabled: true } as Source);
    insertContentItem(db, { id: "ci1", source_id: "s1", url: "https://x/ci1", title: "Agent tool", author: null, published_at: "2026-06-07T00:00:00Z", fetched_at: "2026-06-07T00:00:00Z", language: "en", topic_ids: [topic.id], tags: [], body: "q", body_kind: "article", raw_ref: "", content_hash: "h", fetch_status: "ok" });
    const batch = mkBatch();
    batch.insights[0].headline = "Agent tool";
    batch.insights[0].tags = ["tool"];
    const validation = mkValidation();
    saveAnalysisBatch(db, batch); saveValidationResult(db, batch.id, validation);
    return { batch, validation };
  }

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
    const [opportunity] = listTechnologyOpportunities(db);
    // t1 没有默认方向档案：高价值技术线索只能作为 horizon 供人工校准，不伪装成方向内项目。
    expect(opportunity).toMatchObject({ lane: "horizon", direction_id: null });
    const [linkedLead] = listOpportunityLeads(db, opportunity.id);
    expect(linkedLead.id).toBe(leads[0].id);
    expect(listTechLeadEvidence(db, linkedLead.id)).toMatchObject([{ url: "https://x/ci1", quote: "q" }]);
  });

  it("机会写入失败只标记 derive_opportunity.failed，不反写已完成的方向映射", () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    const { batch, validation } = seedLeadInput();
    upsertTechnologyOpportunitiesMock.mockImplementationOnce(() => { throw new Error("opportunity write failed"); });

    expect(runTechLeadExtraction(db, batch, validation, "2026-06-07T01:00:00Z", { traceId: "trace_1" })).toHaveLength(1);
    expect(db.prepare("SELECT stage,event_type FROM generation_event WHERE stage IN ('map_direction','derive_opportunity') ORDER BY sequence").all()).toEqual([
      { stage: "map_direction", event_type: "started" },
      { stage: "map_direction", event_type: "completed" },
      { stage: "derive_opportunity", event_type: "started" },
      { stage: "derive_opportunity", event_type: "failed" },
    ]);
  });

  it("方向映射失败不会开始机会写入", () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    const { batch, validation } = seedLeadInput();
    seedDefaultDirectionsMock.mockImplementationOnce(() => { throw new Error("direction seed failed"); });

    expect(runTechLeadExtraction(db, batch, validation, "2026-06-07T01:00:00Z", { traceId: "trace_1" })).toHaveLength(1);
    expect(upsertTechnologyOpportunitiesMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT stage,event_type FROM generation_event WHERE stage IN ('map_direction','derive_opportunity') ORDER BY sequence").all()).toEqual([
      { stage: "map_direction", event_type: "started" },
      { stage: "map_direction", event_type: "failed" },
    ]);
  });

  it("将新机会作为 Trace 输出，并冻结其 Lead 与方向 revision", () => {
    applyProvenanceMigrations(db);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-06-07T00:00:00Z')`).run();
    createTopicDirection(db, {
      id: "direction_1", topic_id: topic.id, name: "Agent", objective: "O", problem_statement: "P",
      in_scope: [], out_of_scope: [], key_questions: [], constraints: [], success_signals: [],
      match_terms: ["agent"], adjacent_terms: [], challenge_terms: [], horizon: "now", status: "active",
    }, "2026-06-07T00:00:00Z");
    const { batch, validation } = seedLeadInput();
    runTechLeadExtraction(db, batch, validation, "2026-06-07T01:00:00Z", { traceId: "trace_1" });
    expect(db.prepare(`SELECT DISTINCT entity_type FROM generation_entity_ref
      WHERE trace_id='trace_1' AND role='output' ORDER BY entity_type`).all()).toEqual([
      { entity_type: "tech_lead" }, { entity_type: "technology_opportunity" },
    ]);
    expect(db.prepare(`SELECT DISTINCT entity_type FROM generation_entity_ref
      WHERE trace_id='trace_1' AND role='input' ORDER BY entity_type`).all()).toEqual([
      { entity_type: "analysis_batch" }, { entity_type: "tech_lead" }, { entity_type: "topic_direction" },
    ]);
    expect(db.prepare(`SELECT entity_type,COUNT(*) AS count FROM provenance_revision
      WHERE entity_type IN ('tech_lead','topic_direction','technology_opportunity') GROUP BY entity_type ORDER BY entity_type`).all()).toEqual([
      { entity_type: "tech_lead", count: 1 }, { entity_type: "technology_opportunity", count: 1 }, { entity_type: "topic_direction", count: 1 },
    ]);
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
