import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PRICING } from "../runtime/cost.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertRun, sumRunCostSince } from "./repos.js";
import { beginModelUsageAttempt, observeModelUsage, listModelUsageAttempts } from "./model-usage.js";
import { MODEL_USAGE_ATTEMPT_SCHEMA_SQL } from "./schema.js";

const databases: DB[] = [];
const dirs: string[] = [];
afterEach(() => { databases.forEach((db) => { if (db.open) db.close(); }); dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function fixture(path = ":memory:") {
  const seed = openDb(":memory:"); databases.push(seed); applyProvenanceMigrations(seed);
  let db = seed;
  insertRun(db, { id: "run_test", kind: "analyze", target: {}, status: "running", started_at: "2026-10-04T00:00:00.000Z", ended_at: null, duration_ms: null, cost: { tokens: 10, amount: 2 }, error: null, retry_of: null });
  if (path !== ":memory:") {
    seed.prepare("VACUUM INTO ?").run(path); seed.close();
    db = new Database(path); databases.push(db); db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
  }
  return db;
}
const identity = { attempt_id: "a_1", logical_call_id: "call_1", attempt_number: 1, run_id: "run_test", trace_id: null, role: "analyzer" as const, provider: "anthropic" as const, model: "claude-sonnet-4-6", started_at: "2026-10-04T00:00:00.000Z" };
const usage = { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const observation = { observation_number: 1, final: true, usage };

it("fresh explicit migration installs only v48, replay leaves all checksums unchanged", () => {
  const db = fixture();
  const ledger = db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all();
  expect(ledger).toHaveLength(48);
  const historical = JSON.parse(readFileSync(new URL("../../../tests/fixtures/c3-v47-migration-checksums.json", import.meta.url), "utf8")) as { ledger: unknown[] };
  expect(ledger.slice(0, 47)).toEqual(historical.ledger);
  applyProvenanceMigrations(db);
  expect(db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all()).toEqual(ledger);
  expect(listModelUsageAttempts(db, "run_test")).toEqual({ available: true, attempts: [] });
});

it("bounded reader exposes the next page instead of silently presenting a complete Run", () => {
  const db = fixture();
  db.transaction(() => {
    for (let index = 1; index <= 1001; index++) beginModelUsageAttempt(db, { ...identity, attempt_id: `a_${index}`, attempt_number: index });
  })();
  const first = listModelUsageAttempts(db, "run_test");
  expect(first.attempts).toHaveLength(1000); expect(first.nextOffset).toBe(1000);
  const second = listModelUsageAttempts(db, "run_test", first.nextOffset);
  expect(second.attempts).toHaveLength(1); expect(second.attempts[0].attempt_number).toBe(1001);
  expect(second.nextOffset).toBeUndefined();
  expect(() => listModelUsageAttempts(db, "run_test", -1)).toThrow("usage_reader_invalid_offset");
});

it("unknown usage is nullable; complete estimate is a local estimate with price snapshot", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity);
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ usage_status: "unknown", input_tokens: null, output_tokens: null, estimate_usd: null, estimate_status: "unknown" });
  observeModelUsage(db, identity.attempt_id, observation);
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ usage_status: "reported", input_tokens: 7, output_tokens: 3, estimate_status: "estimated", estimate_usd: 0.000066, price_source: "local-pricing-table" });
});

it("attempt start and observation replay idempotently; conflicting identity/usage preserve original", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity);
  expect(beginModelUsageAttempt(db, identity)).toEqual({ replayed: true });
  expect(() => beginModelUsageAttempt(db, { ...identity, model: "different" })).toThrow("usage_identity_conflict");
  observeModelUsage(db, identity.attempt_id, observation);
  expect(observeModelUsage(db, identity.attempt_id, observation)).toEqual({ replayed: true });
  expect(() => observeModelUsage(db, identity.attempt_id, { ...observation, usage: { ...usage, output_tokens: 4 } })).toThrow("usage_observation_conflict");
  expect(listModelUsageAttempts(db, "run_test").attempts).toHaveLength(1);
  expect(listModelUsageAttempts(db, "run_test").attempts[0].output_tokens).toBe(3);
});

it("partial cumulative snapshots replace counts; duplicates, conflicts and stale revisions are explicit", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity);
  const partial = { ...observation, final: false, usage: { ...usage, output_tokens: 0 } };
  observeModelUsage(db, identity.attempt_id, partial);
  expect(observeModelUsage(db, identity.attempt_id, partial)).toEqual({ replayed: true });
  expect(() => observeModelUsage(db, identity.attempt_id, { ...partial, usage })).toThrow("usage_observation_conflict");
  observeModelUsage(db, identity.attempt_id, { ...observation, observation_number: 2, final: false });
  expect(() => observeModelUsage(db, identity.attempt_id, partial)).toThrow("usage_observation_stale");
  observeModelUsage(db, identity.attempt_id, { ...observation, observation_number: 3 });
  expect(() => observeModelUsage(db, identity.attempt_id, { ...observation, observation_number: 4, final: false })).toThrow("usage_observation_conflict");
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ input_tokens: 7, output_tokens: 3 });
});

it.each(["unpriced-model", "claude-sonnet-4-6"])("unknown price or Coding Plan is never a zero-dollar bill: %s", (model) => {
  const db = fixture(); beginModelUsageAttempt(db, { ...identity, model, provider: model === "unpriced-model" ? "anthropic" : "volcengine-responses" });
  observeModelUsage(db, identity.attempt_id, observation);
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ estimate_usd: null, estimate_status: "unknown", price_source: null });
});

it("missing input/output and cache distinguish missing from explicit zero", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity);
  observeModelUsage(db, identity.attempt_id, { ...observation, usage: { ...usage, input_tokens: null, cache_read_input_tokens: null } });
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ usage_status: "partial", input_tokens: null, estimate_usd: null });
  beginModelUsageAttempt(db, { ...identity, attempt_id: "a_2", attempt_number: 2 });
  observeModelUsage(db, "a_2", { ...observation, usage: { ...usage, input_tokens: 0, output_tokens: 0 } });
  expect(listModelUsageAttempts(db, "run_test").attempts[1]).toMatchObject({ usage_status: "reported", input_tokens: 0, output_tokens: 0, estimate_usd: 0 });
});
it("higher partial revisions inherit unreported fields and never sum cumulative output", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity);
  observeModelUsage(db, "a_1", { ...observation, final: false });
  observeModelUsage(db, "a_1", { observation_number: 2, final: false, usage: { input_tokens: null, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: null } });
  expect(listModelUsageAttempts(db, "run_test").attempts[0]).toMatchObject({ input_tokens: 7, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, usage_status: "partial", estimate_usd: null });
});

it("every insert/update including replay is fenced inside the write transaction", () => {
  const db = fixture(); const lost = () => { throw new Error("generation_fence_lost"); };
  expect(() => beginModelUsageAttempt(db, identity, lost)).toThrow("generation_fence_lost");
  beginModelUsageAttempt(db, identity);
  expect(() => observeModelUsage(db, identity.attempt_id, observation, lost)).toThrow("generation_fence_lost");
  observeModelUsage(db, identity.attempt_id, observation);
  expect(() => observeModelUsage(db, identity.attempt_id, observation, lost)).toThrow("generation_fence_lost");
});

it("committed usage survives reopening and does not add again to Run budget or P1 ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "c3-restart-")); dirs.push(dir); const path = join(dir, "test.db");
  const db = fixture(path); beginModelUsageAttempt(db, identity); observeModelUsage(db, identity.attempt_id, observation); db.close();
  const reopened = new Database(path); databases.push(reopened);
  expect(listModelUsageAttempts(reopened, "run_test").attempts[0]).toMatchObject({ usage_status: "reported", output_tokens: 3 });
  expect(observeModelUsage(reopened, identity.attempt_id, observation)).toEqual({ replayed: true });
  expect(sumRunCostSince(reopened, "2026-10-01")).toBe(2);
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM cost_ledger").get()).toEqual({ n: 0 });
});

it("v47 upgrade is additive and atomic; readonly old/new readers never migrate or write", () => {
  const dir = mkdtempSync(join(tmpdir(), "c3-upgrade-")); dirs.push(dir); const path = join(dir, "test.db");
  const db = fixture(path);
  db.exec("DROP TABLE model_usage_attempt; DELETE FROM schema_migration WHERE version='20261004_48_model_usage_attempt';");
  const oldLedger = db.prepare("SELECT * FROM schema_migration").all(); db.close();
  const old = new Database(path, { readonly: true }); databases.push(old);
  const before = readFileSync(path);
  expect(listModelUsageAttempts(old, "run_test")).toEqual({ available: false, attempts: [] }); old.close();
  expect(readFileSync(path)).toEqual(before);
  const writer = new Database(path); databases.push(writer); writer.pragma("foreign_keys = ON");
  writer.exec("CREATE TABLE model_usage_attempt(synthetic_blocker TEXT)");
  expect(() => applyProvenanceMigrations(writer)).toThrow();
  expect(writer.prepare("SELECT * FROM schema_migration").all()).toEqual(oldLedger);
  writer.exec("DROP TABLE model_usage_attempt"); applyProvenanceMigrations(writer);
  expect(writer.prepare("SELECT * FROM schema_migration WHERE version<>'20261004_48_model_usage_attempt'").all()).toEqual(oldLedger);
  beginModelUsageAttempt(writer, identity); writer.close();
  const ro = new Database(path, { readonly: true }); databases.push(ro);
  const newBefore = readFileSync(path);
  expect(listModelUsageAttempts(ro, "run_test").available).toBe(true);
  expect(() => observeModelUsage(ro, identity.attempt_id, observation)).toThrow(); ro.close();
  expect(readFileSync(path)).toEqual(newBefore);
}, 30_000); // Real file migration/rollback performs durable fsyncs; retain normal global timeout.

it("schema fact source matches installed frozen DDL; invalid counts are rejected", () => {
  const db = fixture(); const source = new Database(":memory:"); databases.push(source); source.exec(MODEL_USAGE_ATTEMPT_SCHEMA_SQL);
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'model_usage%'").all()).toEqual(source.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'model_usage%'").all());
  beginModelUsageAttempt(db, identity);
  expect(() => observeModelUsage(db, identity.attempt_id, { ...observation, usage: { ...usage, output_tokens: -1 } })).toThrow("usage_count_invalid");
});

it("complete replay keeps original price snapshot even if a later binary changes local pricing", () => {
  const db = fixture(); beginModelUsageAttempt(db, identity); observeModelUsage(db, identity.attempt_id, observation);
  const original = PRICING[identity.model]; const stored = listModelUsageAttempts(db, "run_test").attempts[0];
  try {
    PRICING[identity.model] = { input: 100, output: 100 };
    expect(observeModelUsage(db, identity.attempt_id, observation)).toEqual({ replayed: true });
    expect(listModelUsageAttempts(db, "run_test").attempts[0]).toEqual(stored);
  } finally { PRICING[identity.model] = original; }
});

it("SIGKILL after committed usage preserves WAL facts; restarted reader cannot infer unreported attempts", () => {
  const dir = mkdtempSync(join(tmpdir(), "c3-crash-")); dirs.push(dir); const path = join(dir, "test.db");
  const prepared = fixture(path); prepared.close();
  const code = `
    import { openDb } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { beginModelUsageAttempt, observeModelUsage } from ${JSON.stringify(new URL("./model-usage.ts", import.meta.url).href)};
    const db=openDb(${JSON.stringify(path)}, {bootstrap:false});
    beginModelUsageAttempt(db,${JSON.stringify(identity)});
    observeModelUsage(db,"a_1",${JSON.stringify(observation)});
    beginModelUsageAttempt(db,{...${JSON.stringify(identity)},attempt_id:"a_2",attempt_number:2});
    process.stdout.write("committed"); process.kill(process.pid,"SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 5000 });
  expect(child.stdout).toBe("committed"); expect(child.signal).toBe("SIGKILL");
  const reader = new Database(path, { readonly: true }); databases.push(reader);
  expect(listModelUsageAttempts(reader, "run_test").attempts.map((a) => a.usage_status)).toEqual(["reported", "unknown"]);
});
