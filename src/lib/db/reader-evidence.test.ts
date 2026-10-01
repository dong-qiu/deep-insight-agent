import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extractLeadCandidates } from "../agents/tech-leads.js";
import type { AnalysisBatch, ContentItem, Insight, Source, Topic, ValidationResult } from "../types.js";
import { contentHash } from "../sources/normalize.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { buildTopicGraph, insightsMentioningEntity } from "./graph.js";
import { type DB, openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { markRawArchiveUnknown, planRawArchive, writePlannedRawArchive } from "./raw-archive.js";
import { createReaderEvidenceContext } from "./reader-evidence.js";
import { insertContentItem, insertSource, insertTopic } from "./repos.js";
import { listTechLeadEvidence, listTechLeads, upsertTechLeads } from "./tech-leads.js";

const statement = "OpenAI and Cursor built an agent.";
const topic: Topic = { id: "topic_b4", name: "B4", keywords: [], language: "en", brief_schedule: "daily", enabled: true };
const source: Source = { id: "source_b4", name: "Source", type: "rss", endpoint: "https://example.test/rss", topic_ids: [topic.id], fetch_interval: "6h", backfill: null, enabled: true };
const item: ContentItem = { id: "content_b4", source_id: source.id, url: "https://example.test/item", title: "Article", author: null,
  published_at: "2026-09-27T00:00:00Z", fetched_at: "2026-09-28T00:00:00Z", language: "en", topic_ids: [topic.id],
  tags: [], body: statement, body_kind: "article", raw_ref: "", content_hash: contentHash(statement), fetch_status: "ok" };

function envelope(body: string, marker = "a"): string {
  return `${JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: body,
    source_body_kind: "article", source_item_raw: `<item>${marker}</item>`, structured_body_sha256: contentHash(body) })}\n`;
}

function batch(): AnalysisBatch {
  const insight: Insight = { id: "insight_b4", topic_id: topic.id, type: "aggregation", event_id: "event_b4", statement,
    statement_citation_index: 1, headline: "", importance: 4,
    importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
    citations: [{ content_item_id: item.id, citation_ref: "ref_b4", claim: statement, quote: statement,
      locator: { paragraph_index: 0, char_start: 0, char_end: statement.length } }],
    source_count: 1, multi_source: false, time_window: { start: "2026-09-27", end: "2026-09-28" },
    confidence: "high", language: "en", tags: [], entities: [
      { name: "OpenAI", type: "organization" }, { name: "Cursor", type: "organization" },
    ] };
  return { id: "batch_b4", topic_id: topic.id, time_window: { start: "2026-09-27", end: "2026-09-28" },
    status: "done", no_significant_event: false, insights: [insight],
    display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
    display_coverage_audits: [{ insight_id: insight.id, candidate_id: "candidate_b4", gate_version: "display-coverage-v6",
      terminal_reason: "kept", prompt_version: "v6", input_hash: "fixture", validator_model: "coverage",
      decision: { statement_citation_index: 1, statement_citation_ref: "ref_b4", display_projection_version: DISPLAY_PROJECTION_VERSION,
        statement_sha256: sourceQuoteHash(statement), quote_sha256: sourceQuoteHash(statement),
        claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true,
          citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-28T00:00:00Z" }] };
}

const validation: ValidationResult = { checks: [{ insight_id: "insight_b4", citation_index: 0,
  reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }],
report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0,
  flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };

let db: DB;
let dataDir: string;
let leadId: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b4-reader-evidence-"));
  process.env.DATA_DIR = dataDir;
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertTopic(db, topic);
  insertSource(db, source);
});
afterEach(() => {
  db.close();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function saveEvidence(withContent = true, raw = envelope(statement)): string | null {
  if (withContent) {
    insertContentItem(db, item);
    const plan = planRawArchive(db, { contentId: item.id, raw });
    writePlannedRawArchive(db, plan, raw);
  }
  const analysis = batch();
  saveAnalysisBatch(db, analysis);
  saveValidationResult(db, analysis.id, validation);
  const candidates = extractLeadCandidates(analysis, validation, withContent ? new Map([[item.id, item]]) : new Map(), "2026-09-28T01:00:00Z");
  leadId = upsertTechLeads(db, candidates)[0]?.id ?? "";
  return withContent ? join(dataDir, (db.prepare("SELECT raw_ref FROM content_item WHERE id=?").get(item.id) as { raw_ref: string }).raw_ref) : null;
}

function expectHidden(): void {
  expect(buildTopicGraph(db, topic.id, { minEdgeWeight: 1 }).insightCount).toBe(0);
  expect(insightsMentioningEntity(db, topic.id, "OpenAI")).toEqual([]);
  expect(listTechLeadEvidence(db, leadId)).toEqual([]);
  expect(listTechLeads(db)).toEqual([]);
}

it("keeps a current v1 envelope with exact body, quote, effect and v6 binding visible", () => {
  saveEvidence();
  expect(buildTopicGraph(db, topic.id, { minEdgeWeight: 1 }).insightCount).toBe(1);
  expect(insightsMentioningEntity(db, topic.id, "OpenAI")).toHaveLength(1);
  expect(listTechLeadEvidence(db, leadId)).toHaveLength(1);
});

it("rejects a citation whose current content row is missing", () => {
  saveEvidence(false);
  expectHidden();
});

it("rejects a pending replacement even while an older archive is committed", () => {
  saveEvidence();
  planRawArchive(db, { contentId: item.id, raw: envelope(statement, "replacement") });
  expectHidden();
});

it("rejects missing and corrupted current archive bytes", () => {
  const file = saveEvidence()!;
  const original = readFileSync(file);
  rmSync(file);
  expectHidden();
  writeFileSync(file, Buffer.from("x"));
  expectHidden();
  writeFileSync(file, original);
  expect(listTechLeadEvidence(db, leadId)).toHaveLength(1);
});

it("rejects a legacy eligible row with an empty raw_ref", () => {
  saveEvidence();
  db.prepare("UPDATE content_item SET raw_ref='',reader_eligible=1 WHERE id=?").run(item.id);
  expect(db.prepare("SELECT reader_eligible FROM content_item WHERE id=?").get(item.id)).toEqual({ reader_eligible: 1 });
  expectHidden();
});

it("rejects a legacy eligible row whose raw_ref points to a missing file", () => {
  const file = saveEvidence()!;
  rmSync(file);
  expect(db.prepare("SELECT reader_eligible FROM content_item WHERE id=?").get(item.id)).toEqual({ reader_eligible: 1 });
  expectHidden();
});

it("rejects a body-matching quote when archived source_body still contains an omitted qualifier", () => {
  const raw = `${JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed",
    source_body: `${statement} Only under a limited condition.`, source_body_kind: "article",
    source_item_raw: "<item>Original with qualifier</item>", structured_body_sha256: contentHash(statement) })}\n`;
  saveEvidence(true, raw);
  expect(db.prepare("SELECT reader_eligible FROM content_item WHERE id=?").get(item.id)).toEqual({ reader_eligible: 1 });
  expect(createReaderEvidenceContext(db).accepts({ content_item_id: item.id, quote: statement,
    raw_ref: (db.prepare("SELECT raw_ref FROM content_item WHERE id=?").get(item.id) as { raw_ref: string }).raw_ref,
    body: statement, body_kind: "article", content_hash: contentHash(statement) })).toBe(false);
  expectHidden();
});

it("rejects a changed body even if it still contains the old quote", () => {
  saveEvidence();
  db.prepare("UPDATE content_item SET body=? WHERE id=?").run(`${statement} Added unsupported context.`, item.id);
  expectHidden();
});

it("rejects a fully re-archived current body when the old bound quote is no longer reachable", () => {
  saveEvidence();
  const replacement = "A different source statement without either named organization.";
  db.prepare("UPDATE content_item SET body=?,content_hash=? WHERE id=?")
    .run(replacement, contentHash(replacement), item.id);
  const raw = envelope(replacement, "replacement-without-quote");
  writePlannedRawArchive(db, planRawArchive(db, { contentId: item.id, raw }), raw);
  expectHidden();
});

it("rejects a committed pre-envelope plain raw file", () => {
  saveEvidence(true, statement);
  expectHidden();
});

it("rejects a v1-labelled archive that omits required provenance fields", () => {
  const malformed = `${JSON.stringify({ schema_version: "content-raw-archive-v1", source_body: statement,
    source_body_kind: "article", structured_body_sha256: contentHash(statement) })}\n`;
  saveEvidence(true, malformed);
  expectHidden();
});

it("accepts a later valid current effect despite an older unknown effect", () => {
  saveEvidence();
  const interrupted = planRawArchive(db, { contentId: item.id, raw: envelope(statement, "interrupted") });
  markRawArchiveUnknown(db, interrupted.effectId, "raw_archive_write_failed");
  const currentRaw = envelope(statement, "current");
  const current = planRawArchive(db, { contentId: item.id, raw: currentRaw });
  writePlannedRawArchive(db, current, currentRaw);
  expect(buildTopicGraph(db, topic.id, { minEdgeWeight: 1 }).insightCount).toBe(1);
  expect(listTechLeadEvidence(db, leadId)).toHaveLength(1);
});

it("rejects an altered raw envelope whose manifest hash no longer matches", () => {
  const file = saveEvidence()!;
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.replace("structured_body_sha256", "changed_body_sha256"));
  expectHidden();
});

it("rejects a forged target filename whose embedded hash differs from the manifest and file", () => {
  saveEvidence();
  const forgedRaw = envelope(statement, "forged-target");
  const actualHash = createHash("sha256").update(forgedRaw).digest("hex");
  const wrongHash = "a".repeat(64);
  expect(actualHash).not.toBe(wrongHash);
  const target = `${item.id}.${wrongHash}.txt`;
  writeFileSync(join(dataDir, "raw", target), forgedRaw);
  db.prepare(`INSERT INTO generation_effect
    (id,trace_id,event_id,report_id,raw_content_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at)
    VALUES (?,?,?,?,?,'raw_archive',?,?,'{}','committed',NULL,?,?)`).run(
    "effect_forged_target", null, null, null, item.id, `raw_archive:${item.id}:${actualHash}`,
    JSON.stringify([{ target, sha256: actualHash, size: Buffer.byteLength(forgedRaw) }]),
    "2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z",
  );
  db.prepare("UPDATE content_item SET raw_ref=?,reader_eligible=1 WHERE id=?").run(join("raw", target), item.id);
  expectHidden();
});

it("rejects a body hash drift even if the quote remains reachable", () => {
  saveEvidence();
  db.prepare("UPDATE content_item SET content_hash=? WHERE id=?").run(createHash("sha256").update("wrong").digest("hex"), item.id);
  expectHidden();
});
