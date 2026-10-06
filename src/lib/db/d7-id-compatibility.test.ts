import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupQA, Report, ReportIndexEntry, Run, Topic } from "../types.js";
import { retryJob, runJob } from "../runtime/jobs.js";
import { contentItemId } from "../sources/normalize.js";
import { deriveOpportunityCandidates } from "../agents/opportunity-planning.js";
import { listFollowups, saveFollowup } from "./followup.js";
import { openDb, type DB } from "./index.js";
import { upsertTechnologyOpportunities } from "./planning.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { getRun, insertRun, insertTopic, listRuns } from "./repos.js";
import { getReport, listReportIndex, previousReportForTopic, saveFailedReport, saveReport, searchReports } from "./reports.js";
import { upsertTechLeads } from "./tech-leads.js";
import { deterministicUuidV5 } from "./uuid.js";

// D7 owns this file. Fixed legacy/long values deliberately use the unchanged
// baseline readers before touching any generator; no existing fixture is renumbered.
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn() }));
const legacyReportId = "rep_a1b2c3d4";
const longReportId = "rep_0123456789abcdef0123456789abcdef";
const legacyRunId = "run_a1b2c3d4";
const longRunId = "run_0123456789abcdef0123456789abcdef";
const topic: Topic = { id: "t_d7_legacy", name: "D7 synthetic", keywords: ["synthetic"], language: "en", brief_schedule: "daily", enabled: true };
let db: DB;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertTopic(db, topic);
  dir = mkdtempSync(join(tmpdir(), "ia-d7-compat-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function report(id: string, previous: string | null = null): Report {
  return {
    id, type: "brief", topic_id: topic.id, status: "done", generated_at: "2026-10-01T00:00:00Z",
    title: "D7 synthetic report", body_md: "# D7 synthetic report\n", body_html: "<h1>D7 synthetic report</h1>",
    insight_ids: [], event_ids: [], prev_report_id: previous, citation_count: 0, cost: { tokens: 0, amount: 0 },
  };
}
function index(value: Report): ReportIndexEntry {
  return {
    report_id: value.id, type: value.type, topic_id: value.topic_id, date: "2026-10-01", source_ids: [],
    title: value.title, summary: "synthetic", highlights: [], tags: [], entity_names: [], importance: 0,
    event_ids: [], milestone_count: 0,
  };
}
function run(id: string, status: Run["status"] = "running"): Run {
  return { id, kind: "ingest", target: {}, status, started_at: "2026-10-01T00:00:00Z", ended_at: null,
    duration_ms: null, cost: null, error: null, retry_of: null, trace_id: null };
}
function qa(id: string, reportId: string): FollowupQA {
  return { id, report_id: reportId, thread_id: id, turn_index: 0, question: "Synthetic question?", answer_md: "Synthetic answer.",
    citations_used: [], validation: { total: 0, reachable: 0, consistent: 0, blocked: 0, errored: 0 }, cost: { tokens: 0, amount: 0 },
    status: "done", created_at: "2026-10-01T00:00:00Z" };
}

describe("D7 baseline opaque-ID compatibility", () => {
  it("unchanged readers round-trip mixed report IDs, exact files, index/FTS and previous association", async () => {
    const old = report(legacyReportId);
    const next = { ...report(longReportId, old.id), generated_at: "2026-10-02T00:00:00Z" };
    await saveReport(db, old, index(old), { dir });
    await saveReport(db, next, index(next), { dir });
    for (const value of [old, next]) {
      expect(getReport(db, value.id)).toEqual(value);
      expect(readFileSync(join(dir, `${value.id}.md`), "utf8")).toBe(value.body_md);
      expect(readFileSync(join(dir, `${value.id}.html`), "utf8")).toBe(value.body_html);
      const effect = db.prepare("SELECT report_id,idempotency_key,artifact_manifest,status FROM generation_effect WHERE report_id=?").get(value.id);
      expect(effect).toMatchObject({ report_id: value.id, idempotency_key: `report_file:${value.id}`, status: "committed" });
    }
    expect(new Set(listReportIndex(db).map((value) => value.report_id))).toEqual(new Set([old.id, next.id]));
    expect(new Set(searchReports(db, "synthetic"))).toEqual(new Set([old.id, next.id]));
    expect(previousReportForTopic(db, topic.id, "brief")).toBe(next.id);
    expect(getReport(db, "rep_a1b2c3d4_wrong")).toBeNull();
    expect(getReport(db, next.id)?.prev_report_id).toBe(old.id);
  });

  it("failed reports retain explicit old/long IDs and never acquire reader artifacts or index", () => {
    for (const id of [legacyReportId, longReportId]) {
      expect(saveFailedReport(db, { ...report(id), reasonCode: "synthetic_failure" })).toBe(id);
      expect(getReport(db, id)).toBeNull();
      expect(db.prepare("SELECT id,status,body_path FROM report WHERE id=?").get(id)).toEqual({ id, status: "failed", body_path: null });
      expect(() => saveFailedReport(db, { ...report(id), reasonCode: "again" })).toThrow(/UNIQUE/);
    }
    expect(listReportIndex(db)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM generation_effect").get()).toEqual({ n: 0 });
  });

  it("mixed Run IDs are reused exactly; retry links to old failed Run without changing it", async () => {
    insertRun(db, run(legacyRunId, "failed"));
    insertRun(db, run(longRunId));
    const finished = await runJob(db, { kind: "ingest", target: {}, existingRunId: longRunId }, async (ctx) => ctx.runId);
    expect(finished.result).toBe(longRunId);
    expect(finished.run.id).toBe(longRunId);
    expect(listRuns(db)).toHaveLength(2);
    const retried = await retryJob(db, legacyRunId, async () => "synthetic");
    expect(retried.run.retry_of).toBe(legacyRunId);
    expect(getRun(db, legacyRunId)).toMatchObject({ id: legacyRunId, status: "failed" });
    expect(new Set(listRuns(db).map((value) => value.id)).size).toBe(3);
    expect(() => insertRun(db, run(longRunId))).toThrow(/UNIQUE/);
  });

  it("QA/thread stays associated across old/new report formats, including duplicate/FK failures", async () => {
    for (const id of [legacyReportId, longReportId]) await saveReport(db, report(id), index(report(id)), { dir });
    const values = [qa("fup_a1b2c3d4", longReportId), qa("fup_0123456789abcdef0123456789abcdef", legacyReportId)];
    for (const value of values) {
      saveFollowup(db, value);
      expect(listFollowups(db, value.report_id)).toEqual([value]);
      expect(() => saveFollowup(db, value)).toThrow(/UNIQUE/);
    }
    expect(() => saveFollowup(db, qa("fup_bad_report", "rep_missing"))).toThrow(/FOREIGN KEY/);
    expect(listFollowups(db, "rep_missing")).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM followup_qa").get()).toEqual({ n: 2 });
  });

  it("canonical Lead/Opportunity updates preserve manually persisted legacy identities and links", () => {
    const candidate = { topic_id: topic.id, canonical_key: "event:legacy", kind: "benchmark" as const,
      title: "Synthetic lead", summary: "Synthetic", evidence: [], observed_at: "2026-10-01T00:00:00Z", score: 80,
      score_detail: { freshness: 30, evidence: 20, importance: 20, relevance: 10, total: 80, reason: "Synthetic" } };
    // Insert historical fixtures directly, never generate and then renumber an object.
    db.prepare(`INSERT INTO tech_lead(id,topic_id,canonical_key,kind,title,summary,status,score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
      VALUES (?, ?, ?, 'benchmark', ?, ?, 'watching', 80, ?, ?, ?, ?)`).run("lead_a1b2c3d4-e5f", topic.id, candidate.canonical_key,
      candidate.title, candidate.summary, JSON.stringify(candidate.score_detail), candidate.observed_at, candidate.observed_at, candidate.observed_at);
    const [lead] = upsertTechLeads(db, [candidate]);
    expect(lead).toMatchObject({ id: "lead_a1b2c3d4-e5f", status: "watching", canonical_key: candidate.canonical_key });
    const [opportunityCandidate] = deriveOpportunityCandidates([lead], [], "2026-10-02T00:00:00Z");
    expect(opportunityCandidate.canonical_key).toBe(`horizon:lead:${lead.id}`);
    db.prepare(`INSERT INTO technology_opportunity(id,topic_id,canonical_key,lane,planning_effect,title,hypothesis,proposed_validation,uncertainties,status,priority_score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
      VALUES (?, ?, ?, 'horizon', 'new_direction', 'Synthetic', 'Synthetic', 'Synthetic', '[]', 'research_candidate', 50, ?, ?, ?, ?)`)
      .run("opp_a1b2c3d4-e5f", topic.id, opportunityCandidate.canonical_key, JSON.stringify(opportunityCandidate.score_detail), candidate.observed_at, candidate.observed_at, candidate.observed_at);
    const [opportunity] = upsertTechnologyOpportunities(db, [opportunityCandidate], new Map([[lead.id, lead]]));
    expect(opportunity).toMatchObject({ id: "opp_a1b2c3d4-e5f", status: "research_candidate", canonical_key: opportunityCandidate.canonical_key });
    expect(db.prepare("SELECT opportunity_id,lead_id FROM opportunity_lead").all()).toEqual([{ opportunity_id: opportunity.id, lead_id: lead.id }]);
  });

  it("deterministic URL and UUIDv5 identity have frozen values and same-input stability", () => {
    expect(contentItemId("https://example.test/item")).toBe("ci_79a70df1c6587c7d");
    expect(contentItemId("https://example.test/item#fragment")).toBe("ci_79a70df1c6587c7d");
    expect(deterministicUuidV5("www.widgets.com")).toBe("21f7f8de-8051-5b89-8680-0195ef798b6a");
    expect(deterministicUuidV5("d7:stable")).toBe(deterministicUuidV5("d7:stable"));
  });
});
