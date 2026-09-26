import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { saveAnalysisBatch, saveValidationResult } from "../src/lib/db/analysis.js";
import { openDb } from "../src/lib/db/index.js";
import { createTopicDirection } from "../src/lib/db/planning.js";
import { insertContentItem, insertSource, insertTopic } from "../src/lib/db/repos.js";
import { upsertTechLeads } from "../src/lib/db/tech-leads.js";
import type { AnalysisBatch, ContentItem } from "../src/lib/types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../src/lib/utils/source-quote-projection.js";
import { validateQualifiedTechLeadSnapshot, type QualifiedTechLeadSnapshot } from "./technology-opportunities/dogfood-v2.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const at = "2026-09-26T00:00:00.000Z";
const quote = "Atlas is an open-source agent tool.";
const rootDir = process.cwd();
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "opportunity-readonly-export-"));
  roots.push(root);
  return root;
}
function runExport(dbPath: string | undefined, output: string, timestamp = at, cwd = rootDir) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", PROVENANCE_SCHEMA_REQUIRED: "0", PROVENANCE_DEPLOYMENT_REQUIRED: "0" };
  delete env.DB_PATH;
  if (dbPath !== undefined) env.DB_PATH = dbPath;
  return spawnSync(process.execPath, ["--import", join(rootDir, "node_modules/tsx/dist/loader.mjs"),
    join(rootDir, "evals/export-qualified-tech-leads-v2.ts"), output, timestamp], {
    cwd, env, encoding: "utf8", timeout: 20_000,
  });
}

/** Current real schema and persisted audit/evidence joins; no mocked qualification functions. */
function fixture(path: string, count = 1) {
  const db = openDb(path);
  insertTopic(db, { id: "t_code_agents", name: "Synthetic", keywords: [], language: "en", brief_schedule: "daily", enabled: true });
  insertSource(db, { id: "s", name: "Synthetic", type: "rss", endpoint: "https://example.test/feed", topic_ids: ["t_code_agents"], fetch_interval: "6h", backfill: null, enabled: true });
  for (const id of ["c", "hidden"]) {
    const item: ContentItem = { id, source_id: "s", url: `https://example.test/${id}`, title: id, author: null,
      published_at: at, fetched_at: at, language: "en", topic_ids: ["t_code_agents"], tags: [], body: quote,
      body_kind: "article", raw_ref: "", content_hash: id, fetch_status: "ok" };
    insertContentItem(db, item);
  }
  db.prepare("UPDATE content_item SET reader_eligible=0 WHERE id='hidden'").run();
  const insightIds = ["good", "unsupported", "hidden"];
  const batch: AnalysisBatch = {
    id: "b", topic_id: "t_code_agents", status: "done", time_window: { start: at, end: at }, no_significant_event: false,
    display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
    insights: insightIds.map((id) => ({ id, topic_id: "t_code_agents", type: "aggregation", event_id: null,
      statement: quote, statement_citation_index: 1, headline: "", importance: 4,
      importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
      citations: [{ content_item_id: id === "hidden" ? "hidden" : "c", citation_ref: `binding-${id}`, claim: quote, quote,
        locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }],
      source_count: 1, multi_source: false, time_window: { start: at, end: at }, confidence: null, language: "en" })),
    display_coverage_audits: insightIds.map((id) => ({ insight_id: id, candidate_id: id, gate_version: "display-coverage-v6",
      terminal_reason: "kept", prompt_version: "v6", input_hash: "fixture", validator_model: "fixture",
      decision: { statement_citation_index: 1, statement_citation_ref: `binding-${id}`, display_projection_version: DISPLAY_PROJECTION_VERSION,
        statement_sha256: sourceQuoteHash(quote), quote_sha256: sourceQuoteHash(quote),
        claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] },
      created_at: at })),
  };
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, "b", {
    checks: insightIds.map((id) => ({ insight_id: id, citation_index: 0, reachability: "pass", reachability_reason: "ok",
      consistency: id === "unsupported" ? "uncertain" : "support", consistency_reason: "ok", verdict: "pass" })),
    report: { total: 3, pass: 3, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0,
      insights_total: 3, insights_includable: 3, releasable: true },
  });
  const candidates = [
    ...Array.from({ length: count }, (_, i) => ({ key: `valid-${i}`, evidence: [{ insight_id: "good", citation_index: 0 }] })),
    { key: "dismissed", evidence: [{ insight_id: "good", citation_index: 0 }] },
    { key: "unsupported", evidence: [{ insight_id: "unsupported", citation_index: 0 }] },
    { key: "hidden", evidence: [{ insight_id: "hidden", citation_index: 0 }] },
    { key: "no-evidence", evidence: [] },
  ];
  upsertTechLeads(db, candidates.map(({ key, evidence }) => ({ canonical_key: key, topic_id: "t_code_agents", kind: "tool",
    title: "unbound private title", summary: "unbound private summary", evidence, observed_at: at, score: 70,
    score_detail: { evidence: 12, importance: 12, freshness: 1, relevance: 1, total: 70, reason: "fixture" },
  })), at);
  db.prepare("UPDATE tech_lead SET status='dismissed' WHERE canonical_key='dismissed'").run();
  db.prepare("UPDATE tech_lead SET status='watching' WHERE canonical_key='valid-0'").run();
  createTopicDirection(db, { id: "retired", topic_id: "t_code_agents", name: "Retired", objective: "Fixture",
    problem_statement: "Fixture", in_scope: [], out_of_scope: [], key_questions: [], constraints: [], success_signals: [],
    match_terms: ["private-direction-term"], adjacent_terms: [], challenge_terms: [], horizon: "now", status: "retired" }, at);
  db.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES('running','analyze','fixture','running','2020-01-01T00:00:00.000Z')").run();
  // Match a closed, standalone offline backup, without live WAL/SHM dependencies.
  db.pragma("journal_mode = DELETE");
  db.close();
}

describe("qualified TechLead CLI export from a read-only snapshot", () => {
  it("exports all 501 qualified leads with current evidence, without bootstrap writes or private output", () => {
    const root = tempRoot(), dbPath = join(root, "snapshot.db"), output = join(root, "qualified.json");
    fixture(dbPath, 501);
    const before = digest(dbPath);
    const result = runExport(dbPath, output);
    expect(result.status, result.stderr).toBe(0);
    const snapshot = JSON.parse(readFileSync(output, "utf8")) as QualifiedTechLeadSnapshot;
    expect(() => validateQualifiedTechLeadSnapshot(snapshot)).not.toThrow();
    expect(snapshot.total_count).toBe(501);
    expect(snapshot.leads).toHaveLength(501);
    expect(snapshot.leads.every((lead) => lead.title === quote && lead.summary === "" && lead.pass_evidence_count === 1)).toBe(true);
    expect(snapshot.leads.filter((lead) => lead.status === "watching")).toHaveLength(1);
    expect(snapshot.mapping_directions).toEqual([{ direction_id: "retired", topic_id: "t_code_agents", status: "retired", version: 1,
      match_terms: ["private-direction-term"], adjacent_terms: [], challenge_terms: [] }]);
    expect(digest(dbPath)).toBe(before);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT status FROM run WHERE id='running'").get()).toEqual({ status: "running" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM topic_direction").get()).toEqual({ n: 1 });
    } finally { db.close(); }
    if (process.platform !== "win32") expect(statSync(output).mode & 0o777).toBe(0o600);
    for (const value of [quote, "private-direction-term", "unbound private title"]) expect(result.stdout + result.stderr).not.toContain(value);
    const artifact = readFileSync(output);
    expect(runExport(dbPath, output).status).not.toBe(0);
    expect(readFileSync(output)).toEqual(artifact);
    expect(digest(dbPath)).toBe(before);
  });

  it("reads a filesystem read-only database without trying to migrate it", () => {
    const root = tempRoot(), dbPath = join(root, "snapshot.db"), output = join(root, "qualified.json");
    fixture(dbPath);
    const before = digest(dbPath);
    chmodSync(dbPath, 0o400);
    try {
      const result = runExport(dbPath, output);
      expect(result.status, result.stderr).toBe(0);
      expect(digest(dbPath)).toBe(before);
    } finally { chmodSync(dbPath, 0o600); }
  });

  it.each([undefined, "", "relative.db", ":memory:"])("requires an explicit absolute DB_PATH: %s", (dbPath) => {
    const root = tempRoot(), output = join(root, "qualified.json");
    mkdirSync(join(root, ".data"));
    const defaultDb = join(root, ".data/insight.db");
    fixture(defaultDb);
    const before = digest(defaultDb);
    const result = runExport(dbPath, output, at, root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DB_PATH must be an explicit absolute path");
    expect(existsSync(output)).toBe(false);
    expect(digest(defaultDb)).toBe(before);
  });

  it("does not create a missing input database", () => {
    const root = tempRoot(), dbPath = join(root, "missing.db"), output = join(root, "qualified.json");
    expect(runExport(dbPath, output).status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(output)).toBe(false);
  });

  it("rejects incompatible schemas without migrating them or writing a partial export", () => {
    const root = tempRoot(), dbPath = join(root, "old.db"), output = join(root, "qualified.json");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE tech_lead(id TEXT PRIMARY KEY)");
    db.close();
    const before = digest(dbPath);
    expect(runExport(dbPath, output).status).not.toBe(0);
    expect(digest(dbPath)).toBe(before);
    expect(existsSync(output)).toBe(false);
  });

  it.each(["empty", "invalid-timestamp"])("rejects an invalid v2 snapshot: %s", (reason) => {
    const root = tempRoot(), dbPath = join(root, "snapshot.db"), output = join(root, "qualified.json");
    fixture(dbPath, reason === "empty" ? 0 : 1);
    const before = digest(dbPath);
    const result = runExport(dbPath, output, reason === "invalid-timestamp" ? "not-utc" : at);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("qualified_snapshot_schema_invalid");
    expect(digest(dbPath)).toBe(before);
    expect(existsSync(output)).toBe(false);
  });
});
