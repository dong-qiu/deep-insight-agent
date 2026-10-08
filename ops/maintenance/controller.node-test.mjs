import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { initialize, openLedger } from "./ledger.mjs";
import { bindingFor, canonical, hash, tokenFor } from "./contract.mjs";
import { FIXTURE_WIRE } from "./ssm-response.mjs";
import { runControllerStep } from "./controller.mjs";

const directory = import.meta.dirname, cliPath = join(directory, "controller-cli.mjs");
const evidence = process.env.A3_SSM_TEST_EVIDENCE;
const env = { PATH: process.env.PATH };
const input = (token, event) => ({ schema: "a3-ssm-controller-v1", token, ...(event === undefined ? {} : { event }) });
function fixture(t, initializeRoot = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "insight-a3-ssm-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), target = { region: "isolated", instanceId: "fixture-controller-node", volumeId: "fixture-controller-volume", dataPath: root, serviceSet: ["fixture-controller"] };
  const config = { target, approverId: "fixture-reviewer", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
  if (initializeRoot) initialize(root, config);
  const open = () => { const l = openLedger(root); t.after(() => { try { l.close(); } catch { /* Fixture may explicitly close/restart. */ } }); return l; };
  const request = { target, operationId: "op-controller", ownerId: "fixture-owner", executionIdentity: "fixture-controller-v1", kind: "backup" };
  const ledger = initializeRoot ? open() : null, token = ledger ? ledger.acquire(request) : null;
  const cli = (action, body) => spawnSync(process.execPath, [cliPath, root, action], { input: JSON.stringify(body), encoding: "utf8", env, timeout: 5000 });
  return { root, keys, config, target, request, ledger, token, cli, open };
}
function current(f) { const state = f.ledger.inspect(), op = state.operations[f.token.operationId]; return { state, op, token: tokenFor(op) }; }
function sendBody(op) { return { Command: { CommandId: op.commandId ?? randomUUID(), InstanceIds: [FIXTURE_WIRE.InstanceId], DocumentName: FIXTURE_WIRE.DocumentName,
  DocumentVersion: "1", Comment: `a3:${op.submitToken}:${op.requestHash.slice(0, 56)}`, Status: "Success" } }; }
function invocation(op, Status = "InProgress", StatusDetails = "In Progress", ResponseCode = -1) {
  return { ...FIXTURE_WIRE, CommandId: op.commandId, Comment: `a3:${op.submitToken}:${op.requestHash.slice(0, 56)}`, Status, StatusDetails, ResponseCode,
    StandardOutputContent: "PRIVATE_FIXTURE_OUTPUT", StandardErrorContent: "PRIVATE_FIXTURE_ERROR" };
}
function unknown(f) { return runControllerStep(f.root, "stage-submit", input(f.token)).token; }
function submitted(f) {
  const token = unknown(f), body = sendBody(current(f).op);
  const result = runControllerStep(f.root, "receive-send", input(token, { outcome: "response", body }));
  assert.equal(result.token, null); return current(f).token;
}
function safety(result) {
  assert.equal(result.production_permitted, false); assert.equal(result.ready, false); assert.equal(result.termination, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE/);
}
function archive(root, label) {
  const files = [];
  if (!evidence) return;
  const destination = realpathSync(evidence); assert.equal(statSync(destination).mode & 0o777, 0o700);
  for (const name of ["isolation.json", "ledger.sqlite", "ledger.sqlite-journal", "ledger.sqlite-wal", "ledger.sqlite-shm"]) {
    const path = join(root, name);
    if (!existsSync(path)) { files.push({ name, exists: false }); continue; }
    const metadata = statSync(path), digest = hash(readFileSync(path)), output = join(destination, `${label}-${name}.bin`);
    copyFileSync(path, output, 1); chmodSync(output, 0o600);
    assert.equal(hash(readFileSync(output)), digest);
    files.push({ name, exists: true, sourceMode: metadata.mode & 0o777, size: metadata.size, sha256: digest, archive: output });
  }
  writeFileSync(join(destination, `${label}-inventory.json`), JSON.stringify({ root, files }) + "\n", { flag: "wx", mode: 0o600 });
}
function hot(root) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import Database from 'better-sqlite3';
    const d=new Database(process.argv[1]);d.pragma('cache_size=1');d.exec('BEGIN IMMEDIATE');
    const last=d.prepare('SELECT max(seq) AS n FROM events').get().n;
    const insert=d.prepare('INSERT INTO events VALUES(?,?,?,?)');
    for(let i=1;i<=10000;i++)insert.run(last+i,'uncommitted','uncommitted','x'.repeat(1024));
    process.kill(process.pid,'SIGKILL');`, join(root, "ledger.sqlite")], { cwd: process.cwd(), env });
  assert.equal(child.signal, "SIGKILL", child.stderr.toString()); assert.ok(statSync(join(root, "ledger.sqlite-journal")).size > 512);
}
function afterInspect(effect, call) {
  const probe = new Database(":memory:"), prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")); probe.close();
  const run = prototype.run; let fired = false;
  prototype.run = function (...args) {
    const result = run.apply(this, args);
    if (this.source === "COMMIT" && !fired) { fired = true; effect(); }
    return result;
  };
  try { return call(); } finally { prototype.run = run; }
}
function child(script, args) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", bytes => { stdout += bytes; }); proc.stderr.on("data", bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => { proc.on("error", reject); proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { proc, done };
}
async function waitFile(path) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) { assert.ok(Date.now() < deadline, `fixture barrier timeout: ${path}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const gapScript = `import Database from 'better-sqlite3';import{writeFileSync,existsSync}from'node:fs';
  import{runControllerStep}from${JSON.stringify(new URL("./controller.mjs", import.meta.url).href)};
  const[root,action,raw,ready,go,afterHold]=process.argv.slice(1);
  const probe=new Database(':memory:'),prototype=Object.getPrototypeOf(probe.prepare('SELECT 1'));probe.close();
  const original=prototype.run;let commits=0;
  function barrier(path,release){writeFileSync(path,'ready',{flag:'wx',mode:0o600});const end=Date.now()+10000;
    while(!existsSync(release)){if(Date.now()>end)throw Error('fixture barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
  prototype.run=function(...args){const result=original.apply(this,args);if(this.source==='COMMIT'){
    if(++commits===1)barrier(ready,go);else if(commits===2&&afterHold==='true')barrier(ready+'-hold',go+'-hold');}return result;};
  try{console.log(JSON.stringify(runControllerStep(root,action,JSON.parse(raw))));}catch(e){console.error(e.message);process.exitCode=1;}`;
async function race(f, action, body, label, afterHold = false) {
  const signals = realpathSync(mkdtempSync(join(tmpdir(), "insight-a3-ssm-gap-")));
  const a = child(gapScript, [f.root, action, JSON.stringify(body), join(signals, "a-ready"), join(signals, "a-go"), String(afterHold)]);
  let b;
  try {
    await waitFile(join(signals, "a-ready"));
    b = child(gapScript, [f.root, action, JSON.stringify(body), join(signals, "b-ready"), join(signals, "b-go"), String(afterHold)]);
    await waitFile(join(signals, "b-ready"));
    writeFileSync(join(signals, "a-go"), "go", { mode: 0o600 });
    if (afterHold) {
      await waitFile(join(signals, "a-ready-hold")); writeFileSync(join(signals, "b-go"), "go", { mode: 0o600 });
      await waitFile(join(signals, "b-ready-hold")); writeFileSync(join(signals, "a-go-hold"), "go", { mode: 0o600 });
    }
    const first = await a.done;
    writeFileSync(join(signals, afterHold ? "b-go-hold" : "b-go"), "go", { mode: 0o600 }); const second = await b.done;
    if (evidence) writeFileSync(join(evidence, `${label}-race.json`), JSON.stringify({ action, first, second }) + "\n", { flag: "wx", mode: 0o600 });
    return [first, second].map(result => { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); });
  } finally { a.proc.kill(); b?.proc.kill(); rmSync(signals, { recursive: true, force: true }); }
}

test("actual offline CLI stages unknown, binds send without authority, cancels and records ack as hold", t => {
  const f = fixture(t); const staged = f.cli("stage-submit", input(f.token)); assert.equal(staged.status, 0, staged.stderr);
  const unknownToken = JSON.parse(staged.stdout).token; assert.equal(current(f).op.state, "submission_unknown");
  const bound = f.cli("receive-send", input(unknownToken, { outcome: "response", body: sendBody(current(f).op) })); assert.equal(bound.status, 0, bound.stderr);
  const binding = JSON.parse(bound.stdout); assert.equal(binding.token, null); safety(binding);
  const cancelled = f.cli("stage-cancel", input(current(f).token)); assert.equal(cancelled.status, 0, cancelled.stderr);
  const cancellation = JSON.parse(cancelled.stdout);
  const ack = f.cli("receive-cancel", input(cancellation.token, { outcome: "response", body: {} })); assert.equal(ack.status, 0, ack.stderr);
  const result = JSON.parse(ack.stdout); safety(result); assert.equal(result.hold, "recorded");
  assert.equal(current(f).op.state, "cancel_requested"); assert.equal(current(f).op.terminal, null); assert.equal(current(f).op.disposition, "held");
  const running = runControllerStep(f.root, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op) }));
  assert.equal(running.token, null); assert.equal(current(f).op.state, "cancel_requested");
  const done = runControllerStep(f.root, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op, "Success", "Success", 0) }));
  safety(done); assert.equal(current(f).op.state, "terminal_pending"); assert.equal(current(f).op.disposition, "held");
});
test("SIGKILL after real durable stage-submit preserves unknown and restart cannot resend", t => {
  const f = fixture(t);
  const script = `import{runControllerStep}from${JSON.stringify(new URL("./controller.mjs", import.meta.url).href)};
    console.log(JSON.stringify(runControllerStep(process.argv[1],'stage-submit',JSON.parse(process.argv[2]))));process.kill(process.pid,'SIGKILL');`;
  const killed = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.root, JSON.stringify(input(f.token))], { cwd: process.cwd(), env });
  assert.equal(killed.signal, "SIGKILL", killed.stderr.toString()); archive(f.root, "submit-killed");
  const before = current(f); assert.equal(before.op.state, "submission_unknown"); assert.equal(before.op.commandId, null);
  const resumed = runControllerStep(f.root, "resume", input(before.token)); safety(resumed); assert.equal(resumed.hold, "recorded");
  assert.equal(current(f).op.state, "submission_unknown"); assert.equal(current(f).op.commandId, null);
  const snapshot = canonical(f.ledger.inspect()); assert.throws(() => runControllerStep(f.root, "stage-submit", input(resumed.token)), /invalid_maintenance_transition/);
  assert.equal(canonical(f.ledger.inspect()), snapshot);
});
test("two real controller processes past preinspect allow only one beginSubmit CAS", async t => {
  const f = fixture(t), before = f.ledger.inspect().revision;
  const result = await race(f, "stage-submit", input(f.token), "submit");
  assert.equal(result.filter(r => r.outcome === "recorded").length, 1);
  assert.equal(result.filter(r => r.outcome === "blocked" && r.reason === "maintenance_revision_conflict").length, 1);
  assert.equal(f.ledger.inspect().revision, before + 1); assert.equal(current(f).op.state, "submission_unknown");
});
test("two preinspected send and observation calls discard allowStale current token, with audit once", async t => {
  const f = fixture(t), token = unknown(f), before = f.ledger.inspect().revision;
  const sends = await race(f, "receive-send", input(token, { outcome: "response", body: sendBody(current(f).op) }), "send");
  for (const r of sends) { assert.equal(r.outcome, "accepted_or_replay"); assert.equal(r.token, null); assert.equal(r.hold, "not_attempted"); safety(r); }
  assert.equal(f.ledger.inspect().revision, before + 1);
  assert.throws(() => runControllerStep(f.root, "stage-cancel", input(sends[1].token)), /invalid_controller_input/);
  const runningBefore = f.ledger.inspect().revision;
  const observations = await race(f, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op) }), "observe");
  for (const r of observations) { assert.equal(r.outcome, "accepted_or_replay"); assert.equal(r.token, null); assert.equal(r.hold, "not_attempted"); }
  assert.equal(f.ledger.inspect().revision, runningBefore + 1); assert.deepEqual(current(f).op.observations, ["InProgress"]);
  assert.deepEqual(current(f).op.failures, []);
});
test("terminal first strict hold race permits one observer; loser cannot take returned authority", async t => {
  const f = fixture(t); submitted(f); const before = f.ledger.inspect().revision;
  const results = await race(f, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op, "Success", "Success", 0) }), "terminal-first");
  assert.equal(results.filter(r => r.outcome === "accepted_or_replay").length, 1);
  const loser = results.find(r => r.outcome === "blocked"); assert.equal(loser.reason, "maintenance_revision_conflict"); assert.equal(loser.token, null); assert.equal(loser.hold, "unconfirmed");
  assert.equal(f.ledger.inspect().revision, before + 2); assert.deepEqual(current(f).op.failures, ["ssm_terminal_unverified"]); assert.equal(current(f).op.terminal, "Success");
});
test("existing identical terminal hold still gates fresh ingress; two no-op/replay calls never re-hold", async t => {
  const f = fixture(t); submitted(f); const held = f.ledger.hold(current(f).token, "ssm_terminal_unverified"), before = f.ledger.inspect().revision;
  const results = await race(f, "receive-invocation", input(held, { outcome: "response", body: invocation(current(f).op, "Success", "Success", 0) }), "terminal-held", true);
  assert.equal(results[0].outcome, "accepted_or_replay");
  // Both strict no-op holds pass before either observation; replay still exports no authority.
  assert.equal(results[1].outcome, "accepted_or_replay");
  for (const result of results) { assert.equal(result.hold, "recorded"); assert.equal(result.token, null); }
  assert.equal(f.ledger.inspect().revision, before + 1); assert.deepEqual(current(f).op.failures, ["ssm_terminal_unverified"]);
});
test("late nonterminal cannot reverse terminal; conflicting terminal keeps primary and its durable hold", t => {
  const f = fixture(t); submitted(f);
  runControllerStep(f.root, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op, "Success", "Success", 0) }));
  const before = current(f), late = runControllerStep(f.root, "receive-invocation", input(before.token, { outcome: "response", body: invocation(before.op) }));
  assert.equal(late.token, null); assert.equal(canonical(f.ledger.inspect()), canonical(before.state));
  const close = Database.prototype.close; Database.prototype.close = function () { close.call(this); throw new Error("PRIVATE_FIXTURE_CLOSE"); };
  let conflict; try { conflict = runControllerStep(f.root, "receive-invocation", input(before.token, { outcome: "response", body: invocation(before.op, "Failed", "Failed", 2) })); }
  finally { Database.prototype.close = close; }
  assert.equal(conflict.reason, "maintenance_terminal_conflict"); assert.equal(conflict.token, null); assert.equal(conflict.hold, "recorded"); safety(conflict);
  assert.equal(current(f).op.terminal, "Success"); assert.deepEqual(current(f).op.failures, ["ssm_terminal_unverified", "terminal_conflict"]);
  assert.equal(f.ledger.inspect().revision, before.state.revision + 1);
});
test("fresh malformed/unavailable wire records exactly one hold; unknown command is not invented", t => {
  for (const event of [{ outcome: "unavailable" }, { outcome: "response", body: { Error: "PRIVATE_FIXTURE_ERROR" } }]) {
    const f = fixture(t), token = unknown(f), before = f.ledger.inspect().revision;
    const result = runControllerStep(f.root, "receive-send", input(token, event)); safety(result); assert.equal(result.outcome, "blocked");
    assert.equal(result.hold, "recorded"); assert.ok(result.token); assert.equal(current(f).op.commandId, null); assert.equal(current(f).op.state, "submission_unknown");
    assert.equal(f.ledger.inspect().revision, before + 1); assert.deepEqual(current(f).op.failures, [result.reason]);
  }
});
test("wire primary survives a real CAS loss between preinspect and hold; no foreign hold/refresh", t => {
  const f = fixture(t), token = unknown(f), other = f.open();
  const result = afterInspect(() => other.hold(token, "independent_operator_hold"), () => runControllerStep(f.root, "receive-send", input(token, { outcome: "response", body: {} })));
  assert.equal(result.reason, "ssm_response_invalid"); assert.equal(result.hold, "unconfirmed"); assert.equal(result.token, null); safety(result);
  assert.deepEqual(current(f).op.failures, ["independent_operator_hold"]); assert.equal(current(f).op.revision, token.revision + 1);
});
test("unsafe journal appearing after preinspect blocks strict hold while preserving wire primary and original bytes", t => {
  const f = fixture(t), token = unknown(f); let before;
  const result = afterInspect(() => { hot(f.root); chmodSync(join(f.root, "ledger.sqlite-journal"), 0o644); archive(f.root, "cached-unsafe");
    before = [hash(readFileSync(join(f.root, "ledger.sqlite"))), hash(readFileSync(join(f.root, "ledger.sqlite-journal")))]; },
  () => runControllerStep(f.root, "receive-send", input(token, { outcome: "response", body: {} })));
  assert.equal(result.reason, "ssm_response_invalid"); assert.equal(result.hold, "unconfirmed"); assert.equal(result.token, null);
  assert.deepEqual([hash(readFileSync(join(f.root, "ledger.sqlite"))), hash(readFileSync(join(f.root, "ledger.sqlite-journal")))], before);
});
test("strict action CAS/native failures do not trigger fallback hold or expose native errors", t => {
  const f = fixture(t), other = f.open();
  const result = afterInspect(() => other.hold(f.token, "external_hold"), () => runControllerStep(f.root, "stage-submit", input(f.token)));
  assert.equal(result.outcome, "blocked"); assert.equal(result.reason, "maintenance_revision_conflict"); assert.equal(result.hold, "not_attempted");
  assert.equal(result.token, null); assert.deepEqual(current(f).op.failures, ["external_hold"]); assert.equal(current(f).op.state, "pre_submit");
});
test("old revision/owner/fence/target and missing/extra/getter inputs throw without any mutation", t => {
  const f = fixture(t), stale = f.token; unknown(f); const before = canonical(f.ledger.inspect());
  const bad = [input(stale), input({ ...current(f).token, ownerId: "foreign" }), input({ ...current(f).token, fence: 99 }),
    input({ ...current(f).token, target: { ...f.target, region: "production" } }), { ...input(current(f).token), extra: true },
    { schema: "a3-ssm-controller-v1" }, input(null), input({ ...current(f).token, extra: "SECRET" }), input(current(f).token, { outcome: "unavailable", body: {} })];
  let reads = 0; const getter = { schema: "a3-ssm-controller-v1" }; Object.defineProperty(getter, "token", { enumerable: true, get() { reads++; return current(f).token; } }); bad.push(getter);
  for (const body of bad) assert.throws(() => runControllerStep(f.root, "interrupt", body));
  assert.equal(reads, 0); assert.equal(canonical(f.ledger.inspect()), before);
  assert.throws(() => runControllerStep(f.root, "authorize", input(current(f).token)), /invalid_controller_input/);
});
test("released/old operation cannot hold a newly acquired operation", t => {
  const f = fixture(t); f.ledger.complete(f.token);
  const next = f.ledger.acquire({ ...f.request, operationId: "op-next", ownerId: "new-owner" }); const before = canonical(f.ledger.inspect());
  assert.throws(() => runControllerStep(f.root, "resume", input(f.token)), /maintenance_owner_lost/);
  assert.equal(canonical(f.ledger.inspect()), before); assert.deepEqual(f.ledger.inspect().operations[next.operationId].failures, []);
});
test("held rejects new submit/cancel; resume/interrupt preserve facts and exact no-op requires fresh token", t => {
  const f = fixture(t); submitted(f); const held = runControllerStep(f.root, "interrupt", input(current(f).token));
  const before = current(f); assert.equal(held.hold, "recorded"); assert.throws(() => runControllerStep(f.root, "stage-cancel", input(held.token)), /invalid_maintenance_transition/);
  const resumed = runControllerStep(f.root, "resume", input(held.token)); assert.equal(resumed.hold, "recorded");
  assert.equal(current(f).op.commandId, before.op.commandId); assert.equal(current(f).op.state, before.op.state);
  const replay = runControllerStep(f.root, "resume", input(resumed.token)); assert.deepEqual(replay.token, resumed.token); assert.equal(current(f).op.revision, resumed.token.revision);
  assert.ok(Object.isFrozen(replay.token)); assert.ok(Object.isFrozen(replay.token.target)); assert.ok(Object.isFrozen(replay.token.target.serviceSet));
  assert.throws(() => runControllerStep(f.root, "resume", input(held.token)), /maintenance_revision_conflict/);
});
test("all terminal pairs remain unverified and held with zero authorization/release", t => {
  for (const [status, details, code, terminal] of [["Success", "Success", 0, "Success"], ["Failed", "Failed", 9, "Failed"], ["Cancelled", "Cancelled", -1, "Cancelled"],
    ["TimedOut", "Delivery Timed Out", -1, "DeliveryTimedOut"], ["TimedOut", "Execution Timed Out", 124, "ExecutionTimedOut"]]) {
    const f = fixture(t); submitted(f); const result = runControllerStep(f.root, "receive-invocation", input(current(f).token, { outcome: "response", body: invocation(current(f).op, status, details, code) }));
    safety(result); assert.equal(result.token, null); assert.equal(current(f).op.terminal, terminal); assert.equal(current(f).op.state, "terminal_pending");
    assert.equal(current(f).op.disposition, "held"); assert.deepEqual(current(f).op.authorizations, []); assert.equal(f.ledger.inspect().active, f.token.operationId);
  }
});
test("invocation unavailable/false success and fake cancellation body hold once without an invented observation", t => {
  for (const [action, makeEvent] of [["receive-invocation", () => ({ outcome: "unavailable" })],
    ["receive-invocation", op => ({ outcome: "response", body: invocation(op, "Success", "Success", -1) })],
    ["receive-invocation", op => ({ outcome: "response", body: { ...invocation(op), PluginName: "foreignPlugin" } })],
    ["receive-cancel", () => ({ outcome: "response", body: { Status: "Success" } })]]) {
    const f = fixture(t); submitted(f);
    if (action === "receive-cancel") runControllerStep(f.root, "stage-cancel", input(current(f).token));
    const before = current(f), result = runControllerStep(f.root, action, input(before.token, makeEvent(before.op)));
    assert.equal(result.outcome, "blocked"); assert.equal(result.hold, "recorded"); safety(result);
    assert.equal(current(f).op.revision, before.op.revision + 1); assert.deepEqual(current(f).op.observations, before.op.observations);
    assert.equal(current(f).op.terminal, null); assert.equal(current(f).op.state, before.op.state);
  }
});
test("actual child CLI rejects old owner/fence/released tokens without holding the active foreign operation", t => {
  const f = fixture(t), before = canonical(f.ledger.inspect());
  for (const delta of [{ ownerId: "foreign-owner" }, { fence: f.token.fence + 1 }]) {
    const result = f.cli("interrupt", input({ ...f.token, ...delta }));
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "maintenance_owner_lost\n");
  }
  assert.equal(canonical(f.ledger.inspect()), before); f.ledger.complete(f.token);
  f.ledger.acquire({ ...f.request, operationId: "op-new-controller", ownerId: "new-controller" });
  const active = canonical(f.ledger.inspect()), late = f.cli("resume", input(f.token));
  assert.equal(late.status, 1); assert.equal(late.stdout, ""); assert.equal(late.stderr, "maintenance_owner_lost\n");
  assert.equal(canonical(f.ledger.inspect()), active);
});
test("controller open rejects unsafe real hot journal before recovery, and accepts safe recovery preserving hold/unknown", t => {
  const f = fixture(t), token = unknown(f), held = f.ledger.hold(token, "preexisting_unknown"), before = current(f).state;
  hot(f.root); chmodSync(join(f.root, "ledger.sqlite-journal"), 0o644); archive(f.root, "open-unsafe");
  const bytes = [hash(readFileSync(join(f.root, "ledger.sqlite"))), hash(readFileSync(join(f.root, "ledger.sqlite-journal")))];
  assert.throws(() => runControllerStep(f.root, "resume", input(held)), /unsafe_maintenance_path/);
  assert.deepEqual([hash(readFileSync(join(f.root, "ledger.sqlite"))), hash(readFileSync(join(f.root, "ledger.sqlite-journal")))], bytes);
  // Only this own fixture changes mode for the independent safe-engine recovery positive control.
  chmodSync(join(f.root, "ledger.sqlite-journal"), 0o600); archive(f.root, "open-safe");
  const fresh = f.open(); assert.deepEqual(fresh.inspect(), before);
  const resumed = runControllerStep(f.root, "resume", input(held)); safety(resumed); assert.equal(current(f).op.state, "submission_unknown");
  assert.deepEqual(current(f).op.failures, ["preexisting_unknown", "controller_restart_unknown"]);
});
test("cached physical path and marker swaps reject before actual mutation without adopting replacement", t => {
  for (const mode of ["inode", "marker"]) {
    const f = fixture(t), before = current(f).op.revision;
    const result = afterInspect(() => {
      if (mode === "inode") { const path = join(f.root, "ledger.sqlite"); renameSync(path, path + ".original"); copyFileSync(path + ".original", path); chmodSync(path, 0o600); }
      else { const path = join(f.root, "isolation.json"), marker = JSON.parse(readFileSync(path, "utf8")); marker.initId = randomUUID(); writeFileSync(path, canonical(marker), { mode: 0o600 }); }
    }, () => runControllerStep(f.root, "stage-submit", input(f.token)));
    assert.equal(result.outcome, "blocked"); assert.equal(result.reason, mode === "inode" ? "maintenance_file_replaced" : "maintenance_marker_changed"); assert.equal(result.token, null);
    const db = new Database(join(f.root, mode === "inode" ? "ledger.sqlite.original" : "ledger.sqlite"), { readonly: true });
    assert.equal(db.prepare("SELECT max(seq) AS n FROM events").get().n - 1, before); db.close();
  }
});
test("half-initialized and foreign fixed profile roots cannot receive a valid result/hold", t => {
  const f = fixture(t, false); writeFileSync(join(f.root, "isolation.json"), "{}", { mode: 0o600 });
  assert.throws(() => runControllerStep(f.root, "resume", input({ operationId: "op-none", ownerId: "owner", fence: 1, revision: 0, target: f.target, executionIdentity: "fixture-controller-v1" })));
  const foreign = fixture(t, false), target = { ...foreign.target, volumeId: "fixture-foreign" };
  initialize(foreign.root, { ...foreign.config, target }); const ledger = foreign.open(); const token = ledger.acquire({ ...foreign.request, target }); const before = canonical(ledger.inspect());
  assert.throws(() => runControllerStep(foreign.root, "resume", input(token)), /invalid_controller_input/); assert.equal(canonical(ledger.inspect()), before);
});
test("CLI invalid outer emits only fixed error and no token, whereas trusted wire failure returns blocked/nonzero", t => {
  const f = fixture(t), before = canonical(f.ledger.inspect());
  for (const [action, body] of [["resume", {}], ["complete", input(f.token)], ["resume", { ...input(f.token), secret: "PRIVATE_FIXTURE" }]]) {
    const result = f.cli(action, body); assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "invalid_controller_input\n");
  }
  assert.equal(canonical(f.ledger.inspect()), before);
  const token = unknown(f), result = f.cli("receive-send", input(token, { outcome: "unavailable" })); assert.equal(result.status, 1);
  const blocked = JSON.parse(result.stdout); safety(blocked); assert.equal(blocked.reason, "ssm_response_unavailable"); assert.equal(blocked.hold, "recorded"); assert.equal(result.stderr, "");
});
test("streaming CLI interrupts over-limit input before EOF without unbounded read or side effects", async t => {
  const f = fixture(t), before = canonical(f.ledger.inspect());
  const proc = spawn(process.execPath, [cliPath, f.root, "resume"], { env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.on("error", () => { /* Expected consumer interruption. */ });
  let stdout = "", stderr = ""; proc.stdout.on("data", bytes => { stdout += bytes; }); proc.stderr.on("data", bytes => { stderr += bytes; });
  const done = new Promise(resolve => proc.on("close", code => resolve(code)));
  proc.stdin.write("x".repeat(65536)); proc.stdin.write("x"); // Deliberately do not send EOF.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  const code = await done; clearTimeout(timer); proc.stdin.destroy();
  assert.equal(code, 1); assert.equal(stdout, ""); assert.equal(stderr, "invalid_controller_input\n"); assert.equal(canonical(f.ledger.inspect()), before);
});
test("delayed stdin old continuation rejects after independent owner revision advances", async t => {
  const f = fixture(t), proc = spawn(process.execPath, [cliPath, f.root, "interrupt"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; proc.stdout.on("data", bytes => { stdout += bytes; }); proc.stderr.on("data", bytes => { stderr += bytes; });
  const done = new Promise(resolve => proc.on("close", code => resolve(code)));
  const text = JSON.stringify(input(f.token)); proc.stdin.write(text.slice(0, 20)); f.ledger.hold(f.token, "operator_revised");
  const before = canonical(f.ledger.inspect()); proc.stdin.end(text.slice(20));
  assert.equal(await done, 1); assert.equal(stdout, ""); assert.equal(stderr, "maintenance_revision_conflict\n"); assert.equal(canonical(f.ledger.inspect()), before);
});
test("production hard gates, original S0 sources and isolated entry transport surface stay unchanged", () => {
  for (const file of [".github/workflows/deploy.yml", "ops/aws/security-release-policy.json", "ops/aws/security-release-gate.mjs", "ops/aws/deploy.sh", "ops/maintenance/ledger.mjs", "ops/maintenance/contract.mjs"]) {
    const base = spawnSync("git", ["show", `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0:${file}`], { env }); assert.equal(base.status, 0);
    assert.equal(hash(readFileSync(join(directory, "../..", file))), hash(base.stdout));
  }
  for (const file of ["controller.mjs", "controller-cli.mjs", "ssm-response.mjs"]) {
    const source = readFileSync(join(directory, file), "utf8");
    assert.doesNotMatch(source, /(?:from\s*["'](?:node:child_process|node:https?|@aws-sdk)|\bfetch\s*\(|\bspawn\s*\(|\bexecSync\s*\(|\bledger\.(?:acquire|initialize|authorize|complete)\s*\()/);
  }
});
