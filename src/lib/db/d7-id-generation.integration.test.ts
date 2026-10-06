import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisBatch, ContentItem, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";
import type { DB } from "./index.js";

const state = vi.hoisted(() => ({ db: undefined as DB | undefined }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes), randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock("./index.js", async (original) => ({ ...await original<typeof import("./index.js")>(), getDb: () => state.db! }));
vi.mock("../auth-guard.js", () => ({ forbidNonAdmin: vi.fn(async () => null), requireAdminActor: vi.fn() }));
vi.mock("../runtime/llm.js", () => ({
  MODELS: { analyzer: "synthetic-analyzer", validator: "synthetic-validator", followup: "synthetic-followup" },
  callStructured: vi.fn(),
}));
// Only external notification delivery is replaced; report construction, DB, files,
// publication guards and Followup/validator request construction execute normally.
vi.mock("../runtime/alert.js", () => ({ notifyReport: vi.fn(), notifyFailure: vi.fn(), notifyBriefAcceptance: vi.fn(), notifyThinBrief: vi.fn(), notifyBudget: vi.fn() }));

import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertContentItem, insertSource, insertTopic, listRuns, getRun, getContentItem } from "./repos.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { planRawArchive, writePlannedRawArchive } from "./raw-archive.js";
import { contentHash } from "../sources/normalize.js";
import { sourceQuoteHash } from "../utils/source-quote-projection.js";
import { runJob } from "../runtime/jobs.js";
import { callStructured } from "../runtime/llm.js";
import { notifyReport } from "../runtime/alert.js";
import { buildReport } from "../agents/report-gen.js";
import { runReportGen } from "../agents/pipeline.js";
import { answerFollowup } from "../agents/followup.js";
import { extractLeadCandidates } from "../agents/tech-leads.js";
import { deriveOpportunityCandidates } from "../agents/opportunity-planning.js";
import { getReport, listRecentPublishedInsightOccurrences, listReportIndex, saveFailedReport, saveReport } from "./reports.js";
import { getTechLead, listTechLeads, upsertTechLeads } from "./tech-leads.js";
import { getTechnologyOpportunity, listOpportunityLeads, listTechnologyOpportunities, upsertTechnologyOpportunities } from "./planning.js";
import { listFollowups } from "./followup.js";
import { computePolishInputsHash } from "./ppt-cache.js";
import { anchorObjectKey, MemoryAnchorStore } from "./integrity-anchors.js";
import { exportReportPptx } from "../services/ppt-export.js";
import { POST as ask, GET as followups } from "../../app/api/reports/[id]/followup/route.js";
import { GET as leadDetail } from "../../app/api/leads/[id]/route.js";
import { GET as opportunityDetail } from "../../app/api/opportunities/[id]/route.js";
import { newObjectId } from "../utils/object-id.js";

const topic: Topic = { id: "t_d7", name: "D7 synthetic", keywords: ["agent"], language: "en", facets: ["domain:software-engineering"], brief_schedule: "daily", enabled: true };
const oldReportId = "rep_12345678";
const quote = "Atlas released an agent tool for repository inspection.";
let db: DB;
let dir: string;
let batch: AnalysisBatch;
let validation: ValidationResult;

function seedBatch(suffix: string, text: string): { batch: AnalysisBatch; validation: ValidationResult; item: ContentItem } {
  const date = new Date().toISOString();
  const item: ContentItem = { id: `ci_${suffix}`, source_id: "src_d7", url: `https://example.test/${suffix}`, title: suffix, author: null,
    published_at: date, fetched_at: date, language: "en", topic_ids: [topic.id], tags: [], body: text, body_kind: "article",
    raw_ref: "", content_hash: contentHash(text), fetch_status: "ok" };
  insertContentItem(db, item);
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: text,
    source_body_kind: "article", source_item_raw: "<item>synthetic</item>", structured_body_sha256: item.content_hash });
  writePlannedRawArchive(db, planRawArchive(db, { contentId: item.id, raw }), raw);
  const win = { start: date, end: date };
  const insightId = `ins_batch_${suffix}_0`;
  const value: AnalysisBatch = { id: `batch_${suffix}`, topic_id: topic.id, status: "done", no_significant_event: false, time_window: win,
    display_coverage_state: "audited", display_projection_version: "source_quote_v1",
    insights: [{ id: insightId, topic_id: topic.id, type: "aggregation", event_id: `evt_batch_${suffix}_0`, statement: text,
      statement_citation_index: 1, headline: "", importance: 4, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
      citations: [{ content_item_id: item.id, citation_ref: `cite_${suffix}`, claim: text, quote: text, locator: { paragraph_index: 0, char_start: 0, char_end: text.length } }],
      source_count: 1, multi_source: false, time_window: win, confidence: "high", language: "en", tags: [], entities: [] }],
    display_coverage_audits: [{ insight_id: insightId, candidate_id: insightId, gate_version: "display-coverage-v6", terminal_reason: "kept",
      prompt_version: "v6", input_hash: "synthetic", validator_model: "synthetic-validator", created_at: date,
      decision: { statement_citation_index: 1, statement_citation_ref: `cite_${suffix}`, display_projection_version: "source_quote_v1",
        statement_sha256: sourceQuoteHash(text), quote_sha256: sourceQuoteHash(text),
        claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] } }] };
  const checked: ValidationResult = { checks: [{ insight_id: insightId, citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }],
    report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, flagged_rate: 0, consistency_failure_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
  saveAnalysisBatch(db, value); saveValidationResult(db, value.id, checked);
  return { batch: value, validation: checked, item };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  const crypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  vi.mocked(randomBytes).mockImplementation(crypto.randomBytes);
  vi.mocked(randomUUID).mockImplementation(crypto.randomUUID);
  dir = mkdtempSync(join(tmpdir(), "ia-d7-generation-"));
  vi.stubEnv("DATA_DIR", dir);
  db = openDb(":memory:"); state.db = db;
  applyProvenanceMigrations(db);
  insertTopic(db, topic);
  insertSource(db, { id: "src_d7", name: "Synthetic source", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true });
  ({ batch, validation } = seedBatch("current", quote));
  const history = seedBatch("history", "Beacon released a distinct earlier compiler benchmark.");
  const prior: Report = { id: oldReportId, topic_id: topic.id, type: "initial_digest", status: "done", generated_at: new Date().toISOString(),
    title: "Historical synthetic report", body_md: "Historical synthetic evidence", body_html: "<p>Historical synthetic evidence</p>",
    insight_ids: history.batch.insights.map((value) => value.id), event_ids: ["evt_batch_history_0"], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 } };
  const priorIndex: ReportIndexEntry = { report_id: prior.id, type: prior.type, topic_id: topic.id, date: prior.generated_at.slice(0, 10),
    title: prior.title, summary: "Historical synthetic", highlights: [], tags: [], source_ids: ["src_d7"], entity_names: [], importance: 4, event_ids: prior.event_ids, milestone_count: 0 };
  await saveReport(db, prior, priorIndex, { dir: join(dir, "reports"), readerCitationBindings: [{ insight_id: history.batch.insights[0].id, citation_index: 0 }] });
  vi.clearAllMocks();
  vi.mocked(callStructured).mockImplementation(async (opts) => ({ data: opts.role === "followup"
    ? { answerable: true, answer_md: "Atlas released an agent tool [1].", claims: [{ ref: 1, claim: quote }] }
    : { consistency: "support", consistency_reason: "ok", rationale: "synthetic" },
    usage: {}, cost: { tokens: 0, amount: 0 } }) as unknown as Awaited<ReturnType<typeof callStructured>>);
});
afterEach(() => { db.close(); state.db = undefined; vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const assertNew = (id: string, prefix: string): void => { expect(id).toMatch(new RegExp(`^${prefix}_[a-f0-9]{32}$`)); expect(id.length).toBe(prefix.length + 33); };
function build() { return buildReport({ topic, batch, validation, type: "deep_dive", now: "2026-10-06T00:00:00Z", contentLookup: new Map([["ci_current", { source_id: "src_d7", source_name: "Synthetic source", url: "https://example.test/current", published_at: null, observed_at: "2026-10-06T00:00:00Z", tags: [] }]]) }); }

describe("D7 six production generator entry points", () => {
  it("new Run uses the Node CSPRNG and persists the exact Job identity", async () => {
    const result = await runJob(db, { kind: "ingest", target: {} }, async (ctx) => ctx.runId);
    assertNew(result.run.id, "run"); expect(result.result).toBe(result.run.id); expect(getRun(db, result.run.id)).toEqual(result.run);
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
  });
  it("buildReport emits a new ID and binds index without changing rendered content", () => {
    const a = build(); const b = build();
    assertNew(a.report.id, "rep"); assertNew(b.report.id, "rep"); expect(a.index.report_id).toBe(a.report.id);
    expect(a.report.body_md).toBe(b.report.body_md); expect(a.report.body_html).toBe(b.report.body_html);
    expect(randomBytes).toHaveBeenCalledTimes(2); expect(randomBytes).toHaveBeenNthCalledWith(1, 16);
    expect(callStructured).not.toHaveBeenCalled();
  });
  it("failed-report default ID is long while explicit legacy ID draws no random bytes", () => {
    const { report } = build(); vi.clearAllMocks();
    const { id: _id, ...input } = report;
    const id = saveFailedReport(db, { ...input, reasonCode: "synthetic" }); assertNew(id, "rep");
    expect(getReport(db, id)).toBeNull(); expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
    vi.clearAllMocks(); expect(saveFailedReport(db, { ...input, id: "rep_failed_old", reasonCode: "synthetic" })).toBe("rep_failed_old");
    expect(randomBytes).not.toHaveBeenCalled();
  });
  it("Followup POST executes real request construction, then allocates QA/thread and GET reads it back", async () => {
    const response = await ask(new Request(`http://x/api/reports/${oldReportId}/followup`, { method: "POST", body: JSON.stringify({ question: "What changed?" }) }), context(oldReportId));
    expect(response.status).toBe(200); const value = await response.json(); assertNew(value.id, "fup");
    expect(value.thread_id).toBe(value.id); expect(value.report_id).toBe(oldReportId);
    expect(listFollowups(db, oldReportId)).toEqual([value]);
    expect((await (await followups(new Request("http://x"), context(oldReportId))).json()).followups).toEqual([value]);
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
    expect(vi.mocked(callStructured).mock.calls[0][0].system).not.toContain(value.id);
  });
  it("new TechLead ID survives reader/API and canonical update without another allocation", async () => {
    const candidates = extractLeadCandidates(batch, validation, new Map([["ci_current", getContentItem(db, "ci_current")!]]));
    // Candidate extraction requires source metadata; use the same production-shaped input.
    const [lead] = upsertTechLeads(db, candidates); assertNew(lead.id, "lead");
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
    expect(getTechLead(db, lead.id)?.id).toBe(lead.id); expect(listTechLeads(db).map((value) => value.id)).toContain(lead.id);
    expect((await leadDetail(new Request(`http://x/api/leads/${lead.id}`), context(lead.id))).status).toBe(200);
    vi.clearAllMocks(); expect(upsertTechLeads(db, candidates)[0].id).toBe(lead.id); expect(randomBytes).not.toHaveBeenCalled();
  });
  it("new Opportunity links exact Lead and canonical update retains ID while drawing once as before", async () => {
    const [lead] = upsertTechLeads(db, [{ topic_id: topic.id, canonical_key: "event:new", kind: "tool", title: quote, summary: "Synthetic", evidence: [{ insight_id: batch.insights[0].id, citation_index: 0 }],
      observed_at: new Date().toISOString(), score: 80, score_detail: { freshness: 20, evidence: 20, importance: 20, relevance: 20, total: 80, reason: "Synthetic" } }]);
    const candidates = deriveOpportunityCandidates([lead], []); vi.clearAllMocks();
    const [opp] = upsertTechnologyOpportunities(db, candidates, new Map([[lead.id, lead]])); assertNew(opp.id, "opp");
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16); expect(opp.canonical_key).toBe(`horizon:lead:${lead.id}`);
    expect(listOpportunityLeads(db, opp.id)[0].id).toBe(lead.id); expect(getTechnologyOpportunity(db, opp.id)?.id).toBe(opp.id);
    expect(listTechnologyOpportunities(db).map((value) => value.id)).toContain(opp.id);
    expect((await opportunityDetail(new Request(`http://x/api/opportunities/${opp.id}`), context(opp.id))).status).toBe(200);
    vi.clearAllMocks(); expect(upsertTechnologyOpportunities(db, candidates, new Map([[lead.id, lead]]))[0].id).toBe(opp.id);
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
  });
});

describe("D7 publication, deterministic identity and failure protection", () => {
  it("generated Report binds signed in-memory anchors, manifest and publication effects to the exact long ID", async () => {
    const { report, index } = build();
    const keys = generateKeyPairSync("ed25519"); const store = new MemoryAnchorStore();
    await saveReport(db, report, index, { dir: join(dir, "reports"), readerCitationBindings: [{ insight_id: batch.insights[0].id, citation_index: 0 }],
      anchor: { store, signer: { key_id: "d7-synthetic-key", private_key: keys.privateKey }, issuedAt: "2026-10-06T00:00:01Z",
        retainUntil: "2027-01-01T00:00:00Z", retentionEnds: ["2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z", "2027-03-01T00:00:00Z"] } });
    expect(getReport(db, report.id)?.id).toBe(report.id);
    const manifests = db.prepare("SELECT report_id,artifact_id,anchor_object_key FROM artifact_manifest WHERE report_id=? ORDER BY artifact_id").all(report.id);
    expect(manifests).toEqual(["html", "md"].map(kind => ({ report_id: report.id, artifact_id: `${report.id}-${kind}`,
      anchor_object_key: anchorObjectKey("default", report.id, `${report.id}-${kind}`, "v1") })));
    expect(db.prepare("SELECT status FROM generation_effect WHERE report_id=?").get(report.id)).toEqual({ status: "committed" });
    expect(db.prepare("SELECT status FROM generation_anchor_effect").all()).toEqual([{ status: "committed" }, { status: "committed" }]);
  });
  it("encodes every CSPRNG byte without truncation, version bits or time inputs", () => {
    vi.mocked(randomBytes).mockImplementation(() => Buffer.from(Array.from({ length: 16 }, (_, i) => i)));
    expect(newObjectId("rep")).toBe("rep_000102030405060708090a0b0c0d0e0f");
    expect(randomBytes).toHaveBeenCalledExactlyOnceWith(16);
    expect(randomUUID).not.toHaveBeenCalled();
  });
  it("mixed reader-visible legacy and generated Lead/Opportunity identities retain exact evidence links", async () => {
    const date = new Date().toISOString();
    const score = JSON.stringify({ freshness: 20, evidence: 20, importance: 20, relevance: 20, total: 80, reason: "Synthetic" });
    const legacyLead = "lead_12345678-abc"; const legacyOpp = "opp_12345678-abc";
    db.prepare(`INSERT INTO tech_lead(id,topic_id,canonical_key,kind,title,summary,status,score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
      VALUES (?,?,'event:legacy','tool',?,'Synthetic','watching',80,?,?,?,?)`).run(legacyLead, topic.id, quote, score, date, date, date);
    db.prepare("INSERT INTO tech_lead_evidence(lead_id,insight_id,citation_index,added_at) VALUES (?,?,0,?)").run(legacyLead, batch.insights[0].id, date);
    db.prepare(`INSERT INTO technology_opportunity(id,topic_id,canonical_key,lane,planning_effect,title,hypothesis,proposed_validation,uncertainties,status,priority_score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
      VALUES (?,?,?,'horizon','new_direction','Synthetic','Synthetic','Synthetic','[]','research_candidate',80,?,?,?,?)`)
      .run(legacyOpp, topic.id, `horizon:lead:${legacyLead}`, score, date, date, date);
    db.prepare("INSERT INTO opportunity_lead(opportunity_id,lead_id,added_at) VALUES (?,?,?)").run(legacyOpp, legacyLead, date);
    const candidates = extractLeadCandidates(batch, validation, new Map([["ci_current", getContentItem(db, "ci_current")!]]));
    const [lead] = upsertTechLeads(db, candidates);
    const [opp] = upsertTechnologyOpportunities(db, deriveOpportunityCandidates([lead], []), new Map([[lead.id, lead]]));
    expect(listTechLeads(db).map(v => v.id)).toEqual(expect.arrayContaining([legacyLead, lead.id]));
    expect(listTechnologyOpportunities(db).map(v => v.id)).toEqual(expect.arrayContaining([legacyOpp, opp.id]));
    for (const [id, leadId] of [[legacyOpp, legacyLead], [opp.id, lead.id]]) {
      expect(listOpportunityLeads(db, id).map(v => v.id)).toEqual([leadId]);
      expect((await opportunityDetail(new Request("http://x"), context(id))).status).toBe(200);
      expect((await leadDetail(new Request("http://x"), context(leadId))).status).toBe(200);
    }
  });
  it("real runReportGen consumes DB history and publishes exact new file/index/notification/export associations", async () => {
    expect(listRecentPublishedInsightOccurrences(db, topic.id)).toMatchObject([{ insight_id: "ins_batch_history_0", event_id: "evt_batch_history_0" }]);
    const report = await runReportGen(db, { topic, batch, validation, type: "brief", prevReportId: oldReportId });
    assertNew(report.id, "rep"); expect(report.prev_report_id).toBe(oldReportId); expect(report.insight_ids).toEqual([batch.insights[0].id]);
    expect(getReport(db, report.id)).toEqual(report); expect(getReport(db, oldReportId)?.id).toBe(oldReportId);
    expect(readFileSync(join(dir, "reports", `${report.id}.md`), "utf8")).toBe(report.body_md);
    expect(listReportIndex(db).map((value) => value.report_id)).toEqual(expect.arrayContaining([oldReportId, report.id]));
    expect(db.prepare("SELECT status,idempotency_key FROM generation_effect WHERE report_id=?").get(report.id)).toEqual({ status: "committed", idempotency_key: `report_file:${report.id}` });
    expect(notifyReport).toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(notifyReport).mock.calls)).toContain(report.id);
    const exported = await exportReportPptx(db, report.id); expect(exported?.report.id).toBe(report.id); expect(exported?.buffer.length).toBeGreaterThan(0);
    expect(anchorObjectKey("default", report.id, `${report.id}-md`, "v1")).toContain(report.id);
    expect(listRuns(db).find((value) => value.kind === "report-gen")?.id).toMatch(/^run_[a-f0-9]{32}$/);
    expect(callStructured).not.toHaveBeenCalled();
  });
  it("report ID changes leave Followup model input and PPT input hash identical", async () => {
    const { report } = build();
    const hash = computePolishInputsHash(topic, batch.insights);
    await answerFollowup(db, { ...report, id: oldReportId }, "What changed?");
    const first = vi.mocked(callStructured).mock.calls[0][0]; vi.mocked(callStructured).mockClear();
    await answerFollowup(db, { ...report, id: "rep_0123456789abcdef0123456789abcdef" }, "What changed?");
    const second = vi.mocked(callStructured).mock.calls[0][0];
    expect(second.system).toBe(first.system); expect(second.user).toBe(first.user);
    expect(computePolishInputsHash(topic, batch.insights)).toBe(hash);
  });
  it("cancelled or fenced publication does not acquire a report/index/notification", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runReportGen(db, { topic, batch, validation, type: "brief", signal: controller.signal })).rejects.toThrow();
    await expect(runReportGen(db, { topic, batch, validation, type: "brief", assertWrite: () => { throw new Error("synthetic_fence_lost"); } })).rejects.toThrow("synthetic_fence_lost");
    expect(listReportIndex(db).map((value) => value.report_id)).toEqual([oldReportId]); expect(notifyReport).not.toHaveBeenCalled();
  });
  it("a forced Run ID collision rejects before business re-execution and does not swallow SQL errors", async () => {
    vi.mocked(randomBytes).mockImplementation(() => Buffer.alloc(16, 0xab));
    vi.mocked(randomUUID).mockReturnValue("abababab-abab-4bab-abab-abababababab");
    const business = vi.fn(async () => "synthetic");
    await runJob(db, { kind: "ingest", target: {} }, business);
    await expect(runJob(db, { kind: "ingest", target: {} }, business)).rejects.toThrow(/UNIQUE/);
    expect(business).toHaveBeenCalledTimes(1);
  });
  it("Followup failure allocates no QA and does not retry or associate the failed answer", async () => {
    vi.mocked(callStructured).mockRejectedValue(new Error("synthetic_answer_failure"));
    const response = await ask(new Request("http://x", { method: "POST", body: JSON.stringify({ question: "Synthetic?" }) }), context(oldReportId));
    expect(response.status).toBe(500); expect(listFollowups(db, oldReportId)).toEqual([]); expect(randomBytes).not.toHaveBeenCalled();
    expect(callStructured).toHaveBeenCalledTimes(1);
  });
  it("path and invalid-character boundaries remain restrictive for the new length", () => {
    for (const id of ["../rep_escape", "rep_/escape", "rep_\\escape", "rep_\0escape"]) {
      expect(() => anchorObjectKey("default", id, "artifact", "v1")).toThrow();
    }
    expect(() => anchorObjectKey("default", "rep_0123456789abcdef0123456789abcdef", "artifact", "v1")).not.toThrow();
  });
});
