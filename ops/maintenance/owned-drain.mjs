/** Fixed isolated hold-first consumer. No execution permission or automatic recovery. */
import Database from 'better-sqlite3';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, same, parse, markerSchema, tokenSchema, bindingSchema, tokenFor, bindingFor, requestSchema } from './contract.mjs';
import { consumeA2Isolated } from './a2-consumer.mjs';
import { openLedger } from './ledger.mjs';
import { openWriters } from './writers.mjs';
import { openDrainLeaseSource } from './drain.mjs';

const MiB = 1024 * 1024;
const blocked = Object.freeze({ deployment_permitted: false, rollback_permitted: false, production_permitted: false,
  database_restore_permitted: false, inverse_migration_permitted: false, drain_ready: false, writer_quiescence: false,
  approved_safe_rollback: null, observation_atomic: false, controller_uniqueness: 'unknown', process_termination: 'unknown',
  all_writer_coverage: false, commands_executed: false, phase_verified: false });
const fail = code => { throw new Error(code); };
const require = (condition, code) => { if (!condition) fail(code); };
function reason(signal) {
  try {
    const code = signal?.reason?.reasonCode;
    return ['cancelled', 'task_deadline_exceeded', 'generation_fence_lost'].includes(code) ? code : 'writer_drain_cancelled';
  } catch { return 'writer_drain_cancelled'; }
}
function windowFor(deadlineAt) {
  const wall = Date.now(), mono = performance.now();
  require(Number.isSafeInteger(deadlineAt) && deadlineAt > wall && deadlineAt - wall <= 60000, 'invalid_drain_deadline');
  return { remaining: () => Math.min(deadlineAt - Date.now(), deadlineAt - wall - (performance.now() - mono)) };
}
function argumentsCheck(input) {
  require(input && Object.getPrototypeOf(input) === Object.prototype
    && Object.keys(input).every(k => ['root','artifactRoot','inputJson','deadlineAt','pollEveryMs','signal'].includes(k)), 'invalid_owned_drain_input');
  require(Number.isSafeInteger(input.pollEveryMs) && input.pollEveryMs >= 1 && input.pollEveryMs <= 1000, 'invalid_drain_poll');
  require(input.signal === undefined || input.signal instanceof AbortSignal, 'invalid_drain_signal');
  require(typeof input.inputJson === 'string' && Buffer.byteLength(input.inputJson) <= 65536, 'invalid_owned_drain_input');
  let wire; try { wire = JSON.parse(input.inputJson); } catch { fail('invalid_owned_drain_input'); }
  require(wire && Object.getPrototypeOf(wire) === Object.prototype && same(Object.keys(wire).sort(), ['consumer','schema'])
    && wire.schema === 'a2-a3-owned-drain-v1' && wire.consumer?.a2?.phase === 'before-writer-stop', 'invalid_owned_drain_input');
  const token = parse(tokenSchema, wire.consumer?.a3?.token), binding = parse(bindingSchema, wire.consumer?.a3?.binding);
  require(same(token.target, { region: 'isolated', instanceId: 'fixture-controller-node', volumeId: 'fixture-controller-volume',
    serviceSet: ['fixture-controller'], dataPath: input.root }) && token.executionIdentity === 'fixture-controller-v1'
    && same(binding, {operationId:token.operationId,ownerId:token.ownerId,fence:token.fence,target:token.target,
      executionIdentity:token.executionIdentity,commandId:null,submitToken:null,requestHash:null}), 'invalid_owned_drain_input');
  return { wire, token, binding };
}
function safe(path, directory = false, cap = Infinity) {
  const s = lstatSync(path);
  require((directory ? s.isDirectory() : s.isFile()) && !s.isSymbolicLink() && s.uid === process.getuid()
    && (s.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || s.nlink === 1), 'unsafe_owned_drain_path');
  require(s.size <= cap, 'owned_drain_capacity_exceeded'); return s;
}
function bytes(path, cap) {
  const before = safe(path, false, cap), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); require(opened.dev === before.dev && opened.ino === before.ino && opened.uid === process.getuid()
      && opened.isFile() && opened.nlink === 1 && (opened.mode & 0o777) === 0o600, 'owned_drain_file_changed');
    const buffer = Buffer.alloc(cap + 1); let total = 0, n;
    while (total <= cap && (n = readSync(fd, buffer, total, cap + 1 - total, null))) total += n;
    require(total <= cap, 'owned_drain_capacity_exceeded'); const data = buffer.subarray(0, total);
    require(Buffer.from(data.toString('utf8')).equals(data), 'invalid_owned_drain_utf8'); return data;
  } finally { closeSync(fd); }
}
function rootCheck(root) { require(typeof root === 'string' && isAbsolute(root) && root === realpathSync(root), 'noncanonical_owned_drain_root'); return safe(root, true); }
/** Pure filesystem gates always precede a new SQLite constructor or any cached SQL. */
function gate(root, artifactRoot) {
  const parent = rootCheck(root), artifacts = rootCheck(artifactRoot); require(root !== artifactRoot, 'owned_drain_artifact_scope');
  const markerIdentities=['isolation.json','writers-isolation.json'].map(name=>{const s=safe(join(root,name),false,16384);return {dev:s.dev,ino:s.ino};});
  const marker = parse(markerSchema, JSON.parse(bytes(join(root,'isolation.json'), 16384)));
  require(marker.target.dataPath === root && bytes(join(root,'writers-isolation.json'),16384).toString('utf8')
    === canonical({schema:'a3-writers-isolation-v1',marker}), 'owned_drain_marker_changed');
  const names = ['ledger.sqlite','writers.sqlite','fixture-business.sqlite'];
  const identities = names.map((name, i) => { const path = join(root,name), s = safe(path,false,(i===2?64:16)*MiB);
    require(realpathSync(path) === path, 'owned_drain_file_changed'); return {dev:s.dev,ino:s.ino}; });
  function physical() {
    const r = rootCheck(root), a = rootCheck(artifactRoot);
    require(r.dev===parent.dev && r.ino===parent.ino && a.dev===artifacts.dev && a.ino===artifacts.ino, 'owned_drain_file_changed');
    ['isolation.json','writers-isolation.json'].forEach((name,i)=>{const s=safe(join(root,name),false,16384);require(s.dev===markerIdentities[i].dev&&s.ino===markerIdentities[i].ino,'owned_drain_marker_changed');});
    require(same(parse(markerSchema,JSON.parse(bytes(join(root,'isolation.json'),16384))),marker)
      && bytes(join(root,'writers-isolation.json'),16384).toString('utf8')===canonical({schema:'a3-writers-isolation-v1',marker}), 'owned_drain_marker_changed');
    names.forEach((name,i) => {
      const path=join(root,name), s=safe(path,false,(i===2?64:16)*MiB);
      require(realpathSync(path)===path && s.dev===identities[i].dev && s.ino===identities[i].ino,'owned_drain_file_changed');
      for (const suffix of ['-journal','-wal','-shm']) {
        try { safe(path+suffix,false,(i===2?64:16)*MiB); require(i===2 || suffix==='-journal','unexpected_owned_drain_sidecar'); }
        catch(error) { if(error.code!=='ENOENT') throw error; }
      }
    });
  }
  function rows(db,table,cap) { require(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${cap+1})`).get().n<=cap,'owned_drain_capacity_exceeded'); }
  function columns(db,table,columns) {
    for(const [name,cap,nullable=false,integer=false] of columns) {
      const invalid=integer ? `typeof(${name})!='integer' OR ${name}<0 OR ${name}>9007199254740991`
        : `typeof(${name})!='text' OR length(CAST(${name} AS BLOB))>${cap}`;
      require(!db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${nullable?`${name} IS NOT NULL AND `:''}(${invalid})) AS bad`).get().bad,'owned_drain_column_invalid');
    }
  }
  function size(db,table,cols) { return db.prepare(`SELECT coalesce(sum(${cols.map(c=>`coalesce(length(CAST(${c} AS BLOB)),0)`).join('+')}),0) AS n FROM ${table}`).get().n; }
  function count(db,table) { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
  function metadata() {
    physical(); let budget;
    names.forEach((name,i)=> {
      physical(); const path=join(root,name), db=new Database(path,{readonly:true,fileMustExist:true,timeout:0});
      try { physical(); db.transaction(()=> {
        physical(); const list=db.prepare('PRAGMA database_list').all();require(list.length===1&&list[0].file===path&&list[0].name==='main','owned_drain_database_scope');
        rows(db,'sqlite_master',i===2?1024:32); columns(db,'sqlite_master',[['name',512],['type',512],['tbl_name',512],['sql',65536,true]]);
        const sqlBytes=size(db,'sqlite_master',['sql']);require(sqlBytes<=(i===2?MiB:256*1024),'owned_drain_capacity_exceeded');
        if(i===0) {
          rows(db,'events',512);columns(db,'events',[['seq',0,false,true],['previous_hash',64],['hash',64],['snapshot',65536]]);
          budget={n:count(db,'events'),bytes:size(db,'events',['snapshot'])};require(budget.bytes<=4*MiB,'owned_drain_capacity_exceeded');
        } else if(i===1) {
          for(const [table,cols] of Object.entries({identity:[['marker',16384]],admission:[['id',0,false,true],['mode',6]],workers:[['worker_id',128],['generation_token',36],['entry_point',128]],tasks:[['task_id',36],['worker_id',128]],completions:[['task_id',36],['outcome',32]]})) {
            rows(db,table,['identity','admission'].includes(table)?1:1024);columns(db,table,cols);
          }
        } else {
          rows(db,'schema_migration',1024);columns(db,'schema_migration',[['version',512],['checksum',64]]);
          require(size(db,'schema_migration',['version','checksum'])*6+count(db,'schema_migration')*256+256<=256*1024,'owned_drain_capacity_exceeded');
          require(size(db,'sqlite_master',['name','type','tbl_name','sql'])*6+count(db,'sqlite_master')*1024+256<=MiB,'owned_drain_capacity_exceeded');
          let total=256;
          for(const [table,cols,epoch] of [['generation_dispatch',['id','trace_id','state','owner_token','claim_epoch','lease_expires_at'],'claim_epoch'],['generation_lease',['id','trace_id','state','owner_token','fencing_epoch','expires_at','active_key','scope_key'],'fencing_epoch']]) {
            rows(db,table,1024);columns(db,table,cols.map(c=>[c,512,['owner_token','lease_expires_at','expires_at'].includes(c),c===epoch]));
            total+=size(db,table,cols.filter(c=>c!==epoch))*6+count(db,table)*1024;
          }
          require(total<=MiB,'owned_drain_capacity_exceeded');
        }
      })(); } finally { db.close(); }
    }); physical(); return budget;
  }
  physical(); return {physical,metadata,marker};
}
function reserve(state,budget,token) {
  const projected=structuredClone(state); delete projected.production_permitted;
  let added=0;
  for(const why of ['owned_drain_started','x'.repeat(128)]) {
    projected.revision++;const op=projected.operations[token.operationId];op.revision=projected.revision;op.disposition='held';op.failures.push(why);
    const n=Buffer.byteLength(canonical(projected));require(n<=65536,'owned_drain_capacity_exceeded');added+=n;
  }
  require(budget.n+2<=512 && budget.bytes+added<=4*MiB,'owned_drain_capacity_exceeded');
}
async function consume(input,window) {
  const {root,artifactRoot,signal,pollEveryMs}=input,{wire,token:ingress,binding}=argumentsCheck(input);
  let consumer=null,ledger,writers,source,current=null,sample=null,polls=0,entry='not_attempted',final='not_attempted',admission='unknown',firstCancellation,answer,primary;
  const onAbort=()=>{firstCancellation??=reason(signal);};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  const result=why=>({schema:'a2-a3-owned-drain-result-v1',profile:'held-before-cooperative-drain',consumer,reason:why,
    token:current?structuredClone(current):null,sample,polls,entry_hold:entry,final_hold:final,admission,...blocked});
  try {
    if(firstCancellation!==undefined || window.remaining()<=0) {answer=result(firstCancellation??'task_deadline_exceeded');return answer;}
    const gates=gate(root,artifactRoot);gates.metadata();
    consumer=consumeA2Isolated({root,artifactRoot,input:wire.consumer,now:Date.now()});
    if(!consumer.isolated_consumer_integrated) {answer=result(consumer.reason);return answer;}
    gates.metadata();ledger=openLedger(root);gates.metadata();writers=openWriters(root);gates.metadata();source=openDrainLeaseSource(root,join(root,'fixture-business.sqlite'));
    function owned(expected,disposition) {
      gates.metadata();const state=ledger.inspect(),op=state.operations[expected.operationId];
      require(state.active===expected.operationId && op && same(tokenFor(op),expected),'owned_drain_owner_revision_lost');
      require(same(state.marker,gates.marker)&&same(bindingFor(op),binding),'owned_drain_binding_lost');
      require(op.state==='pre_submit'&&op.disposition===disposition,'owned_drain_operation_not_active');
      parse(requestSchema,{operationId:op.operationId,ownerId:op.ownerId,kind:op.kind,target:op.target,executionIdentity:op.executionIdentity});return state;
    }
    const initial=owned(ingress,'active');gates.metadata();const view=writers.inspect();
    require(same(view.marker,gates.marker)&&view.admission==='open','owned_drain_writer_binding_lost');admission='open';
    const budget=gates.metadata();reserve(initial,budget,ingress);gates.physical();
    // Last synchronous checkpoint is adjacent to first CAS, including the CLI's original monotonic window.
    if(signal?.aborted)onAbort();
    if(firstCancellation!==undefined||window.remaining()<=0){answer=result(firstCancellation??'task_deadline_exceeded');return answer;}
    try {current=ledger.hold(ingress,'owned_drain_started');entry='committed';}
    catch(error){if(/^maintenance_(owner_lost|revision_conflict)$/.test(error.message))throw error;entry='unknown';current=null;answer=result(firstCancellation??'owned_drain_initial_commit_unknown');return answer;}
    let why;
    owned(current,'held');
    try {gates.metadata();writers.closeAdmission();admission='closed';gates.metadata();require(writers.inspect().admission==='closed','owned_drain_writer_binding_lost');}
    catch {admission='unknown';why=firstCancellation??'owned_drain_close_failed';}
    if(!why) {
      try {
        for(;;) {
          owned(current,'held');gates.metadata();const v=writers.inspect();require(same(v.marker,gates.marker)&&v.admission==='closed','owned_drain_writer_binding_lost');
          gates.metadata();sample=source.sample(Date.now());polls++;
          if(signal?.aborted)onAbort();
          if(firstCancellation!==undefined){why=firstCancellation;break;}
          if(window.remaining()<=0){why='writer_drain_timeout';break;}
          if(!v.tasks.some(t=>t.outcome===null)){why='writer_drain_coverage_unknown';break;}
          await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};timer=setTimeout(done,Math.min(pollEveryMs,Math.max(1,window.remaining())));signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
        }
      } catch {sample=null;why=firstCancellation??'writer_drain_observation_failed';}
    }
    // Outside observation catch: ownership loss never becomes generic failure or foreign hold.
    owned(current,'held');gates.physical();
    try {current=ledger.hold(current,why);final='committed';}
    catch(error){current=null;if(/^maintenance_(owner_lost|revision_conflict)$/.test(error.message))throw error;final='unknown';answer=result(firstCancellation??'owned_drain_final_commit_unknown');return answer;}
    answer=result(why);return answer;
  } catch(error) {current=null;primary=error;throw error;}
  finally {
    signal?.removeEventListener('abort',onAbort);let cleanup=false;
    for(const handle of [source,writers,ledger])try{handle?.close();}catch{cleanup=true;}
    if(cleanup&&!primary){if(answer){answer.token=null;answer.reason=firstCancellation??'owned_drain_cleanup_failed';}else fail('owned_drain_cleanup_failed');}
  }
}
/** Fresh library window only. CLI calls the same private implementation with its original admitted window. */
export async function consumeOwnedDrainIsolated(input) { const window=windowFor(input?.deadlineAt);return consume(input,window); }
/** Fixed actual process CLI; no injectable args, clock, window, transport or callback. */
export async function runOwnedDrainCli() {
  const args=process.argv.slice(2);require(args.length===4&&args.slice(2).every(x=>/^[0-9]+$/.test(x)),'invalid_owned_drain_arguments');
  const [root,artifactRoot]=args,deadlineAt=Number(args[2]),pollEveryMs=Number(args[3]),window=windowFor(deadlineAt);
  require(Number.isSafeInteger(pollEveryMs)&&pollEveryMs>=1&&pollEveryMs<=1000,'invalid_drain_poll');
  const controller=new AbortController();let firstCause,timer;
  const abort=code=>{firstCause??=code;controller.abort({reasonCode:firstCause});};
  const onSignal=()=>abort('cancelled');process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  timer=setTimeout(()=>abort('task_deadline_exceeded'),Math.max(1,window.remaining()));
  try {
    const chunks=[];let total=0;
    await new Promise((resolve,reject)=>{
      const stop=()=>{process.stdin.pause();process.stdin.removeListener('data',data);process.stdin.removeListener('end',end);process.stdin.removeListener('error',error);controller.signal.removeEventListener('abort',cancel);};
      const data=chunk=>{total+=chunk.length;if(total>65536){stop();reject(new Error('owned_drain_stdin_too_large'));}else chunks.push(chunk);};
      const end=()=>{stop();resolve();},error=()=>{stop();reject(new Error('owned_drain_stdin_failed'));},cancel=()=>{stop();reject(new Error(firstCause));};
      process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.once('error',error);controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();
    });
    const inputJson=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    const input={root,artifactRoot,inputJson,deadlineAt,pollEveryMs,signal:controller.signal};argumentsCheck(input);
    if(controller.signal.aborted)firstCause??=reason(controller.signal);
    if(firstCause!==undefined||window.remaining()<=0)fail(firstCause??'task_deadline_exceeded');
    const result=await consume(input,window);process.exitCode=1;
    await new Promise((resolve,reject)=>{
      const error=()=>reject(new Error('owned_drain_stdout_failed'));
      process.stdout.once('error',error);
      process.stdout.write(JSON.stringify(result)+'\n',failure=>{
        if(failure){error();return;}process.stdout.removeListener('error',error);resolve();
      });
    });
  } finally {clearTimeout(timer);process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);process.stdin.pause();}
}
