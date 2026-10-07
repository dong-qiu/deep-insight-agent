/** Isolated protocol only. No business DB, AWS, shell or writer-resume adapter. */
import Database from "better-sqlite3";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  authorizationSchema, bindingFor, bindingSchema, canonical, check, configSchema, DOMAIN,
  evidenceSchema, hash, markerSchema, parse, requestSchema, responseSchema, same,
  signedSchema, stateSchema, terminalSchema, tokenFor, tokenSchema,
} from "./contract.mjs";

const APP_ID = 0x41335330;
const objects = {
  events: "CREATE TABLE events (seq INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL)",
  events_no_update: "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END",
  events_no_delete: "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END",
};
function safeInfo(info, directory = false) {
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
    && info.uid === process.getuid() && (info.mode & 0o777) === (directory ? 0o700 : 0o600)
    && (directory || info.nlink === 1), "unsafe_maintenance_path");
  return info;
}
function ordinary(path, directory = false) { return safeInfo(lstatSync(path), directory); }
function rootPath(root) {
  check(isAbsolute(root) && root === realpathSync(root), "noncanonical_maintenance_root");
  ordinary(root, true);
}
function bytes(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = safeInfo(fstatSync(fd));
    check(info.size <= 16384, "maintenance_record_too_large");
    const data = readFileSync(fd);
    check(Buffer.from(data.toString("utf8"), "utf8").equals(data), "invalid_maintenance_utf8");
    return data;
  } finally { closeSync(fd); }
}
function publicKey(pem) {
  check(/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n?$/.test(pem), "invalid_approver_public_key");
  const key = createPublicKey(pem);
  check(key.asymmetricKeyType === "ed25519", "invalid_approver_key");
  return key;
}
function syncDirectory(root) {
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createDurable(path, content, root) {
  const fd = openSync(path, "wx", 0o600);
  try { if (content !== undefined) writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(root);
}
function journalCheck(root) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const path = join(root, `ledger.sqlite${suffix}`);
    try { ordinary(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    check(suffix === "-journal", "unexpected_maintenance_sidecar");
  }
}
export function initialize(root, configuration) {
  rootPath(root);
  const config = parse(configSchema, configuration);
  check(config.target.dataPath === root, "maintenance_target_mismatch");
  publicKey(config.publicKey);
  check(!existsSync(join(root, "isolation.json")) && !existsSync(join(root, "ledger.sqlite")), "maintenance_already_initialized");
  check(readdirSync(root).length === 0, "maintenance_root_not_empty");
  const marker = { ...config, schema: "a3-isolation-v1", initId: randomUUID() };
  // The marker is a permanent tombstone for an interrupted initialization.
  createDurable(join(root, "isolation.json"), canonical(marker), root);
  createDurable(join(root, "ledger.sqlite"), undefined, root);
  journalCheck(root);
  const db = new Database(join(root, "ledger.sqlite"), { fileMustExist: true, timeout: 0 });
  try {
    db.pragma("journal_mode = DELETE"); db.pragma("synchronous = FULL");
    db.transaction(() => {
      for (const sql of Object.values(objects)) db.exec(sql);
      db.pragma(`application_id = ${APP_ID}`); db.pragma("user_version = 1");
      const state = parse(stateSchema, { schema: "a3-ledger-v1", marker, revision: 0, fence: 0, active: null, operations: {} });
      const snapshot = canonical(state);
      db.prepare("INSERT INTO events VALUES(1,?,?,?)").run("genesis", hash(`genesis\n${snapshot}`), snapshot);
    }).immediate();
  } finally { db.close(); }
  syncDirectory(root);
}

export function openLedger(root) {
  rootPath(root);
  const marker = parse(markerSchema, JSON.parse(bytes(join(root, "isolation.json"))));
  check(marker.target.dataPath === root, "maintenance_target_mismatch");
  const key = publicKey(marker.publicKey);
  const dbPath = join(root, "ledger.sqlite");
  const identity = ordinary(dbPath);
  journalCheck(root);
  const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma("synchronous = FULL");
    read();
  } catch (error) { db.close(); throw error; }

  function pathCheck() {
    rootPath(root); journalCheck(root);
    const current = ordinary(dbPath);
    check(current.dev === identity.dev && current.ino === identity.ino, "maintenance_file_replaced");
    check(same(marker, parse(markerSchema, JSON.parse(bytes(join(root, "isolation.json"))))), "maintenance_marker_changed");
  }
  function metadataCheck() {
    check(db.pragma("journal_mode", { simple: true }) === "delete", "invalid_maintenance_journal");
    check(db.pragma("application_id", { simple: true }) === APP_ID && db.pragma("user_version", { simple: true }) === 1, "invalid_maintenance_version");
    const actual = Object.fromEntries(db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(row => [row.name, row.sql]));
    check(same(actual, objects), "invalid_maintenance_schema");
  }
  function read() {
    pathCheck();
    metadataCheck();
    let previous = "genesis", state, index = 0;
    for (const row of db.prepare("SELECT * FROM events ORDER BY seq").all()) {
      check(row.seq === ++index && row.previous_hash === previous && row.hash === hash(`${previous}\n${row.snapshot}`), "maintenance_audit_corrupt");
      state = parse(stateSchema, JSON.parse(row.snapshot));
      check(state.revision === index - 1 && same(state.marker, marker), "maintenance_genesis_mismatch");
      check(canonical(state) === row.snapshot, "maintenance_snapshot_invalid");
      validateState(state);
      previous = row.hash;
    }
    check(state, "maintenance_genesis_missing");
    return { state, previous, index };
  }
  function validateState(state) {
    const operations = Object.values(state.operations);
    const unreleased = operations.filter(op => op.disposition !== "released");
    check(unreleased.length === (state.active === null ? 0 : 1) && (unreleased.length === 0 || unreleased[0].operationId === state.active), "maintenance_active_corrupt");
    check(state.fence === operations.length, "maintenance_fence_corrupt");
    for (const [id, op] of Object.entries(state.operations)) {
      check(op.operationId === id && same(op.target, marker.target) && op.revision <= state.revision && op.fence <= state.fence, "maintenance_operation_corrupt");
      check(op.state === "pre_submit" ? op.submitToken === null && op.requestHash === null && op.commandId === null
        : op.state === "manual_takeover" || (op.submitToken !== null && op.requestHash !== null), "maintenance_submission_corrupt");
      if (["submitted", "running", "cancel_requested", "terminal_pending", "terminal_verified"].includes(op.state)) check(op.commandId !== null, "maintenance_command_missing");
      if (["terminal_pending", "terminal_verified"].includes(op.state)) check(op.terminal !== null, "maintenance_terminal_missing");
    }
  }
  function transaction(change) {
    // BEGIN can recover/remove a hot journal even on an existing handle.
    // Preserve unsafe evidence before any SQLite operation; read() rechecks in-transaction.
    pathCheck();
    return db.transaction(() => {
      const { state, previous, index } = read();
      const before = canonical(state);
      const result = change(state);
      if (canonical(state) !== before) {
        state.revision += 1;
        if (state.active) state.operations[state.active].revision = state.revision;
        // Released operation still needs the revision of its final mutation.
        if (result?.operationId) state.operations[result.operationId].revision = state.revision;
        parse(stateSchema, state); validateState(state);
        const snapshot = canonical(state);
        db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(index + 1, previous, hash(`${previous}\n${snapshot}`), snapshot);
      }
      return result?.operationId ? tokenFor(state.operations[result.operationId]) : structuredClone(state);
    }).immediate();
  }
  function owned(state, rawToken, allowStale = false) {
    const token = parse(tokenSchema, rawToken);
    const op = state.operations[token.operationId];
    check(op && state.active === op.operationId && op.disposition !== "released", "maintenance_owner_lost");
    const current = tokenFor(op);
    check(same({ ...current, revision: 0 }, { ...token, revision: 0 }), "maintenance_owner_lost");
    if (!allowStale) check(token.revision === op.revision, "maintenance_revision_conflict");
    return op;
  }
  function acquire(raw) {
    const request = parse(requestSchema, raw);
    return transaction(state => {
      check(same(request.target, marker.target), "maintenance_target_mismatch");
      const existing = state.operations[request.operationId];
      if (existing) {
        check(same(parse(requestSchema, Object.fromEntries(Object.keys(request).map(k => [k, existing[k]]))), request), "maintenance_operation_conflict");
        return existing;
      }
      check(state.active === null, "maintenance_busy");
      state.fence += 1;
      const op = { ...request, fence: state.fence, revision: state.revision, state: "pre_submit", disposition: "active",
        commandId: null, submitToken: null, requestHash: null, terminal: null, authorizations: [], failures: [], observations: [] };
      state.operations[request.operationId] = op; state.active = request.operationId;
      return op;
    });
  }
  function beginSubmit(token, commandHash) {
    check(/^[a-f0-9]{64}$/.test(commandHash) && !/^0+$/.test(commandHash), "invalid_fixture_command_hash");
    return transaction(state => {
      const op = owned(state, token);
      check(op.state === "pre_submit" && op.disposition === "active", "maintenance_submission_already_started");
      op.submitToken = randomUUID();
      op.requestHash = hash(canonical({ schema: "fixture-submit-v1", ...bindingFor(op), commandHash }));
      op.state = "submission_unknown";
      return op;
    });
  }
  function bindCommand(token, rawBinding) {
    const binding = parse(bindingSchema, rawBinding);
    check(binding.commandId !== null, "maintenance_command_missing");
    return transaction(state => {
      const op = owned(state, token, true);
      check(same({ ...binding, commandId: null }, { ...bindingFor(op), commandId: null }), "maintenance_response_mismatch");
      if (op.commandId !== null) { check(op.commandId === binding.commandId, "maintenance_command_conflict"); return op; }
      check(op.revision === token.revision, "maintenance_revision_conflict");
      check(op.state === "submission_unknown", "invalid_maintenance_transition");
      op.commandId = binding.commandId; op.state = "submitted";
      return op;
    });
  }
  function observe(token, rawResponse) {
    const response = parse(responseSchema, rawResponse);
    let conflict = false;
    const result = transaction(state => {
      const op = owned(state, token, true);
      const { status, ...binding } = response;
      check(op.commandId !== null && same(binding, bindingFor(op)), "maintenance_response_mismatch");
      const isTerminal = terminalSchema.safeParse(status).success;
      if (op.terminal !== null) {
        if (isTerminal && op.terminal !== status) {
          check(op.revision === token.revision, "maintenance_revision_conflict");
          conflict = true; op.disposition = "held";
          if (!op.failures.includes("terminal_conflict")) op.failures.push("terminal_conflict");
        }
        return op; // Late nonterminal observation cannot reverse or release a terminal hold.
      }
      if (op.observations.includes(status)) return op;
      check(op.revision === token.revision, "maintenance_revision_conflict");
      check(["submitted", "running", "cancel_requested"].includes(op.state), "invalid_maintenance_transition");
      op.observations.push(status);
      if (isTerminal) { op.terminal = status; op.state = "terminal_pending"; }
      else if (op.state !== "cancel_requested") op.state = ["InProgress", "Cancelling"].includes(status) ? "running" : op.state;
      return op;
    });
    check(!conflict, "maintenance_terminal_conflict");
    return result;
  }
  function cancel(token) {
    return transaction(state => {
      const op = owned(state, token);
      check(["submitted", "running", "cancel_requested"].includes(op.state), "invalid_maintenance_transition");
      op.state = "cancel_requested";
      return op;
    });
  }
  function hold(token, reason) {
    check(/^[A-Za-z0-9_-]{1,128}$/.test(reason), "invalid_hold_reason");
    return transaction(state => {
      const op = owned(state, token);
      op.disposition = "held";
      if (!op.failures.includes(reason)) op.failures.push(reason);
      return op;
    });
  }
  function complete(token) {
    return transaction(state => {
      const op = owned(state, token);
      check(op.disposition === "active" && (op.state === "pre_submit" || (op.state === "terminal_verified" && op.terminal === "Success")), "maintenance_not_verified");
      op.disposition = "released"; state.active = null;
      return op;
    });
  }
  function authorize(rawSigned) {
    const signed = parse(signedSchema, rawSigned);
    const payload = parse(authorizationSchema, signed.payload);
    check(payload.approverId === marker.approverId && verify(null, Buffer.from(DOMAIN + canonical(payload)), key, Buffer.from(signed.signature, "hex")), "maintenance_authorization_invalid");
    return transaction(state => {
      const { operationId, ownerId, fence, revision, target, executionIdentity } = payload;
      const op = owned(state, { operationId, ownerId, fence, revision, target, executionIdentity });
      const binding = Object.fromEntries(Object.keys(bindingFor(op)).map(k => [k, payload[k]]));
      check(same(binding, bindingFor(op)), "maintenance_authorization_binding");
      let evidenceBytes = null;
      if (payload.action !== "takeover") {
        check(payload.processesStopped && payload.evidenceHash, "maintenance_stop_evidence_required");
        evidenceBytes = bytes(join(root, `evidence-${payload.evidenceHash}.json`));
        check(hash(evidenceBytes) === payload.evidenceHash, "maintenance_evidence_hash_mismatch");
        const evidence = parse(evidenceSchema, JSON.parse(evidenceBytes));
        const { schema, remoteFixtureStopped, localControllerStopped, continuationsStopped, outcome, ...evidenceBinding } = evidence;
        void schema; void remoteFixtureStopped; void localControllerStopped; void continuationsStopped;
        check(same(evidenceBinding, bindingFor(op)), "maintenance_evidence_binding");
        check(op.terminal === null || outcome === op.terminal, "maintenance_terminal_conflict");
      }
      if (payload.action === "takeover") { op.state = "manual_takeover"; op.disposition = "held"; }
      if (payload.action === "terminal_verify") {
        check(op.state === "terminal_pending", "invalid_maintenance_transition");
        op.state = "terminal_verified";
        if (op.terminal !== "Success") op.disposition = "held";
      }
      if (payload.action === "release") {
        check(op.disposition === "held", "maintenance_not_held");
        op.disposition = "released"; state.active = null;
      }
      op.authorizations.push({ signed, evidenceBytes: evidenceBytes === null ? null : evidenceBytes.toString("utf8") });
      return op;
    });
  }
  return { acquire, beginSubmit, bindCommand, observe, cancel, hold, complete, authorize,
    inspect: () => ({ ...transaction(() => undefined), production_permitted: false }), close: () => db.close() };
}

/** Test transport composition; the durable unknown transition always precedes dispatch.
 * No retry, cancellation inference, follow-on backup, migration or switch exists here. */
export async function submitFixtureOnce(ledger, token, commandHash, transport) {
  const unknown = ledger.beginSubmit(token, commandHash);
  const op = ledger.inspect().operations[unknown.operationId];
  const response = await transport(bindingFor(op));
  return ledger.bindCommand(unknown, response);
}
