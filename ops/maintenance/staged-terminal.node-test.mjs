import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, readFileSync, statSync, existsSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';
import { initialize, openLedger } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
import { initializeStagedTerminal } from './staged-terminal.mjs';
import { openDrainLeaseSource } from './drain.mjs';
import { canonical, hash } from './contract.mjs';
register();
const { openDb } = await import('../../src/lib/db/index.ts');
const { applyProvenanceMigrations } = await import('../../src/lib/db/provenance-migrations.ts');
const { insertTopic } = await import('../../src/lib/db/repos.ts');
const { createDeepDiveTraceRequest, claimNextGenerationDispatch } = await import('../../src/lib/db/provenance.ts');
const { openTerminalDispatchDriver } = await import('../../src/lib/runtime/terminal-dispatch-driver.ts');
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'insight-a3-staged-native-')));chmodSync(root,0o700);
  const {publicKey}=generateKeyPairSync('ed25519'),target={region:'isolated',instanceId:'fixture-app',volumeId:'fixture-data',dataPath:root,serviceSet:['app']};
  initialize(root,{target,approverId:'fixture-reviewer',publicKey:publicKey.export({type:'spki',format:'pem'})});initializeWriters(root);
  const path=join(root,'fixture-business.sqlite'),seed=openDb(path);chmodSync(path,0o600);applyProvenanceMigrations(seed);
  insertTopic(seed,{id:'topic_a',name:'Topic A',keywords:[],language:'en',brief_schedule:'daily',enabled:true,archetype:'deep_vertical',facets:[]});
  createDeepDiveTraceRequest(seed,{topicId:'topic_a',idempotencyKeyHash:'a'.repeat(64),planning:true});seed.pragma('wal_checkpoint(TRUNCATE)');seed.close();
  const driver=openTerminalDispatchDriver(root),db=driver.db;initializeStagedTerminal(root);const writers=openWriters(root),control=writers.stagedTerminalControl();
  const {admission,worker}=writers.registerStagedTerminal('staged-worker',db,driver);
  const gatePath=join(root,'staged-terminal-v1','gate.sqlite');
  t.after(()=>{if(db.open)driver.close();writers.close();}); // Retain isolated native/crash bytes for evidence, never claim deleted fixtures are retained.
  t.diagnostic(`retained fixture ${root}`);
  function claim(){const cap=admission.admit(),claim=claimNextGenerationDispatch(db);assert.ok(claim);admission.bindClaim(cap,claim);return {cap,claim};}
  function held(){const ledger=openLedger(root);try{let token=ledger.acquire({operationId:'op-stage',ownerId:'stage-controller',kind:'backup',target,executionIdentity:'fixture-stage-controller'});return ledger.hold(token,'writer_drain_coverage_unknown');}finally{ledger.close();}}
  const facts=()=>['generation_dispatch','generation_lease','run','generation_event'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return {root,path,gatePath,db,driver,writers,control,admission,worker,claim,held,facts};
}
const failed={status:'failed',error:{reason_code:'dispatch_failed',message:'dispatch_failed',retryable:false}};
const digest=p=>({size:statSync(p).size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')});
function blocked(s){assert.equal(s.writer_quiescence,false);assert.equal(s.drain_ready,false);assert.equal(s.production_permitted,false);assert.equal(s.process_termination,'unknown');}

test('real closed cooperative terminal commits exactly once; independent durable reservation survives finish', t=>{
 const f=fixture(t),{cap,claim}=f.claim();let token=f.control.inspect().token;token=f.control.closeAdmission(token);
 assert.throws(()=>f.admission.admit());assert.deepEqual(f.admission.commitOutcome(cap,claim,failed),{kind:'committed',businessCommit:'committed'});
 assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');let view=f.control.inspect();assert.equal(view.attempts.length,1);assert.equal(view.attempt_outcomes.length,1);blocked(view);
 assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');f.admission.finish(cap,'failed');assert.equal(f.control.inspect().attempts.length,1);
 assert.deepEqual(f.control.closeAdmission(f.control.inspect().token),f.control.inspect().token);
});

test('drain record immutable; stale S0 revision rejected, legitimately fresh same binding accepted, revoke once', t=>{
 const f=fixture(t),{cap,claim}=f.claim();let token=f.control.closeAdmission(f.control.inspect().token),held=f.held();token=f.control.bindDrain(token,held);const old=f.control.inspect().stage.drain_record;
 const ledger=openLedger(f.root);try{held=ledger.hold(held,'staged_terminal_manual_block');}finally{ledger.close();}
 const oldHeld=JSON.parse(old).heldToken;assert.throws(()=>f.control.revoke(token,oldHeld,'staged_terminal_manual_block'),/staged_terminal_owner_lost/);
 const before=f.facts();token=f.control.revoke(token,held,'staged_terminal_manual_block');assert.deepEqual(f.facts(),before);const view=f.control.inspect();assert.equal(view.stage.drain_record,old);assert.ok(view.stage.revoke_record);assert.equal(JSON.parse(view.stage.revoke_record).heldToken.revision,held.revision);blocked(view);
 assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_revoked');assert.deepEqual(f.facts(),before);assert.deepEqual(f.control.revoke(token,held,'staged_terminal_manual_block'),token);assert.throws(()=>f.control.revoke(token,held,'cancelled'));assert.throws(()=>f.control.closeAdmission({...token,revision:token.revision-1}));
});

test('native six-field tuple UNIQUE, wrong root, repeated bind, foreign cap, restart cannot remint', t=>{
 const f=fixture(t),cap=f.admission.admit(),claim=claimNextGenerationDispatch(f.db);assert.ok(claim);
 assert.throws(()=>f.admission.bindClaim(cap,{...claim,rootRunId:'wrong-root'}),/staged_terminal_claim_mismatch/);f.admission.bindClaim(cap,claim);assert.throws(()=>f.admission.bindClaim(cap,claim));
 const second=f.admission.admit();assert.throws(()=>f.admission.bindClaim(second,claim));assert.equal(f.admission.commitOutcome({},claim,failed).code,'staged_terminal_capability_invalid');assert.equal(f.admission.commitOutcome(cap,{...claim,claimEpoch:claim.claimEpoch+1},failed).code,'staged_terminal_claim_mismatch');assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');
 const other=openWriters(f.root);try{assert.throws(()=>other.registerStagedTerminal('replacement',f.db,f.driver),/staged_terminal_owner_lost/);assert.equal(other.stagedTerminalControl().inspect().claims.length,1);}finally{other.close();}
 assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'claimed');
});

test('lease owner/claim epoch/fence epoch loss prevents fixed terminal business writes',t=>{
 for(const sql of ["UPDATE generation_lease SET owner_token='foreign'",'UPDATE generation_dispatch SET claim_epoch=claim_epoch+1','UPDATE generation_lease SET fencing_epoch=fencing_epoch+1',"UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z'"]){const f=fixture(t),{cap,claim}=f.claim();f.db.exec(sql);const before=f.facts();assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'generation_fence_lost');assert.deepEqual(f.facts(),before);assert.equal(f.control.inspect().attempts.length,1);}
});

test('ATTACH, foreign handle and business file identity refuse before admission',t=>{
 const f=fixture(t),before=f.facts();f.db.exec("ATTACH ':memory:' AS extra");assert.throws(()=>f.admission.admit(),/staged_terminal_business_mismatch/);assert.deepEqual(f.facts(),before);assert.equal(f.control.inspect().tasks.length,0);f.db.exec('DETACH extra');
 const foreign=new Database(f.path,{timeout:0});try{assert.throws(()=>f.writers.registerStagedTerminal('another',foreign,f.driver),/staged_terminal_business_mismatch/);}finally{foreign.close();}
 chmodSync(f.path,0o644);assert.throws(()=>f.admission.admit(),/unsafe_staged_path/);chmodSync(f.path,0o600);assert.equal(f.control.inspect().tasks.length,0);
});

function hot(f){
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.pragma('cache_size=1');db.exec('BEGIN IMMEDIATE');const ins=db.prepare('INSERT INTO events VALUES (?,?,?,?)');for(let i=0;i<10000;i++)ins.run(100000+i,'x','x','x'.repeat(100));process.kill(process.pid,'SIGKILL');`,f.gatePath],{cwd:process.cwd(),env:{PATH:process.env.PATH},stdio:'pipe'});
 assert.equal(child.signal,'SIGKILL');assert.ok(statSync(f.gatePath+'-journal').size>512);
 for(const path of [f.gatePath,f.gatePath+'-journal']){const preserved=path+'.hot-before';writeFileSync(preserved,readFileSync(path),{flag:'wx',mode:0o600});chmodSync(preserved,0o600);assert.deepEqual(digest(preserved),digest(path));}
}
for(const existing of [false,true])test(`real unsafe hot journal ${existing?'existing':'new'} handle refused before recovery with original hashes preserved`,t=>{
 const f=fixture(t);if(existing)f.control.inspect();hot(f);const journal=f.gatePath+'-journal';chmodSync(journal,0o644);const before=[digest(f.gatePath),digest(journal)];
 const w=existing?f.writers:openWriters(f.root);try{assert.throws(()=>w.stagedTerminalControl().inspect(),/unsafe_staged_path/);assert.deepEqual([digest(f.gatePath),digest(journal)],before);}finally{if(!existing)w.close();}
 t.diagnostic(`retained unsafe hot journal ${journal} ${canonical(before)}`);
});
test('safe real hot journal recovers closed/unfinished state without releasing unknown task',t=>{
 const f=fixture(t);f.claim();f.control.closeAdmission(f.control.inspect().token);hot(f);chmodSync(f.gatePath+'-journal',0o600);const view=f.control.inspect();assert.equal(view.stage.admission,'closed');assert.equal(view.tasks.length,1);assert.equal(view.completions.length,0);assert.equal(view.claims.length,1);blocked(view);
});

test('phase1 stage COMMIT unknown never invokes business; durable reservation prevents retry',t=>{
 const f=fixture(t),{cap,claim}=f.claim(),exec=Database.prototype.exec;let cut=false;
 Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(this.name===f.gatePath&&sql==='COMMIT'&&!cut){cut=true;throw new Error('private native commit cut');}return result;};
 let result;try{result=f.admission.commitOutcome(cap,claim,failed);}finally{Database.prototype.exec=exec;}
 assert.deepEqual(result,{kind:'unknown',businessCommit:'not_committed',code:'staged_terminal_reservation_unknown'});assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'claimed');assert.equal(f.control.inspect().attempts.length,1);assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');
});

test('phase2 stage COMMIT failure preserves actual business COMMIT and no fallback',t=>{
 const f=fixture(t),{cap,claim}=f.claim(),exec=Database.prototype.exec;let commits=0;
 Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(this.name===f.gatePath&&sql==='COMMIT'&&++commits===2)throw new Error('private phase2 commit cut');return result;};
 let result;try{result=f.admission.commitOutcome(cap,claim,failed);}finally{Database.prototype.exec=exec;}
 assert.deepEqual(result,{kind:'unknown',businessCommit:'committed',code:'staged_terminal_gate_commit_unknown'});assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');assert.equal(f.control.inspect().attempts.length,1);assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');
});

test('busy phase1 spends process-local permission without a business write',t=>{
 const f=fixture(t),{cap,claim}=f.claim(),lock=new Database(f.gatePath,{timeout:0});lock.exec('BEGIN IMMEDIATE');const before=f.facts();try{assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_busy');assert.deepEqual(f.facts(),before);}finally{lock.exec('ROLLBACK');lock.close();}assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');
});

test('aggregate lease hash records exact exported sample, not claim epochs or whole-writer silence',t=>{
 const f=fixture(t);f.claim();let token=f.control.closeAdmission(f.control.inspect().token);token=f.control.bindDrain(token,f.held());const record=JSON.parse(f.control.inspect().stage.drain_record);const source=openDrainLeaseSource(f.root,f.path);try{assert.equal(record.leaseSampleHash,hash(canonical(source.sample(record.sampledAt))));}finally{source.close();}assert.equal(record.resultStageRevision,record.expectedStageRevision+1);assert.equal(record.source.businessPath,f.path);assert.equal(hash(canonical(record)),hash(f.control.inspect().stage.drain_record));blocked(f.control.inspect());
});

function revokeChild(f,held) {
 const script=`import {openWriters} from './ops/maintenance/writers.mjs';let w;try{w=openWriters(process.argv[1]);const c=w.stagedTerminalControl();c.revoke(c.inspect().token,JSON.parse(process.argv[2]),'staged_terminal_manual_block');console.log('revoked');}catch(e){console.log(e.code||e.message);process.exitCode=2;}finally{w?.close();}`;
 return spawnSync(process.execPath,['--input-type=module','-e',script,f.root,canonical(held)],{cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8'});
}
test('real second process revoke wins the unlocked phase1/phase2 gap, reservation remains and business never writes',t=>{
 const f=fixture(t),{cap,claim}=f.claim();let token=f.control.closeAdmission(f.control.inspect().token),held=f.held();f.control.bindDrain(token,held);
 const prepare=f.db.prepare.bind(f.db);let calls=0,child;
 f.db.prepare=function(sql){if(sql==='PRAGMA database_list'&&++calls===2){child=revokeChild(f,held);assert.equal(child.status,0,child.stdout+child.stderr);}return prepare(sql);};
 let result;const before=f.facts();try{result=f.admission.commitOutcome(cap,claim,failed);}finally{f.db.prepare=prepare;}
 assert.equal(child.stdout.trim(),'revoked');assert.equal(result.code,'staged_terminal_revoked');assert.deepEqual(f.facts(),before);const view=f.control.inspect();assert.equal(view.attempts.length,1);assert.equal(view.stage.terminal,'revoked');blocked(view);
});
test('real second process cannot revoke while registry/stage locks span business COMMIT',t=>{
 const f=fixture(t),{cap,claim}=f.claim();let token=f.control.closeAdmission(f.control.inspect().token),held=f.held();token=f.control.bindDrain(token,held);
 const exec=f.db.exec.bind(f.db);let child;f.db.exec=sql=>{const value=exec(sql);if(sql==='COMMIT'){child=revokeChild(f,held);assert.equal(child.status,2);assert.match(child.stdout,/SQLITE_BUSY/);}return value;};
 let result;try{result=f.admission.commitOutcome(cap,claim,failed);}finally{f.db.exec=exec;}
 assert.equal(result.kind,'committed');assert.equal(f.control.inspect().stage.terminal,'live');assert.equal(revokeChild(f,held).status,0);assert.equal(f.control.inspect().stage.terminal,'revoked');
});
const childPrelude=`import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';import {chmodSync,mkdtempSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import Database from 'better-sqlite3';import {initialize,openLedger} from './ops/maintenance/ledger.mjs';import {initializeWriters,openWriters} from './ops/maintenance/writers.mjs';import {initializeStagedTerminal} from './ops/maintenance/staged-terminal.mjs';import {openDb} from './src/lib/db/index.ts';import {applyProvenanceMigrations} from './src/lib/db/provenance-migrations.ts';import {insertTopic} from './src/lib/db/repos.ts';import {createDeepDiveTraceRequest,claimNextGenerationDispatch} from './src/lib/db/provenance.ts';import {openTerminalDispatchDriver} from './src/lib/runtime/terminal-dispatch-driver.ts';${fixture.toString()};const f=fixture({after(){},diagnostic(){}},{ });console.log(f.root);const {cap,claim}=f.claim();`;
for(const cut of ['before_reservation_commit','after_reservation_commit','before_business_commit','after_business_commit'])test(`real SIGKILL ${cut} never permits restart remint/replay; durable facts classified`,t=>{
 const hook=`const mode=process.argv[1],exec=Database.prototype.exec;Database.prototype.exec=function(sql){const gate=this.name===f.gatePath,terminal=this.name===f.path;if(sql==='COMMIT'&&gate&&this.prepare('SELECT count(*) AS n FROM attempts').get().n===1&&this.prepare('SELECT count(*) AS n FROM attempt_outcomes').get().n===0){if(mode==='before_reservation_commit')process.kill(process.pid,'SIGKILL');const value=exec.call(this,sql);if(mode==='after_reservation_commit')process.kill(process.pid,'SIGKILL');return value;}if(sql==='COMMIT'&&terminal){if(mode==='before_business_commit')process.kill(process.pid,'SIGKILL');const value=exec.call(this,sql);if(mode==='after_business_commit')process.kill(process.pid,'SIGKILL');return value;}return exec.call(this,sql);};f.admission.commitOutcome(cap,claim,${canonical(failed)});throw new Error('cut not reached');`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',childPrelude+hook,cut],{cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);const root=child.stdout.trim().split('\n').at(-1);const gate=join(root,'staged-terminal-v1','gate.sqlite'),business=join(root,'fixture-business.sqlite');
 const captured=[];for(const path of [gate,business,gate+'-journal',business+'-journal'])if(existsSync(path))captured.push({path,...digest(path)});t.diagnostic(`retained SIGKILL pre-recovery ${canonical(captured)}`);
 // Preserve pre-recovery original bytes separately before SQLite may remove legitimate hot journals.
 for(const item of captured){const backup=item.path+'.'+cut+'.before';writeFileSync(backup,readFileSync(item.path),{flag:'wx',mode:0o600});chmodSync(backup,0o600);assert.deepEqual(digest(backup),{size:item.size,sha256:item.sha256});}
 const w=openWriters(root),driver=openTerminalDispatchDriver(root);try{const view=w.stagedTerminalControl().inspect();assert.equal(view.claims.length,1);assert.equal(view.completions.length,0);assert.equal(view.attempts.length,cut==='before_reservation_commit'?0:1);assert.throws(()=>w.registerStagedTerminal('restart-worker',driver.db,driver));assert.equal(driver.db.prepare('SELECT state FROM generation_dispatch').get().state,cut==='after_business_commit'?'failed':'claimed');blocked(view);}finally{w.close();driver.close();}
});

test('two actual claims retain independent epochs; bound caps cannot be exchanged or replaced by another cap',t=>{
 const f=fixture(t),first=f.claim();
 insertTopic(f.db,{id:'topic_b',name:'Topic B',keywords:[],language:'en',brief_schedule:'daily',enabled:true,archetype:'deep_vertical',facets:[]});createDeepDiveTraceRequest(f.db,{topicId:'topic_b',idempotencyKeyHash:'b'.repeat(64),planning:true});
 const secondCap=f.admission.admit(),raw=claimNextGenerationDispatch(f.db);assert.ok(raw);f.db.prepare('UPDATE generation_lease SET fencing_epoch=9 WHERE trace_id=?').run(raw.traceId);const secondClaim={...raw,fencingEpoch:9};f.admission.bindClaim(secondCap,secondClaim);const before=f.facts();
 assert.equal(f.admission.commitOutcome(first.cap,secondClaim,failed).code,'staged_terminal_claim_mismatch');assert.equal(f.admission.commitOutcome(secondCap,first.claim,failed).code,'staged_terminal_claim_mismatch');assert.deepEqual(f.facts(),before);assert.equal(f.control.inspect().claims[1].fencing_epoch,9);assert.equal(f.control.inspect().attempts.length,0);
});
test('stage marker and complete schema/audit must validate before mutations',t=>{
 const f=fixture(t),marker=join(f.root,'staged-terminal-v1','stage-isolation.json'),original=readFileSync(marker);writeFileSync(marker,original.toString().replace('generation-dispatch','uncovered'));assert.throws(()=>f.admission.admit());writeFileSync(marker,original);chmodSync(marker,0o600);
 const corrupt=new Database(f.gatePath);try{corrupt.exec('DROP TRIGGER events_no_update');corrupt.prepare("UPDATE events SET hash='wrong' WHERE seq=1").run();}finally{corrupt.close();}assert.throws(()=>f.admission.admit(),/invalid_staged_schema/);assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'queued');
});

test('stage inode replacement on existing native connection rejects without registration or business writes',t=>{
 const f=fixture(t),before=f.facts();f.control.inspect();const old=f.gatePath+'.original-inode';renameSync(f.gatePath,old);copyFileSync(old,f.gatePath);chmodSync(f.gatePath,0o600);assert.throws(()=>f.admission.admit(),/staged_marker_changed/);assert.deepEqual(f.facts(),before);assert.deepEqual(digest(old),digest(f.gatePath));
});

test('phase2 busy after confirmed reservation is known business deny, never reservation-unknown or retry permission',t=>{
 const f=fixture(t),{cap,claim}=f.claim(),prepare=f.db.prepare.bind(f.db);let calls=0,lock;
 f.db.prepare=function(sql){if(sql==='PRAGMA database_list'&&++calls===2){lock=new Database(f.gatePath,{timeout:0});lock.exec('BEGIN IMMEDIATE');}return prepare(sql);};
 const before=f.facts();let result;try{result=f.admission.commitOutcome(cap,claim,failed);}finally{f.db.prepare=prepare;lock?.exec('ROLLBACK');lock?.close();}
 assert.deepEqual(result,{kind:'not_committed',businessCommit:'not_committed',code:'staged_terminal_busy'});assert.deepEqual(f.facts(),before);assert.equal(f.control.inspect().attempts.length,1);assert.equal(f.admission.commitOutcome(cap,claim,failed).code,'staged_terminal_capability_invalid');
});
