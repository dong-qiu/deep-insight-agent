/** Synthetic historical index fixture; never publishes or opens an existing database. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openDb } from "../../src/lib/db/startup.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";
import { planRawArchive, writePlannedRawArchive } from "../../src/lib/db/raw-archive.js";
import { saveAnalysisBatch, saveValidationResult } from "../../src/lib/db/analysis.js";
import { contentHash } from "../../src/lib/sources/normalize.js";
import { sourceQuoteHash } from "../../src/lib/utils/source-quote-projection.js";
import type { AnalysisBatch, ContentItem, ReportIndexEntry } from "../../src/lib/types.js";
import type { ReportQuery } from "../../src/lib/db/reports.js";
import type { DB } from "../../src/lib/db/connection.js";

export const fixtureVersion = "d3-report-list-v1";
export const sizes = [50, 400, 1200, 2400] as const;
export const conditions: Array<{ name: string; params: Record<string, string> }> = [
  { name: "default", params: {} },
  { name: "date-asc", params: { sort: "date", dir: "asc" } },
  { name: "importance", params: { sort: "importance" } },
  { name: "fts", params: { q: "raretoken" } },
  { name: "window-json", params: { topic: "topic-0", from: "2026-09-01", to: "2026-09-03", tag: "common", entity: "Atlas" } },
  { name: "empty", params: { q: "absenttoken" } },
];
const dates = ["2026-08-31", "2026-09-01", "2026-09-01", "2026-09-02", "2026-09-03", "2026-10-01"];
export const evidenceModes = ["valid", "missing", "unreadable", "corrupt", "mismatch", "plain", "ineligible", "blocked", "unchecked"] as const;
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type Fixture = ReturnType<typeof createReportListFixture>;

/** Permission-aware fingerprints do not read intentionally unreadable synthetic files. */
export function filesIdentity(root: string): Array<{ path: string; bytes: number; mode: number; sha256: string | null }> {
  const entries: ReturnType<typeof filesIdentity> = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = join(prefix, name), stat = statSync(path);
      if (stat.isDirectory()) walk(path, rel);
      else entries.push({ path: rel, bytes: stat.size, mode: stat.mode & 0o777,
        sha256: (stat.mode & 0o444) ? digest(readFileSync(path)) : null });
    }
  }
  walk(root, "");
  return entries;
}

export function createReportListFixture(root: string, size: number) {
  assert(isAbsolute(root) && readdirSync(root).length === 0, "fixture requires a new empty absolute directory");
  assert(Number.isSafeInteger(size) && size > 0 && size <= 2400, "invalid fixture size");
  chmodSync(root, 0o700);
  const dbPath = join(root, "synthetic.db"), prior = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  const started = performance.now();
  const db = openDb(dbPath);
  const records: Array<{ entry: ReportIndexEntry; visible: boolean; rare: boolean; mode: number }> = [];
  const evidence: Array<{ mode: typeof evidenceModes[number]; id: string; path: string; item: ContentItem }> = [];
  try {
    applyProvenanceMigrations(db);
    for (let i = 0; i < 4; i++) insertTopic(db, { id: `topic-${i}`, name: `Topic ${i}`, keywords: [], language: "en",
      facets: [i % 2 ? "domain:security" : "domain:software-engineering", "lens:business"], brief_schedule: "daily", enabled: true });
    for (let i = 0; i < 8; i++) insertSource(db, { id: `source-${i}`, name: `Source ${i}`, type: "rss",
      endpoint: `https://example.test/feed/${i}`, topic_ids: [`topic-${i % 4}`], fetch_interval: "6h", backfill: null, enabled: true });
    // Real schema, effect writer and audited/check records; corrupt current files only after historical inputs exist.
    const batch: AnalysisBatch = { id: "batch-evidence", topic_id: "topic-0", status: "done", no_significant_event: false,
      time_window: { start: "2026-08-31", end: "2026-10-01" }, insights: [], display_coverage_state: "audited",
      display_projection_version: "source_quote_v1", display_coverage_audits: [] };
    for (const mode of evidenceModes) {
      const id = `content-${mode}`, statement = `Atlas synthetic ${mode} evidence.`;
      const item: ContentItem = { id, source_id: "source-0", url: `https://example.test/${id}`, title: id, author: null,
        published_at: "2026-09-01T00:00:00Z", fetched_at: "2026-09-01T00:00:00Z", language: "en", topic_ids: ["topic-0"], tags: [],
        body: statement, body_kind: "article", raw_ref: "", content_hash: contentHash(statement), fetch_status: "ok" };
      insertContentItem(db, item);
      const raw = mode === "plain" ? statement : JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed",
        source_body: statement, source_body_kind: "article", source_item_raw: "<synthetic />", structured_body_sha256: item.content_hash });
      const plan = planRawArchive(db, { contentId: id, raw });
      writePlannedRawArchive(db, plan, raw);
      item.raw_ref = plan.rawRef;
      const insightId = `insight-${mode}`;
      batch.insights.push({ id: insightId, topic_id: "topic-0", type: "aggregation", event_id: null, statement,
        statement_citation_index: 1, headline: "", importance: 3, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
        citations: [{ content_item_id: id, citation_ref: insightId, claim: statement, quote: statement,
          locator: { paragraph_index: 0, char_start: 0, char_end: statement.length } }], source_count: 1, multi_source: false,
        time_window: batch.time_window, confidence: "high", language: "en", tags: [], entities: [{ name: "Atlas", type: "organization" }] });
      batch.display_coverage_audits!.push({ insight_id: insightId, candidate_id: insightId, gate_version: "display-coverage-v6",
        terminal_reason: "kept", prompt_version: "synthetic", input_hash: "synthetic", validator_model: "synthetic",
        created_at: "2026-09-01T00:00:00Z", decision: { statement_citation_index: 1, statement_citation_ref: insightId,
          display_projection_version: "source_quote_v1", statement_sha256: sourceQuoteHash(statement), quote_sha256: sourceQuoteHash(statement),
          claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] } });
      evidence.push({ mode, id: insightId, path: join(root, plan.rawRef), item });
    }
    saveAnalysisBatch(db, batch);
    const checks = batch.insights.filter(i => i.id !== "insight-unchecked").map(i => ({ insight_id: i.id, citation_index: 0,
      reachability: "pass" as const, reachability_reason: "ok" as const,
      consistency: i.id === "insight-blocked" ? "not_support" as const : "support" as const,
      consistency_reason: i.id === "insight-blocked" ? "exaggeration" as const : "ok" as const,
      verdict: i.id === "insight-blocked" ? "blocked" as const : "pass" as const }));
    saveValidationResult(db, batch.id, { checks, report: { total: 8, pass: 7, blocked: 1, flagged: 0, errored: 0,
      consistency_failure_rate: 1 / 8, flagged_rate: 0, insights_total: 9, insights_includable: 7, releasable: false } });
    mkdirSync(join(root, "reports"));
    const body = "Synthetic historical report filler. ".repeat(120);
    db.transaction(() => {
      for (let n = 0; n < size; n++) {
        const mode = n % 12, visible = mode < 8, rare = n % 4 === 0;
        const id = n % 2 ? `rep_${n.toString(16).padStart(24, "0")}` : `rep_${n.toString(16).padStart(8, "0")}`;
        const date = dates[Math.floor(n / 12) % 6]!;
        const sources = visible ? (mode === 7 ? ["retired-source", "source-0"] : [`source-${n % 8}`, `source-${(n + 1) % 8}`])
          : [`hidden-source-${mode}`, `hidden-source-${mode}`];
        const tags = visible ? ["common", `tag-${n % 32}`, `tag-${(n + 1) % 32}`, "common", "history", "synthetic"] : [`hidden-tag-${mode}`];
        const entities = visible ? ["Atlas", `Entity-${n % 64}`, `Entity-${(n + 1) % 64}`, "Atlas", "Beacon", "Cedar"] : [`hidden-entity-${mode}`];
        const entry: ReportIndexEntry = { report_id: id, type: (["brief", "deep_dive", "initial_digest"] as const)[n % 3]!,
          topic_id: `topic-${n % 4}`, facets: [n % 2 ? "domain:security" : "domain:software-engineering", "lens:business"], date,
          source_ids: sources, title: `Synthetic report ${n}`, summary: `Synthetic summary ${n}`, highlights: n % 2 ? ["Synthetic highlight"] : [],
          tags, entity_names: entities, importance: n % 5 + 1, event_ids: [], milestone_count: n % 5 === 0 ? 1 : 0,
          freshest_candidate_at: null, freshest_citation_at: null, freshness_lag_hours: null };
        const text = `${body}${rare ? (n % 8 === 0 ? " raretoken raretoken raretoken" : " raretoken") : " ordinarytoken"}`;
        const prefix = join(root, "reports", id);
        writeFileSync(`${prefix}.md`, text, { mode: 0o600 });
        writeFileSync(`${prefix}.html`, `<p>${text}</p>`, { mode: 0o600 });
        // Historical snapshots with references formerly accepted; blocked/unchecked are never selected.
        const historical = evidence[mode < 7 ? mode : 0]!.id;
        db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost,failure)
          VALUES (?,?,?,?,?,?,?,?,?,1,'{"tokens":0,"amount":0}',?)`).run(id, entry.type, entry.topic_id,
          mode === 10 ? "generating" : mode === 11 ? "failed" : "done", `${date}T00:00:00Z`, entry.title, prefix,
          JSON.stringify([historical, historical]), "[]", mode === 11 ? '{"reason_code":"synthetic_failure"}' : null);
        db.prepare(`INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, entry.type, entry.topic_id, JSON.stringify(entry.facets), date,
          JSON.stringify(sources), entry.title, entry.summary, JSON.stringify(entry.highlights), JSON.stringify(tags), JSON.stringify(entities), entry.importance, "[]", entry.milestone_count);
        db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES (?,?,?,?)").run(id, entry.title, entry.summary, text);
        if (mode === 8) db.prepare(`INSERT INTO provenance_redaction(record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref,created_at)
          VALUES (?,?,'report','user_erasure','2020-01-01T00:00:00Z','2020-02-01T00:00:00Z','synthetic','2020-01-01T00:00:00Z')`).run(`redaction-${n}`, `report:${id}`);
        if (mode === 9 || mode === 0) db.prepare(`INSERT INTO integrity_report_lifecycle(tenant_id,report_id,reader_state,readable_until,archive_until)
          VALUES ('default',?,?,'2030-01-01','2030-01-01')`).run(id, mode === 9 ? "delete_pending" : "active");
        records.push({ entry, visible, rare, mode });
      }
    })();
    for (const e of evidence) {
      if (e.mode === "missing") unlinkSync(e.path);
      if (e.mode === "unreadable") chmodSync(e.path, 0);
      if (e.mode === "corrupt") writeFileSync(e.path, "corrupt", { mode: 0o600 });
      if (e.mode === "mismatch") db.prepare("UPDATE content_item SET body=body || ' changed' WHERE id=?").run(e.item.id);
      if (e.mode === "ineligible") db.prepare("UPDATE content_item SET reader_eligible=0 WHERE id=?").run(e.item.id);
    }
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
    const ledger = db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode=DELETE");
    const buildMs = performance.now() - started;
    return { dbPath, root, records, evidence, buildMs, version: fixtureVersion, size,
      schemaHash: digest(JSON.stringify(schema)), ledgerHash: digest(JSON.stringify(ledger)),
      logicalHash: digest(JSON.stringify({ fixtureVersion, size, records, modes: evidenceModes, body })),
      visibleCount: records.filter(r => r.visible).length };
  } finally {
    db.close();
    chmodSync(dbPath, 0o600);
    if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior;
  }
}

export function matches(fixture: Fixture, opts: ReportQuery) {
  return fixture.records.filter(r => r.visible && (!opts.q || (opts.q === "raretoken" && r.rare))
    && (!opts.topic || r.entry.topic_id === opts.topic) && (!opts.from || r.entry.date >= opts.from)
    && (!opts.to || r.entry.date <= opts.to) && (!opts.tag || r.entry.tags.includes(opts.tag))
    && (!opts.entity || r.entry.entity_names.includes(opts.entity)));
}

/** Independent complete candidate set and cutoff check; ties are permitted, missing rows are not. */
export function assertRows(fixture: Fixture, db: DB, rows: ReportIndexEntry[], opts: ReportQuery, limit = 100) {
  const eligible = matches(fixture, opts), candidates = new Map(eligible.map(r => [r.entry.report_id, r.entry]));
  assert.equal(rows.length, Math.min(limit, eligible.length));
  assert.equal(new Set(rows.map(r => r.report_id)).size, rows.length);
  let scores = new Map<string, number>();
  if (opts.q === "raretoken") scores = new Map((db.prepare("SELECT report_id,bm25(report_fts) AS score FROM report_fts WHERE report_fts MATCH ?")
    .all('"raretoken"*') as Array<{ report_id: string; score: number }>).map(r => [r.report_id, r.score]));
  const compare = (a: ReportIndexEntry, b: ReportIndexEntry) => opts.q === "raretoken"
    ? scores.get(a.report_id)! - scores.get(b.report_id)!
    : opts.sort === "importance" ? b.importance - a.importance || b.date.localeCompare(a.date)
      : (opts.dir === "asc" ? 1 : -1) * a.date.localeCompare(b.date);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!, expected = candidates.get(r.report_id);
    assert(expected, "hidden or unmatched report");
    const { snippet, ...actual } = r;
    assert.deepEqual(actual, expected);
    if (opts.q) assert(snippet?.includes("\u0001raretoken\u0002"), "missing highlighted FTS snippet");
    else assert.equal(snippet, undefined);
    if (i) assert(compare(rows[i - 1]!, r) <= 0, "order mismatch");
  }
  const selected = new Set(rows.map(r => r.report_id));
  if (rows.length) for (const r of eligible) if (!selected.has(r.entry.report_id)) {
    assert(compare(rows.at(-1)!, r.entry) <= 0, "omitted a better ranked report");
  }
}

export function assertSnapshotUnchanged(root: string, before: ReturnType<typeof filesIdentity>, db: DB) {
  assert.deepEqual(filesIdentity(root), before);
  assert.equal((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n, 0);
  for (const suffix of ["-wal", "-shm", "-journal"]) assert(!existsSync(join(root, `synthetic.db${suffix}`)));
}
