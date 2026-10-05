/** Real worker/scheduler/pipeline/Jobs/DB, synthetic agents and isolated archive. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { createScheduledTraceRequest } from "../db/provenance.js";
import { insertContentItem, insertSource, insertTopic, listRuns } from "../db/repos.js";
import { getAnalysisBatch, getValidationResult } from "../db/analysis.js";
import { planRawArchive, writePlannedRawArchive } from "../db/raw-archive.js";
import { contentHash } from "../sources/normalize.js";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";
import { runPipelineForTopic } from "./scheduler.js";
import { runAnalysis } from "./pipeline.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry-sqlite.js";
import { notifyReport, notifyFailure } from "../runtime/alert.js";
import type { AnalysisBatch, ContentItem, Cost, Topic, ValidationResult } from "../types.js";
const { analyze, validateBatch } = vi.hoisted(() => ({ analyze: vi.fn(), validateBatch: vi.fn() }));
vi.mock("./analyzer.js", async (original) => ({ ...await original<typeof import("./analyzer.js")>(), analyze }));
vi.mock("./validator.js", async (original) => ({ ...await original<typeof import("./validator.js")>(), validateBatch }));
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn(), notifyReport: vi.fn(), notifyBudget: vi.fn(), notifyThinBrief: vi.fn(), notifyBriefAcceptance: vi.fn() }));
let db: DB; let dir: string; let item: ContentItem;
const topic: Topic = { id: "synthetic", name: "Synthetic", keywords: ["Agent"], facets: [], language: "en", enabled: true, brief_schedule: "daily" };
const batch: AnalysisBatch = { id: "synthetic-batch", topic_id: topic.id, time_window: { start: "2026-01-01", end: "2026-12-31" }, status: "done", no_significant_event: true, insights: [] };
const validation: ValidationResult = { checks: [], report: { total: 0, pass: 0, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 0, insights_includable: 0, releasable: true } };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ia-c2b-pipeline-")); vi.stubEnv("DATA_DIR", dir); vi.stubEnv("ANALYSIS_CACHE", "0");
  vi.stubEnv("INTEGRITY_ANCHOR_ENABLED", "0"); vi.stubEnv("COST_LIMIT_TASK", undefined);
  vi.stubEnv("COST_LIMIT_DAILY", undefined); vi.stubEnv("COST_LIMIT_MONTHLY", undefined);
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertTopic(db, topic);
  insertSource(db, { id: "source", name: "synthetic", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true });
  const body = "Agent synthetic evidence.";
  item = { id: "item", source_id: "source", url: "https://example.test/item", title: "Agent", body, body_kind: "article", author: null, published_at: new Date().toISOString(), fetched_at: new Date().toISOString(), language: "en", topic_ids: [topic.id], tags: [], raw_ref: "", content_hash: contentHash(body), fetch_status: "ok" };
  insertContentItem(db, item);
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: body, source_body_kind: "article", source_item_raw: "synthetic", structured_body_sha256: contentHash(body) });
  const archive = planRawArchive(db, { contentId: item.id, raw }); writePlannedRawArchive(db, archive, raw); item.raw_ref = archive.rawRef;
  analyze.mockReset(); validateBatch.mockReset(); vi.mocked(notifyReport).mockClear(); vi.mocked(notifyFailure).mockClear();
  analyze.mockImplementation(async (_topic, _items, _window, recordCost: (cost: Cost) => void) => { recordCost({ tokens: 10, amount: 1 }); return structuredClone(batch); });
  validateBatch.mockImplementation(async (_insights, _items, recordCost: (cost: Cost) => void) => { recordCost({ tokens: 10, amount: 1 }); return structuredClone(validation); });
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function accept() {
  const accepted = createScheduledTraceRequest(db, { topicId: topic.id, reportType: "brief", period: "synthetic", windowHours: 24, items: 1 });
  if (accepted.kind !== "accepted") throw new Error("synthetic acceptance failed");
  return accepted.traceId;
}
it("standalone runAnalysis budget rejects uncommitted business results but retains Run cost", async () => {
  await expect(runAnalysis(db, topic, [item], batch.time_window, { taskBudgetUsd: 1 })).rejects.toThrow("task_budget_exceeded");
  expect(getAnalysisBatch(db, batch.id)).toBeNull();
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", cost: { amount: 1 }, error: { message: "task_budget_exceeded" } });
});
it("manual single-topic task shares the cap across real stage Jobs and preserves its committed analysis", async () => {
  // Legacy daily/monthly manual advisory remains independent of the explicit task cap.
  vi.stubEnv("COST_LIMIT_DAILY", "0.1");
  await expect(runPipelineForTopic(db, topic.id, { taskBudgetUsd: 1.5 })).rejects.toThrow("task_budget_exceeded");
  expect(analyze).toHaveBeenCalledTimes(1); expect(validateBatch).toHaveBeenCalledTimes(1);
  expect(getAnalysisBatch(db, batch.id)).not.toBeNull(); expect(getValidationResult(db, batch.id)).toBeNull();
  expect(listRuns(db).map((run) => [run.kind, run.status, run.cost?.amount])).toEqual(expect.arrayContaining([["analyze", "done", 1], ["validate", "failed", 1]]));
  expect(db.prepare("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 }); expect(notifyReport).not.toHaveBeenCalled();
});
it.each([false, true])("worker env cap with P1=%s preserves original projections and fixed nonretryable trace reason", async (p1) => {
  vi.stubEnv("COST_LIMIT_TASK", "1.5"); const traceId = accept();
  expect(await runGenerationDispatchOnce(db, undefined, p1 ? { telemetry: SQLITE_P1_TELEMETRY_SINK } : {})).toMatchObject({ claimed: true, status: "failed", traceId });
  const row = db.prepare("SELECT last_error FROM generation_dispatch WHERE trace_id=?").get(traceId) as { last_error: string };
  expect(JSON.parse(row.last_error)).toEqual({ reason_code: "task_budget_exceeded", message: "task_budget_exceeded", retryable: false });
  expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(traceId)).toEqual({ status: "failed" });
  expect(db.prepare("SELECT error FROM generation_event WHERE trace_id=? AND stage='validate' AND event_type='failed'").get(traceId)).toEqual({ error: '{"reason_code":"task_budget_exceeded"}' });
  expect(getAnalysisBatch(db, batch.id)).not.toBeNull(); expect(getValidationResult(db, batch.id)).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM cost_ledger").get()).toEqual({ n: p1 ? 1 : 0 });
  expect(notifyReport).not.toHaveBeenCalled();
  expect(notifyFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "task_budget_exceeded" }));
});
it("unconfigured worker preserves the normal pipeline, including report publication", async () => {
  const traceId = accept();
  expect(await runGenerationDispatchOnce(db)).toMatchObject({ status: "done", traceId });
  expect(getAnalysisBatch(db, batch.id)).not.toBeNull(); expect(getValidationResult(db, batch.id)).not.toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM report WHERE status='done'").get()).toEqual({ n: 1 });
});
it("invalid env is rejected before claim; explicit valid runtime option takes precedence", async () => {
  vi.stubEnv("COST_LIMIT_TASK", "synthetic-private-value"); const traceId = accept();
  await expect(runGenerationDispatchOnce(db)).rejects.toThrow("invalid_task_budget");
  expect(db.prepare("SELECT state FROM generation_dispatch WHERE trace_id=?").get(traceId)).toEqual({ state: "queued" });
  expect(await runGenerationDispatchOnce(db, undefined, { taskBudgetUsd: 0 })).toMatchObject({ status: "failed" });
  expect(analyze).not.toHaveBeenCalled();
});
