/** D3 deterministic synthetic read fixture. Creates a new temporary DB only; no migration runner. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveAnalysisBatch, saveValidationResult } from "../../src/lib/db/analysis.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";
import { SCHEMA_SQL, INTEGRITY_LIFECYCLE_SCHEMA_SQL } from "../../src/lib/db/schema.js";
import { contentHash, normalizeBody } from "../../src/lib/sources/normalize.js";
import { sourceQuoteHash } from "../../src/lib/utils/source-quote-projection.js";
import type { AnalysisBatch, Insight } from "../../src/lib/types.js";

export const fixtureVersion = "d3-reader-v2";
export const since = "2026-09-01 00:00:00";
export const modes = ["valid", "valid", "valid", "blocked", "unchecked", "legacy", "ineligible", "missing", "corrupt", "pending", "misbound", "plain"] as const;
export function createD3Fixture(root: string, size: number, validOnly = false) {
  const dbPath = join(root, "synthetic.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys=ON");
  db.exec(SCHEMA_SQL.replace("CREATE TABLE IF NOT EXISTS insight (", `CREATE TABLE IF NOT EXISTS insight (
    is_followup INTEGER NOT NULL DEFAULT 0, entities TEXT, tags TEXT,`));
  // Current read projection, matching accessed columns and current raw-content index.
  // Foreign trace/anchor infrastructure is deliberately absent: this is not a startup/migration fixture.
  db.exec(`CREATE TABLE generation_effect (id TEXT PRIMARY KEY,raw_content_id TEXT REFERENCES content_item(id),
    kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT '2026-09-01',idempotency_key TEXT NOT NULL UNIQUE,artifact_manifest TEXT NOT NULL);
    CREATE INDEX idx_generation_effect_raw_pending ON generation_effect(raw_content_id,status,created_at) WHERE kind='raw_archive';
    CREATE TABLE provenance_redaction (record_id TEXT PRIMARY KEY,scope TEXT NOT NULL,entity_key TEXT NOT NULL,effective_at TEXT NOT NULL,expiry_at TEXT NOT NULL,UNIQUE(entity_key,scope));
    CREATE INDEX idx_provenance_redaction_active ON provenance_redaction(entity_key,effective_at,expiry_at);`);
  db.exec(INTEGRITY_LIFECYCLE_SCHEMA_SQL);
  for (const id of ["target", "other", "empty"]) insertTopic(db, {
    id, name: id, keywords: ["synthetic"], language: "zh", brief_schedule: "daily", enabled: true,
  });
  insertSource(db, { id: "synthetic", name: "synthetic", type: "rss", endpoint: "https://example.test/feed",
    topic_ids: ["target", "other"], fetch_interval: "6h", backfill: null, enabled: true });
  mkdirSync(join(root, "raw"));
  let archiveBytes = 0;
  let archiveCount = 0;
  const batches: AnalysisBatch[] = [];
  for (const topic of ["target", "other"]) for (let bucket = 0; bucket < 6; bucket++) batches.push({
    id: `${topic}-b${bucket}`, topic_id: topic, time_window: { start: "2026-08-01", end: "2026-10-01" },
    status: "done", no_significant_event: false, insights: [], display_coverage_state: "audited",
    display_projection_version: "source_quote_v1", display_coverage_audits: [],
  });
  const expected: string[] = [];
  const manifest: unknown[] = [];
  for (const topic of ["target", "other"]) for (let n = 0; n < (topic === "target" ? size : Math.ceil(size / 4)); n++) {
    const id = `${topic}-i${n.toString().padStart(4, "0")}`;
    const mode = validOnly ? "valid" : modes[n % modes.length]!;
    const bucket = Math.floor(n / modes.length) % 6;
    const batch = batches.find(b => b.id === `${topic}-b${bucket}`)!;
    // Adjacent valid rows share their original bytes; repeats must retain distinct occurrences.
    const contentId = `${topic}-${mode === "valid" ? "v" : "c"}${mode === "valid" ? Math.floor(n / 3) : n}`;
    const name = n % 2 === 0 ? "Beacon" : "Cedar";
    const statement = `Atlas ${name} synthetic finding ${Math.floor(n / 24)}`;
    const body = `${statement}\n${"Synthetic archive filler. ".repeat(170)}`;
    if (!db.prepare("SELECT 1 FROM content_item WHERE id=?").get(contentId)) {
      // Shared content contains all quotes in its group; stable irrespective of insertion order.
      const sharedBody = normalizeBody(mode === "valid" ? `Atlas Beacon synthetic finding ${Math.floor(n / 24)}\nAtlas Cedar synthetic finding ${Math.floor(n / 24)}\n${"Synthetic archive filler. ".repeat(170)}` : body);
      const hash = contentHash(sharedBody);
      const envelope = mode === "plain" ? sharedBody : JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed",
        source_body: sharedBody, source_body_kind: "article", source_item_raw: "<synthetic />", structured_body_sha256: hash });
      const digest = createHash("sha256").update(envelope).digest("hex");
      const target = `${contentId}.${digest}.txt`;
      const bytes = Buffer.byteLength(envelope);
      insertContentItem(db, { id: contentId, source_id: "synthetic", url: `https://example.test/${contentId}`,
        title: contentId, author: null, published_at: "2026-09-01T00:00:00Z", fetched_at: "2026-09-01T00:00:00Z",
        language: "en", topic_ids: [topic], tags: [], body: sharedBody, body_kind: "article", raw_ref: join("raw", target),
        content_hash: hash, fetch_status: "ok" });
      if (mode !== "missing") {
        writeFileSync(join(root, "raw", target), mode === "corrupt" ? "corrupt" : envelope);
        archiveCount++; archiveBytes += mode === "corrupt" ? 7 : bytes;
      }
      db.prepare("INSERT INTO generation_effect (id,raw_content_id,kind,status,idempotency_key,artifact_manifest) VALUES (?,?,?,?,?,?)").run(`effect-${contentId}`, contentId, "raw_archive",
        mode === "pending" ? "unknown" : "committed", `raw_archive:${contentId}:${digest}`,
        JSON.stringify([{ target, sha256: mode === "misbound" ? "0".repeat(64) : digest, size: bytes }]));
      if (mode === "ineligible") db.prepare("UPDATE content_item SET reader_eligible=0 WHERE id=?").run(contentId);
      manifest.push([contentId, hash, digest, mode]);
    }
    const citations: Insight["citations"] = [0, 1, 2].map(index => ({
      content_item_id: contentId, citation_ref: `${id}:cite${index}`, claim: index === 1 ? "bound" : "secondary",
      quote: index === 1 ? statement : `secondary quote ${index}`, locator: { paragraph_index: 0, char_start: 0, char_end: statement.length },
      ...(index === 2 ? { speaker_attribution: { status: "none" as const } } : {}),
    }));
    const insight: Insight = { id, topic_id: topic, type: "aggregation", event_id: null, statement, headline: "",
      reader_statement: "", statement_citation_index: mode === "legacy" ? undefined : 2, importance: 3,
      importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", citations, source_count: 1, multi_source: false,
      time_window: batch.time_window, confidence: "high", language: "en", is_followup: false,
      entities: [{ name: "Atlas", type: "organization" }, { name, type: "project" }], tags: [] };
    batch.insights.push(insight);
    batch.display_coverage_audits!.push({ insight_id: id, candidate_id: id, gate_version: "display-coverage-v6",
      terminal_reason: "kept", prompt_version: "synthetic", input_hash: "synthetic", validator_model: "synthetic",
      created_at: "2026-09-01T00:00:00Z", decision: {
        statement_citation_index: 2, statement_citation_ref: citations[1]!.citation_ref,
        display_projection_version: "source_quote_v1", statement_sha256: sourceQuoteHash(statement), quote_sha256: sourceQuoteHash(statement),
        claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [2], countercheck: { supports: true } }],
      } });
    if (topic === "target" && mode === "valid") expected.push(id);
  }
  for (const batch of batches) {
    saveAnalysisBatch(db, batch);
    const bucket = Number(batch.id.at(-1));
    const createdAt = ["2026-08-01 00:00:00", since, since, "2026-09-02 00:00:00", "2026-09-03 00:00:00", "2026-09-04 00:00:00"][bucket]!;
    db.prepare("UPDATE analysis_batch SET created_at=? WHERE id=?").run(createdAt, batch.id);
    const checks = batch.insights.filter(i => validOnly || modes[Number(i.id.split("-i")[1]) % modes.length] !== "unchecked").map(i => ({
      insight_id: i.id, citation_index: 1, reachability: "pass" as const, reachability_reason: "ok" as const,
      consistency: !validOnly && modes[Number(i.id.split("-i")[1]) % modes.length] === "blocked" ? "not_support" as const : "support" as const,
      consistency_reason: !validOnly && modes[Number(i.id.split("-i")[1]) % modes.length] === "blocked" ? "exaggeration" as const : "ok" as const,
      verdict: !validOnly && modes[Number(i.id.split("-i")[1]) % modes.length] === "blocked" ? "blocked" as const : "pass" as const,
    }));
    saveValidationResult(db, batch.id, { checks, report: { total: checks.length, pass: checks.length, blocked: 0, flagged: 0,
      errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: batch.insights.length, insights_includable: 0, releasable: true } });
  }
  for (let n = 0; n < 7; n++) {
    const id = `report-${n}`;
    db.prepare(`INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
      VALUES (?,'brief','target',?,'2026-09-01','synthetic','synthetic',?,'[]',0,'{}')`).run(id, n === 6 ? "generating" : "done", JSON.stringify(expected));
    db.prepare("INSERT INTO report_index (report_id,type,topic_id,date,title,summary,importance) VALUES (?,'brief','target',?,'synthetic','',3)")
      .run(id, `2026-09-0${n + 1}`);
  }
  db.prepare("INSERT INTO provenance_redaction VALUES ('synthetic','report','report:report-4','2020-01-01','2030-01-01')").run();
  db.prepare("INSERT INTO integrity_report_lifecycle (tenant_id,report_id,reader_state,readable_until,archive_until) VALUES ('default','report-5','delete_pending','2030-01-01','2030-01-01')").run();
  expected.sort((a, b) => {
    const number = (id: string) => Number(id.split("-i")[1]);
    return Math.floor(number(a) / modes.length) % 6 - Math.floor(number(b) / modes.length) % 6 || number(a) - number(b);
  });
  db.close();
  return { dbPath, expected, archiveCount, archiveBytes, fixtureHash: createHash("sha256").update(JSON.stringify({ fixtureVersion, size, validOnly, manifest })).digest("hex") };
}
