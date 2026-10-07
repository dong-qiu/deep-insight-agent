import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { initialize, openLedger, submitFixtureOnce } from "./ledger.mjs";
import { bindingFor, canonical, DOMAIN, hash } from "./contract.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const cliPath = join(directory, "cli.mjs");
const commandHash = hash("fixture command, no AWS");
function fixture(t, initialized = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a3-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const target = { region: "isolated", instanceId: "fixture-instance", volumeId: "fixture-volume", dataPath: root, serviceSet: ["app", "cron", "worker"] };
  const config = { target, approverId: "approver", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
  if (initialized) initialize(root, config);
  const request = (operationId = "op-deploy", kind = "deploy") => ({ operationId, ownerId: "owner", kind, executionIdentity: "fixture-executor", target });
  const cli = (action, input = null) => spawnSync(process.execPath, [cliPath, root, action], { input: JSON.stringify(input), encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000 });
  const open = () => { const ledger = openLedger(root); t.after(() => { try { ledger.close(); } catch { /* May already be closed to simulate restart. */ } }); return ledger; };
  return { root, keys, target, config, request, cli, open };
}
function op(ledger, token) { return ledger.inspect().operations[token.operationId]; }
function evidence(f, operation, overrides = {}) {
  const body = canonical({ ...bindingFor(operation), schema: "fixture-process-stop-v1", remoteFixtureStopped: true,
    localControllerStopped: true, continuationsStopped: true, outcome: operation.terminal ?? "NotSubmitted", ...overrides });
  const digest = hash(body);
  writeFileSync(join(f.root, `evidence-${digest}.json`), body, { flag: "wx", mode: 0o600 });
  return digest;
}
function signed(f, operation, action, overrides = {}) {
  const payload = { ...bindingFor(operation), schema: "a3-authorization-v1", revision: operation.revision,
    approverId: "approver", action, reason: "fixture reviewer verified the scoped evidence",
    processesStopped: action !== "takeover", evidenceHash: action === "takeover" ? null : evidence(f, operation), ...overrides };
  return { payload, signature: sign(null, Buffer.from(DOMAIN + canonical(payload)), f.keys.privateKey).toString("hex") };
}
function submitted(f, ledger) {
  const token = ledger.beginSubmit(ledger.acquire(f.request()), commandHash);
  const binding = { ...bindingFor(op(ledger, token)), commandId: randomUUID() };
  return { token: ledger.bindCommand(token, binding), binding, unknown: token };
}
function child(f, action, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [cliPath, f.root, action], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    let stdout = "", stderr = "";
    process.stdout.on("data", data => { stdout += data; }); process.stderr.on("data", data => { stderr += data; });
    process.on("error", reject); process.on("exit", status => resolve({ status, stdout, stderr }));
    process.stdin.end(JSON.stringify(input));
  });
}

test("cross-entry exclusion, replay and restart preserve the owner", t => {
  const f = fixture(t), ledger = f.open(), a = ledger.acquire(f.request());
  const snapshot = canonical(ledger.inspect());
  assert.deepEqual(ledger.acquire(f.request()), a);
  assert.equal(canonical(ledger.inspect()), snapshot);
  for (const kind of ["backup", "restore"]) assert.throws(() => ledger.acquire(f.request(`op-${kind}`, kind)), /maintenance_busy/);
  ledger.close();
  const restarted = f.open();
  assert.equal(restarted.inspect().active, "op-deploy");
  assert.throws(() => restarted.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
});

test("real CLI deploy/backup/restore requests compete in independent processes", async t => {
  const f = fixture(t);
  const results = await Promise.all(["deploy", "backup", "restore"].map(kind => child(f, "acquire", f.request(`op-${kind}`, kind))));
  assert.equal(results.filter(r => r.status === 0).length, 1);
  for (const result of results.filter(r => r.status === 0)) assert.equal(JSON.parse(result.stdout).production_permitted, false);
  for (const result of results.filter(r => r.status !== 0)) assert.match(result.stderr, /maintenance_busy|maintenance_failed/);
  const state = f.open().inspect();
  assert.equal(state.fence, 1);
  assert.equal(Object.keys(state.operations).length, 1);
});

test("BEGIN IMMEDIATE is nonwaiting when another process owns a transaction", t => {
  const f = fixture(t), blocker = new Database(join(f.root, "ledger.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  try { const result = f.cli("acquire", f.request()); assert.notEqual(result.status, 0); assert.match(result.stderr, /maintenance_failed/); }
  finally { blocker.exec("ROLLBACK"); blocker.close(); }
  assert.equal(f.open().inspect().fence, 0);
});

test("target/owner/kind/identity conflict and old fence cannot release a new operation", t => {
  const f = fixture(t), ledger = f.open(), a = ledger.acquire(f.request());
  for (const change of [{ ownerId: "other" }, { kind: "backup" }, { executionIdentity: "fixture-other" }]) {
    assert.throws(() => ledger.acquire({ ...f.request(), ...change }), /maintenance_operation_conflict/);
  }
  assert.throws(() => ledger.acquire({ ...f.request(), target: { ...f.target, volumeId: "fixture-other" } }), /maintenance_target_mismatch/);
  assert.throws(() => ledger.complete({ ...a, ownerId: "other" }), /maintenance_owner_lost/);
  ledger.complete(a);
  const b = ledger.acquire(f.request("op-backup", "backup"));
  assert.equal(b.fence, 2);
  assert.throws(() => ledger.complete(a), /maintenance_owner_lost/);
  assert.deepEqual(ledger.acquire(f.request()), { ...a, revision: 2 }); // historical replay never acquires
  assert.equal(ledger.inspect().active, "op-backup");
});

test("initialization validates isolated target and rejects foreign data", t => {
  const f = fixture(t, false);
  for (const change of [{ region: "ap-southeast-1" }, { instanceId: "i-production" }, { dataPath: "/data" }, { serviceSet: ["cron", "app"] }]) {
    assert.throws(() => initialize(f.root, { ...f.config, target: { ...f.target, ...change } }));
    assert.equal(existsSync(join(f.root, "isolation.json")), false);
  }
  writeFileSync(join(f.root, "foreign-file"), "preserve me");
  assert.throws(() => initialize(f.root, f.config), /maintenance_root_not_empty/);
  assert.equal(readFileSync(join(f.root, "foreign-file"), "utf8"), "preserve me");
});

test("two initializers cannot replace one another", async t => {
  const f = fixture(t, false);
  const result = await Promise.all([child(f, "init", f.config), child(f, "init", f.config)]);
  assert.equal(result.filter(r => r.status === 0).length, 1);
  assert.equal(f.open().inspect().revision, 0);
});

for (const fault of ["missing-db", "missing-marker", "marker-only", "empty-db", "bad-version", "bad-marker", "wrong-permission", "symlink", "hardlink", "partial-write", "wrong-schema", "wrong-genesis"]) {
  test(`fail closed and retain evidence: ${fault}`, t => {
    const f = fixture(t);
    const dbPath = join(f.root, "ledger.sqlite"), markerPath = join(f.root, "isolation.json");
    if (fault === "missing-db" || fault === "marker-only") rmSync(dbPath);
    if (fault === "missing-marker") rmSync(markerPath);
    if (fault === "empty-db") writeFileSync(dbPath, "");
    if (fault === "bad-version") { const db = new Database(dbPath); db.pragma("user_version=2"); db.close(); }
    if (fault === "bad-marker") writeFileSync(markerPath, "{partial");
    if (fault === "wrong-permission") chmodSync(dbPath, 0o644);
    if (fault === "symlink") { rmSync(dbPath); symlinkSync(markerPath, dbPath); }
    if (fault === "hardlink") linkSync(dbPath, join(f.root, "another-link"));
    if (fault === "partial-write") writeFileSync(dbPath, readFileSync(dbPath).subarray(0, 200));
    if (fault === "wrong-schema") { const db = new Database(dbPath); db.exec("DROP TRIGGER events_no_delete"); db.close(); }
    if (fault === "wrong-genesis") { const m = JSON.parse(readFileSync(markerPath, "utf8")); m.initId = randomUUID(); writeFileSync(markerPath, canonical(m)); }
    const before = existsSync(markerPath) ? readFileSync(markerPath) : null;
    assert.notEqual(f.cli("acquire", f.request()).status, 0);
    assert.notEqual(f.cli("init", f.config).status, 0);
    if (before) assert.deepEqual(readFileSync(markerPath), before);
  });
}

test("audit mutation is rejected; forged appended snapshot is detected", t => {
  const f = fixture(t), db = new Database(join(f.root, "ledger.sqlite"));
  assert.throws(() => db.exec("UPDATE events SET snapshot='{}'"), /audit_append_only/);
  assert.throws(() => db.exec("DELETE FROM events"), /audit_append_only/);
  db.prepare("INSERT INTO events VALUES(2,?,?,?)").run("bad", "bad", "{}"); db.close();
  assert.throws(() => f.open(), /maintenance_audit_corrupt/);
});

test("submit timeout persists unknown and repeated calls do not redispatch", async t => {
  const f = fixture(t), ledger = f.open(), token = ledger.acquire(f.request());
  let calls = 0;
  await assert.rejects(submitFixtureOnce(ledger, token, commandHash, async () => { calls++; throw new Error("mock timeout"); }), /mock timeout/);
  await assert.rejects(submitFixtureOnce(ledger, token, commandHash, async () => { calls++; }), /revision_conflict/);
  assert.equal(calls, 1);
  assert.equal(op(ledger, token).state, "submission_unknown");
  assert.throws(() => ledger.complete({ ...token, revision: op(ledger, token).revision }), /maintenance_not_verified/);
  ledger.close();
  assert.equal(op(f.open(), token).state, "submission_unknown");
});

test("concurrent fixture submits have exactly one transport invocation", async t => {
  const f = fixture(t), a = f.open(), b = f.open(), token = a.acquire(f.request());
  let calls = 0, finish;
  const first = submitFixtureOnce(a, token, commandHash, binding => { calls++; return new Promise(resolve => { finish = () => resolve({ ...binding, commandId: randomUUID() }); }); });
  await assert.rejects(submitFixtureOnce(b, token, commandHash, () => { calls++; }), /revision_conflict/);
  finish(); await first;
  assert.equal(calls, 1);
});

test("binding is immutable; exact response replay has zero audit/revision changes", t => {
  const f = fixture(t), ledger = f.open(), { token, binding, unknown } = submitted(f, ledger);
  const snapshot = canonical(ledger.inspect());
  assert.deepEqual(ledger.bindCommand(unknown, binding), token);
  assert.equal(canonical(ledger.inspect()), snapshot);
  for (const change of [{ commandId: randomUUID() }, { submitToken: randomUUID() }, { requestHash: hash("wrong") }, { target: { ...f.target, instanceId: "fixture-other" } }]) {
    assert.throws(() => ledger.bindCommand(token, { ...binding, ...change }), /maintenance_.*(mismatch|conflict)/);
  }
  const running = ledger.observe(token, { ...binding, status: "InProgress" });
  assert.deepEqual(ledger.observe(token, { ...binding, status: "InProgress" }), running);
  assert.throws(() => ledger.observe(token, { ...binding, status: "Delayed" }), /revision_conflict/);
});

test("cancel acknowledgement/poll failure/SSM terminal never release; restart retains hold", t => {
  const f = fixture(t), ledger = f.open(), { token, binding } = submitted(f, ledger);
  let current = ledger.cancel(token);
  current = ledger.hold(current, "poll_failed");
  current = ledger.observe(current, { ...binding, status: "Cancelled" });
  assert.equal(op(ledger, current).state, "terminal_pending");
  assert.throws(() => ledger.complete(current), /maintenance_not_verified/);
  ledger.close();
  const restarted = f.open();
  assert.equal(op(restarted, current).disposition, "held");
  assert.throws(() => restarted.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
  assert.deepEqual(restarted.observe(token, { ...binding, status: "InProgress" }), current);
  assert.throws(() => restarted.observe(current, { ...binding, status: "Success" }), /terminal_conflict/);
});

test("verified success completes; verified failure remains held", t => {
  for (const outcome of ["Success", "Failed"]) {
    const f = fixture(t), ledger = f.open(), { token, binding } = submitted(f, ledger);
    let current = ledger.observe(token, { ...binding, status: outcome });
    current = ledger.authorize(signed(f, op(ledger, current), "terminal_verify"));
    if (outcome === "Success") { ledger.complete(current); assert.equal(ledger.inspect().active, null); }
    else { assert.throws(() => ledger.complete(current), /not_verified/); assert.equal(ledger.inspect().active, current.operationId); }
  }
});

test("unknown takeover preserves hold and signed exact evidence permits only next isolated operation", t => {
  const f = fixture(t), ledger = f.open();
  let token = ledger.beginSubmit(ledger.acquire(f.request()), commandHash);
  token = ledger.authorize(signed(f, op(ledger, token), "takeover"));
  assert.equal(op(ledger, token).state, "manual_takeover");
  assert.throws(() => ledger.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
  const authorization = signed(f, op(ledger, token), "release");
  ledger.authorize(authorization);
  assert.equal(ledger.inspect().active, null);
  assert.equal(ledger.inspect().production_permitted, false);
  const backup = ledger.acquire(f.request("op-backup", "backup"));
  assert.throws(() => ledger.authorize(authorization), /owner_lost/);
  assert.equal(ledger.inspect().active, backup.operationId);
  assert.equal(op(ledger, token).authorizations.length, 2);
});

for (const fault of ["signature", "approver", "target", "command", "request", "revision", "no-evidence", "missing-file", "tampered-file", "symlink", "evidence-binding", "local-not-stopped", "continuation-not-stopped", "extra-field"]) {
  test(`manual release refuses ${fault}`, t => {
    const f = fixture(t), ledger = f.open();
    const token = ledger.hold(ledger.acquire(f.request()), "drain_unproven");
    const operation = op(ledger, token);
    const overrides = {};
    if (fault === "approver") overrides.approverId = "unapproved";
    if (fault === "target") overrides.target = { ...f.target, volumeId: "fixture-other" };
    if (fault === "command") overrides.commandId = randomUUID();
    if (fault === "request") overrides.requestHash = hash("wrong request");
    if (fault === "revision") overrides.revision = token.revision - 1;
    if (fault === "no-evidence") overrides.evidenceHash = null;
    if (fault === "evidence-binding") overrides.evidenceHash = evidence(f, operation, { ownerId: "other" });
    if (fault === "local-not-stopped") overrides.evidenceHash = evidence(f, operation, { localControllerStopped: false });
    if (fault === "continuation-not-stopped") overrides.evidenceHash = evidence(f, operation, { continuationsStopped: false });
    if (fault === "extra-field") overrides.force = true;
    const authorization = signed(f, operation, "release", overrides);
    const path = join(f.root, `evidence-${authorization.payload.evidenceHash}.json`);
    if (fault === "signature") authorization.signature = "0".repeat(128);
    if (fault === "missing-file") rmSync(path);
    if (fault === "tampered-file") writeFileSync(path, "{}");
    if (fault === "symlink") { rmSync(path); symlinkSync(join(f.root, "isolation.json"), path); }
    const snapshot = canonical(ledger.inspect());
    assert.throws(() => ledger.authorize(authorization));
    assert.equal(canonical(ledger.inspect()), snapshot);
    assert.throws(() => ledger.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
  });
}

test("paused submit controller cannot be declared stopped by incomplete evidence", async t => {
  const f = fixture(t), ledger = f.open(), token = ledger.acquire(f.request());
  let calls = 0, finish;
  const work = submitFixtureOnce(ledger, token, commandHash, binding => new Promise(resolve => {
    finish = () => { calls++; resolve({ ...binding, commandId: randomUUID() }); };
  }));
  const unknown = op(ledger, token);
  const incomplete = evidence(f, unknown, { localControllerStopped: false, continuationsStopped: false });
  ledger.authorize(signed(f, unknown, "takeover"));
  assert.throws(() => ledger.authorize(signed(f, op(ledger, token), "release", { evidenceHash: incomplete })));
  assert.throws(() => ledger.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
  finish(); await assert.rejects(work, /revision_conflict/);
  assert.equal(calls, 1); // Signature assertions, not CAS, must prove all submitters stopped.
  assert.equal(op(ledger, token).state, "manual_takeover");
});

test("actual CLI enforces protocol and has no production execution/resume action", t => {
  const f = fixture(t);
  const first = f.cli("acquire", f.request()); assert.equal(first.status, 0);
  const token = JSON.parse(first.stdout).result;
  const unknown = f.cli("begin-submit", { token, commandHash }); assert.equal(unknown.status, 0);
  assert.equal(f.cli("complete", { token: JSON.parse(unknown.stdout).result }).status, 1);
  for (const action of ["force", "unlock", "resume-writers", "backup-execute", "deploy-execute", "ssm-send-command"]) assert.equal(f.cli(action).status, 1);
  const state = f.cli("inspect"); assert.equal(state.status, 0);
  assert.equal(JSON.parse(state.stdout).result.production_permitted, false);
  const repoRoot = resolveRepo();
  const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
  assert.match(workflow, /if: always\(\)/); assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /configure-aws-credentials|send-command|id-token: write/);
});
function resolveRepo() { return dirname(dirname(directory)); }

test("abrupt child exit after durable unknown never releases or redispatches", t => {
  const f = fixture(t);
  const program = `import {openLedger} from ${JSON.stringify(join(directory, "ledger.mjs"))};
const ledger=openLedger(process.argv[1]);
ledger.beginSubmit(ledger.acquire(JSON.parse(process.argv[2])),process.argv[3]);
process.exit(23);`;
  const exited = spawnSync(process.execPath, ["--input-type=module", "-e", program, f.root, JSON.stringify(f.request()), commandHash], { env: {}, encoding: "utf8" });
  assert.equal(exited.status, 23);
  const ledger = f.open(), operation = ledger.inspect().operations["op-deploy"];
  assert.equal(operation.state, "submission_unknown");
  assert.throws(() => ledger.acquire(f.request("op-restore", "restore")), /maintenance_busy/);
  assert.notEqual(f.cli("begin-submit", { token: { operationId: operation.operationId, ownerId: operation.ownerId,
    fence: operation.fence, revision: operation.revision, target: operation.target, executionIdentity: operation.executionIdentity }, commandHash }).status, 0);
});

test("conflicting late terminal creates sticky hold even when Success was observed first", t => {
  const f = fixture(t), ledger = f.open(), { token, binding } = submitted(f, ledger);
  const pending = ledger.observe(token, { ...binding, status: "Success" });
  assert.throws(() => ledger.observe(pending, { ...binding, status: "Failed" }), /terminal_conflict/);
  assert.equal(op(ledger, token).disposition, "held");
  assert.deepEqual(op(ledger, token).failures, ["terminal_conflict"]);
  const verified = ledger.authorize(signed(f, op(ledger, token), "terminal_verify"));
  assert.throws(() => ledger.complete(verified), /not_verified/);
  assert.throws(() => ledger.acquire(f.request("op-backup", "backup")), /maintenance_busy/);
});

test("dangling journal symlink and marker key replacement fail closed", t => {
  const f = fixture(t), ledger = f.open();
  symlinkSync(join(f.root, "absent-journal"), join(f.root, "ledger.sqlite-journal"));
  assert.throws(() => ledger.inspect(), /unsafe_maintenance_path/);
  rmSync(join(f.root, "ledger.sqlite-journal"));
  const markerPath = join(f.root, "isolation.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  marker.publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(markerPath, canonical(marker));
  assert.throws(() => ledger.acquire(f.request()), /marker_changed/);
  assert.throws(() => f.open(), /genesis_mismatch/);
});

test("stale conflicting terminal rejects without altering audit or disposition", t => {
  const f = fixture(t), ledger = f.open(), { token, binding } = submitted(f, ledger);
  const pending = ledger.observe(token, { ...binding, status: "Success" });
  const snapshot = canonical(ledger.inspect());
  assert.throws(() => ledger.observe(token, { ...binding, status: "Failed" }), /revision_conflict/);
  assert.equal(canonical(ledger.inspect()), snapshot);
  assert.throws(() => ledger.observe(pending, { ...binding, status: "Failed" }), /terminal_conflict/);
  assert.equal(op(ledger, pending).disposition, "held");
});

test("canonical signing rejects sparse arrays and other non JSON inputs", () => {
  for (const value of [new Array(2), [undefined], NaN, Infinity, { unsupported: undefined }, new Date()]) assert.throws(() => canonical(value), /invalid_json/);
  assert.equal(canonical({ b: [false, null], a: 1 }), '{"a":1,"b":[false,null]}');
});

test("manual evidence hashes original bytes and refuses invalid UTF8", t => {
  const f = fixture(t), ledger = f.open();
  const token = ledger.hold(ledger.acquire(f.request()), "drain_unknown");
  const operation = op(ledger, token);
  const authorization = signed(f, operation, "release");
  const path = join(f.root, `evidence-${authorization.payload.evidenceHash}.json`);
  const valid = readFileSync(path);
  const malformed = Buffer.concat([valid.subarray(0, valid.length - 1), Buffer.from([0xff]), valid.subarray(valid.length - 1)]);
  writeFileSync(path, malformed);
  assert.notEqual(hash(malformed), authorization.payload.evidenceHash);
  assert.throws(() => ledger.authorize(authorization), /invalid_maintenance_utf8/);
  assert.equal(ledger.inspect().active, token.operationId);
  writeFileSync(path, valid);
  ledger.authorize(authorization);
  const archived = op(ledger, token).authorizations[0].evidenceBytes;
  assert.deepEqual(Buffer.from(archived, "utf8"), valid);
  assert.equal(hash(Buffer.from(archived, "utf8")), authorization.payload.evidenceHash);
});

test("private key configuration is rejected before any marker or ledger is written", t => {
  const f = fixture(t, false);
  const privateKey = f.keys.privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => initialize(f.root, { ...f.config, publicKey: privateKey }), /invalid_approver_public_key/);
  assert.equal(existsSync(join(f.root, "isolation.json")), false);
  assert.equal(existsSync(join(f.root, "ledger.sqlite")), false);
  assert.notEqual(f.cli("init", { ...f.config, publicKey: privateKey }).status, 0);
  assert.equal(existsSync(join(f.root, "isolation.json")), false);
});

for (const change of ["version", "application-id", "schema", "journal-mode"]) {
  test(`already open handle rejects changed ${change} inside transaction`, t => {
    const f = fixture(t), ledger = f.open();
    const db = new Database(join(f.root, "ledger.sqlite"));
    const before = db.prepare("SELECT * FROM events ORDER BY seq").all();
    if (change === "version") db.pragma("user_version=2");
    if (change === "application-id") db.pragma("application_id=1");
    if (change === "schema") db.exec("DROP TRIGGER events_no_delete");
    if (change === "journal-mode") db.pragma("journal_mode=WAL");
    db.close();
    assert.throws(() => ledger.acquire(f.request()), /invalid_maintenance_|unexpected_maintenance_sidecar/);
    const after = new Database(join(f.root, "ledger.sqlite"), { readonly: true, fileMustExist: true });
    try { assert.deepEqual(after.prepare("SELECT * FROM events ORDER BY seq").all(), before); } finally { after.close(); }
  });
}
