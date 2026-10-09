import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import cp, { spawn, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { initialize, openLedger } from "./ledger.mjs";
import { bindingFor, canonical, DOMAIN, hash, tokenFor } from "./contract.mjs";
import { FIXTURE_WIRE } from "./ssm-response.mjs";
import { runIsolatedSsmTransport } from "./ssm-isolated-transport.mjs";

const cli = join(import.meta.dirname, "ssm-isolated-transport-cli.mjs");
const evidence = process.env.A3_TRANSPORT_EVIDENCE;
const nodeEnv = { PATH: process.env.PATH };
const schema = "a3-isolated-ssm-transport-v1";
function fixture(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "insight-transport-"))); chmodSync(root, 0o700);
  const keys = generateKeyPairSync("ed25519"), target = { region: "isolated", instanceId: "fixture-controller-node", volumeId: "fixture-controller-volume", dataPath: root, serviceSet: ["fixture-controller"] };
  initialize(root, { target, approverId: "fixture-reviewer", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) });
  const ledger = openLedger(root), request = { target, operationId: "op-transport", ownerId: "fixture-owner", executionIdentity: "fixture-controller-v1", kind: "backup" };
  const token = ledger.acquire(request);
  t.after(() => { try { ledger.close(); } catch { /* Fixture intentionally closes handles. */ } if (!extra.preserve?.()) rmSync(root, { recursive: true, force: true }); });
  return { root, keys, target, request, ledger, token };
}
function current(f) { const state = f.ledger.inspect(), op = state.operations[f.token.operationId]; return { state, op, token: tokenFor(op) }; }
function options(f, endpoint, action = "send", token = f.token, extra = {}) {
  return { root: f.root, endpoint, action, deadlineAt: Date.now() + 10000, inputJson: JSON.stringify({ schema, token }), ...extra };
}
function safety(value) {
  assert.equal(value.ready, false); assert.equal(value.production_permitted, false); assert.equal(value.maintenance_permitted, false);
  assert.equal(value.termination, "unknown"); assert.equal(value.safe_rollback, null); assert.equal(value.token, null);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_FIXTURE|fixture-only-not-a-secret/);
}
async function server(t, handler) {
  const records = [], sockets = new Set();
  const instance = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const entry = { target: req.headers["x-amz-target"], body: JSON.parse(Buffer.concat(chunks)), authorization: req.headers.authorization };
    records.push(entry); res.setHeader("Content-Type", "application/x-amz-json-1.1"); handler(entry, res, records);
  });
  instance.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${instance.address().port}/`, records };
}
function commandResponse(entry, commandId = randomUUID()) {
  return { Command: { ...entry.body, CommandId: commandId, Status: "Pending", Targets: [] } };
}
async function normalServer(t) {
  let comment, id;
  return server(t, (entry, res) => {
    if (entry.target === "AmazonSSM.SendCommand") {
      comment = entry.body.Comment; id = randomUUID(); res.end(JSON.stringify(commandResponse(entry, id)));
    } else if (entry.target === "AmazonSSM.GetCommandInvocation") {
      res.end(JSON.stringify({ ...FIXTURE_WIRE, CommandId: id, Comment: comment, Status: "Success", StatusDetails: "Success", ResponseCode: 0,
        StandardOutputContent: "PRIVATE_FIXTURE_OUTPUT", StandardErrorContent: "PRIVATE_FIXTURE_ERROR" }));
    } else res.end("{}");
  });
}
function inventory(root) {
  return ["isolation.json", "ledger.sqlite", "ledger.sqlite-journal", "ledger.sqlite-wal", "ledger.sqlite-shm"].map(name => {
    const path = join(root, name);
    return existsSync(path) ? { name, present: true, bytes: statSync(path).size, hash: hash(readFileSync(path)), mode: statSync(path).mode & 0o777 } : { name, present: false };
  });
}
function archive(root, label) {
  const files = inventory(root);
  if (evidence) {
    for (const file of files) if (file.present) {
      const output = join(evidence, `${label}-${file.name}.bin`); copyFileSync(join(root, file.name), output, 1); chmodSync(output, 0o600);
      assert.equal(hash(readFileSync(output)), file.hash);
    }
    writeFileSync(join(evidence, `${label}-inventory.json`), JSON.stringify({ root, files }) + "\n", { flag: "wx", mode: 0o600 });
  }
  return files;
}
function hot(f) {
  f.ledger.close();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import Database from 'better-sqlite3';
    const d=new Database(process.argv[1]);d.pragma('cache_size=1');d.exec('BEGIN IMMEDIATE');
    const last=d.prepare('SELECT max(seq) AS n FROM events').get().n;
    const insert=d.prepare('INSERT INTO events VALUES(?,?,?,?)');
    for(let i=1;i<=10000;i++)insert.run(last+i,'uncommitted','uncommitted','x'.repeat(1024));process.kill(process.pid,'SIGKILL');`, join(f.root, "ledger.sqlite")], { cwd: process.cwd(), env: nodeEnv });
  assert.equal(result.signal, "SIGKILL", result.stderr.toString());
  assert.equal(statSync(join(f.root, "ledger.sqlite-journal")).mode & 0o777, 0o600);
}
function child(root, action, endpoint, token, extra = {}) {
  const preload = extra.preload ? ["--import", `data:text/javascript,${encodeURIComponent(extra.preload)}`] : [];
  const proc = spawn(process.execPath, [...preload, cli, root, action, endpoint, String(Date.now() + (extra.duration ?? 10000))], { env: nodeEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", bytes => { stdout += bytes; }); proc.stderr.on("data", bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => { proc.on("error", reject); proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  if (extra.write !== false) proc.stdin.end(JSON.stringify({ schema, token }));
  return { proc, done };
}
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, "fixture barrier deadline"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

// Test-only scheduling: execute original native SQL, then pause at a proved
// transaction boundary. Neither the runtime nor AWS/version output is replaced.
function contention() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "insight-transport-race-"))); chmodSync(root, 0o700);
  const children = [], releases = new Set();
  const databaseUrl = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
  const race = { root, children, preserve: false };
  function path(role, name) { return join(root, `${role}-${name}.json`); }
  function release(role, name) {
    const output = path(role, `${name}-go`);
    if (!existsSync(output)) writeFileSync(output, "{}\n", { flag: "wx", mode: 0o600 });
  }
  function preload(role, pauses) {
    for (const name of Object.values(pauses)) releases.add(`${role}/${name}`);
    return `import Database from ${JSON.stringify(databaseUrl)};
      import { existsSync, writeFileSync } from 'node:fs';
      const root=${JSON.stringify(root)}, role=${JSON.stringify(role)}, pauses=${JSON.stringify(pauses)};
      const probe=new Database(':memory:'), prototype=Object.getPrototypeOf(probe.prepare('SELECT 1'));
      const original=prototype.run; probe.close(); let begins=0, commits=0, rollbacks=0;
      const wait=new Int32Array(new SharedArrayBuffer(4));
      function record(name,value){writeFileSync(root+'/'+role+'-'+name+'.json',JSON.stringify(value)+'\\n',{flag:'wx',mode:0o600});}
      function pause(name,inTransaction){
        record(name+'-ready',{inTransaction,begins,commits,rollbacks});
        const deadline=performance.now()+10000;
        while(!existsSync(root+'/'+role+'-'+name+'-go.json')){
          if(performance.now()>=deadline)throw new Error('fixture_contention_barrier_deadline');
          Atomics.wait(wait,0,0,5);
        }
      }
      prototype.run=function(...args){
        let value;
        try{value=original.apply(this,args);}catch(error){
          if(this.source==='BEGIN IMMEDIATE'&&error.code==='SQLITE_BUSY')record('native-busy',{statement:this.source,code:error.code});
          throw error;
        }
        if(this.source==='BEGIN IMMEDIATE'){
          begins++; if(pauses['begin'+begins])pause(pauses['begin'+begins],this.database.inTransaction);
        }else if(this.source==='COMMIT'){
          commits++; if(pauses['commit'+commits])pause(pauses['commit'+commits],this.database.inTransaction);
        }else if(this.source==='ROLLBACK'){
          rollbacks++; record('rollback'+rollbacks,{begins,commits,rollbacks,inTransaction:this.database.inTransaction});
        }
        return value;
      };`;
  }
  async function ready(role, name, milliseconds = 10000) {
    const deadline = performance.now() + milliseconds;
    while (!existsSync(path(role, `${name}-ready`))) {
      assert.ok(performance.now() < deadline, `fixture ${role}/${name} preparation deadline`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return JSON.parse(readFileSync(path(role, `${name}-ready`), "utf8"));
  }
  function start(f, s, role, pauses, token = f.token) {
    const item = child(f.root, "send", s.endpoint, token, { duration: 30000, preload: preload(role, pauses) });
    item.closed = false; item.done.then(() => { item.closed = true; }, () => {}); children.push(item); return item;
  }
  async function close() {
    for (const item of releases) { const [role, name] = item.split("/"); release(role, name); }
    async function waitClosed(milliseconds) {
      const deadline = performance.now() + milliseconds;
      while (children.some(item => !item.closed) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    }
    for (const item of children) if (!item.closed) item.proc.kill("SIGTERM");
    await waitClosed(2000);
    for (const item of children) if (!item.closed) item.proc.kill("SIGKILL");
    await waitClosed(2000);
    race.preserve = children.some(item => !item.closed);
    assert.equal(race.preserve, false, `fixture children not closed; retained ${root}`);
    await Promise.all(children.map(item => item.done));
    rmSync(root, { recursive: true, force: true });
  }
  return Object.assign(race, { path, release, preload, ready, start, close });
}
function contentionEvidence(label, value) {
  if (evidence) writeFileSync(join(evidence, `${label}.json`), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

test("actual fixed AWS CLI v2 capability is required, never skipped", t => {
  const binary = process.platform === "darwin" ? "/opt/homebrew/bin/aws" : "/usr/local/bin/aws";
  const observed = spawnSync(binary, ["--version"], { env: { AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true", AWS_ACCESS_KEY_ID: "AKIAISOLATEDFIXTURE01", AWS_SECRET_ACCESS_KEY: "fixture-only-not-a-secret", PATH: "/usr/bin:/bin" }, timeout: 5000 });
  assert.equal(observed.error, undefined); assert.equal(observed.status, 0); assert.match(observed.stdout.toString(), /^aws-cli\/2\.[0-9]+\.[0-9]+\s/);
  t.diagnostic(`Node ${process.version}; ${binary}; ${observed.stdout.toString().trim()}`);
});

test("actual AWS CLI send -> plugin terminal uses original ledger and never grants authority", async t => {
  const f = fixture(t), s = await normalServer(t), sent = await runIsolatedSsmTransport(options(f, s.endpoint)); safety(sent);
  assert.equal(sent.stage, "committed"); assert.equal(sent.response, "accepted_or_replay"); assert.equal(sent.child, "started");
  const op = current(f).op;
  assert.equal(op.state, "submitted"); assert.equal(s.records.length, 1);
  assert.match(s.records[0].authorization, /Credential=AKIAISOLATEDFIXTURE01\//);
  assert.deepEqual(s.records[0].body, { InstanceIds: [FIXTURE_WIRE.InstanceId], DocumentName: FIXTURE_WIRE.DocumentName,
    DocumentVersion: "1", TimeoutSeconds: 30, Comment: `a3:${op.submitToken}:${op.requestHash.slice(0, 56)}` });
  const observed = await runIsolatedSsmTransport(options(f, s.endpoint, "invocation", current(f).token)); safety(observed);
  assert.equal(observed.observedStatus, "Success"); assert.equal(observed.hold, "committed");
  assert.equal(current(f).op.state, "terminal_pending"); assert.equal(current(f).op.disposition, "held");
  assert.deepEqual(s.records[1].body, { CommandId: op.commandId, InstanceId: FIXTURE_WIRE.InstanceId, PluginName: FIXTURE_WIRE.PluginName });
});
test("actual cancel ACK only records cancellation and unknown termination", async t => {
  const f = fixture(t), s = await normalServer(t);
  await runIsolatedSsmTransport(options(f, s.endpoint)); const token = current(f).token;
  const value = await runIsolatedSsmTransport(options(f, s.endpoint, "cancel", token)); safety(value);
  assert.equal(value.stage, "committed"); assert.equal(value.hold, "committed");
  assert.equal(current(f).op.state, "cancel_requested"); assert.equal(current(f).op.disposition, "held");
  assert.ok(current(f).op.failures.includes("ssm_cancel_not_termination")); assert.equal(s.records.length, 2);
});
for (const status of [503, 429, 301, 302, 307, 308]) test(`actual AWS CLI HTTP ${status}: one wire request, redirects zero`, async t => {
  const f = fixture(t), sentinel = await server(t, (_entry, res) => res.end("{}"));
  const s = await server(t, (_entry, res) => { res.statusCode = status; res.setHeader("Location", sentinel.endpoint); res.end(JSON.stringify({ __type: "FixtureUnavailable", message: "PRIVATE_FIXTURE_ERROR" })); });
  const value = await runIsolatedSsmTransport(options(f, s.endpoint)); safety(value);
  assert.equal(s.records.length, 1); assert.equal(sentinel.records.length, 0);
  assert.equal(value.stage, "committed"); assert.equal(value.hold, "committed"); assert.equal(value.child, "started");
  assert.equal(current(f).op.state, "submission_unknown"); assert.equal(current(f).op.disposition, "held");
  await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint, "send", current(f).token)), /invalid_maintenance_transition/);
  assert.equal(s.records.length, 1);
});
test("parent credentials/proxy/profile contamination is not inherited", async t => {
  const f = fixture(t), s = await normalServer(t);
  const variables = { AWS_PROFILE: "PRIVATE_FIXTURE_PROFILE", AWS_DEFAULT_PROFILE: "PRIVATE_FIXTURE_PROFILE", HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", AWS_ACCESS_KEY_ID: "PRIVATE_FIXTURE_KEY", AWS_SECRET_ACCESS_KEY: "PRIVATE_FIXTURE_SECRET",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/PRIVATE_FIXTURE_TOKEN", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9/credentials", PYTHONPATH: "/PRIVATE_FIXTURE_PYTHON" };
  const before = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try { const value = await runIsolatedSsmTransport(options(f, s.endpoint)); safety(value); assert.equal(value.response, "accepted_or_replay"); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(s.records.length, 1); assert.match(s.records[0].authorization, /Credential=AKIAISOLATEDFIXTURE01\//);
});
test("pre-cancel, endpoint aliases and extra inputs refuse before ledger/API effects", async t => {
  const f = fixture(t), s = await normalServer(t), before = inventory(f.root), aborted = AbortSignal.abort(new Error("generation_fence_lost"));
  const value = await runIsolatedSsmTransport(options(f, s.endpoint, "send", f.token, { signal: aborted }));
  assert.equal(value.first_control_reason, "generation_fence_lost"); assert.equal(value.stage, "not_attempted"); safety(value);
  for (const endpoint of ["http://localhost:1/", "http://127.0.0.1:01/", "http://127.0.0.1:65536/", "https://127.0.0.1:1/", "http://127.0.0.1:1/path", "http://127.0.0.1:1/?x=1", "http://127.1:1/", "http://127.0.0.1:1/#x"]) {
    await assert.rejects(runIsolatedSsmTransport(options(f, endpoint)), /transport_input_invalid/);
  }
  await assert.rejects(runIsolatedSsmTransport({ ...options(f, s.endpoint), callback() {} }), /transport_input_invalid/);
  let getters = 0;
  await assert.rejects(runIsolatedSsmTransport({ ...options(f, s.endpoint), get signal() { getters++; return undefined; } }), /transport_input_invalid/);
  assert.equal(getters, 0);
  await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint, "send", f.token, { deadlineAt: Date.now() - 1 })), /transport_input_invalid/);
  assert.deepEqual(inventory(f.root), before); assert.equal(s.records.length, 0);
});
test("mandatory own fields, optional signal and JSON keys reject inherited/getter/Proxy before reads or SQL/child/API", async t => {
  const f = fixture(t), s = await normalServer(t), before = inventory(f.root), methods = ["prepare", "exec", "pragma"];
  const originalMethods = Object.fromEntries(methods.map(name => [name, Database.prototype[name]])), originalSpawn = cp.spawn;
  let sql = 0, children = 0, reads = 0;
  for (const name of methods) Database.prototype[name] = function (...args) { sql++; return originalMethods[name].apply(this, args); };
  cp.spawn = function (...args) { children++; return originalSpawn.apply(this, args); }; syncBuiltinESMExports();
  async function inherited(name, value, raw) {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
    Object.defineProperty(Object.prototype, name, { configurable: true, get() { reads++; return value; } });
    try { await assert.rejects(runIsolatedSsmTransport(raw), /transport_input_invalid/); }
    finally { if (previous) Object.defineProperty(Object.prototype, name, previous); else delete Object.prototype[name]; }
  }
  try {
    for (const key of ["root", "action", "inputJson", "endpoint", "deadlineAt"]) {
      const raw = options(f, s.endpoint), value = raw[key]; delete raw[key]; await inherited(key, value, raw);
    }
    await inherited("signal", undefined, options(f, s.endpoint));
    const raw = options(f, s.endpoint);
    Object.defineProperty(raw, "signal", { enumerable: true, get() { reads++; return undefined; } });
    await assert.rejects(runIsolatedSsmTransport(raw), /transport_input_invalid/);
    const proxy = new Proxy(options(f, s.endpoint), { getPrototypeOf() { reads++; return Object.prototype; }, ownKeys() { reads++; return []; }, get() { reads++; return undefined; } });
    await assert.rejects(runIsolatedSsmTransport(proxy), /transport_input_invalid/);
    await assert.rejects(runIsolatedSsmTransport({ ...options(f, s.endpoint), endpoint: { toString() { reads++; return s.endpoint; } } }), /transport_input_invalid/);
    await inherited("schema", schema, { ...options(f, s.endpoint), inputJson: JSON.stringify({ extra: true, token: f.token }) });
    await inherited("token", f.token, { ...options(f, s.endpoint), inputJson: JSON.stringify({ schema, extra: true }) });
    const missingOwner = { ...f.token }; delete missingOwner.ownerId;
    await inherited("ownerId", f.token.ownerId, { ...options(f, s.endpoint), inputJson: JSON.stringify({ schema, token: missingOwner }) });
    const missingVolume = { ...f.token.target }; delete missingVolume.volumeId;
    await inherited("volumeId", f.token.target.volumeId, { ...options(f, s.endpoint), inputJson: JSON.stringify({ schema, token: { ...f.token, target: missingVolume } }) });
  } finally {
    for (const name of methods) Database.prototype[name] = originalMethods[name]; cp.spawn = originalSpawn; syncBuiltinESMExports();
  }
  assert.equal(reads, 0); assert.equal(sql, 0); assert.equal(children, 0); assert.equal(s.records.length, 0); assert.deepEqual(inventory(f.root), before);
});
test("own primitive input snapshot stays fixed when caller mutates original during real version child", async t => {
  const f = fixture(t), s = await normalServer(t), raw = options(f, s.endpoint), original = cp.spawn;
  cp.spawn = function (file, args, nativeOptions) {
    if (args.includes("--version")) { raw.root = "/PRIVATE_FIXTURE_ROOT"; raw.endpoint = "https://example.invalid"; raw.inputJson = "{}"; raw.deadlineAt = 0; raw.signal = AbortSignal.abort(); }
    return original.call(this, file, args, nativeOptions);
  }; syncBuiltinESMExports();
  let value; try { value = await runIsolatedSsmTransport(raw); } finally { cp.spawn = original; syncBuiltinESMExports(); }
  safety(value); assert.equal(value.response, "accepted_or_replay"); assert.equal(s.records.length, 1); assert.equal(current(f).op.state, "submitted");
});
test("version child cancellation preserves first cause; private empty cwd removed, ledger/API unchanged", async t => {
  const f = fixture(t), s = await normalServer(t), before = inventory(f.root), original = cp.spawn, cancel = new AbortController(); let cwd;
  cp.spawn = function (file, args, nativeOptions) {
    assert.notEqual(nativeOptions.cwd, f.root); assert.equal(statSync(nativeOptions.cwd).mode & 0o777, 0o700); cwd = nativeOptions.cwd;
    const proc = original.call(this, file, args, nativeOptions);
    if (args.includes("--version")) proc.once("spawn", () => cancel.abort(new Error("generation_fence_lost")));
    return proc;
  }; syncBuiltinESMExports();
  let value;
  try { value = await runIsolatedSsmTransport(options(f, s.endpoint, "send", f.token, { signal: cancel.signal })); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  safety(value); assert.equal(value.first_control_reason, "generation_fence_lost"); assert.equal(value.reason, "generation_fence_lost");
  assert.equal(value.stage, "not_attempted"); assert.equal(s.records.length, 0); assert.deepEqual(inventory(f.root), before); assert.equal(existsSync(cwd), false);
});
for (const invalid of ["wrongIdentity", "correctIdentity"]) test(`600 hot journal ${invalid}: NEW gate SQL0/API0 and exact bytes unchanged`, async t => {
  const f = fixture(t), s = await normalServer(t); hot(f); const before = archive(f.root, `hot-${invalid}-before`);
  const methods = ["prepare", "exec", "pragma"], original = Object.fromEntries(methods.map(name => [name, Database.prototype[name]])); let statements = 0;
  for (const name of methods) Database.prototype[name] = function (...args) { statements++; return original[name].apply(this, args); };
  try {
    const token = invalid === "wrongIdentity" ? { ...f.token, executionIdentity: "fixture-wrong" } : f.token;
    await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint, "send", token)), /transport_input_invalid|transport_sidecar_present/);
  } finally { for (const name of methods) Database.prototype[name] = original[name]; }
  assert.equal(statements, 0); assert.equal(s.records.length, 0); assert.deepEqual(archive(f.root, `hot-${invalid}-after`), before);
});
for (const suffix of ["-journal", "-wal", "-shm"]) test(`all observed ${suffix} sidecars rejected without SQL or cleanup`, async t => {
  const f = fixture(t), s = await normalServer(t); writeFileSync(join(f.root, `ledger.sqlite${suffix}`), "PRIVATE_FIXTURE", { mode: 0o600 });
  const before = inventory(f.root);
  await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint)), /transport_sidecar_present/);
  assert.deepEqual(inventory(f.root), before); assert.equal(s.records.length, 0);
});
test("two actual CLI processes compete: only stage winner sends", async t => {
  const race = contention(), f = fixture(t, { preserve: () => race.preserve }), s = await normalServer(t);
  try {
    const a = race.start(f, s, "a", { commit1: "inspect", commit2: "stage" });
    const aInspect = await race.ready("a", "inspect"); assert.equal(aInspect.inTransaction, false);
    const b = race.start(f, s, "b", { commit1: "inspect" });
    const bInspect = await race.ready("b", "inspect"); assert.equal(bInspect.inTransaction, false);
    race.release("a", "inspect");
    const aStage = await race.ready("a", "stage"); assert.equal(aStage.inTransaction, false); assert.equal(aStage.commits, 2);
    race.release("b", "inspect"); const loser = await b.done;
    const cas = JSON.parse(readFileSync(race.path("b", "rollback1"), "utf8"));
    assert.deepEqual(cas, { begins: 2, commits: 1, rollbacks: 1, inTransaction: false });
    assert.equal(loser.code, 1); assert.equal(loser.signal, null);
    const rejected = JSON.parse(loser.stdout); safety(rejected); assert.equal(rejected.reason, "maintenance_revision_conflict");
    race.release("a", "stage"); const winner = await a.done, values = [winner, loser];
    assert.equal(values.filter(value => value.code === 0).length, 1, JSON.stringify(values)); assert.equal(s.records.length, 1);
    const accepted = JSON.parse(winner.stdout); safety(accepted); assert.equal(accepted.response, "accepted_or_replay");
    assert.equal(current(f).op.state, "submitted");
    contentionEvidence("cas-race", { values, aInspect, bInspect, aStage, cas, wireRequests: s.records.length, state: current(f).state });
  } finally { await race.close(); }
});
test("real inspect lock contention: durable unknown sends0; ingress and current restart send0", async t => {
  const race = contention(), f = fixture(t, { preserve: () => race.preserve }), s = await normalServer(t);
  try {
    const before = current(f).state;
    const a = race.start(f, s, "a", { commit2: "stage" });
    const stage = await race.ready("a", "stage"); assert.equal(stage.inTransaction, false);
    const b = race.start(f, s, "b", { begin1: "locked" });
    const locked = await race.ready("b", "locked"); assert.equal(locked.inTransaction, true);
    race.release("a", "stage"); const winner = await a.done;
    const native = JSON.parse(readFileSync(race.path("a", "native-busy"), "utf8"));
    assert.deepEqual(native, { statement: "BEGIN IMMEDIATE", code: "SQLITE_BUSY" });
    assert.equal(winner.code, 1); assert.equal(winner.signal, null);
    const rejected = JSON.parse(winner.stdout); safety(rejected);
    assert.equal(rejected.stage, "committed"); assert.equal(rejected.child, "not_started"); assert.equal(rejected.reason, "transport_ledger_failed");
    race.release("b", "locked"); const loser = await b.done;
    assert.equal(loser.code, 1); assert.equal(loser.signal, null); assert.match(loser.stderr, /maintenance_revision_conflict/);
    assert.equal(s.records.length, 0);
    // Preserve exact native bytes after both CLI closes, before diagnostic SQL.
    const files = archive(f.root, "busy-before-diagnostic");
    const unknown = current(f);
    assert.equal(unknown.op.state, "submission_unknown"); assert.equal(unknown.op.disposition, "active"); assert.equal(unknown.op.commandId, null);
    assert.equal(unknown.op.revision, before.operations[f.token.operationId].revision + 1);
    assert.equal(unknown.state.revision, before.revision + 1); assert.deepEqual(inventory(f.root), files);
    const restarts = [];
    for (const [role, token] of [["ingress", f.token], ["unknown", unknown.token]]) {
      const restarted = await race.start(f, s, role, {}, token).done; restarts.push({ role, ...restarted });
      assert.equal(restarted.code, 1); assert.equal(restarted.signal, null); assert.equal(s.records.length, 0);
      assert.deepEqual(archive(f.root, `busy-after-${role}-restart`), files);
      assert.deepEqual(current(f).state, unknown.state);
    }
    // A real measured red for the old unconditional liveness assumption; the
    // expected assertion failure is evidence, not a runtime retry/fix claim.
    let oldAssertion;
    try { assert.equal([winner, loser].filter(value => value.code === 0).length, 1); }
    catch (error) { oldAssertion = { code: error.code, actual: error.actual, expected: error.expected, operator: error.operator }; }
    assert.deepEqual(oldAssertion, { code: "ERR_ASSERTION", actual: 0, expected: 1, operator: "strictEqual" });
    contentionEvidence("busy-race", { winner, loser, stage, locked, native, wireRequests: s.records.length, files, unknown, restarts, oldAssertion });
  } finally { await race.close(); }
});
test("contention preparation failure remains failed; own CLI closes before controls are removed", async t => {
  const race = contention(), f = fixture(t, { preserve: () => race.preserve }), s = await normalServer(t);
  let a, preparation;
  await assert.rejects(async () => {
    try {
      a = race.start(f, s, "a", { commit1: "inspect" });
      assert.equal((await race.ready("a", "inspect")).inTransaction, false);
      try { await race.ready("a", "deliberately-absent", 10); }
      catch (error) { preparation = error.message; throw error; }
    } finally { await race.close(); }
  }, /fixture a\/deliberately-absent preparation deadline/);
  assert.equal(a.closed, true); assert.equal(race.preserve, false); assert.equal(existsSync(race.root), false);
  contentionEvidence("preparation-failure", { preparation, child: await a.done, controlsRemovedAfterClose: true });
});
test("accepted request, dropped response, kill/restart remains unknown and never resends", async t => {
  const f = fixture(t), s = await server(t, (_entry, res) => { res.socket.destroy(); });
  const value = await runIsolatedSsmTransport(options(f, s.endpoint)); safety(value);
  assert.equal(s.records.length, 1); assert.equal(value.hold, "committed"); assert.equal(current(f).op.state, "submission_unknown");
  const restart = child(f.root, "send", s.endpoint, current(f).token); assert.notEqual((await restart.done).code, 0); assert.equal(s.records.length, 1);
});
test("SIGKILL after actual HTTP before response preserves durable unknown, restart sends0", async t => {
  const f = fixture(t); let respond;
  const s = await server(t, (entry, res) => { respond = () => res.end(JSON.stringify(commandResponse(entry))); }), proc = child(f.root, "send", s.endpoint, f.token);
  await until(() => s.records.length === 1); proc.proc.kill("SIGKILL"); assert.equal((await proc.done).signal, "SIGKILL");
  // The killed parent does not certify child/remote termination. Finish only this local
  // fixture response so the orphaned CLI can close; retain the durable unknown fact.
  respond();
  archive(f.root, "kill-after-http-before-recovery"); assert.equal(current(f).op.state, "submission_unknown");
  const restart = child(f.root, "send", s.endpoint, current(f).token); assert.notEqual((await restart.done).code, 0); assert.equal(s.records.length, 1);
});
test("first cancellation during hanging actual HTTP persists cause, late response has no authority", async t => {
  const f = fixture(t); let responder;
  const s = await server(t, (entry, res) => { responder = () => res.end(JSON.stringify(commandResponse(entry))); });
  const cancel = new AbortController(), run = runIsolatedSsmTransport(options(f, s.endpoint, "send", f.token, { signal: cancel.signal }));
  await until(() => s.records.length === 1); cancel.abort(new Error("generation_fence_lost"));
  const value = await run; safety(value); assert.equal(value.first_control_reason, "generation_fence_lost"); assert.equal(value.hold, "committed");
  assert.ok(current(f).op.failures.includes("generation_fence_lost")); responder();
  assert.equal(current(f).op.commandId, null); assert.equal(current(f).op.state, "submission_unknown");
});
test("actual body without EOF times out, cleanup grace adds no requests", async t => {
  const f = fixture(t); let response, partialWritten = false, writeFailure;
  const s = await server(t, (_entry, res) => {
    response = res;
    res.write("{\"Command\":", error => { if (error) writeFailure = error; else partialWritten = true; });
  });
  archive(f.root, "no-eof-before-control");
  const input = options(f, s.endpoint), outcome = runIsolatedSsmTransport(input).then(value => ({ value }), error => ({ error }));
  let preparationFailure;
  try {
    const barrierDeadline = performance.now() + 5000;
    while (true) {
      assert.ok(performance.now() < barrierDeadline, "fixture no-EOF preparation deadline");
      if (writeFailure) throw new Error("fixture_partial_body_write_failed");
      if (s.records.length === 1 && s.records[0].target === "AmazonSSM.SendCommand" && partialWritten && response?.writableEnded === false) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } catch { preparationFailure = new Error("fixture_no_eof_prepare_barrier_failed"); }
  // Always settle this same original 10s run, including a failed 5s preparation barrier.
  // The write callback proves server output with no EOF, not that the CLI parsed bytes.
  const settled = await outcome;
  archive(f.root, "no-eof-after-control-before-diagnostic");
  t.diagnostic(JSON.stringify({ case: "no-eof", deadlineAt: input.deadlineAt, requests: s.records.length, target: s.records[0]?.target ?? null,
    partialWritten, writeFailed: Boolean(writeFailure), writableEnded: response?.writableEnded ?? null, preparationFailed: Boolean(preparationFailure), result: settled.value ?? null }));
  if (preparationFailure) throw preparationFailure;
  if (settled.error) throw settled.error;
  const value = settled.value; safety(value);
  assert.equal(value.first_control_reason, "task_deadline_exceeded"); assert.equal(value.hold, "committed"); assert.equal(s.records.length, 1);
  assert.equal(partialWritten, true); assert.equal(response.writableEnded, false);
  const op = current(f).op; assert.equal(op.state, "submission_unknown"); assert.equal(op.disposition, "held");
  assert.ok(op.failures.includes("task_deadline_exceeded"));
});
for (const scenario of ["stdout", "stderr", "invalidJSON", "wrongComment"]) test(`actual ${scenario} response refuses and holds`, async t => {
  const f = fixture(t), s = await server(t, (entry, res) => {
    if (scenario === "stderr") { res.statusCode = 400; res.end(JSON.stringify({ __type: "FixtureError", message: "PRIVATE_FIXTURE_".repeat(10000) })); }
    else if (scenario === "invalidJSON") res.end("not JSON PRIVATE_FIXTURE");
    else { const body = commandResponse(entry); body.Command.Comment = scenario === "stdout" ? "PRIVATE_FIXTURE_".repeat(10000) : "PRIVATE_FIXTURE_WRONG"; res.end(JSON.stringify(body)); }
  });
  const value = await runIsolatedSsmTransport(options(f, s.endpoint)); safety(value);
  assert.equal(s.records.length, 1); assert.equal(value.hold, "committed"); assert.equal(current(f).op.disposition, "held");
  assert.equal(current(f).op.commandId, null);
});
test("stage COMMIT actually succeeds but acknowledgement throws: unknown, no child API, no retry", async t => {
  const f = fixture(t), s = await normalServer(t), probe = new Database(":memory:"), prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")); probe.close();
  const original = prototype.run; let commits = 0;
  prototype.run = function (...args) { const value = original.apply(this, args); if (this.source === "COMMIT" && ++commits === 2) throw new Error("PRIVATE_FIXTURE_COMMIT_ACK_LOST"); return value; };
  let value; try { value = await runIsolatedSsmTransport(options(f, s.endpoint)); } finally { prototype.run = original; }
  safety(value); assert.equal(value.stage, "unknown"); assert.equal(value.child, "not_started"); assert.equal(s.records.length, 0);
  archive(f.root, "stage-commit-ack-lost-before-operator-inspection"); assert.equal(current(f).op.state, "submission_unknown");
  await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint, "send", current(f).token)), /invalid_maintenance_transition/);
  assert.equal(s.records.length, 0);
});
test("hold COMMIT succeeds but acknowledgement throws: durable held, returned hold unknown, no retry", async t => {
  const f = fixture(t), s = await server(t, (_entry, res) => { res.statusCode = 503; res.end("{}"); });
  const probe = new Database(":memory:"), prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")); probe.close();
  const original = prototype.run; let armed = false, injected = false;
  prototype.run = function (...args) {
    const value = original.apply(this, args);
    if (this.source.startsWith("INSERT INTO events") && args.some(arg => typeof arg === "string" && arg.includes("transport_child_failed"))) armed = true;
    if (armed && this.source === "COMMIT") { injected = true; armed = false; throw new Error("PRIVATE_FIXTURE_HOLD_ACK_LOST"); }
    return value;
  };
  let value; try { value = await runIsolatedSsmTransport(options(f, s.endpoint)); } finally { prototype.run = original; }
  safety(value); assert.equal(injected, true); assert.equal(value.hold, "unknown"); assert.equal(value.reason, "transport_ledger_failed"); assert.equal(s.records.length, 1);
  archive(f.root, "hold-commit-ack-lost-before-operator-inspection"); assert.equal(current(f).op.disposition, "held");
  assert.ok(current(f).op.failures.includes("transport_child_failed"));
  await assert.rejects(runIsolatedSsmTransport(options(f, s.endpoint, "send", current(f).token)), /invalid_maintenance_transition/); assert.equal(s.records.length, 1);
});
test("actual conflicting plugin terminal preserves original committed hold/conflict and performs no follow-on mutation", async t => {
  const f = fixture(t); let commandId, comment, observations = 0;
  const s = await server(t, (entry, res) => {
    if (entry.target === "AmazonSSM.SendCommand") { commandId = randomUUID(); comment = entry.body.Comment; res.end(JSON.stringify(commandResponse(entry, commandId))); }
    else { const first = observations++ === 0; res.end(JSON.stringify({ ...FIXTURE_WIRE, CommandId: commandId, Comment: comment, Status: first ? "Success" : "Failed",
      StatusDetails: first ? "Success" : "Failed", ResponseCode: first ? 0 : 1 })); }
  });
  await runIsolatedSsmTransport(options(f, s.endpoint));
  await runIsolatedSsmTransport(options(f, s.endpoint, "invocation", current(f).token)); const before = current(f).op;
  const value = await runIsolatedSsmTransport(options(f, s.endpoint, "invocation", current(f).token)); safety(value);
  assert.equal(value.response, "invalid"); assert.equal(value.reason, "maintenance_terminal_conflict"); assert.equal(value.hold, "committed"); assert.equal(value.observedStatus, null);
  assert.equal(current(f).op.disposition, "held"); assert.equal(current(f).op.revision, before.revision + 1); assert.equal(s.records.length, 3);
  assert.deepEqual(current(f).op.failures.slice(-1), ["terminal_conflict"]);
});
test("false stopped signed fixture declaration may race last-check -> spawn; no foreign mutation", async t => {
  const f = fixture(t), s = await normalServer(t), original = cp.spawn; let fired = false, foreignToken;
  cp.spawn = function (file, args, ...rest) {
    if (file.endsWith("/aws") && args.includes("send-command") && !fired) {
      fired = true; let { token, op } = current(f); token = f.ledger.hold(token, "false_fixture_stop"); op = current(f).op;
      const binding = bindingFor(op), bytes = canonical({ schema: "fixture-process-stop-v1", ...binding, remoteFixtureStopped: true,
        localControllerStopped: true, continuationsStopped: true, outcome: "NotSubmitted" });
      const evidenceHash = hash(bytes); writeFileSync(join(f.root, `evidence-${evidenceHash}.json`), bytes, { mode: 0o600, flag: "wx" });
      const payload = { schema: "a3-authorization-v1", ...binding, revision: token.revision, approverId: "fixture-reviewer", action: "release",
        reason: "false_stop_declaration_fixture_negative", processesStopped: true, evidenceHash };
      f.ledger.authorize({ payload, signature: sign(null, Buffer.from(DOMAIN + canonical(payload)), f.keys.privateKey).toString("hex") });
      foreignToken = f.ledger.acquire({ ...f.request, operationId: "op-foreign", ownerId: "fixture-foreign" });
    }
    return original.call(this, file, args, ...rest);
  }; syncBuiltinESMExports();
  let value; try { value = await runIsolatedSsmTransport(options(f, s.endpoint)); } finally { cp.spawn = original; syncBuiltinESMExports(); }
  safety(value); assert.equal(fired, true); assert.equal(s.records.length, 1); assert.equal(value.reason, "maintenance_owner_lost");
  const state = f.ledger.inspect(); assert.equal(state.operations[foreignToken.operationId].revision, foreignToken.revision);
  assert.deepEqual(state.operations[foreignToken.operationId].failures, []); assert.equal(state.operations[f.token.operationId].disposition, "released");
});
test("actual CLI valid entry and bounded stdin without EOF", async t => {
  const f = fixture(t), s = await normalServer(t), successful = child(f.root, "send", s.endpoint, f.token);
  const good = await successful.done; assert.equal(good.code, 0, good.stderr); safety(JSON.parse(good.stdout));
  const fresh = fixture(t), before = inventory(fresh.root), blocked = child(fresh.root, "send", s.endpoint, fresh.token, { write: false, duration: 150 });
  blocked.proc.stdin.write(JSON.stringify({ schema, token: fresh.token }));
  const noEof = await blocked.done; assert.equal(noEof.code, 1); assert.equal(noEof.stdout, ""); assert.match(noEof.stderr, /task_deadline_exceeded/);
  assert.deepEqual(inventory(fresh.root), before); assert.equal(s.records.length, 1);
  const oversized = child(fresh.root, "send", s.endpoint, fresh.token, { write: false });
  oversized.proc.stdin.on("error", () => {}); oversized.proc.stdin.write("x".repeat(65537));
  const over = await oversized.done; assert.equal(over.code, 1); assert.equal(over.stdout, ""); assert.deepEqual(inventory(fresh.root), before);
});
