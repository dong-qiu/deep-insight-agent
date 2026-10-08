/** Isolated, caller-declared writer registration. No production adapter, drain-ready or resume. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { canonical, check, same, hash, tokenFor } from './contract.mjs';
import { openLedger } from './ledger.mjs';
import { openDrainLeaseSource } from './drain.mjs';
import { STAGED_APP_ID, STAGED_VERSION, STAGED_PROFILE, stagedObjects, stagedPreflight, validateStagedRows, revokeReasons } from './staged-terminal.mjs';

const APP_ID = 0x41335731;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const workerSchema = z.strictObject({ workerId: id, generationToken: z.uuid() });
const taskSchema = workerSchema.extend({ taskId: z.uuid() });
const entrySchema = z.literal('generation-dispatch');
const outcomeSchema = z.enum(['no_claim', 'done', 'failed', 'threw']);
const objects = {
  identity: 'CREATE TABLE identity (marker TEXT NOT NULL)',
  admission: "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('open','closed')))",
  workers: 'CREATE TABLE workers (worker_id TEXT PRIMARY KEY, generation_token TEXT UNIQUE NOT NULL, entry_point TEXT NOT NULL)',
  tasks: 'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(worker_id))',
  completions: 'CREATE TABLE completions (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), outcome TEXT NOT NULL)',
};
for (const table of ['identity', 'workers', 'tasks', 'completions']) {
  for (const action of ['UPDATE', 'DELETE']) objects[`${table}_no_${action.toLowerCase()}`] = `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'writer_facts_append_only'); END`;
}
objects.admission_no_delete = "CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT, 'writer_admission_permanent'); END";
objects.admission_no_reopen = "CREATE TRIGGER admission_no_reopen BEFORE UPDATE ON admission WHEN OLD.mode='closed' BEGIN SELECT RAISE(ABORT, 'writer_admission_permanent'); END";

function parse(schema, raw) { const value = schema.safeParse(raw); check(value.success, 'invalid_writer_record'); return value.data; }
function safe(path, directory = false) {
  const info = lstatSync(path);
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || info.nlink === 1), 'unsafe_writer_path');
  return info;
}
function journalCheck(path) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { safe(`${path}${suffix}`); check(suffix === '-journal', 'unexpected_writer_sidecar'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function rootCheck(root) { check(isAbsolute(root) && root === realpathSync(root), 'noncanonical_writer_root'); safe(root, true); }
function ledgerMarker(root) {
  const ledger = openLedger(root);
  try { return ledger.inspect().marker; } finally { ledger.close(); }
}
function syncDirectory(root) { const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

export function initializeWriters(root) {
  rootCheck(root); const marker = ledgerMarker(root);
  const markerPath = join(root, 'writers-isolation.json');
  const markerFd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(markerFd, canonical({ schema: 'a3-writers-isolation-v1', marker })); fsyncSync(markerFd); } finally { closeSync(markerFd); }
  syncDirectory(root);
  const path = join(root, 'writers.sqlite');
  // O_EXCL leaves a permanent incomplete file if initialization is interrupted.
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { check(fstatSync(fd).nlink === 1, 'unsafe_writer_path'); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(root);
  journalCheck(path);
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    db.transaction(() => {
      for (const sql of Object.values(objects)) db.exec(sql);
      db.pragma(`application_id = ${APP_ID}`); db.pragma('user_version = 1');
      db.prepare('INSERT INTO identity VALUES (?)').run(canonical(marker));
      db.prepare("INSERT INTO admission VALUES (1,'open')").run();
    }).immediate();
  } finally { db.close(); }
  syncDirectory(root);
}

export function openWriters(root) {
  rootCheck(root); const marker = ledgerMarker(root);
  const markerPath = join(root, 'writers-isolation.json');
  function markerCheck() {
    const info = safe(markerPath); check(info.size <= 16384, 'writer_marker_too_large');
    const fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); check(opened.dev === info.dev && opened.ino === info.ino, 'writer_marker_changed');
      check(readFileSync(fd, 'utf8') === canonical({ schema: 'a3-writers-isolation-v1', marker }), 'writer_marker_changed');
    } finally { closeSync(fd); }
  }
  markerCheck();
  const path = join(root, 'writers.sqlite'); const identity = safe(path);
  journalCheck(path); // Validate before SQLite is allowed to recover/remove a hot journal.
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  function pathCheck() {
    rootCheck(root); markerCheck(); const current = safe(path);
    check(current.dev === identity.dev && current.ino === identity.ino, 'writer_file_replaced');
    journalCheck(path);
  }
  function validate() {
    pathCheck();
    check(same(marker, ledgerMarker(root)), 'writer_marker_changed');
    check(db.pragma('application_id', { simple: true }) === APP_ID && db.pragma('user_version', { simple: true }) === 1, 'invalid_writer_version');
    check(db.pragma('journal_mode', { simple: true }) === 'delete' && db.pragma('foreign_keys', { simple: true }) === 1, 'invalid_writer_database');
    const actual = Object.fromEntries(db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(row => [row.name, row.sql]));
    check(same(actual, objects), 'invalid_writer_schema');
    const rows = db.prepare('SELECT marker FROM identity').all();
    check(rows.length === 1 && rows[0].marker === canonical(marker), 'writer_marker_changed');
    const gate = db.prepare('SELECT * FROM admission').all();
    check(gate.length === 1 && gate[0].id === 1 && ['open', 'closed'].includes(gate[0].mode), 'invalid_writer_admission');
    check(db.pragma('foreign_key_check').length === 0, 'invalid_writer_relationship');
    for (const row of db.prepare('SELECT * FROM workers').all()) {
      parse(workerSchema, { workerId: row.worker_id, generationToken: row.generation_token }); parse(entrySchema, row.entry_point);
    }
    for (const row of db.prepare('SELECT * FROM tasks').all()) parse(z.uuid(), row.task_id);
    for (const row of db.prepare('SELECT * FROM completions').all()) parse(outcomeSchema, row.outcome);
  }
  function transact(fn) {
    // BEGIN itself may recover a hot journal on a previously opened handle.
    // No SQLite operation is allowed before the filesystem preflight.
    pathCheck();
    return db.transaction(() => { validate(); return fn(); }).immediate();
  }
  try {
    db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    transact(() => undefined);
  } catch (error) { db.close(); throw error; }
  function openAdmission() { check(db.prepare('SELECT mode FROM admission WHERE id=1').get().mode === 'open', 'writer_admission_closed'); }
  function owned(raw) {
    const token = parse(workerSchema, raw);
    const worker = db.prepare('SELECT * FROM workers WHERE worker_id=? AND generation_token=?').get(token.workerId, token.generationToken);
    check(worker, 'writer_owner_lost'); return token;
  }
  function register(workerId, entryPoint) {
    parse(id, workerId); parse(entrySchema, entryPoint);
    return transact(() => {
      openAdmission(); check(!db.prepare('SELECT 1 FROM workers WHERE worker_id=?').get(workerId), 'writer_generation_exists');
      const token = { workerId, generationToken: randomUUID() };
      db.prepare('INSERT INTO workers VALUES (?,?,?)').run(workerId, token.generationToken, entryPoint); return token;
    });
  }
  function admit(rawWorker) {
    return transact(() => {
      const worker = owned(rawWorker); openAdmission();
      const token = { ...worker, taskId: randomUUID() };
      db.prepare('INSERT INTO tasks VALUES (?,?)').run(token.taskId, token.workerId); return token;
    });
  }
  function finish(rawTask, outcome) {
    const task = parse(taskSchema, rawTask); parse(outcomeSchema, outcome);
    return transact(() => {
      owned({ workerId: task.workerId, generationToken: task.generationToken });
      check(db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND worker_id=?').get(task.taskId, task.workerId), 'writer_owner_lost');
      const previous = db.prepare('SELECT outcome FROM completions WHERE task_id=?').get(task.taskId);
      if (previous) { check(previous.outcome === outcome, 'writer_completion_conflict'); return; }
      db.prepare('INSERT INTO completions VALUES (?,?)').run(task.taskId, outcome);
    });
  }
  function closeAdmission() {
    return transact(() => { db.prepare("UPDATE admission SET mode='closed' WHERE id=1 AND mode='open'").run(); });
  }
  function inspect() {
    return transact(() => ({
      schema: 'a3-writer-admission-v1', scope: 'isolated', entryPoint: 'generation-dispatch', coreCoverage: 'runGenerationDispatchOnce',
      marker: structuredClone(marker), admission: db.prepare('SELECT mode FROM admission WHERE id=1').get().mode,
      workers: db.prepare('SELECT worker_id AS workerId, entry_point AS entryPoint FROM workers ORDER BY rowid').all(),
      tasks: db.prepare('SELECT t.task_id AS taskId,t.worker_id AS workerId,c.outcome FROM tasks t LEFT JOIN completions c USING(task_id) ORDER BY t.rowid').all().map(row => ({ ...row, remote_subwork: 'unknown' })),
      writer_quiescence: false, production_permitted: false,
    }));
  }
  function admissionFor(worker) {
    transact(() => owned(worker));
    return { scope: 'isolated', entryPoint: 'generation-dispatch', admit: () => admit(worker), finish };
  }
  const terminalClaims = new Set(); // Per connection, retained through finish/deny/unknown; never restored from persisted tasks.
  function terminalAdmissionFor(worker, businessDb, driver) {
    worker = Object.freeze(parse(workerSchema, worker));
    const descriptor = driver?.[Symbol.for('insight-agent.a3-terminal-driver-v1')];
    const deny = code => ({ kind: 'not_committed', businessCommit: 'not_committed', code });
    function physical() {
      check(Object.isFrozen(driver) && Object.isFrozen(descriptor) && Object.isFrozen(descriptor?.marker)
        && Object.isFrozen(descriptor?.marker?.target) && Object.isFrozen(descriptor?.marker?.target?.serviceSet), 'writer_terminal_business_mismatch');
      check(descriptor.root === root && same(descriptor.marker, marker) && businessDb === driver.db
        && businessDb instanceof Database && businessDb.open && !businessDb.readonly
        && businessDb.name === join(root, 'fixture-business.sqlite'), 'writer_terminal_business_mismatch');
      check(!businessDb.inTransaction, 'writer_terminal_reverse_transaction');
      rootCheck(root); check(same(marker, ledgerMarker(root)), 'writer_terminal_business_mismatch');
      const businessPath = join(root, 'fixture-business.sqlite'), current = safe(businessPath);
      check(businessPath === realpathSync(businessPath) && current.dev === descriptor.fileDev && current.ino === descriptor.fileIno, 'writer_terminal_business_mismatch');
      for (const suffix of ['-journal', '-wal', '-shm']) {
        try { safe(businessPath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // This SQL may recover a journal: all physical gates above must complete first.
      // Recheck the actual connection on every admit, not only its factory's initial binding.
      const databases = businessDb.prepare('PRAGMA database_list').all();
      check(databases.length === 1 && databases[0].name === 'main' && databases[0].file === businessPath, 'writer_terminal_business_mismatch');
    }
    physical(); transact(() => owned(worker));
    const capabilities = new WeakMap();
    const fields = ['dispatchId', 'traceId', 'ownerToken', 'claimEpoch', 'fencingEpoch', 'rootRunId'];
    function snapshot(claim) {
      check(claim && fields.every(key => ['claimEpoch', 'fencingEpoch'].includes(key)
        ? Number.isSafeInteger(claim[key]) && claim[key] > 0 : typeof claim[key] === 'string' && claim[key].length > 0), 'writer_terminal_claim_mismatch');
      return Object.freeze(Object.fromEntries(fields.map(key => [key, claim[key]])));
    }
    function fresh(cap) {
      const local = capabilities.get(cap);
      check(local && !local.finished, 'writer_terminal_capability_invalid'); return local;
    }
    function taskOwned(local) {
      owned(worker);
      check(db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND worker_id=?').get(local.task.taskId, worker.workerId)
        && !db.prepare('SELECT 1 FROM completions WHERE task_id=?').get(local.task.taskId), 'writer_terminal_capability_invalid');
    }
    return Object.freeze({ scope: 'isolated', entryPoint: 'generation-dispatch', version: 'a3-terminal-commit-v1', profile: 'close-fences-terminal',
      [Symbol.for('insight-agent.a3-terminal-admission-v1')]: Object.freeze({ businessDb }),
      admit() {
        physical(); const task = admit(worker), cap = Object.freeze({});
        capabilities.set(cap, { task, claim: null, attempted: false, finished: false }); return cap;
      },
      bindClaim(cap, claim) {
        const local = fresh(cap); check(!local.claim && !local.attempted, 'writer_terminal_capability_invalid');
        const binding = snapshot(claim), key = canonical(binding);
        check(!terminalClaims.has(key), 'writer_terminal_claim_mismatch'); physical();
        transact(() => { taskOwned(local); local.claim = binding; terminalClaims.add(key); });
      },
      commitOutcome(cap, claim, outcome) {
        let local;
        try { local = fresh(cap); check(!local.attempted, 'writer_terminal_capability_invalid'); }
        catch { return deny('writer_terminal_capability_invalid'); }
        local.attempted = true; // All attempts consume terminal permission, including deny/busy/unknown.
        if (!local.claim) return deny('writer_terminal_capability_invalid');
        try { check(same(local.claim, snapshot(claim)), 'writer_terminal_claim_mismatch'); }
        catch { return deny('writer_terminal_claim_mismatch'); }
        let businessResult, driverAttempted = false;
        try {
          physical();
          return transact(() => {
            taskOwned(local);
            if (db.prepare('SELECT mode FROM admission WHERE id=1').get().mode !== 'open') return deny('writer_terminal_closed');
            // This fixed factory driver is the sole synchronous consumer, under this same registry connection.
            driverAttempted = true; businessResult = driver.commit(claim, outcome); return businessResult;
          });
        } catch (error) {
          if (businessResult?.businessCommit === 'committed') return { kind: 'unknown', businessCommit: 'committed', code: 'writer_terminal_registry_commit_unknown' };
          if (businessResult?.kind === 'unknown') return businessResult;
          if (driverAttempted && !businessResult) return { kind: 'unknown', businessCommit: 'unknown', code: 'writer_terminal_business_commit_unknown' };
          const code = error.message === 'writer_terminal_reverse_transaction' ? error.message
            : error.code === 'SQLITE_BUSY' ? 'writer_terminal_busy'
              : error.message === 'writer_terminal_capability_invalid' ? error.message : 'writer_terminal_business_mismatch';
          return deny(code);
        }
      },
      finish(cap, outcome) {
        const local = fresh(cap); finish(local.task, outcome); local.finished = true;
      },
    });
  }
  let stageDb, stageIdentity;
  const stagedTaskFields = ['dispatchId', 'traceId', 'ownerToken', 'claimEpoch', 'fencingEpoch', 'rootRunId'];
  function stageOpen() {
    const current = stagedPreflight(root, stageIdentity);
    if (!stageDb) {
      stageIdentity = current; stageDb = new Database(current.path, { fileMustExist: true, timeout: 0 });
      try { stageDb.pragma('synchronous=FULL'); stageDb.pragma('foreign_keys=ON'); stageRead(); }
      catch (error) { stageDb.close(); throw error; }
    }
    check(stageDb.open && !stageDb.readonly && stageDb.name === current.path, 'staged_terminal_owner_lost');
  }
  function stageRead() {
    stagedPreflight(root, stageIdentity);
    check(same(marker, stageIdentity.marker.s0Marker) && same(marker, ledgerMarker(root)), 'staged_marker_changed');
    check(stageDb.pragma('application_id', { simple: true }) === STAGED_APP_ID && stageDb.pragma('user_version', { simple: true }) === 1
      && stageDb.pragma('journal_mode', { simple: true }) === 'delete' && stageDb.pragma('foreign_keys', { simple: true }) === 1, 'invalid_staged_version');
    const list=stageDb.prepare('PRAGMA database_list').all(); check(list.length===1&&list[0].name==='main'&&list[0].file===stageIdentity.path,'invalid_staged_database');
    const objectsNow=Object.fromEntries(stageDb.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(r=>[r.name,r.sql])); check(same(objectsNow,stagedObjects),'invalid_staged_schema');
    const identityRows=stageDb.prepare('SELECT marker FROM identity').all();check(identityRows.length===1&&identityRows[0].marker===canonical(stageIdentity.marker),'staged_marker_changed');
    check(stageDb.pragma('foreign_key_check').length===0,'invalid_staged_relationship');
    const stageRows=stageDb.prepare('SELECT * FROM stage').all();check(stageRows.length===1,'invalid_staged_state');
    const rows={stage:stageRows[0]};for(const t of ['tasks','claims','attempts','attempt_outcomes','completions'])rows[t]=stageDb.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    validateStagedRows(rows,stageIdentity.marker);
    let previous='genesis',seq=0,last;
    for(const event of stageDb.prepare('SELECT * FROM events ORDER BY seq').all()){
      check(event.seq===++seq&&event.previous_hash===previous&&event.hash===hash(`${previous}\n${event.snapshot}`),'staged_audit_corrupt');
      const history=JSON.parse(event.snapshot);validateStagedRows(history,stageIdentity.marker);check(canonical(history)===event.snapshot&&history.stage.revision===seq-1,'staged_audit_corrupt');previous=event.hash;last=event.snapshot;
    }
    check(last===canonical(rows)&&rows.stage.revision===seq-1,'staged_audit_corrupt');return {rows,previous,seq};
  }
  function stageAppend(before) {
    stageDb.prepare('UPDATE stage SET revision=revision+1 WHERE id=1').run();
    const rows={stage:stageDb.prepare('SELECT * FROM stage').get()};for(const t of ['tasks','claims','attempts','attempt_outcomes','completions'])rows[t]=stageDb.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    validateStagedRows(rows,stageIdentity.marker);const snapshot=canonical(rows);
    stageDb.prepare('INSERT INTO events VALUES (?,?,?,?)').run(before.seq+1,before.previous,hash(`${before.previous}\n${snapshot}`),snapshot);
  }
  function stageTransact(change) {
    stageOpen();stagedPreflight(root,stageIdentity);check(!stageDb.inTransaction,'staged_terminal_reverse_transaction');
    stageDb.exec('BEGIN IMMEDIATE');let commitAttempted=false;
    try {const before=stageRead();const result=change(before.rows);const after={stage:stageDb.prepare('SELECT * FROM stage').get()};for(const t of ['tasks','claims','attempts','attempt_outcomes','completions'])after[t]=stageDb.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();if(!same(before.rows,after))stageAppend(before);commitAttempted=true;stageDb.exec('COMMIT');return result;}
    catch(error){try{if(stageDb.inTransaction)stageDb.exec('ROLLBACK');}catch{throw new Error('staged_terminal_gate_commit_unknown');}if(commitAttempted)throw new Error('staged_terminal_gate_commit_unknown');throw error;}
  }
  function stageToken(stage) {
    check(stage.epoch===1,'staged_terminal_owner_lost');return {stageId:stageIdentity.marker.stageId,stageInitId:stageIdentity.marker.stageInitId,workerId:stage.worker_id,generationToken:stage.generation_token,epoch:1,revision:stage.revision};
  }
  function stageOwned(stage, expected) { check(same(stageToken(stage),expected),'staged_terminal_owner_lost');owned({workerId:stage.worker_id,generationToken:stage.generation_token}); }
  function stageInspect() {
    stageOpen();return transact(()=>stageTransact(rows=>({schema:STAGED_VERSION,scope:'isolated',profile:STAGED_PROFILE,token:rows.stage.epoch===1?stageToken(rows.stage):null,...structuredClone(rows),writer_quiescence:false,drain_ready:false,production_permitted:false,process_termination:'unknown'})));
  }
  function controlObservation(held,rows) {
    // Fixed reads under the existing registry lock, no public inspect/second registry handle.
    const ledger=openLedger(root);let state,op;try{state=ledger.inspect();op=state.operations[held?.operationId];check(op&&state.active===held.operationId&&same(tokenFor(op),held)&&op.state==='pre_submit'&&op.disposition==='held'&&op.commandId===null&&op.submitToken===null&&op.requestHash===null&&same(op.target,marker.target)&&same(state.marker,marker),'staged_terminal_owner_lost');}finally{ledger.close();}
    const stableBinding={operationId:op.operationId,ownerId:op.ownerId,fence:op.fence,kind:op.kind,target:op.target,executionIdentity:op.executionIdentity,state:'pre_submit',submitToken:null,requestHash:null,commandId:null};
    const writerRows={admission:db.prepare('SELECT mode FROM admission WHERE id=1').get().mode,workers:db.prepare('SELECT * FROM workers ORDER BY rowid').all(),tasks:db.prepare('SELECT * FROM tasks ORDER BY rowid').all(),completions:db.prepare('SELECT * FROM completions ORDER BY rowid').all()};
    check(writerRows.admission==='closed'&&rows.stage.admission==='closed','staged_terminal_closed');
    const sampledAt=Date.now(),source=openDrainLeaseSource(root,stageIdentity.marker.businessPath);let sample;try{sample=source.sample(sampledAt);}finally{source.close();}
    const m=stageIdentity.marker;return {heldToken:structuredClone(held),stableBinding,stageOwner:{stageId:m.stageId,stageInitId:m.stageInitId,workerId:rows.stage.worker_id,generationToken:rows.stage.generation_token,epoch:1},expectedStageRevision:rows.stage.revision,resultStageRevision:rows.stage.revision+1,source:{root,businessPath:m.businessPath,businessDev:m.businessDev,businessIno:m.businessIno,registryDev:m.registryDev,registryIno:m.registryIno},sampledAt,leaseSampleHash:hash(canonical(sample)),S0snapshotHash:hash(canonical(state)),registrysnapshotHash:hash(canonical(writerRows))};
  }
  function stagedTerminalControl() {
    stageOpen();return Object.freeze({inspect:stageInspect,
      closeAdmission(expected){return transact(()=>stageTransact(rows=>{stageOwned(rows.stage,expected);db.prepare("UPDATE admission SET mode='closed' WHERE id=1 AND mode='open'").run();const changed=stageDb.prepare("UPDATE stage SET admission='closed' WHERE id=1 AND admission='open'").run().changes;return {...expected,revision:expected.revision+changed};}));},
      bindDrain(expected,held){transact(()=>stageTransact(rows=>{stageOwned(rows.stage,expected);check(rows.stage.terminal==='live'&&rows.stage.drain_record===null,'staged_terminal_owner_lost');const record={schema:'a3-staged-drain-record-v1',...controlObservation(held,rows)};stageDb.prepare('UPDATE stage SET drain_record=? WHERE id=1').run(canonical(record));}));return {...expected,revision:expected.revision+1};},
      revoke(expected,held,reason){check(revokeReasons.includes(reason),'invalid_staged_reason');return transact(()=>stageTransact(rows=>{stageOwned(rows.stage,expected);check(rows.stage.drain_record!==null,'staged_terminal_owner_lost');const observation=controlObservation(held,rows),drain=JSON.parse(rows.stage.drain_record);check(same(observation.stableBinding,drain.stableBinding),'staged_terminal_owner_lost');if(rows.stage.terminal==='revoked'){check(rows.stage.revoke_reason===reason,'staged_terminal_owner_lost');return {...expected};}const record={schema:'a3-staged-revoke-record-v1',...observation,drainRecordHash:hash(canonical(drain)),reason};stageDb.prepare("UPDATE stage SET terminal='revoked',revoke_reason=?,revoke_record=? WHERE id=1").run(reason,canonical(record));return {...expected,revision:expected.revision+1};}));},
    });
  }
  function registerStagedTerminal(workerId,businessDb,driver) {
    parse(id,workerId);stageOpen();const descriptor=driver?.[Symbol.for('insight-agent.a3-terminal-driver-v1')];
    function physical() {
      stagedPreflight(root,stageIdentity);check(Object.isFrozen(driver)&&Object.isFrozen(descriptor)&&Object.isFrozen(descriptor?.marker)&&Object.isFrozen(descriptor?.marker?.target)&&Object.isFrozen(descriptor?.marker?.target?.serviceSet)&&descriptor.root===root&&same(descriptor.marker,marker)&&descriptor.fileDev===stageIdentity.marker.businessDev&&descriptor.fileIno===stageIdentity.marker.businessIno&&businessDb===driver.db&&businessDb instanceof Database&&businessDb.open&&!businessDb.readonly&&businessDb.name===stageIdentity.marker.businessPath,'staged_terminal_business_mismatch');
      check(!businessDb.inTransaction,'writer_terminal_reverse_transaction');const list=businessDb.prepare('PRAGMA database_list').all();check(list.length===1&&list[0].name==='main'&&list[0].file===stageIdentity.marker.businessPath,'staged_terminal_business_mismatch');
    }
    physical();let worker;
    transact(()=>stageTransact(rows=>{openAdmission();check(rows.stage.epoch===0&&rows.stage.admission==='open'&&rows.stage.terminal==='live','staged_terminal_owner_lost');check(!db.prepare('SELECT 1 FROM workers WHERE worker_id=?').get(workerId),'writer_generation_exists');worker=Object.freeze({workerId,generationToken:randomUUID()});db.prepare('INSERT INTO workers VALUES (?,?,?)').run(workerId,worker.generationToken,'generation-dispatch');stageDb.prepare('UPDATE stage SET epoch=1,worker_id=?,generation_token=? WHERE id=1').run(workerId,worker.generationToken);}));
    const caps=new WeakMap(),deny=code=>({kind:'not_committed',businessCommit:'not_committed',code});
    function fresh(cap){const local=caps.get(cap);check(local&&!local.finished,'staged_terminal_capability_invalid');return local;}
    function taskOwned(rows,local){owned(worker);check(rows.stage.worker_id===worker.workerId&&rows.stage.generation_token===worker.generationToken&&rows.stage.epoch===1&&rows.tasks.some(t=>t.task_id===local.task.taskId)&&!rows.completions.some(t=>t.task_id===local.task.taskId)&&db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND worker_id=?').get(local.task.taskId,worker.workerId)&&!db.prepare('SELECT 1 FROM completions WHERE task_id=?').get(local.task.taskId),'staged_terminal_capability_invalid');}
    function boundClaim(rows,local){const c=rows.claims.find(c=>c.task_id===local.task.taskId);return c&&same({dispatchId:c.dispatch_id,traceId:c.trace_id,ownerToken:c.owner_token,claimEpoch:c.claim_epoch,fencingEpoch:c.fencing_epoch,rootRunId:c.root_run_id},local.claim);}
    function snapshot(claim){check(claim&&stagedTaskFields.every(k=>['claimEpoch','fencingEpoch'].includes(k)?Number.isSafeInteger(claim[k])&&claim[k]>0:typeof claim[k]==='string'&&claim[k].length>0),'staged_terminal_claim_mismatch');return Object.freeze(Object.fromEntries(stagedTaskFields.map(k=>[k,claim[k]])));}
    function code(error){return error.code==='SQLITE_BUSY'?'staged_terminal_busy':['staged_terminal_capability_invalid','staged_terminal_claim_mismatch','staged_terminal_owner_lost','staged_terminal_revoked','writer_terminal_reverse_transaction'].includes(error.message)?error.message:'staged_terminal_business_mismatch';}
    const admission=Object.freeze({scope:'isolated',entryPoint:'generation-dispatch',version:STAGED_VERSION,profile:STAGED_PROFILE,[Symbol.for('insight-agent.a3-staged-terminal-admission-v1')]:Object.freeze({businessDb}),
      admit(){physical();let task;transact(()=>stageTransact(rows=>{owned(worker);openAdmission();check(rows.stage.admission==='open'&&rows.stage.terminal==='live','staged_terminal_closed');check(rows.stage.worker_id===worker.workerId&&rows.stage.generation_token===worker.generationToken,'staged_terminal_owner_lost');task={...worker,taskId:randomUUID()};db.prepare('INSERT INTO tasks VALUES (?,?)').run(task.taskId,worker.workerId);stageDb.prepare('INSERT INTO tasks VALUES (?,?,?,1)').run(task.taskId,worker.workerId,worker.generationToken);}));const cap=Object.freeze({});caps.set(cap,{task,claim:null,attempted:false,finished:false});return cap;},
      bindClaim(cap,claim){const local=fresh(cap);check(!local.claim&&!local.attempted,'staged_terminal_capability_invalid');const binding=snapshot(claim);physical();transact(()=>stageTransact(rows=>{taskOwned(rows,local);check(rows.stage.terminal==='live','staged_terminal_revoked');businessDb.transaction(()=>{const now=new Date().toISOString();const valid=businessDb.prepare(`SELECT 1 FROM generation_dispatch d JOIN generation_lease l ON l.trace_id=d.trace_id JOIN generation_trace t ON t.id=d.trace_id JOIN run r ON r.id=t.root_run_id WHERE d.id=? AND d.trace_id=? AND d.state='claimed' AND d.owner_token=? AND d.claim_epoch=? AND d.lease_expires_at>=? AND l.state='owned' AND l.owner_token=? AND l.fencing_epoch=? AND l.expires_at>=? AND t.root_run_id=? AND r.trace_id=t.id`).get(binding.dispatchId,binding.traceId,binding.ownerToken,binding.claimEpoch,now,binding.ownerToken,binding.fencingEpoch,now,binding.rootRunId);check(valid,'staged_terminal_claim_mismatch');}).immediate();stageDb.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?)').run(local.task.taskId,...stagedTaskFields.map(k=>binding[k]));}));local.claim=binding;},
      commitOutcome(cap,claim,outcome){let local;try{local=fresh(cap);check(!local.attempted,'staged_terminal_capability_invalid');}catch{return deny('staged_terminal_capability_invalid');}local.attempted=true;
        try{check(local.claim&&same(local.claim,snapshot(claim)),'staged_terminal_claim_mismatch');}catch{return deny('staged_terminal_claim_mismatch');}
        const attemptId=randomUUID();let reserved=false,stageReservationConfirmed=false;
        try{physical();transact(()=>{stageTransact(rows=>{taskOwned(rows,local);check(rows.stage.terminal==='live','staged_terminal_revoked');check(boundClaim(rows,local)&&!rows.attempts.some(a=>a.task_id===local.task.taskId),'staged_terminal_capability_invalid');stageDb.prepare('INSERT INTO attempts VALUES (?,?)').run(local.task.taskId,attemptId);});stageReservationConfirmed=true;});reserved=true;}
        catch(error){return error.message==='staged_terminal_gate_commit_unknown'||stageReservationConfirmed?{kind:'unknown',businessCommit:'not_committed',code:'staged_terminal_reservation_unknown'}:deny(code(error));}
        let businessResult,driverAttempted=false;
        try{physical();return transact(()=>stageTransact(rows=>{taskOwned(rows,local);check(reserved&&boundClaim(rows,local)&&rows.attempts.some(a=>a.task_id===local.task.taskId&&a.attempt_id===attemptId)&&!rows.attempt_outcomes.some(o=>o.task_id===local.task.taskId),'staged_terminal_capability_invalid');if(rows.stage.terminal==='revoked')businessResult=deny('staged_terminal_revoked');else{driverAttempted=true;businessResult=driver.commit(claim,outcome);}stageDb.prepare('INSERT INTO attempt_outcomes VALUES (?,?)').run(local.task.taskId,canonical(businessResult));return businessResult;}));}
        catch(error){if(businessResult?.businessCommit==='committed')return {kind:'unknown',businessCommit:'committed',code:'staged_terminal_gate_commit_unknown'};if(businessResult?.kind==='unknown')return businessResult;if(driverAttempted&&!businessResult)return {kind:'unknown',businessCommit:'unknown',code:'writer_terminal_business_commit_unknown'};if(businessResult?.kind==='not_committed')return businessResult;return deny(code(error));}
      },
      finish(cap,outcome){const local=fresh(cap);parse(outcomeSchema,outcome);transact(()=>stageTransact(rows=>{taskOwned(rows,local);db.prepare('INSERT INTO completions VALUES (?,?)').run(local.task.taskId,outcome);stageDb.prepare('INSERT INTO completions VALUES (?,?)').run(local.task.taskId,outcome);}));local.finished=true;},
    });return Object.freeze({worker,admission});
  }
  return { register, admit, finish, closeAdmission, admissionFor, terminalAdmissionFor, registerStagedTerminal, stagedTerminalControl, inspect, close: () => { if(stageDb?.open)stageDb.close();db.close(); } };
}
