/** Isolated observation and permanent hold only. Never grants maintenance readiness. */
import Database from 'better-sqlite3';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, check, markerSchema, parse, requestSchema, same, tokenFor } from './contract.mjs';
import { openLedger } from './ledger.mjs';
import { openWriters } from './writers.mjs';

const sourceBindings = new WeakMap();
const blocked = { drain_ready: false, writer_quiescence: false, production_permitted: false, process_termination: 'unknown' };
function safe(path, directory = false) {
  const info = lstatSync(path);
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || info.nlink === 1), 'unsafe_drain_path');
  return info;
}
function markerBytes(root) {
  check(isAbsolute(root) && root === realpathSync(root), 'noncanonical_drain_root'); safe(root, true);
  const path = join(root, 'isolation.json'), info = safe(path);
  check(info.size <= 16384, 'drain_marker_too_large');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    check(opened.isFile() && opened.uid === process.getuid() && (opened.mode & 0o777) === 0o600 && opened.nlink === 1, 'unsafe_drain_path');
    check(opened.dev === info.dev && opened.ino === info.ino, 'drain_marker_changed');
    const marker = parse(markerSchema, JSON.parse(readFileSync(fd, 'utf8')));
    check(marker.target.dataPath === root, 'drain_target_mismatch'); return marker;
  } finally { closeSync(fd); }
}
function ledgerMarker(root) { const ledger = openLedger(root); try { return ledger.inspect().marker; } finally { ledger.close(); } }
function sidecars(path) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { safe(`${path}${suffix}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const text = value => typeof value === 'string' && value.length > 0;
const epoch = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d\.\d{3}Z$/.test(value)) return null;
  const number = Date.parse(value); return Number.isFinite(number) && new Date(number).toISOString() === value ? number : null;
}
function inventory(dispatches, leases, at) {
  const result = { queued: 0, claimedCurrent: 0, claimedExpired: 0, unknown: 0 };
  const byTrace = new Map(); const validLeases = new Set(); const related = new Set();
  for (const lease of leases) {
    const group = byTrace.get(lease.trace_id) ?? []; group.push(lease); byTrace.set(lease.trace_id, group);
    const valid = text(lease.id) && text(lease.trace_id) && text(lease.active_key) && text(lease.scope_key)
      && ['reserved', 'owned', 'released'].includes(lease.state) && epoch(lease.fencing_epoch, lease.state === 'owned')
      && (lease.state === 'released' ? lease.expires_at === null
        : lease.state === 'reserved' ? lease.owner_token === null && (lease.expires_at === null || instant(lease.expires_at) !== null)
          : instant(lease.expires_at) !== null && text(lease.owner_token));
    if (valid) validLeases.add(lease); else result.unknown++;
  }
  for (const dispatch of dispatches) {
    const matches = byTrace.get(dispatch.trace_id) ?? [], lease = matches[0];
    const valid = text(dispatch.id) && text(dispatch.trace_id) && ['queued', 'claimed', 'done', 'failed'].includes(dispatch.state)
      && epoch(dispatch.claim_epoch, dispatch.state !== 'queued');
    if (!valid || matches.length !== 1 || !validLeases.has(lease)) { result.unknown++; continue; }
    if (dispatch.state === 'queued' && lease.state === 'reserved' && dispatch.owner_token === null && dispatch.lease_expires_at === null) {
      result.queued++; related.add(lease);
    } else if (dispatch.state === 'claimed' && lease.state === 'owned' && text(dispatch.owner_token)
      && dispatch.owner_token === lease.owner_token && instant(dispatch.lease_expires_at) !== null
      && dispatch.lease_expires_at === lease.expires_at) {
      if (instant(dispatch.lease_expires_at) >= at) result.claimedCurrent++; else result.claimedExpired++;
      related.add(lease);
    } else if (['done', 'failed'].includes(dispatch.state) && lease.state === 'released') related.add(lease);
    else result.unknown++;
  }
  for (const lease of leases) {
    if (validLeases.has(lease) && ['reserved', 'owned'].includes(lease.state) && !related.has(lease)) result.unknown++;
  }
  return result;
}

/** Own readonly connection, complete inventory in one native SQLite snapshot. */
export function openDrainLeaseSource(root, databasePath) {
  check(databasePath === join(root, 'fixture-business.sqlite') && isAbsolute(databasePath), 'drain_business_scope_mismatch');
  const marker = markerBytes(root); check(same(marker, ledgerMarker(root)), 'drain_marker_changed');
  const identity = safe(databasePath); check(databasePath === realpathSync(databasePath), 'drain_business_scope_mismatch'); sidecars(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
  let closed = false;
  function preflight() {
    check(!closed && db.open && db.readonly && !db.inTransaction && db.name === databasePath, 'drain_source_unavailable');
    check(same(marker, markerBytes(root)), 'drain_marker_changed');
    const current = safe(databasePath); check(current.dev === identity.dev && current.ino === identity.ino, 'drain_business_file_replaced');
    check(realpathSync(databasePath) === databasePath, 'drain_business_scope_mismatch'); sidecars(databasePath);
  }
  function sample(atUnixMs) {
    check(Number.isSafeInteger(atUnixMs) && atUnixMs >= 0, 'invalid_drain_sample_time');
    preflight(); // BEGIN/read can recover journals; this gate must have no SQL.
    return db.transaction(() => {
      check(same(marker, markerBytes(root)) && same(marker, ledgerMarker(root)), 'drain_marker_changed');
      const current = safe(databasePath); check(current.dev === identity.dev && current.ino === identity.ino, 'drain_business_file_replaced'); sidecars(databasePath);
      const databases = db.prepare('PRAGMA database_list').all();
      check(databases.length === 1 && databases[0].name === 'main' && databases[0].file === databasePath, 'drain_business_scope_mismatch');
      // Do not filter or join: orphan active/invalid leases and other entry points must remain visible.
      const dispatches = db.prepare('SELECT id,trace_id,state,owner_token,claim_epoch,lease_expires_at FROM generation_dispatch').all();
      const leases = db.prepare('SELECT id,trace_id,state,owner_token,fencing_epoch,expires_at,active_key,scope_key FROM generation_lease').all();
      return { schema: 'a3-drain-observation-v1', scope: 'isolated', sampledAt: atUnixMs,
        source: { root, databasePath, marker: structuredClone(marker) }, ...inventory(dispatches, leases, atUnixMs), ...blocked };
    })();
  }
  try { sample(Date.now()); } catch (error) { db.close(); throw error; }
  const source = Object.freeze({ sample, close: () => { if (!closed) { db.close(); closed = true; } } });
  sourceBindings.set(source, { root, databasePath, marker }); return source;
}

function cancellationReason(signal) {
  const code = signal?.reason?.reasonCode;
  return ['cancelled', 'task_deadline_exceeded', 'generation_fence_lost'].includes(code) ? code : 'writer_drain_cancelled';
}
/** Caller-declared fixture identity. Every exit is blocked; only an owned token may persist hold. */
export async function observeDrain({ root, request: rawRequest, deadlineAt, pollEveryMs, signal, leaseSource }) {
  const request = parse(requestSchema, rawRequest); const wallStart = Date.now(), monoStart = performance.now();
  check(Number.isSafeInteger(deadlineAt) && deadlineAt > wallStart && deadlineAt - wallStart <= 60_000, 'invalid_drain_deadline');
  check(Number.isSafeInteger(pollEveryMs) && pollEveryMs >= 1 && pollEveryMs <= 1000, 'invalid_drain_poll');
  check(signal === undefined || signal instanceof AbortSignal, 'invalid_drain_signal');
  const binding = sourceBindings.get(leaseSource);
  check(binding && binding.root === root && binding.databasePath === join(root, 'fixture-business.sqlite'), 'drain_source_scope_mismatch');
  let ledger, writers, token, firstCancellation;
  const remaining = () => Math.min(deadlineAt - Date.now(), deadlineAt - wallStart - (performance.now() - monoStart));
  const onAbort = () => { firstCancellation ??= cancellationReason(signal); };
  const result = (reason, sample, polls = 0) => ({ schema: 'a3-drain-observation-v1', scope: 'isolated',
    reason, token: token ? structuredClone(token) : null, sample, polls, controller_uniqueness: 'unknown', ...blocked });
  function owned() {
    const state = ledger.inspect(), op = state.operations[token.operationId];
    check(state.active === token.operationId && op && same(tokenFor(op), token), 'drain_owner_revision_lost');
    check(op.state === 'pre_submit' && op.disposition === 'active', 'drain_operation_not_active');
    check(same(state.marker, binding.marker) && same(op.target, request.target) && op.executionIdentity === request.executionIdentity, 'drain_target_mismatch');
  }
  try {
    ledger = openLedger(root); writers = openWriters(root);
    const initial = ledger.inspect(), writerInitial = writers.inspect();
    check(same(initial.marker, binding.marker) && same(writerInitial.marker, binding.marker)
      && same(request.target, binding.marker.target), 'drain_target_mismatch');
    const sample = leaseSource.sample(Date.now()); // Validate real full source before closing/acquiring.
    const previous = initial.operations[request.operationId];
    if (previous) {
      check(same(parse(requestSchema, Object.fromEntries(Object.keys(request).map(key => [key, previous[key]]))), request), 'maintenance_operation_conflict');
      return result('writer_drain_replay', sample); // No close, acquire, resume, or hold on an observed replay.
    }
    if (signal?.aborted) return result(cancellationReason(signal), sample);
    check(remaining() > 0, 'invalid_drain_deadline');
    signal?.addEventListener('abort', onAbort, { once: true });
    writers.closeAdmission();
    const beforeAcquire = ledger.inspect();
    if (beforeAcquire.operations[request.operationId]) return result('writer_drain_replay', sample);
    token = ledger.acquire(request);
    // Observation check only: same-identity simultaneous callers cannot be OS-authenticated here.
    check(token.fence === beforeAcquire.fence + 1 && token.revision === beforeAcquire.revision + 1, 'drain_acquire_unknown');
    let last = sample, polls = 0, reason;
    try {
      for (;;) {
        owned(); const view = writers.inspect();
        check(same(view.marker, binding.marker) && view.admission === 'closed', 'drain_writer_binding_lost');
        last = leaseSource.sample(Date.now()); polls++;
        if (firstCancellation !== undefined || signal?.aborted) { onAbort(); reason = firstCancellation; break; }
        if (remaining() <= 0) { reason = 'writer_drain_timeout'; break; }
        if (!view.tasks.some(task => task.outcome === null)) { reason = 'writer_drain_coverage_unknown'; break; }
        await new Promise(resolve => {
          let timer;
          const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
          timer = setTimeout(done, Math.min(pollEveryMs, Math.max(1, remaining())));
          signal?.addEventListener('abort', done, { once: true });
          if (signal?.aborted) done();
        });
      }
    } catch { reason = 'writer_drain_observation_failed'; }
    // A failure never authorizes takeover/retry or mutation of someone else's operation.
    owned(); token = ledger.hold(token, reason);
    return result(reason, last, polls);
  } finally {
    signal?.removeEventListener('abort', onAbort); writers?.close(); ledger?.close();
  }
}
