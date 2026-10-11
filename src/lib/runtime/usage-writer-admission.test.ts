import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { generateKeyPairSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../../ops/maintenance/ledger.mjs";
import { initializeWriters, openWriters } from "../../../ops/maintenance/writers.mjs";
import { openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { insertTopic } from "../db/repos.js";
import { createDeepDiveTraceRequest, claimNextGenerationDispatch } from "../db/provenance.js";
import { openUsageDispatchDriver } from "./usage-dispatch-driver.js";
import type { UsageIdentity } from "../db/model-usage.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.R3_USAGE_EVIDENCE_DIR ?? tmpdir(), "admission-"))); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync("ed25519");
  initialize(root, { target: { region: "isolated", instanceId: "fixture-app", volumeId: "fixture-data", dataPath: root, serviceSet: ["app"] }, approverId: "fixture-reviewer", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }); initializeWriters(root);
  const path = join(root, "fixture-business.sqlite"), seed = openDb(path); chmodSync(path, 0o600); applyProvenanceMigrations(seed);
  insertTopic(seed, { id: "topic_a", name: "A", keywords: [], language: "en", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [] });
  createDeepDiveTraceRequest(seed, { topicId: "topic_a", idempotencyKeyHash: "a".repeat(64), planning: true });
  seed.pragma("wal_checkpoint(TRUNCATE)"); seed.pragma("journal_mode=DELETE"); seed.close();
  const driver = openUsageDispatchDriver(root), db = driver.db, writers = openWriters(root), worker = writers.register("usage-one", "generation-dispatch");
  let registryClosed = false;
  const closeRegistry = () => { writers.close(); registryClosed = true; };
  const admission = writers.usageAdmissionFor(worker, db, driver), cap = admission.admit(), claim = claimNextGenerationDispatch(db)!; admission.bindClaim(cap, claim);
  const controller = new AbortController(), run = admission.bindRun(cap, { runId: claim.rootRunId, traceId: claim.traceId }, controller.signal);
  const identity: UsageIdentity = { attempt_id: "attempt_a", logical_call_id: "call_a", attempt_number: 1, run_id: claim.rootRunId, trace_id: claim.traceId, role: "analyzer", provider: "anthropic", model: "claude-sonnet-4-6", started_at: "2026-10-12T00:00:00Z" };
  cleanup.push(() => { if (db.open) { writeFileSync(join(root, "facts.json"), JSON.stringify(db.prepare("SELECT * FROM model_usage_attempt").all()), { mode: 0o600 }); driver.close(); } if (!registryClosed) closeRegistry(); });
  return { root, path, driver, db, writers, worker, admission, cap, claim, controller, run, identity, closeRegistry };
}
const observation = { observation_number: 1, final: true, usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
it("reopened registry cannot turn a durable replay into a fresh observer credential", () => {
  const f = fixture(); expect(f.run.beginAttempt(f.identity)).toMatchObject({ replayed: false });
  f.closeRegistry();
  const writers = openWriters(f.root);
  try {
    const worker = writers.register("usage-reopened", "generation-dispatch"), admission = writers.usageAdmissionFor(worker, f.db, f.driver), cap = admission.admit();
    admission.bindClaim(cap, f.claim);
    const run = admission.bindRun(cap, { runId: f.claim.rootRunId, traceId: f.claim.traceId }, new AbortController().signal);
    expect(run.beginAttempt(f.identity)).toMatchObject({ kind: "committed", replayed: true });
    expect(run.observeAttempt(f.identity.attempt_id, observation)).toMatchObject({ code: "writer_usage_capability_invalid" });
    expect(run.beginAttempt({ ...f.identity, attempt_id: "new_after_replay" })).toMatchObject({ code: "writer_usage_capability_invalid" });
    expect(f.db.prepare("SELECT usage_status,estimate_usd FROM model_usage_attempt").get()).toEqual({ usage_status: "unknown", estimate_usd: null });
  } finally { writers.close(); }
});
it("replacing the root directory with unchanged business inode rejects old driver and capability", () => {
  const f = fixture(), retained = f.root + "-retained";
  renameSync(f.root, retained); mkdirSync(f.root, { mode: 0o700 });
  for (const name of readdirSync(retained)) renameSync(join(retained, name), join(f.root, name));
  expect(f.driver.begin(f.claim, f.identity)).toMatchObject({ code: "writer_usage_business_mismatch" });
  expect(f.run.beginAttempt(f.identity)).toMatchObject({ code: "writer_usage_business_mismatch" });
  expect(f.db.prepare("SELECT count(*) n FROM model_usage_attempt").get()).toEqual({ n: 0 });
});
it("accounts an actual child Run after its local completion without changing either Run", () => {
  const f = fixture();
  f.db.prepare("INSERT INTO run(id,kind,target,status,started_at,trace_id) VALUES ('child','analyze','{}','running','2026-10-12T00:00:00Z',?)").run(f.claim.traceId);
  const run = f.admission.bindRun(f.cap, { runId: "child", traceId: f.claim.traceId }, f.controller.signal);
  const identity = { ...f.identity, attempt_id: "child_attempt", run_id: "child" };
  expect(run.beginAttempt(identity).kind).toBe("committed"); f.db.exec("UPDATE run SET status='failed' WHERE id='child'");
  const before = f.db.prepare("SELECT * FROM run ORDER BY id").all();
  expect(run.observeAttempt(identity.attempt_id, observation).kind).toBe("committed");
  expect(run.beginAttempt({ ...identity, attempt_id: "late_begin", attempt_number: 2 })).toMatchObject({ code: "generation_fence_lost" });
  expect(f.db.prepare("SELECT * FROM run ORDER BY id").all()).toEqual(before);
});
function childClose(root: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import {openWriters} from ${JSON.stringify(new URL("../../../ops/maintenance/writers.mjs", import.meta.url).href)};let w;try{w=openWriters(process.argv[1]);w.closeAdmission();console.log('CLOSED');}catch(e){console.log(e.code??e.message);}finally{w?.close();}`, root], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 5000, encoding: "utf8" });
}
it("allows cancelled/local-finished existing observer only while original lease and maintenance remain valid", () => {
  const f = fixture(); expect(f.run.beginAttempt(f.identity).kind).toBe("committed");
  f.controller.abort(); f.admission.finish(f.cap, "threw");
  expect(f.run.observeAttempt(f.identity.attempt_id, observation).kind).toBe("committed");
  expect(f.run.beginAttempt({ ...f.identity, attempt_id: "another", attempt_number: 2 }).kind).toBe("not_committed");
  f.writers.closeAdmission(); expect(f.run.observeAttempt(f.identity.attempt_id, { ...observation, observation_number: 2 })).toMatchObject({ code: "writer_usage_closed" });
  expect(f.db.prepare("SELECT usage_status,input_tokens FROM model_usage_attempt").get()).toEqual({ usage_status: "reported", input_tokens: 7 });
  expect(f.writers.inspect().writer_quiescence).toBe(false);
});
it("persisted completion blocks new begin even if local finish acknowledgement was not observed", () => {
  const f = fixture(); f.run.beginAttempt(f.identity);
  f.writers.finish({ ...f.worker, taskId: f.writers.inspect().tasks[0].taskId }, "threw");
  expect(f.run.beginAttempt({ ...f.identity, attempt_id: "new_after_finish", attempt_number: 2 })).toMatchObject({ code: "writer_usage_capability_invalid" });
  expect(f.run.observeAttempt(f.identity.attempt_id, observation).kind).toBe("committed");
});
it("close-first denies and commit-first holds registry through real outer COMMIT; check-release negative permits the race", () => {
  const denied = fixture(); expect(childClose(denied.root).stdout).toContain("CLOSED");
  expect(denied.run.beginAttempt(denied.identity)).toMatchObject({ code: "writer_usage_closed" });
  const f = fixture(), exec = f.db.exec.bind(f.db); let competitor = "";
  f.db.exec = sql => { if (sql === "COMMIT") competitor = childClose(f.root).stdout; return exec(sql); };
  expect(f.run.beginAttempt(f.identity).kind).toBe("committed"); f.db.exec = exec;
  expect(competitor).toContain("SQLITE_BUSY"); expect(childClose(f.root).stdout).toContain("CLOSED");
  const negative = fixture(); expect(negative.writers.inspect().admission).toBe("open"); expect(childClose(negative.root).stdout).toContain("CLOSED");
  expect(negative.driver.begin(negative.claim, negative.identity).kind).toBe("committed"); // Outside permit is the required old check-release negative control.
});
it("registry ACK loss retains committed accounting and poisons capability rather than reissuing", () => {
  const f = fixture(), exec = f.db.exec.bind(f.db);
  f.db.exec = sql => { const value = exec(sql); if (sql === "COMMIT") f.closeRegistry(); return value; };
  expect(f.run.beginAttempt(f.identity)).toMatchObject({ kind: "unknown", businessCommit: "committed", code: "writer_usage_registry_commit_unknown" }); f.db.exec = exec;
  expect(f.db.prepare("SELECT count(*) n FROM model_usage_attempt").get()).toEqual({ n: 1 });
  expect(f.run.observeAttempt(f.identity.attempt_id, observation)).toMatchObject({ code: "writer_usage_capability_invalid" });
});
it("business busy and unsafe cached sidecar deny before publication, retaining the exact file bytes", () => {
  const f = fixture(), blocker = new Database(f.path, { timeout: 0 }); blocker.exec("BEGIN IMMEDIATE");
  try { expect(f.run.beginAttempt(f.identity)).toMatchObject({ code: "writer_usage_busy" }); }
  finally { blocker.exec("ROLLBACK"); blocker.close(); }
  const unsafe = fixture(), journal = unsafe.path + "-journal";
  writeFileSync(journal, "synthetic unsafe journal", { mode: 0o666 }); chmodSync(journal, 0o666);
  const before = createHash("sha256").update(readFileSync(journal)).digest("hex");
  expect(unsafe.run.beginAttempt(unsafe.identity)).toMatchObject({ code: "writer_usage_business_mismatch" });
  expect(createHash("sha256").update(readFileSync(journal)).digest("hex")).toBe(before);
  // Inspection may recover a safe synthetic journal; the consumer above did no SQL before rejecting it.
  chmodSync(journal, 0o600);
});
it.each(["owner", "epoch", "root", "expired"])("denies late observation on %s change, preserving unknown and no Run cleanup", fault => {
  const f = fixture(); f.run.beginAttempt(f.identity);
  if (fault === "owner") f.db.exec("UPDATE generation_lease SET owner_token='other'");
  if (fault === "epoch") f.db.exec("UPDATE generation_lease SET fencing_epoch=fencing_epoch+1");
  if (fault === "root") f.db.exec("UPDATE generation_trace SET root_run_id=NULL");
  if (fault === "expired") f.db.exec("UPDATE generation_lease SET expires_at='2000-01-01T00:00:00Z'");
  expect(f.run.observeAttempt(f.identity.attempt_id, observation)).toMatchObject({ code: "generation_fence_lost" });
  expect(f.db.prepare("SELECT usage_status,estimate_usd FROM model_usage_attempt").get()).toEqual({ usage_status: "unknown", estimate_usd: null });
});
it("rejects cloned caps, foreign DB, ATTACH, reverse lock and own-property accessors", () => {
  const f = fixture(), other = fixture();
  expect(() => f.admission.bindRun({ ...f.cap }, { runId: f.identity.run_id, traceId: f.claim.traceId }, f.controller.signal)).toThrow("writer_usage_capability_invalid");
  expect(() => f.writers.usageAdmissionFor(f.worker, other.db, f.driver)).toThrow("writer_usage_business_mismatch");
  let reads = 0; const raw = { ...f.identity }; Object.defineProperty(raw, "model", { get() { reads++; return "bad"; } });
  expect(f.run.beginAttempt(raw)).toMatchObject({ code: "usage_identity_invalid" }); expect(reads).toBe(0);
  const attached = fixture(); attached.db.exec("ATTACH ':memory:' AS foreign_db");
  expect(attached.run.beginAttempt(attached.identity)).toMatchObject({ code: "writer_usage_business_mismatch" }); attached.db.exec("DETACH foreign_db");
  const reversed = fixture(); reversed.db.exec("BEGIN IMMEDIATE"); expect(reversed.run.beginAttempt(reversed.identity)).toMatchObject({ code: "writer_usage_reverse_transaction" }); reversed.db.exec("ROLLBACK");
});
it.each(["before", "after"])("SIGKILL %s native COMMIT preserves crash facts with no resumed old cap", cut => {
  const f = fixture();
  const source = `import{openWriters}from${JSON.stringify(new URL("../../../ops/maintenance/writers.mjs", import.meta.url).href)};import{openUsageDispatchDriver}from${JSON.stringify(new URL("./usage-dispatch-driver.ts", import.meta.url).href)};import{writeFileSync}from'node:fs';const root=process.argv[1],driver=openUsageDispatchDriver(root),writers=openWriters(root),worker=writers.register('crash','generation-dispatch'),a=writers.usageAdmissionFor(worker,driver.db,driver),cap=a.admit(),claim=${JSON.stringify(f.claim)};a.bindClaim(cap,claim);const r=a.bindRun(cap,{runId:claim.rootRunId,traceId:claim.traceId},new AbortController().signal),exec=driver.db.exec.bind(driver.db);driver.db.exec=sql=>{if(sql==='COMMIT'&&process.argv[2]==='before'){writeFileSync(root+'/crash-cut','before',{mode:0o600});process.kill(process.pid,'SIGKILL');}const result=exec(sql);if(sql==='COMMIT'){writeFileSync(root+'/crash-cut','after',{mode:0o600});process.kill(process.pid,'SIGKILL');}return result;};r.beginAttempt(${JSON.stringify(f.identity)});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, f.root, cut], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 5000, encoding: "utf8" });
  expect(child.signal).toBe("SIGKILL"); expect(readFileSync(join(f.root, "crash-cut"), "utf8")).toBe(cut);
  expect(f.db.prepare("SELECT count(*) n FROM model_usage_attempt").get()).toEqual({ n: cut === "after" ? 1 : 0 });
  writeFileSync(join(f.root, "crash-hashes.json"), JSON.stringify({ business: createHash("sha256").update(readFileSync(f.path)).digest("hex"), signal: child.signal, cut }), { mode: 0o600 });
});
it("actual hot journal is rejected preSQL on new/cached handles; legal recovery then consumes a fresh permit", () => {
  const f = fixture(), journal = f.path + "-journal";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import Database from 'better-sqlite3';const d=new Database(process.argv[1],{timeout:0});d.pragma('cache_size=10');d.exec('BEGIN IMMEDIATE');const insert=d.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES(?,'analyze',?,'running','2026-10-12T00:00:00Z')");for(let i=0;i<250;i++)insert.run('crash_pad_'+i,'x'.repeat(5000));process.kill(process.pid,'SIGKILL');`, f.path], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 5000, encoding: "utf8" });
  expect(child.signal).toBe("SIGKILL"); expect(readFileSync(journal).length).toBeGreaterThan(512);
  chmodSync(journal, 0o666);
  const hashes = () => [f.path, journal].map(path => createHash("sha256").update(readFileSync(path)).digest("hex"));
  const before = hashes();
  expect(() => openUsageDispatchDriver(f.root)).toThrow();
  expect(f.run.beginAttempt(f.identity)).toMatchObject({ code: "writer_usage_business_mismatch" }); expect(hashes()).toEqual(before);
  writeFileSync(join(f.root, "unsafe-hot-journal-hashes.json"), JSON.stringify(before), { mode: 0o600 }); chmodSync(journal, 0o600);
  const writers = openWriters(f.root);
  try {
    const worker = writers.register("recovery-test", "generation-dispatch"), admission = writers.usageAdmissionFor(worker, f.db, f.driver), cap = admission.admit();
    admission.bindClaim(cap, f.claim);
    const run = admission.bindRun(cap, { runId: f.claim.rootRunId, traceId: f.claim.traceId }, new AbortController().signal);
    expect(run.beginAttempt(f.identity).kind).toBe("committed");
    expect(f.db.prepare("SELECT count(*) n FROM run WHERE id LIKE 'crash_pad_%'").get()).toEqual({ n: 0 });
  } finally { writers.close(); }
});
