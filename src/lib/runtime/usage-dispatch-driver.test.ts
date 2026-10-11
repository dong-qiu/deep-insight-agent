import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../../ops/maintenance/ledger.mjs";
import { openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { insertTopic } from "../db/repos.js";
import { createDeepDiveTraceRequest, claimNextGenerationDispatch } from "../db/provenance.js";
import { openUsageDispatchDriver } from "./usage-dispatch-driver.js";
import type { UsageIdentity } from "../db/model-usage.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.R3_USAGE_EVIDENCE_DIR ?? tmpdir(), "driver-"))); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync("ed25519");
  initialize(root, { target: { region: "isolated", instanceId: "fixture-app", volumeId: "fixture-data", dataPath: root, serviceSet: ["app"] }, approverId: "fixture-reviewer", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() });
  const path = join(root, "fixture-business.sqlite"), seed = openDb(path); chmodSync(path, 0o600); applyProvenanceMigrations(seed);
  insertTopic(seed, { id: "topic_a", name: "A", keywords: [], language: "en", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [] });
  createDeepDiveTraceRequest(seed, { topicId: "topic_a", idempotencyKeyHash: "a".repeat(64), planning: true });
  seed.pragma("wal_checkpoint(TRUNCATE)"); seed.pragma("journal_mode=DELETE"); seed.close();
  const driver = openUsageDispatchDriver(root), db = driver.db, claim = claimNextGenerationDispatch(db)!;
  const identity: UsageIdentity = { attempt_id: "attempt_a", logical_call_id: "call_a", attempt_number: 1, run_id: claim.rootRunId, trace_id: claim.traceId, role: "analyzer", provider: "anthropic", model: "claude-sonnet-4-6", started_at: "2026-10-12T00:00:00Z" };
  cleanup.push(() => { if (db.open) { writeFileSync(join(root, "facts.json"), JSON.stringify(db.prepare("SELECT * FROM model_usage_attempt").all()), { mode: 0o600 }); driver.close(); } });
  return { root, driver, db, claim, identity };
}
describe("fixed usage synchronous native commit", () => {
  it("persists begin/observe/replay through actual outer COMMIT and preserves unknown versus real zero", () => {
    const f = fixture(); expect(f.driver.begin(f.claim, f.identity)).toEqual({ kind: "committed", businessCommit: "committed", replayed: false });
    expect(f.driver.begin(f.claim, f.identity)).toMatchObject({ replayed: true });
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(f.driver.observe(f.claim, f.identity, { observation_number: 1, final: true, usage })).toMatchObject({ kind: "committed" });
    expect(f.driver.observe(f.claim, f.identity, { observation_number: 1, final: true, usage })).toMatchObject({ replayed: true });
    expect(f.db.prepare("SELECT usage_status,estimate_usd FROM model_usage_attempt").get()).toEqual({ usage_status: "reported", estimate_usd: 0 });
    expect(f.db.inTransaction).toBe(false);
  });
  it.each(["prebegin", "commit-before", "commit-after", "rollback-unknown"])("classifies %s without rewriting committed facts", cut => {
    const f = fixture(), exec = f.db.exec.bind(f.db); let rollbackCalls = 0;
    if (cut === "rollback-unknown") f.db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'fixture-fault'); END");
    f.db.exec = sql => {
      if (sql === "ROLLBACK") { rollbackCalls++; if (cut === "rollback-unknown") throw new Error("fixture-rollback"); }
      if ((cut === "prebegin" && sql === "BEGIN IMMEDIATE") || (cut === "commit-before" && sql === "COMMIT")) throw new Error("fixture-cut");
      const value = exec(sql); if (cut === "commit-after" && sql === "COMMIT") throw new Error("fixture-ack"); return value;
    };
    const result = f.driver.begin(f.claim, f.identity); f.db.exec = exec;
    if (cut === "prebegin") { expect(result.kind).toBe("not_committed"); expect(rollbackCalls).toBe(0); }
    else expect(result.kind).toBe("unknown");
    if (f.db.inTransaction) f.db.exec("ROLLBACK");
    expect(f.db.prepare("SELECT count(*) n FROM model_usage_attempt").get()).toEqual({ n: cut === "commit-after" ? 1 : 0 });
  });
  it("rejects reverse transaction, wrong run/trace, lease loss and getters with no accounting write", () => {
    const f = fixture(); f.db.exec("BEGIN IMMEDIATE");
    expect(f.driver.begin(f.claim, f.identity)).toMatchObject({ code: "writer_usage_reverse_transaction" }); f.db.exec("ROLLBACK");
    expect(f.driver.begin(f.claim, { ...f.identity, run_id: "other_run" })).toMatchObject({ code: "generation_fence_lost" });
    let reads = 0; const bad = { ...f.identity }; Object.defineProperty(bad, "model", { get() { reads++; return "unsafe"; } });
    expect(f.driver.begin(f.claim, bad)).toMatchObject({ code: "usage_identity_invalid" }); expect(reads).toBe(0);
    f.db.exec("UPDATE generation_lease SET owner_token='other'");
    expect(f.driver.begin(f.claim, f.identity)).toMatchObject({ code: "generation_fence_lost" });
    expect(f.db.prepare("SELECT count(*) n FROM model_usage_attempt").get()).toEqual({ n: 0 });
  });
});
