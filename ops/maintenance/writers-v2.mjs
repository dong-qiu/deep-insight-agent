/** S2a isolated v2 coordination and fixed empty-business pre-open. No domain SQL or readiness grant. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonical, check, hash, same } from './contract.mjs';
import { openLedger } from './ledger.mjs';

const APP_ID = 0x41335732;
const ENTRIES = ['generation-dispatch', 'source-collect', 'startup', 'local-seed', 'raw-recovery', 'report-recovery'];
const OUTCOMES = ['completed', 'completed_with_diagnostics', 'denied', 'cancelled', 'interrupted_unknown'];
const TABLE_SQL = [
  "CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
  "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('open','closed')))",
  "CREATE TABLE workers (worker_id TEXT PRIMARY KEY, generation_token TEXT UNIQUE NOT NULL, entry_point TEXT NOT NULL CHECK(entry_point IN ('generation-dispatch','source-collect','startup','local-seed','raw-recovery','report-recovery')))",
  "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(worker_id))",
  "CREATE TABLE operations (operation_id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL REFERENCES tasks(task_id), invocation_id TEXT UNIQUE NOT NULL, scope_json TEXT NOT NULL, input_hash TEXT NOT NULL, recovery_of TEXT)",
  "CREATE TABLE steps (step_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(operation_id), step_key TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), input_hash TEXT NOT NULL, UNIQUE(operation_id,ordinal))",
  "CREATE TABLE bindings (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), target_kind TEXT NOT NULL CHECK(target_kind IN ('business','raw','report')), identity_json TEXT NOT NULL)",
  "CREATE TABLE step_results (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), business_commit TEXT NOT NULL CHECK(business_commit IN ('not_committed','committed','unknown','not_applicable')), filesystem_json TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('completed','denied','cancelled','unsupported','unknown')), reason TEXT NOT NULL)",
  "CREATE TABLE terminals (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), outcome TEXT NOT NULL CHECK(outcome IN ('completed','completed_with_diagnostics','denied','cancelled','interrupted_unknown')), first_reason TEXT NOT NULL)",
  "CREATE TABLE audit_facts (seq INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, fact_json TEXT NOT NULL)"
];
const OBJECTS = Object.fromEntries(TABLE_SQL.map(sql => [sql.match(/^CREATE TABLE (\w+)/)[1], sql]));
for (const table of ['identity','workers','tasks','operations','steps','bindings','step_results','terminals','audit_facts']) {
  for (const action of ['UPDATE','DELETE']) OBJECTS[`${table}_no_${action.toLowerCase()}`] = `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END`;
}
OBJECTS.admission_no_delete = "CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END";
OBJECTS.admission_no_reopen = "CREATE TRIGGER admission_no_reopen BEFORE UPDATE ON admission WHEN OLD.mode='closed' BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END";
const INDEX_COLUMNS = { workers_1:['worker_id'], workers_2:['generation_token'], tasks_1:['task_id'], operations_1:['operation_id'], operations_2:['task_id'], operations_3:['invocation_id'], steps_1:['step_id'], steps_2:['operation_id','ordinal'], bindings_1:['step_id'], step_results_1:['step_id'], terminals_1:['operation_id'], audit_facts_1:['hash'] };
const workerCaps = new WeakMap(), operationCaps = new WeakMap(), targetCaps = new WeakMap();
// Known local connections only: unknown external writers are not covered by S2a.
const businessHandles = new Map();
function noBusinessTransaction(root) {
  for (const db of businessHandles.get(root) ?? []) {
    if (!db.open) { businessHandles.get(root).delete(db); continue; }
    check(!db.inTransaction, 'v2_reverse_business_transaction');
  }
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
function valueCopy(value, depth = 0) {
  check(depth < 20 && !types.isProxy(value), 'v2_invalid_value');
  if (value === null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') { check(Number.isSafeInteger(value), 'v2_invalid_value'); return value; }
  check(value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), 'v2_invalid_value');
  check(Object.getOwnPropertySymbols(value).length === 0, 'v2_invalid_value');
  const out = Array.isArray(value) ? [] : {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    check(Object.hasOwn(descriptor,'value') && descriptor.enumerable, 'v2_invalid_value');
    Object.defineProperty(out,key,{value:valueCopy(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  if (Array.isArray(value)) check(Object.keys(out).length === value.length && Object.keys(out).every((k,i) => k === String(i)), 'v2_invalid_value');
  return out;
}
function exact(value, keys) { check(value && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), 'v2_invalid_record'); }
function json(textValue) { const v = valueCopy(JSON.parse(textValue)); check(canonical(v) === textValue, 'v2_noncanonical_json'); return v; }
function scopeFor(entry, raw) {
  const scope = valueCopy(raw);
  if (entry === 'startup' || entry === 'local-seed') {
    exact(scope,['kind','configHash','runtimeVersion','mode']);
    check(scope.kind === entry && digest(scope.configHash) && text(scope.runtimeVersion) && scope.mode === (entry === 'startup' ? 'initialize-existing' : 'local-create'), 'v2_invalid_scope');
  } else if (entry === 'generation-dispatch') {
    exact(scope,['kind','purpose','claim']); exact(scope.claim,['dispatchId','traceId','ownerToken','claimEpoch','fencingEpoch','rootRunId']);
    check(scope.kind === 'dispatch' && ['usage','terminal'].includes(scope.purpose) && ['dispatchId','traceId','ownerToken','rootRunId'].every(k => text(scope.claim[k])) && ['claimEpoch','fencingEpoch'].every(k => Number.isSafeInteger(scope.claim[k]) && scope.claim[k] > 0), 'v2_invalid_scope');
  } else if (entry === 'source-collect') {
    exact(scope,['kind','sourceId','triggerKind','scopeKey','retryOfTraceId','retryOfRunId','requestTimeIso']);
    check(scope.kind === 'source-prelude' && text(scope.sourceId) && ['cron','api','retry','probe'].includes(scope.triggerKind) && typeof scope.requestTimeIso === 'string' && new Date(scope.requestTimeIso).toISOString() === scope.requestTimeIso, 'v2_invalid_scope');
    const retry = scope.triggerKind === 'retry'; check(retry ? text(scope.retryOfTraceId) && text(scope.retryOfRunId) : scope.retryOfTraceId === null && scope.retryOfRunId === null, 'v2_invalid_scope');
    const expected = retry ? `source_collect_retry:${scope.sourceId}:${scope.retryOfRunId}` : scope.triggerKind === 'cron' ? `source_collect:${scope.sourceId}:${scope.requestTimeIso.slice(0,13)}` : `source_collect:${scope.triggerKind}:${scope.sourceId}:${scope.requestTimeIso}`;
    check(scope.scopeKey === expected, 'v2_invalid_scope');
  } else {
    exact(scope,['kind','effectId','idempotencyKey','manifestHash','payloadHash']);
    check(scope.kind === entry && text(scope.effectId) && text(scope.idempotencyKey) && digest(scope.manifestHash) && digest(scope.payloadHash), 'v2_invalid_scope');
  }
  return scope;
}
function safe(path, directory = false) {
  const info = lstatSync(path);
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || info.nlink === 1), 'v2_unsafe_path');
  return info;
}
function identity(path, directory = false) { const s = safe(path,directory); return {path,dev:String(s.dev),ino:String(s.ino)}; }
function rootIdentity(root) { check(typeof root === 'string' && isAbsolute(root) && realpathSync(root) === root, 'v2_noncanonical_root'); return identity(root,true); }
function sidecars(path) { for (const suffix of ['-journal','-wal','-shm']) { try { safe(path+suffix); check(suffix === '-journal','v2_unexpected_sidecar'); } catch(e) { if(e.code !== 'ENOENT') throw e; } } }
function durable(path, bytes, createEffect) {
  const fd = openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
  // O_EXCL success is a file fact, even when fsync/close subsequently fails.
  if (createEffect) createEffect.outcome = 'occurred';
  try { if(bytes !== undefined) writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncRoot(root) { const fd = openSync(root,'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ledgerIdentity(root) {
  const ledger = openLedger(root); let marker;
  try { marker = ledger.inspect().marker; } finally { ledger.close(); } // .inspect's IMMEDIATE transaction ends here.
  check(same(marker.target,{region:'isolated',instanceId:'fixture-writers-v2-node',volumeId:'fixture-writers-v2-volume',dataPath:root,serviceSet:['fixture-writers-v2']}), 'v2_s0_target_mismatch');
  return hash(canonical(marker));
}
function markerRead(root) {
  const path = join(root,'writers-isolation.json'), info = safe(path); check(info.size <= 16384,'v2_marker_too_large');
  const fd = openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes;
  try { const opened = fstatSync(fd); check(opened.dev === info.dev && opened.ino === info.ino,'v2_marker_changed'); bytes = readFileSync(fd); } finally { closeSync(fd); }
  check(Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes),'v2_marker_utf8');
  const str = bytes.toString('utf8'); check(str.endsWith('\n') && !str.endsWith('\n\n'),'v2_marker_format'); const m = json(str.slice(0,-1));
  exact(m,['schema','initId','ledgerMarkerHash','root','registry','targets']); exact(m.root,['path','dev','ino']); exact(m.registry,['name','dev','ino']); exact(m.targets,['business','raw','report']);
  check(m.schema === 'a3-writers-isolation-v2' && uuid(m.initId) && digest(m.ledgerMarkerHash) && decimal(m.root.dev) && decimal(m.root.ino) && decimal(m.registry.dev) && decimal(m.registry.ino) && m.registry.name === 'writers.sqlite' && same(m.targets,{business:'d2-business.sqlite',raw:'raw',report:'report'}),'v2_invalid_marker');
  check(same(m.root,rootIdentity(root)) && same({dev:m.registry.dev,ino:m.registry.ino},{dev:identity(join(root,'writers.sqlite')).dev,ino:identity(join(root,'writers.sqlite')).ino}), 'v2_physical_generation_lost');
  return {marker:m,markerFile:identity(path)};
}
function schemaCheck(db) {
  check(db.pragma('application_id',{simple:true}) === APP_ID && db.pragma('user_version',{simple:true}) === 2 && db.pragma('foreign_keys',{simple:true}) === 1 && db.pragma('journal_mode',{simple:true}) === 'delete' && db.pragma('synchronous',{simple:true}) === 2,'v2_invalid_version');
  const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master').all();
  check(same(Object.fromEntries(rows.filter(r => r.sql !== null).map(r => [r.name,r.sql])),OBJECTS),'v2_invalid_schema');
  const indices = rows.filter(r => r.sql === null); check(indices.length === 12,'v2_invalid_indices');
  for (const [name,columns] of Object.entries(INDEX_COLUMNS)) {
    const actual = indices.find(r => r.name === `sqlite_autoindex_${name}`); check(actual?.type === 'index' && actual.tbl_name === name.replace(/_\d+$/,''),'v2_invalid_indices');
    check(same(db.prepare(`PRAGMA index_info('${actual.name}')`).all().map(r => r.name),columns),'v2_invalid_indices');
    const record = db.prepare(`PRAGMA index_list('${actual.tbl_name}')`).all().find(r => r.name === actual.name); check(record?.unique === 1 && record.partial === 0 && ['pk','u'].includes(record.origin),'v2_invalid_indices');
  }
  check(db.pragma('foreign_key_check').length === 0,'v2_invalid_relationship');
}
function appendFact(db,fact) {
  const last = db.prepare('SELECT seq,hash FROM audit_facts ORDER BY seq DESC LIMIT 1').get(); const seq = last ? last.seq+1 : 1, previousHash = last?.hash ?? '0'.repeat(64);
  db.prepare('INSERT INTO audit_facts VALUES (?,?,?,?)').run(seq,previousHash,hash(canonical({seq,previousHash,fact})),canonical(fact));
}
function validateRows(db,marker,root) {
  const rows = Object.fromEntries(['identity','admission','workers','tasks','operations','steps','bindings','step_results','terminals'].map(table => [table,db.prepare(`SELECT * FROM ${table}`).all()]));
  check(rows.identity.length === 1 && rows.identity[0].id === 1 && rows.identity[0].marker === canonical(marker) && rows.admission.length === 1 && rows.admission[0].id === 1 && ['open','closed'].includes(rows.admission[0].mode),'v2_invalid_identity');
  const seen = Object.fromEntries(Object.keys(rows).map(k => [k,new Set()])); let previousHash = '0'.repeat(64), seq = 0, closed = false, businessIdentity;
  const cover = (table,key,value) => { const candidates = rows[table].filter(r => r[key] === value[key]); check(candidates.length === 1 && same(candidates[0],value) && !seen[table].has(value[key]),'v2_fact_row_mismatch'); seen[table].add(value[key]); };
  const operation = id => rows.operations.find(r => r.operation_id === id);
  const workerFor = op => rows.workers.find(w => w.worker_id === rows.tasks.find(t => t.task_id === op.task_id)?.worker_id);
  const stepsFor = op => rows.steps.filter(s => s.operation_id === op).sort((a,b) => a.ordinal-b.ordinal);
  const resultFor = step => rows.step_results.find(r => r.step_id === step);
  for (const record of db.prepare('SELECT * FROM audit_facts ORDER BY seq').all()) {
    const fact = json(record.fact_json); check(record.seq === ++seq && record.previous_hash === previousHash && record.hash === hash(canonical({seq,previousHash,fact})),'v2_invalid_audit'); previousHash = record.hash;
    switch(fact.kind) {
      case 'initialized': exact(fact,['kind','marker']); check(seq === 1 && fact.marker === canonical(marker),'v2_invalid_audit'); cover('identity','id',{id:1,marker:fact.marker}); break;
      case 'registered': exact(fact,['kind','workerId','generationToken','entryPoint']); check(!closed && identifier(fact.workerId) && uuid(fact.generationToken) && ENTRIES.includes(fact.entryPoint),'v2_invalid_worker'); cover('workers','worker_id',{worker_id:fact.workerId,generation_token:fact.generationToken,entry_point:fact.entryPoint}); break;
      case 'admitted': {
        exact(fact,['kind','taskId','workerId','operationId','invocationId','scopeJson','inputHash','recoveryOf']); check(!closed && uuid(fact.taskId) && uuid(fact.operationId) && uuid(fact.invocationId) && seen.workers.has(fact.workerId),'v2_invalid_operation');
        const entry = rows.workers.find(w => w.worker_id === fact.workerId).entry_point; const scope = scopeFor(entry,json(fact.scopeJson)); check(fact.inputHash === hash(fact.scopeJson) && fact.recoveryOf === (['raw-recovery','report-recovery'].includes(entry) ? scope.effectId : null),'v2_invalid_operation');
        cover('tasks','task_id',{task_id:fact.taskId,worker_id:fact.workerId}); cover('operations','operation_id',{operation_id:fact.operationId,task_id:fact.taskId,invocation_id:fact.invocationId,scope_json:fact.scopeJson,input_hash:fact.inputHash,recovery_of:fact.recoveryOf}); break;
      }
      case 'step_reserved': {
        exact(fact,['kind','stepId','operationId','stepKey','ordinal','inputHash']); const op = operation(fact.operationId), entry = op && workerFor(op)?.entry_point;
        check(!closed && uuid(fact.stepId) && seen.operations.has(fact.operationId) && !seen.terminals.has(fact.operationId) && ['startup','local-seed'].includes(entry) && fact.stepKey === 'open-business' && fact.ordinal === 0 && fact.inputHash === hash(canonical({stepKey:'open-business',scopeJson:op.scope_json})),'v2_invalid_step');
        cover('steps','step_id',{step_id:fact.stepId,operation_id:fact.operationId,step_key:fact.stepKey,ordinal:fact.ordinal,input_hash:fact.inputHash}); break;
      }
      case 'step_result': {
        exact(fact,['kind','stepId','businessCommit','filesystemJson','disposition','reason','binding']); const reserved = rows.steps.find(s => s.step_id === fact.stepId); check(seen.steps.has(fact.stepId) && reserved && !seen.terminals.has(reserved.operation_id) && ['not_committed','committed','unknown','not_applicable'].includes(fact.businessCommit) && ['completed','denied','cancelled','unsupported','unknown'].includes(fact.disposition) && identifier(fact.reason),'v2_invalid_result');
        const fs = json(fact.filesystemJson); check(Array.isArray(fs),'v2_invalid_filesystem'); for(const effect of fs) { exact(effect,['action','path','outcome']); check(['create','open','configure'].includes(effect.action) && ['occurred','not_occurred','unknown'].includes(effect.outcome) && [join(root,'d2-business.sqlite'),join(root,'d2-business.sqlite-journal')].includes(effect.path),'v2_invalid_filesystem'); }
        if(fact.disposition === 'completed') check(fact.businessCommit === 'committed' && fact.binding !== null,'v2_invalid_result');
        if(fact.binding !== null) {
          exact(fact.binding,['targetKind','identityJson']); check(fact.binding.targetKind === 'business' && fact.businessCommit === 'committed' && fact.disposition === 'completed','v2_invalid_binding'); const ident = json(fact.binding.identityJson); exact(ident,['path','dev','ino','parent','creation']); exact(ident.parent,['path','dev','ino']); check(ident.path === join(root,'d2-business.sqlite') && same(ident.parent,marker.root) && decimal(ident.dev) && decimal(ident.ino) && ['new','existing'].includes(ident.creation),'v2_invalid_binding');
          const key = {path:ident.path,dev:ident.dev,ino:ident.ino,parent:ident.parent}; check(!businessIdentity || same(businessIdentity,key),'v2_invalid_binding'); if(!businessIdentity) check(ident.creation === 'new','v2_invalid_binding'); businessIdentity = key;
          cover('bindings','step_id',{step_id:fact.stepId,target_kind:fact.binding.targetKind,identity_json:fact.binding.identityJson});
        }
        cover('step_results','step_id',{step_id:fact.stepId,business_commit:fact.businessCommit,filesystem_json:fact.filesystemJson,disposition:fact.disposition,reason:fact.reason}); break;
      }
      case 'terminal': {
        exact(fact,['kind','operationId','outcome','firstReason']); check(seen.operations.has(fact.operationId) && OUTCOMES.includes(fact.outcome) && identifier(fact.firstReason),'v2_invalid_terminal'); const steps = stepsFor(fact.operationId);
        const results = steps.map(s => seen.step_results.has(s.step_id) ? resultFor(s.step_id) : null);
        if(results.some(r => !r || r.disposition === 'unknown')) check(fact.outcome === 'interrupted_unknown','v2_unknown_terminal');
        else if(!steps.length) check(['denied','cancelled'].includes(fact.outcome),'v2_unsupported_terminal');
        else if(['completed','completed_with_diagnostics'].includes(fact.outcome)) check(steps.length === 1 && results.every(r => r.disposition === 'completed'),'v2_invalid_terminal');
        cover('terminals','operation_id',{operation_id:fact.operationId,outcome:fact.outcome,first_reason:fact.firstReason}); break;
      }
      case 'closed': exact(fact,['kind','previousMode','nextMode']); check(!closed && fact.previousMode === 'open' && fact.nextMode === 'closed','v2_invalid_close'); closed = true; break;
      default: check(false,'v2_unknown_fact');
    }
  }
  check(seq > 0 && closed === (rows.admission[0].mode === 'closed'),'v2_invalid_close');
  for(const table of Object.keys(seen).filter(k => k !== 'admission')) check(seen[table].size === rows[table].length,'v2_unaudited_row');
  for(const op of rows.operations) {
    const list = stepsFor(op.operation_id); check(list.length <= 1 && list.every(s => s.ordinal === 0),'v2_invalid_step');
    const scopeConflicts = rows.operations.filter(other => other.scope_json === op.scope_json && workerFor(other)?.worker_id === workerFor(op)?.worker_id); check(scopeConflicts.length === 1,'v2_scope_conflict');
  }
  if (businessIdentity) {
    check(same(identity(businessIdentity.path),{path:businessIdentity.path,dev:businessIdentity.dev,ino:businessIdentity.ino}) && same(rootIdentity(root),businessIdentity.parent),'v2_business_generation_lost');
  }
  return rows;
}

export function initializeWritersV2(root) {
  const rootInfo = rootIdentity(root), ledgerMarkerHash = ledgerIdentity(root);
  check(readdirSync(root).every(n => ['isolation.json','ledger.sqlite','ledger.sqlite-journal'].includes(n)),'v2_root_not_empty'); sidecars(join(root,'ledger.sqlite'));
  const registryPath = join(root,'writers.sqlite'); durable(registryPath); const registry = identity(registryPath);
  const marker = {schema:'a3-writers-isolation-v2',initId:randomUUID(),ledgerMarkerHash,root:rootInfo,registry:{name:'writers.sqlite',dev:registry.dev,ino:registry.ino},targets:{business:'d2-business.sqlite',raw:'raw',report:'report'}};
  durable(join(root,'writers-isolation.json'),canonical(marker)+'\n'); syncRoot(root);
  const db = new Database(registryPath,{fileMustExist:true,timeout:0});
  try { db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON'); db.transaction(() => { for(const sql of Object.values(OBJECTS)) db.exec(sql); db.pragma(`application_id = ${APP_ID}`); db.pragma('user_version = 2'); db.prepare('INSERT INTO identity VALUES (1,?)').run(canonical(marker)); db.prepare("INSERT INTO admission VALUES (1,'open')").run(); appendFact(db,{kind:'initialized',marker:canonical(marker)}); }).immediate(); } finally { db.close(); }
  syncRoot(root); return Object.freeze({schema:'a3-writers-isolation-v2',initId:marker.initId});
}
class CommitUnknown extends Error { constructor(cause) { super('v2_registry_commit_unknown',{cause}); } }
export function openWritersV2(root) {
  rootIdentity(root); noBusinessTransaction(root); const captured = markerRead(root); check(captured.marker.ledgerMarkerHash === ledgerIdentity(root),'v2_s0_generation_lost');
  const registryPath = join(root,'writers.sqlite'); sidecars(registryPath);
  const db = new Database(registryPath,{fileMustExist:true,timeout:0}); const localWorkers = new WeakSet(), localOperations = new WeakSet(); let live = true;
  const physical = () => { check(live,'v2_handle_closed'); const current = markerRead(root); check(same(current,captured),'v2_physical_generation_lost'); sidecars(registryPath); sidecars(join(root,'d2-business.sqlite')); };
  const validate = () => { noBusinessTransaction(root); physical(); check(captured.marker.ledgerMarkerHash === ledgerIdentity(root),'v2_s0_generation_lost'); schemaCheck(db); return validateRows(db,captured.marker,root); };
  function transaction(action) {
    noBusinessTransaction(root); physical(); db.exec('BEGIN IMMEDIATE'); let commitAttempted = false;
    try { const rows = validate(); const value = action(rows); validate(); commitAttempted = true; db.exec('COMMIT'); return value; }
    catch(e) { if(db.inTransaction) { try { db.exec('ROLLBACK'); } catch { /* retain original failure */ } } if(commitAttempted) throw new CommitUnknown(e); throw e; }
  }
  function openCheck(rows) { check(rows.admission[0].mode === 'open','v2_admission_closed'); }
  function owned(cap) { check(!types.isProxy(cap) && localWorkers.has(cap),'v2_worker_capability_invalid'); const state = workerCaps.get(cap); check(state?.owner === handle,'v2_worker_capability_invalid'); return state; }
  function opOwned(cap) { check(!types.isProxy(cap) && localOperations.has(cap),'v2_operation_capability_invalid'); const state = operationCaps.get(cap); check(state?.owner === handle,'v2_operation_capability_invalid'); return state; }
  function cancelled(state) { if(abortedGetter.call(state.signal)) { state.firstReason ||= 'v2_cancelled'; return true; } return false; }
  function snapshot(rows) { return {schema:'a3-writer-admission-v2',scope:'isolated',admission:rows.admission[0].mode,workers:structuredClone(rows.workers),operations:rows.operations.map(o => ({...o,terminal:rows.terminals.find(t => t.operation_id === o.operation_id) ?? null})),steps:rows.steps.map(s => ({...s,result:rows.step_results.find(x => x.step_id === s.step_id) ?? null,observed:rows.step_results.some(x => x.step_id === s.step_id) ? 'recorded' : 'unknown'})),bindings:structuredClone(rows.bindings),writer_quiescence:false,drain_ready:false,production_permitted:false}; }
  function register(workerId,entryPoint) {
    check(identifier(workerId) && ENTRIES.includes(entryPoint),'v2_invalid_worker');
    const state = transaction(rows => { openCheck(rows); check(!rows.workers.some(w => w.worker_id === workerId),'v2_generation_exists'); const generationToken = randomUUID(); db.prepare('INSERT INTO workers VALUES (?,?,?)').run(workerId,generationToken,entryPoint); appendFact(db,{kind:'registered',workerId,generationToken,entryPoint}); return {workerId,generationToken,entryPoint,owner:handle}; });
    const cap = Object.freeze({}); localWorkers.add(cap); workerCaps.set(cap,state); return cap;
  }
  function admit(worker,rawScope,signal) {
    const w = owned(worker); check(signal && !types.isProxy(signal),'v2_signal_invalid'); try { abortedGetter.call(signal); } catch { throw new Error('v2_signal_invalid'); }
    const scope = scopeFor(w.entryPoint,rawScope), scopeJson = canonical(scope); check(!abortedGetter.call(signal),'v2_cancelled');
    const state = transaction(rows => { openCheck(rows); check(!abortedGetter.call(signal),'v2_cancelled'); check(rows.workers.some(r => r.worker_id === w.workerId && r.generation_token === w.generationToken),'v2_generation_lost'); check(!rows.operations.some(op => op.scope_json === scopeJson && rows.tasks.some(t => t.task_id === op.task_id && t.worker_id === w.workerId)),'v2_scope_conflict'); const taskId = randomUUID(),operationId = randomUUID(),invocationId = randomUUID(),inputHash = hash(scopeJson),recoveryOf = ['raw-recovery','report-recovery'].includes(w.entryPoint) ? scope.effectId : null; db.prepare('INSERT INTO tasks VALUES (?,?)').run(taskId,w.workerId); db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?)').run(operationId,taskId,invocationId,scopeJson,inputHash,recoveryOf); appendFact(db,{kind:'admitted',taskId,workerId:w.workerId,operationId,invocationId,scopeJson,inputHash,recoveryOf}); return {owner:handle,operationId,entryPoint:w.entryPoint,scopeJson,signal,used:false,finished:false,firstReason:null}; });
    const cap = Object.freeze({}); localOperations.add(cap); operationCaps.set(cap,state); return cap;
  }
  function finish(operation,outcome) {
    const state = opOwned(operation); check(OUTCOMES.includes(outcome),'v2_invalid_terminal'); cancelled(state);
    const value = transaction(rows => { const old = rows.terminals.find(t => t.operation_id === state.operationId); if(old) { check(old.outcome === outcome,'v2_terminal_conflict'); return old; } const steps = rows.steps.filter(s => s.operation_id === state.operationId); const results = steps.map(s => rows.step_results.find(r => r.step_id === s.step_id)); const unknown = results.some(r => !r || r.disposition === 'unknown'); if(unknown) { check(outcome === 'interrupted_unknown','v2_unknown_terminal'); state.firstReason ||= 'v2_step_unknown'; } else if(!steps.length) check(['denied','cancelled'].includes(outcome),'v2_unsupported_terminal'); else if(results.some(r => r.disposition !== 'completed')) check(!['completed','completed_with_diagnostics'].includes(outcome),'v2_invalid_terminal'); state.firstReason ||= outcome === 'cancelled' ? 'v2_cancelled' : outcome === 'denied' ? 'v2_denied' : 'v2_preopen_only'; const firstReason = state.firstReason; db.prepare('INSERT INTO terminals VALUES (?,?,?)').run(state.operationId,outcome,firstReason); appendFact(db,{kind:'terminal',operationId:state.operationId,outcome,firstReason}); return {operation_id:state.operationId,outcome,first_reason:firstReason}; }); state.finished = true; return value;
  }
  function closeAdmission() {
    try { return transaction(rows => { if(rows.admission[0].mode === 'closed') return {close_commit:'not_committed',disposition:'observed_closed',inventory:snapshot(rows)}; db.prepare("UPDATE admission SET mode='closed' WHERE id=1 AND mode='open'").run(); appendFact(db,{kind:'closed',previousMode:'open',nextMode:'closed'}); return {close_commit:'committed',disposition:'closed',inventory:snapshot({...rows,admission:[{id:1,mode:'closed'}]})}; }); }
    catch(e) { if(e instanceof CommitUnknown) return {close_commit:'unknown',code:e.message,writer_quiescence:false,drain_ready:false,production_permitted:false}; throw e; }
  }
  function acknowledge(state,stepId,businessCommit,effects,disposition,reason,binding) {
    const filesystemJson = canonical(effects); db.prepare('INSERT INTO step_results VALUES (?,?,?,?,?)').run(stepId,businessCommit,filesystemJson,disposition,reason);
    if(binding) db.prepare('INSERT INTO bindings VALUES (?,?,?)').run(stepId,binding.targetKind,binding.identityJson);
    appendFact(db,{kind:'step_result',stepId,businessCommit,filesystemJson,disposition,reason,binding}); state.firstReason ||= disposition === 'completed' ? null : reason;
  }
  function preopen(operation) {
    const state = opOwned(operation); if(state.finished || state.used) return {kind:'not_committed',businessCommit:'not_committed',coordination:'acknowledged',code:'v2_capability_consumed'};
    if(!['startup','local-seed'].includes(state.entryPoint)) { state.used = true; state.firstReason ||= 'unsupported_step'; return {kind:'not_committed',businessCommit:'not_committed',coordination:'acknowledged',code:'unsupported_step'}; }
    state.used = true; if(cancelled(state)) return {kind:'not_committed',businessCommit:'not_committed',coordination:'acknowledged',code:state.firstReason};
    const stepId = randomUUID(), stepKey = 'open-business', inputHash = hash(canonical({stepKey,scopeJson:state.scopeJson}));
    try { transaction(rows => { openCheck(rows); check(!cancelled(state),'v2_cancelled'); check(!rows.terminals.some(t => t.operation_id === state.operationId),'v2_terminal_exists'); db.prepare('INSERT INTO steps VALUES (?,?,?,?,?)').run(stepId,state.operationId,stepKey,0,inputHash); appendFact(db,{kind:'step_reserved',stepId,operationId:state.operationId,stepKey,ordinal:0,inputHash}); }); }
    catch(e) { state.firstReason ||= e instanceof CommitUnknown ? 'v2_reservation_unknown' : identifier(e.message) ? e.message : 'v2_reservation_denied'; return {kind:e instanceof CommitUnknown ? 'unknown' : 'not_committed',businessCommit:'not_committed',coordination:e instanceof CommitUnknown ? 'unknown' : 'acknowledged',code:state.firstReason}; }
    const effects = [], path = join(root,'d2-business.sqlite'); let business, businessCommit = 'not_applicable', binding = null, target = null, denied = null;
    try {
      transaction(rows => {
        if(rows.admission[0].mode !== 'open' || cancelled(state)) { denied = state.firstReason || 'v2_admission_closed'; acknowledge(state,stepId,businessCommit,effects,cancelled(state) ? 'cancelled' : 'denied',denied,null); return; }
        const record = rows.steps.find(s => s.step_id === stepId); check(record && !rows.step_results.some(s => s.step_id === stepId),'v2_reservation_invalid');
        try {
          const prior = rows.bindings.filter(b => b.target_kind === 'business').map(b => json(b.identity_json)); let creation;
          try { const current = identity(path); check(prior.length > 0 && prior.every(p => same({path:p.path,dev:p.dev,ino:p.ino},current)),'v2_business_unbound'); creation = 'existing'; }
          catch(e) { if(e.code !== 'ENOENT') throw e; check(prior.length === 0,'v2_business_generation_lost'); check(!cancelled(state),'v2_cancelled'); const createEffect = {action:'create',path,outcome:'unknown'}; effects.push(createEffect); durable(path,undefined,createEffect); syncRoot(root); creation = 'new'; }
          check(!cancelled(state),'v2_cancelled'); physical(); const file = identity(path); sidecars(path);
          effects.push({action:'open',path,outcome:'unknown'}); business = new Database(path,{fileMustExist:true,timeout:0}); if(!businessHandles.has(root)) businessHandles.set(root,new Set()); businessHandles.get(root).add(business); effects.at(-1).outcome = 'occurred';
          check(!cancelled(state),'v2_cancelled'); check(same(file,identity(path)),'v2_business_generation_lost'); effects.push({action:'configure',path,outcome:'unknown'});
          business.pragma('journal_mode = DELETE'); check(!cancelled(state),'v2_cancelled'); business.pragma('synchronous = FULL'); check(!cancelled(state),'v2_cancelled'); business.pragma('foreign_keys = ON'); effects.at(-1).outcome = 'occurred';
          check(!business.inTransaction && business.prepare('PRAGMA database_list').all().length === 1 && business.prepare('PRAGMA database_list').get().file === path,'v2_business_connection_invalid');
          check(captured.marker.ledgerMarkerHash === ledgerIdentity(root),'v2_s0_generation_lost');
          business.exec('BEGIN IMMEDIATE'); businessCommit = 'not_committed'; check(!cancelled(state),'v2_cancelled'); physical(); check(same(file,identity(path)),'v2_business_generation_lost');
          businessCommit = 'unknown'; business.exec('COMMIT'); businessCommit = 'committed';
          binding = {targetKind:'business',identityJson:canonical({...file,parent:captured.marker.root,creation})};
          // Late cancellation cannot undo a confirmed business COMMIT.
          cancelled(state); acknowledge(state,stepId,businessCommit,effects,'completed','v2_preopen_only',binding);
          target = Object.freeze({db:business,close:() => { if(business.open) business.close(); businessHandles.get(root).delete(business); }});
        } catch(e) {
          if(business?.inTransaction) { try { business.exec('ROLLBACK'); } catch { /* never turn COMMIT unknown into rollback proof */ } }
          denied = identifier(e.message) ? e.message : e.code === 'SQLITE_BUSY' ? 'v2_business_busy' : 'v2_business_failure';
          if(businessCommit === 'unknown' || businessCommit === 'committed') { state.firstReason ||= 'v2_business_commit_unknown'; acknowledge(state,stepId,businessCommit,effects,'unknown',state.firstReason,null); }
          else acknowledge(state,stepId,businessCommit,effects,cancelled(state) ? 'cancelled' : 'denied',denied,null);
        }
      });
    } catch(e) { if(business?.open) business.close(); state.firstReason ||= 'v2_ack_unknown'; return {kind:'unknown',businessCommit,coordination:'unknown',code:state.firstReason,filesystem:structuredClone(effects)}; }
    if(target && binding) { targetCaps.set(target,{db:business,owner:handle,binding,operation:state.operationId}); return {kind:'committed',businessCommit:'committed',coordination:'acknowledged',target,filesystem:structuredClone(effects)}; }
    if(business?.open) business.close(); return {kind:businessCommit === 'unknown' || businessCommit === 'committed' ? 'unknown' : 'not_committed',businessCommit,coordination:'acknowledged',code:state.firstReason || denied,filesystem:structuredClone(effects)};
  }
  const handle = Object.freeze({register,admit,finish,inspect:() => transaction(snapshot),closeAdmission,close:() => { if(live) { live = false; db.close(); } }});
  try { db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL'); transaction(() => undefined); } catch(e) { db.close(); throw e; }
  // Only the module's fixed factory can find this method; no caller callback or SQL is admitted.
  registryPreopens.set(handle,preopen); return handle;
}
const registryPreopens = new WeakMap();
export function openV2BusinessTarget(operation) {
  check(operation && !types.isProxy(operation) && operationCaps.has(operation),'v2_operation_capability_invalid');
  const owner = operationCaps.get(operation).owner; return registryPreopens.get(owner)(operation);
}
