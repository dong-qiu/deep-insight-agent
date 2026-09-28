import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deriveOpportunityCandidates } from "../../../../lib/agents/opportunity-planning.js";
import { saveAnalysisBatch, saveValidationResult } from "../../../../lib/db/analysis.js";
import { openDb, type DB } from "../../../../lib/db/index.js";
import { listTechnologyOpportunities, upsertTechnologyOpportunities } from "../../../../lib/db/planning.js";
import { applyProvenanceMigrations } from "../../../../lib/db/provenance-migrations.js";
import { planRawArchive, writePlannedRawArchive } from "../../../../lib/db/raw-archive.js";
import { insertContentItem, insertSource, insertTopic } from "../../../../lib/db/repos.js";
import { upsertTechLeads } from "../../../../lib/db/tech-leads.js";
import { listTechLeadEvidence, listTechLeadEvidenceBatch } from "../../../../lib/db/tech-leads.js";
import { createReaderEvidenceContext } from "../../../../lib/db/reader-evidence.js";
import { contentHash } from "../../../../lib/sources/normalize.js";
import type { AnalysisBatch, ValidationResult } from "../../../../lib/types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../../../../lib/utils/source-quote-projection.js";

const state = vi.hoisted(() => ({ db: null as DB | null }));
vi.mock("../../../../lib/db/index.js", async (original) => ({
  ...(await original<typeof import("../../../../lib/db/index.js")>()), getDb: () => state.db,
}));
vi.mock("../../../../lib/auth-guard.js", () => ({ requireAdminActor: vi.fn() }));
vi.mock("../../../../lib/db/provenance.js", () => ({ hashIdempotencyKey: vi.fn(), recordManualDecision: vi.fn() }));
vi.mock("../../../../lib/db/provenance-revisions.js", () => ({ technologyOpportunityRef: vi.fn(),
  technologyOpportunityRevisionSnapshot: vi.fn(), techLeadRef: vi.fn(), techLeadRevisionSnapshot: vi.fn() }));
import { GET as getOpportunity } from "./route.js";
import { GET as getLead } from "../../leads/[id]/route.js";

const quote = "OpenAI and Cursor built an agent.";
let db: DB;
let dataDir: string;
let opportunityId: string;
let leadId: string;
let rawPath: string;
const previousDataDir = process.env.DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b4-route-evidence-"));
  process.env.DATA_DIR = dataDir;
  db = openDb(":memory:");
  state.db = db;
  applyProvenanceMigrations(db);
  insertTopic(db, { id: "t", name: "T", keywords: [], language: "en", brief_schedule: "daily", enabled: true });
  insertSource(db, { id: "s", name: "S", type: "rss", endpoint: "https://example.test/feed", topic_ids: ["t"], fetch_interval: "6h", backfill: null, enabled: true });
  insertContentItem(db, { id: "c", source_id: "s", url: "https://example.test/item", title: "Item", author: null,
    published_at: "2026-09-28T00:00:00Z", fetched_at: "2026-09-28T00:00:00Z", language: "en", topic_ids: ["t"], tags: [],
    body: quote, body_kind: "article", raw_ref: "", content_hash: contentHash(quote), fetch_status: "ok" });
  const raw = `${JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: quote,
    source_body_kind: "article", source_item_raw: "<item>fixture</item>", structured_body_sha256: contentHash(quote) })}\n`;
  const archive = planRawArchive(db, { contentId: "c", raw });
  writePlannedRawArchive(db, archive, raw);
  rawPath = join(dataDir, "raw", archive.target);
  const batch: AnalysisBatch = { id: "b", topic_id: "t", time_window: { start: "2026-09-27", end: "2026-09-28" },
    status: "done", no_significant_event: false, display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
    insights: [{ id: "i", topic_id: "t", type: "aggregation", event_id: null, statement: quote, statement_citation_index: 1,
      headline: "", importance: 4, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
      citations: [{ content_item_id: "c", citation_ref: "binding", quote, locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }],
      source_count: 1, multi_source: false, time_window: { start: "2026-09-27", end: "2026-09-28" }, confidence: "high", language: "en", tags: [] }],
    display_coverage_audits: [{ insight_id: "i", candidate_id: "i", gate_version: "display-coverage-v6", terminal_reason: "kept",
      prompt_version: "v6", input_hash: "fixture", validator_model: "validator", created_at: "2026-09-28T00:00:00Z",
      decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION,
        statement_sha256: sourceQuoteHash(quote), quote_sha256: sourceQuoteHash(quote),
        claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true,
          citation_indexes: [1], countercheck: { supports: true } }] } }] };
  const validation: ValidationResult = { checks: [{ insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok",
    consistency: "support", consistency_reason: "ok", verdict: "pass" }], report: { total: 1, pass: 1, blocked: 0,
    flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, batch.id, validation);
  const [lead] = upsertTechLeads(db, [{ topic_id: "t", canonical_key: "agent", kind: "tool", title: "unbound title",
    summary: "unbound summary", evidence: [{ insight_id: "i", citation_index: 0 }], observed_at: "2026-09-28T00:00:00Z",
    score: 80, score_detail: { freshness: 20, evidence: 20, importance: 20, relevance: 20, total: 80, reason: "unbound reason" } }]);
  leadId = lead.id;
  const [opportunity] = upsertTechnologyOpportunities(db, deriveOpportunityCandidates([lead], [], "2026-09-28T00:00:00Z"), new Map([[lead.id, lead]]));
  opportunityId = opportunity.id;
});
afterEach(() => {
  state.db = null;
  db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const request = (kind: "opportunity" | "lead", id: string) => new Request(`http://example.test/api/${kind === "lead" ? "leads" : "opportunities"}/${id}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

it("serves only currently verifiable source evidence through lead and opportunity GET routes", async () => {
  const opportunity = await getOpportunity(request("opportunity", opportunityId), params(opportunityId));
  expect(opportunity.status).toBe(200);
  const payload = await opportunity.json();
  expect(payload.opportunity.title).toBe("待验证机会");
  expect(payload.leads).toMatchObject([{ id: leadId, title: "已核验技术线索", evidence: [{ quote }] }]);
  expect(JSON.stringify(payload)).not.toContain("unbound title");
  const lead = await getLead(request("lead", leadId), params(leadId));
  expect(lead.status).toBe(200);
  expect((await lead.json()).evidence).toMatchObject([{ quote }]);

  writeFileSync(rawPath, "corrupted archive bytes");
  expect((await getOpportunity(request("opportunity", opportunityId), params(opportunityId))).status).toBe(404);
  expect((await getLead(request("lead", leadId), params(leadId))).status).toBe(404);
});

it("batch opportunity list matches the single-detail evidence gate before and after archive damage", () => {
  expect(listTechnologyOpportunities(db).map((item) => item.id)).toEqual([opportunityId]);
  const [unboundLead] = upsertTechLeads(db, [{ topic_id: "t", canonical_key: "unbound", kind: "tool", title: "unbound",
    summary: "unbound", evidence: [], observed_at: "2026-09-28T00:00:00Z", score: 70,
    score_detail: { freshness: 20, evidence: 20, importance: 20, relevance: 10, total: 70, reason: "unbound" } }]);
  const [unboundOpportunity] = upsertTechnologyOpportunities(db,
    deriveOpportunityCandidates([unboundLead], [], "2026-09-28T00:00:00Z"), new Map([[unboundLead.id, unboundLead]]));
  expect(listTechnologyOpportunities(db, { includeClosed: true, limit: 1000 }).map((item) => item.id)).toEqual([opportunityId]);
  expect(unboundOpportunity.id).not.toBe(opportunityId);
  writeFileSync(rawPath, "corrupted archive bytes");
  expect(listTechnologyOpportunities(db, { includeClosed: true, limit: 1000 })).toEqual([]);
});

it("batch and single lead evidence agree across 400-ID chunks with mixed eligibility", () => {
  const extra = upsertTechLeads(db, Array.from({ length: 401 }, (_, index) => ({
    topic_id: "t", canonical_key: `batch_${index}`, kind: "tool" as const, title: "cached", summary: "cached",
    evidence: index % 2 === 0 ? [{ insight_id: "i", citation_index: 0 }] : [],
    observed_at: "2026-09-28T00:00:00Z", score: 70,
    score_detail: { freshness: 20, evidence: 20, importance: 20, relevance: 10, total: 70, reason: "cached" },
  })));
  const ids = [leadId, ...extra.map((lead) => lead.id)];
  const batched = listTechLeadEvidenceBatch(db, ids, createReaderEvidenceContext(db));
  for (const index of [0, 1, 2, 399, 400, 401]) {
    expect(batched.get(ids[index]!)).toEqual(listTechLeadEvidence(db, ids[index]!));
  }
  expect(batched.get(ids[399]!)).toHaveLength(1);
  expect(batched.get(ids[400]!)).toEqual([]);
  expect(batched.get(ids[401]!)).toHaveLength(1);
});
