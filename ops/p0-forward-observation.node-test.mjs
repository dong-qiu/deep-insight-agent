import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { formatSnapshot, parseArgs, remoteAggregateProgram, remoteCommandForAggregate } from "./p0-forward-observation.mjs";

test("parses conservative terminal observation options", () => {
  assert.deepEqual(parseArgs([]), { watch: false, untilCandidateThreshold: false, intervalSeconds: 900 });
  assert.deepEqual(parseArgs(["--watch", "--until-candidate-threshold", "--interval", "300"]), {
    watch: true, untilCandidateThreshold: true, intervalSeconds: 300,
  });
  assert.throws(() => parseArgs(["--interval", "299"]), /at least 300/);
  assert.throws(() => parseArgs(["--until-candidate-threshold"]), /requires --watch/);
});

test("remote aggregate returns only aggregate counts and never starts a pipeline", () => {
  const command = remoteCommandForAggregate();
  const program = remoteAggregateProgram();
  assert.match(command, /docker exec deep-insight-app-1/);
  assert.doesNotMatch(program, /api\/cron|trigger\.mjs|\bINSERT\b|\bDELETE\b|prepare\([^)]*\bUPDATE\b/i);
  assert.doesNotMatch(program, /actual_candidate|actual_direction|actual_lane/i);
});

test("remote aggregate rejects dismissed and audit-invalid evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insight-p0-observe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "fixture.db");
  const db = new Database(databasePath);
  db.exec(`CREATE TABLE tech_lead (id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE tech_lead_evidence (lead_id TEXT,insight_id TEXT,citation_index INTEGER);
    CREATE TABLE insight (id TEXT PRIMARY KEY,batch_id TEXT,statement TEXT,statement_citation_index INTEGER,headline TEXT,importance_basis TEXT);
    CREATE TABLE analysis_batch (id TEXT PRIMARY KEY,status TEXT,display_coverage_state TEXT,display_projection_version TEXT);
    CREATE TABLE display_coverage_audit (batch_id TEXT,insight_id TEXT,terminal_reason TEXT,decision TEXT);
    CREATE TABLE citation (insight_id TEXT,citation_index INTEGER,content_item_id TEXT,citation_ref TEXT,quote TEXT);
    CREATE TABLE citation_check (batch_id TEXT,insight_id TEXT,citation_index INTEGER,verdict TEXT,consistency TEXT,reachability TEXT);
    CREATE TABLE content_item (id TEXT PRIMARY KEY,reader_eligible INTEGER);`);
  const quote = "A source-quoted fact.";
  const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const decision = (citationRef, quoteHash = hash(quote)) => JSON.stringify({
    statement_citation_index: 1, statement_citation_ref: citationRef, display_projection_version: "source_quote_v1",
    statement_sha256: hash(quote), quote_sha256: quoteHash,
    claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }],
  });
  const insert = db.prepare("INSERT INTO tech_lead VALUES (?,?)");
  const evidence = db.prepare("INSERT INTO tech_lead_evidence VALUES (?,?,0)");
  const insight = db.prepare("INSERT INTO insight VALUES (?,?,?,?,?,?)");
  const audit = db.prepare("INSERT INTO display_coverage_audit VALUES (?,?,?,?)");
  const citation = db.prepare("INSERT INTO citation VALUES (?,?,?,?,?)");
  const check = db.prepare("INSERT INTO citation_check VALUES (?,?,?,?,?,?)");
  const content = db.prepare("INSERT INTO content_item VALUES (?,1)");
  db.prepare("INSERT INTO analysis_batch VALUES ('batch','done','audited','source_quote_v1')").run();
  for (const [leadId, status, invalid] of [["accepted", "recommended", false], ["dismissed", "dismissed", false], ["invalid", "recommended", true]]) {
    const insightId = `insight-${leadId}`;
    const citationRef = `ref-${leadId}`;
    insert.run(leadId, status); evidence.run(leadId, insightId);
    insight.run(insightId, "batch", quote, 1, "", "系统重要性判断：该结果可为工程选型提供参考。");
    content.run(`content-${leadId}`); citation.run(insightId, 0, `content-${leadId}`, citationRef, quote);
    check.run("batch", insightId, 0, "pass", "support", "pass");
    audit.run("batch", insightId, "kept", decision(citationRef, invalid ? "wrong-hash" : hash(quote)));
  }
  db.close();
  const output = execFileSync(process.execPath, ["-e", remoteAggregateProgram()], {
    encoding: "utf8", env: { ...process.env, P0_OBSERVE_DB_PATH: databasePath },
  });
  assert.deepEqual(JSON.parse(output), { total_tech_leads: 3, candidate_source_quote_v1: 1 });
});

test("candidate threshold is explicitly not the human dogfood gate", () => {
  const below = formatSnapshot({ total_tech_leads: 530, candidate_source_quote_v1: 49 }, "2026-09-12T00:00:00.000Z");
  assert.match(below, /49\/50/);
  assert.match(below, /do not replay history or start INSI-180/);
  const reached = formatSnapshot({ total_tech_leads: 530, candidate_source_quote_v1: 50 }, "2026-09-12T00:00:00.000Z");
  assert.match(reached, /create a fresh private snapshot/);
  assert.match(reached, /eval:opportunity-export/);
  assert.doesNotMatch(reached, /open INSI-180$/);
});
