import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { appendGenerationEvent, canonicalHash, captureRevision, type EntityRef } from "../../src/lib/db/provenance-facts.js";
import { entityKey } from "../../src/lib/db/provenance-facts.js";
import { contentHash } from "../../src/lib/sources/normalize.js";
import { exportBriefDensity, terminalBucket, type ExportOptions } from "./export.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = "2026-09-24T17:00:00.000Z";
function setup(options: { wrongArchive?: boolean; failedOnly?: boolean; diagnostics?: boolean; completedAfterWindow?: boolean; invalidRevision?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "brief-density-")); dirs.push(dir);
  const dbPath = join(dir, "offline.db");
  // Build the real migrated schema in memory; the exporter still reads a real standalone file.
  // Avoid hundreds of fixture-only fsyncs under CI coverage and parallel test load.
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  db.exec(`INSERT INTO topic(id,name,language,brief_schedule) VALUES('t','Synthetic','en','daily');
    INSERT INTO source(id,name,type,endpoint,fetch_interval) VALUES('s','Synthetic','rss','https://example.test','daily');`);
  const body = "Acme released version 2. It supports offline operation.";
  const snapshot = { url: "https://example.test/a", title: "Release", source_id: "s", published_at: at, fetched_at: at, body_kind: "article", fetch_status: "ok", body_length: body.length, content_hash: contentHash(body) };
  const ref: EntityRef = { type: "content_item", locator: { kind: "id", id: "c" }, revision: `content-v4:${canonicalHash(snapshot)}`, role: "input" };
  captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot });
  const inputRef = options.invalidRevision ? { ...ref, revision: `content-v4:${"0".repeat(64)}` } : ref;
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", structured_body_sha256: options.wrongArchive ? "0".repeat(64) : snapshot.content_hash, source_body_kind: "article", source_body: body });
  const rawHash = createHash("sha256").update(raw).digest("hex"), target = `c.${rawHash}.txt`;
  const dataDir = join(dir, "archive"); mkdirSync(join(dataDir, "raw"), { recursive: true }); writeFileSync(join(dataDir, "raw", target), raw);
  db.prepare(`INSERT INTO content_item(id,source_id,url,title,published_at,fetched_at,language,body,body_kind,raw_ref,content_hash,fetch_status)
    VALUES('c','s',?,'Release',?,?,'en',?,'article',?,?,'ok')`).run(snapshot.url, at, at, body, `raw/${target}`, snapshot.content_hash);
  db.prepare(`INSERT INTO generation_effect(id,kind,raw_content_id,idempotency_key,artifact_manifest,publication_payload,status,created_at,updated_at)
    VALUES('raw','raw_archive','c',?,?,'{}','committed',?,?)`).run(`raw_archive:c:${rawHash}`, JSON.stringify([{ target, sha256: rawHash, size: Buffer.byteLength(raw) }]), at, at);
  db.prepare(`INSERT INTO generation_trace(id,topic_id,scope_kind,trigger_kind,status,completion_policy,started_at)
    VALUES('tr','t','topic_pipeline','scheduler','done','{}',?)`).run(at);
  const started = appendGenerationEvent(db, { trace_id: "tr", stage: "analyze", event_type: "started", input_refs: [inputRef], occurred_at: at });
  if (options.failedOnly) {
    const diag = { schema_version: 1, candidates: [{ candidate_sha256: "a".repeat(64), terminal_reason: "dropped_coverage" }] };
    const diagRef: EntityRef = { type: "analysis_coverage_diagnostics", locator: { kind: "id", id: "tr" }, revision: canonicalHash(diag), role: "evidence" };
    if (options.diagnostics) captureRevision(db, { entity_type: diagRef.type, entity_key: entityKey(diagRef), revision: diagRef.revision, snapshot: diag });
    appendGenerationEvent(db, { trace_id: "tr", stage: "analyze", event_type: "failed", output_refs: options.diagnostics ? [diagRef] : [], occurred_at: at });
  } else {
    db.prepare("INSERT INTO analysis_batch(id,topic_id,time_window,status,created_at) VALUES('b','t','{}','done',?)").run(at);
    db.exec(`INSERT INTO insight(id,batch_id,topic_id,type,statement,importance,importance_basis,source_count,multi_source,time_window,language)
      VALUES('i','b','t','aggregation','Acme released version 2.',4,'research_tracking',1,0,'{}','en');
      INSERT INTO citation(insight_id,citation_index,content_item_id,quote,locator) VALUES('i',0,'c','Acme released version 2.','{"char_start":0,"char_end":24}');
      INSERT INTO citation_check VALUES('b','i',0,'pass','ok','support','ok','pass');`);
    const audit = db.prepare(`INSERT INTO display_coverage_candidate_audit(batch_id,candidate_id,insight_id,gate_version,terminal_reason,prompt_version,input_hash,validator_model,decision,created_at) VALUES('b',?,?,'v6',?,'p','h','m','{}',?)`);
    audit.run("kept", "i", "kept", at); audit.run("rejected", null, "dropped_coverage", at);
    const completed = appendGenerationEvent(db, { trace_id: "tr", stage: "analyze", event_type: "completed", input_refs: [inputRef], output_refs: [{ type: "analysis_batch", locator: { kind: "id", id: "b" }, revision: "b", role: "output" }], occurred_at: options.completedAfterWindow ? "2026-09-26T19:00:00.000Z" : at });
    const addReport = (id: string, type: string, generated: string, reason: string, published: boolean) => {
      db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,insight_ids,citation_count,cost) VALUES(?,?,'t','done',?,'R',?,1,'{}')`).run(id, type, generated, published ? '["i"]' : '[]');
      db.prepare(`INSERT INTO report_review_snapshot VALUES(?,'tr','b',?,?,?,?,?,'v1','complete','published',?)`).run(id, started.id, completed.id, started.id, completed.id, started.id, generated);
      db.prepare(`INSERT INTO report_selection_decision VALUES(?,'i',?,?,NULL,?,'[0]','v1',?)`).run(id, published ? "published" : "excluded", reason, published ? 1 : null, generated);
    };
    addReport("r", "brief", at, "supplemental_limit", false);
    addReport("future", "brief", "2026-09-28T00:00:00.000Z", "already_published_event", false);
    addReport("deep", "deep_dive", at, "already_published_event", false);
  }
  writeFileSync(dbPath, db.serialize()); db.close();
  const opts: ExportOptions = { dbPath, outputDir: join(dir, "out"), from: "2026-09-23T00:00:00.000Z", until: "2026-09-26T18:00:00.000Z", asOf: "2026-09-26T18:00:00.000Z", topics: ["t"], gitSha: "a".repeat(40), dataDir };
  return { dir, opts, rawPath: join(dataDir, "raw", target) };
}
function readPool(outputDir: string) { return readFileSync(join(outputDir, "candidate-pool.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s)); }
function attachBackupReceipt(opts: ExportOptions, dir: string) {
  const backupDir = join(dir, "backup"); mkdirSync(backupDir);
  const bytes = readFileSync(opts.dbPath);
  writeFileSync(join(backupDir, "insight.db"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schema_version: 1, created_at: "2026-09-26T18:00:01.000Z", status: "incomplete",
    files: [{ path: "insight.db", size: bytes.length, sha256: digest }],
    db_snapshot_interval: { started_at: "2026-09-26T17:59:59.000Z", completed_at: opts.asOf,
      source_data_version_before: 1, source_data_version_after: 1, source_data_version_unchanged: true, db_sha256: digest },
  };
  const path = join(backupDir, "backup-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  opts.backupManifestPath = path;
  return { manifest, path };
}

describe("private Brief density export", () => {
  it("exports rejected candidates, exact input evidence and only cutoff Brief decisions without changing DB", () => {
    const { opts } = setup(); const before = createHash("sha256").update(readFileSync(opts.dbPath)).digest("hex");
    expect(exportBriefDensity(opts)).toEqual({ batches: 1, candidates: 2, tracesWithoutBatch: 0 });
    const [record] = readPool(opts.outputDir);
    expect(record.candidates.map((c: { terminal: string }) => c.terminal)).toEqual(["selection_budget_filtered", "display_audit_rejected"]);
    expect(record.report_reviews.map((r: { report_id: string }) => r.report_id)).toEqual(["r"]);
    expect(record.input_evidence[0].gaps).toEqual([]);
    expect(record.input_evidence[0].archive.content_version_verified).toBe(true);
    expect(record.candidates[0].citations[0].locator_verified).toBe(true);
    expect(record.candidates[1].candidate_text_status).toBe("not_persisted");
    expect(JSON.parse(readFileSync(join(opts.outputDir, "snapshot-manifest.json"), "utf8")).snapshot_time_evidence.status).toBe("operator_as_of_unattested");
    expect(createHash("sha256").update(readFileSync(opts.dbPath)).digest("hex")).toBe(before);
    expect(existsSync(`${opts.dbPath}-wal`)).toBe(false);
    expect(statSync(opts.outputDir).mode & 0o777).toBe(0o700);
    for (const file of ["candidate-pool.jsonl", "stage-loss.json", "snapshot-manifest.json"]) expect(statSync(join(opts.outputDir, file)).mode & 0o777).toBe(0o600);
    expect(() => exportBriefDensity(opts)).toThrow();
  });
  it("does not duplicate a batch whose completion is after the cohort window but before asOf", () => {
    const { opts } = setup({ completedAfterWindow: true });
    opts.asOf = "2026-09-26T20:00:00.000Z";
    expect(exportBriefDensity(opts)).toEqual({ batches: 1, candidates: 2, tracesWithoutBatch: 0 });
    expect(readPool(opts.outputDir)).toHaveLength(1);
  });
  it("binds an attested asOf to a stable backup interval and byte-identical offline DB", () => {
    const { opts, dir } = setup();
    const { path } = attachBackupReceipt(opts, dir);
    exportBriefDensity(opts);
    const result = JSON.parse(readFileSync(join(opts.outputDir, "snapshot-manifest.json"), "utf8"));
    expect(result.snapshot_time_evidence.status).toBe("db_interval_no_external_commit_observed");
    expect(result.snapshot_time_evidence.backup_manifest_sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(result.snapshot_time_evidence.completed_at).toBe(opts.asOf);
    expect(result.snapshot_time_evidence.backup_db_sha256).toBe(result.snapshot_sha256);
    expect(result.snapshot_time_evidence.declared_backup_status).toBe("incomplete");
    expect(result.snapshot_time_evidence.verification_scope).toBe("db_and_interval_only");
  });
  it("rejects missing, changed or nonstable backup time evidence before creating output", () => {
    const { opts, dir } = setup();
    const { manifest, path } = attachBackupReceipt(opts, dir);
    const write = () => writeFileSync(path, JSON.stringify(manifest));
    manifest.db_snapshot_interval.source_data_version_after = 2;
    manifest.db_snapshot_interval.source_data_version_unchanged = false;
    write();
    expect(() => exportBriefDensity(opts)).toThrow("backup_interval_external_commit_observed");
    manifest.db_snapshot_interval.source_data_version_after = 1;
    manifest.db_snapshot_interval.source_data_version_unchanged = true;
    manifest.db_snapshot_interval.completed_at = "2026-09-26T17:59:59.000Z";
    write();
    expect(() => exportBriefDensity(opts)).toThrow("as_of_must_equal_stable_interval_end");
    manifest.db_snapshot_interval.completed_at = opts.asOf;
    manifest.db_snapshot_interval.db_sha256 = "0".repeat(64);
    write();
    expect(() => exportBriefDensity(opts)).toThrow("backup_interval_or_db_binding_invalid");
    manifest.db_snapshot_interval.db_sha256 = manifest.files[0].sha256;
    write();
    writeFileSync(join(dir, "backup", "insight.db"), "wrong bytes");
    expect(() => exportBriefDensity(opts)).toThrow("backup_source_db_mismatch");
    manifest.status = "invalid";
    write();
    expect(() => exportBriefDensity(opts)).toThrow("backup_manifest_invalid");
    writeFileSync(path, JSON.stringify({ ...manifest, status: ["complete"] }));
    expect(() => exportBriefDensity(opts)).toThrow("backup_manifest_invalid");
    expect(existsSync(opts.outputDir)).toBe(false);
  });
  it("records both publication and later exclusion without rewriting the earlier publication", () => {
    const { opts } = setup(); const db = new Database(opts.dbPath);
    db.exec(`UPDATE report SET generated_at='2026-09-25T17:00:00.000Z' WHERE id='future';
      UPDATE report SET insight_ids='["i"]' WHERE id='r';
      UPDATE report_selection_decision SET decision='published',reason_code='selected_by_rule',published_rank=1 WHERE report_id='r';`); db.close();
    exportBriefDensity(opts);
    const candidate = readPool(opts.outputDir)[0].candidates[0];
    expect(candidate.terminal).toBe("published");
    expect(candidate.report_outcomes.map((r: { terminal: string }) => r.terminal)).toEqual(["published", "history_or_freshness_filtered"]);
  });
  it("preserves rejected draft text present in coverage audits without approving it", () => {
    const { opts } = setup(); const db = new Database(opts.dbPath);
    db.prepare("UPDATE display_coverage_candidate_audit SET decision=? WHERE candidate_id='rejected'").run(JSON.stringify({ claims: [{ claim_id: "statement:1", field: "statement", text: "Unverified draft", supports: false }] })); db.close();
    exportBriefDensity(opts); const rejected = readPool(opts.outputDir)[0].candidates[1];
    expect(rejected.candidate_text_status).toBe("audit_claim_text_available");
    expect(rejected.audit_claims[0].text).toBe("Unverified draft");
    expect(rejected.insight).toBeNull();
    expect(rejected.experiment_eligibility).toBe("not_evaluated");
    expect(rejected.terminal).toBe("display_audit_rejected");
  });
  it("rejects a correctly hashed archive envelope for a different source version", () => {
    const { opts } = setup({ wrongArchive: true }); exportBriefDensity(opts);
    const source = readPool(opts.outputDir)[0].input_evidence[0];
    expect(source.archive.file_integrity_verified).toBe(true);
    expect(source.archive.content_version_verified).toBe(false);
    expect(source.gaps).toContain("archive_content_version_mismatch");
  });
  it("retains source and quote gaps without silently removing candidates", () => {
    const { opts } = setup(); const db = new Database(opts.dbPath);
    db.exec("UPDATE content_item SET body='changed'; UPDATE citation SET locator='{\"char_start\":-1,\"char_end\":1}';"); db.close();
    exportBriefDensity(opts); const [record] = readPool(opts.outputDir);
    expect(record.candidates).toHaveLength(2);
    expect(record.input_evidence[0].body).toBeNull();
    expect(record.input_evidence[0].gaps).toContain("source_version_mismatch");
    expect(record.candidates[0].citations[0].locator_verified).toBe(false);
  });
  it("does not expose a body or verify a quote against an invalid source revision", () => {
    const { opts } = setup({ invalidRevision: true });
    exportBriefDensity(opts); const [record] = readPool(opts.outputDir);
    expect(record.input_evidence[0].gaps).toContain("revision_missing_or_invalid");
    expect(record.input_evidence[0].body).toBeNull();
    expect(record.input_evidence[0].archive.content_version_verified).toBe(false);
    expect(record.candidates[0].citations[0].locator_verified).toBe(false);
  });
  it("exports known failed diagnostics while leaving the unobserved total unknown", () => {
    const { opts } = setup({ failedOnly: true, diagnostics: true }); opts.dataDir = undefined;
    exportBriefDensity(opts); const [record] = readPool(opts.outputDir);
    expect(record.observed_candidate_count).toBe(1);
    expect(record.total_candidate_count).toBe("unknown");
    expect(record.analysis_diagnostics[0].verified).toBe(true);
    const loss = JSON.parse(readFileSync(join(opts.outputDir, "stage-loss.json"), "utf8"));
    expect(loss.observed_candidates_without_batch).toBe(1);
    expect(loss.input_evidence_gaps_by_kind.trace_without_batch.archive_file_missing).toBe(1);
  });
  it("does not fabricate candidates for a failed attempt with no diagnostics", () => {
    const { opts } = setup({ failedOnly: true }); exportBriefDensity(opts);
    const [record] = readPool(opts.outputDir); expect(record.candidates).toBeNull(); expect(record.total_candidate_count).toBe("unknown");
  });
  it("rejects non-isolated paths, WAL sidecars and output reuse", () => {
    const { opts, dir } = setup();
    expect(() => exportBriefDensity({ ...opts, dbPath: "relative.db" })).toThrow("absolute_paths_required");
    expect(() => exportBriefDensity({ ...opts, topics: ["t", "t"] })).toThrow("invalid_cohort");
    expect(() => exportBriefDensity({ ...opts, backupManifestPath: "relative-manifest.json" })).toThrow("absolute_paths_required");
    expect(() => exportBriefDensity({ ...opts, outputDir: resolve("docs", "unsafe-brief-export") })).toThrow("output_dir_must_be_gitignored");
    const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
    try {
      process.env.GIT_CEILING_DIRECTORIES = process.cwd();
      expect(() => exportBriefDensity({ ...opts, outputDir: resolve("docs", "unsafe-brief-export") })).toThrow("output_dir_must_be_gitignored");
    } finally {
      if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
    }
    const link = join(dir, "link.db"); symlinkSync(opts.dbPath, link);
    expect(() => exportBriefDensity({ ...opts, dbPath: link })).toThrow("snapshot_symlink_forbidden");
    writeFileSync(`${opts.dbPath}-wal`, "");
    expect(() => exportBriefDensity(opts)).toThrow("standalone_offline_snapshot_required");
  });
  it("allows a private output path covered by Git ignore rules", () => {
    const { opts } = setup();
    const repo = mkdtempSync(join(tmpdir(), "brief-density-git-")); dirs.push(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "private/\n");
    mkdirSync(join(repo, "private"));
    opts.outputDir = join(repo, "private", "out");
    expect(exportBriefDensity(opts).candidates).toBe(2);
  });
  it("fails closed on redacted snapshots", () => {
    const { opts } = setup(); const db = new Database(opts.dbPath);
    db.exec(`INSERT INTO provenance_redaction VALUES('x','content:c','content','removed','2026-09-24','2027-09-24','registry','2026-09-24')`); db.close();
    expect(() => exportBriefDensity(opts)).toThrow("redacted_snapshot_requires_scoped_export_review");
    expect(existsSync(opts.outputDir)).toBe(false);
  });
  it("does not guess a single terminal from conflicting report attempts", () => {
    expect(terminalBucket(null, { id: "i" }, [], [{ reason_code: "batch_duplicate" }, { reason_code: "supplemental_limit" }], false)).toBe("multiple_attempt_outcomes");
    expect(terminalBucket(null, { id: "i" }, [], [{ reason_code: "already_published_event" }], true)).toBe("published");
    expect(terminalBucket({ terminal_reason: "unknown" }, null, [], [], false)).toBe("unknown");
  });
});
