import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { register } from 'tsx/esm/api';
import { initialize } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
register();
const { openDb } = await import('../../src/lib/db/index.ts');
const { applyProvenanceMigrations } = await import('../../src/lib/db/provenance-migrations.ts');
const { insertTopic } = await import('../../src/lib/db/repos.ts');
const { createDeepDiveTraceRequest, claimNextGenerationDispatch, finishGenerationDispatch } = await import('../../src/lib/db/provenance.ts');
const { openTerminalDispatchDriver } = await import('../../src/lib/runtime/terminal-dispatch-driver.ts');
function fixture(t, { journalMode = "WAL" } = {}) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'insight-a3-terminal-')));chmodSync(root,0o700);
 const {publicKey}=generateKeyPairSync('ed25519');
 initialize(root,{target:{region:'isolated',instanceId:'fixture-app',volumeId:'fixture-data',dataPath:root,serviceSet:['app']},approverId:'fixture-reviewer',publicKey:publicKey.export({type:'spki',format:'pem'})}); initializeWriters(root);
 const path=join(root,'fixture-business.sqlite'),seed=openDb(path);chmodSync(path,0o600);applyProvenanceMigrations(seed);
 insertTopic(seed,{id:'topic_a',name:'Topic A',keywords:[],language:'en',brief_schedule:'daily',enabled:true,archetype:'deep_vertical',facets:[]});
 createDeepDiveTraceRequest(seed,{topicId:'topic_a',idempotencyKeyHash:'a'.repeat(64),planning:true});seed.pragma('wal_checkpoint(TRUNCATE)');if(journalMode==='DELETE')seed.pragma('journal_mode=DELETE');seed.close();
 const writers=openWriters(root),driver=openTerminalDispatchDriver(root),db=driver.db;
 t.after(()=>{if(db.open)driver.close();writers.close();rmSync(root,{recursive:true});});
 const worker=writers.register('terminal-one','generation-dispatch'),admission=writers.terminalAdmissionFor(worker,db,driver);
 return {root,path,writers,driver,db,admission,worker};
}
test('strict close rejects late real terminal while cooperative local finish remains legal',t=>{
 const f=fixture(t),cap=f.admission.admit(),claim=claimNextGenerationDispatch(f.db);f.admission.bindClaim(cap,claim);
 const before=f.db.prepare('SELECT * FROM generation_dispatch').all();f.writers.closeAdmission();
 assert.deepEqual(f.admission.commitOutcome(cap,claim,{status:'failed'}),{kind:'not_committed',businessCommit:'not_committed',code:'writer_terminal_closed'});
 assert.deepEqual(f.db.prepare('SELECT * FROM generation_dispatch').all(),before);f.admission.finish(cap,'failed');
 assert.equal(f.writers.inspect().writer_quiescence,false);assert.equal(f.writers.inspect().tasks[0].remote_subwork,'unknown');
});

const outcome={status:'failed',error:{reason_code:'synthetic_failure',message:'synthetic_failure',retryable:false}};
const tables=['generation_dispatch','generation_lease','generation_trace','generation_trace_request','run','generation_event'];
const facts=f=>tables.map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const enroll=f=>{const cap=f.admission.admit(),claim=claimNextGenerationDispatch(f.db);f.admission.bindClaim(cap,claim);return {cap,claim};};
const childClose=f=>spawnSync(process.execPath,['--input-type=module','-e',`import {openWriters} from ${JSON.stringify(new URL('./writers.mjs',import.meta.url).href)};let w;try{w=openWriters(process.argv[1]);w.closeAdmission();console.log('CLOSED');}catch(e){console.log(e.code??e.message);}finally{w?.close();}`,f.root],{cwd:process.cwd(),env:{PATH:process.env.PATH},stdio:'pipe',timeout:5000});

test('fixed driver commits real failed terminal and consumes exactly one capability attempt',t=>{
 const f=fixture(t),{cap,claim}=enroll(f);
 assert.deepEqual(f.admission.commitOutcome(cap,claim,outcome),{kind:'committed',businessCommit:'committed'});
 assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');
 assert.equal(f.db.prepare('SELECT state FROM generation_lease').get().state,'released');
 assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'writer_terminal_capability_invalid');f.admission.finish(cap,'failed');
});

test('real process close and protected terminal COMMIT share registry lock; unlocked negative crosses close',t=>{
 const f=fixture(t),{cap,claim}=enroll(f),exec=f.db.exec.bind(f.db);let competitor;
 f.db.exec=sql=>{if(sql==='BEGIN IMMEDIATE')competitor=childClose(f);return exec(sql);};
 assert.equal(f.admission.commitOutcome(cap,claim,outcome).kind,'committed');
 assert.equal(competitor.status,0,competitor.stderr.toString());assert.match(competitor.stdout.toString(),/SQLITE_BUSY/);
 f.db.exec=exec;assert.match(childClose(f).stdout.toString(),/CLOSED/);
 const negative=fixture(t),n=enroll(negative);
 assert.equal(negative.writers.inspect().admission,'open');assert.match(childClose(negative).stdout.toString(),/CLOSED/);
 // Intentional unguarded negative, not a production consumer: check then release cannot fence this actual repo write.
 assert.equal(finishGenerationDispatch(negative.db,n.claim,outcome),true);
 assert.equal(negative.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');
});

test('same closure two caps/claims cannot exchange, mutate six fields, rebind or remint a claim',t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO topic (id,name,keywords,language,brief_schedule,enabled,archetype,facets) SELECT 'topic_b','Topic B',keywords,language,brief_schedule,enabled,archetype,facets FROM topic WHERE id='topic_a'").run();
 createDeepDiveTraceRequest(f.db,{topicId:'topic_b',idempotencyKeyHash:'b'.repeat(64),planning:true});
 const a=enroll(f),b=enroll(f),before=facts(f);
 assert.equal(f.admission.commitOutcome(a.cap,b.claim,outcome).code,'writer_terminal_claim_mismatch');
 assert.equal(f.admission.commitOutcome(b.cap,a.claim,outcome).code,'writer_terminal_claim_mismatch');assert.deepEqual(facts(f),before);
 assert.throws(()=>f.admission.bindClaim(a.cap,a.claim),/writer_terminal_capability_invalid/);
 const other=f.writers.terminalAdmissionFor(f.writers.register('terminal-two','generation-dispatch'),f.db,f.driver),replacement=other.admit();
 assert.throws(()=>other.bindClaim(replacement,a.claim),/writer_terminal_claim_mismatch/);
 assert.equal(other.commitOutcome(a.cap,a.claim,outcome).code,'writer_terminal_capability_invalid');
 assert.equal(f.admission.commitOutcome(structuredClone(a.cap),a.claim,outcome).code,'writer_terminal_capability_invalid');
 const fresh=f.admission.admit();assert.equal(f.admission.commitOutcome(fresh,a.claim,outcome).code,'writer_terminal_capability_invalid');
 assert.throws(()=>f.admission.bindClaim(fresh,{...a.claim,ownerToken:'different-owner'}),/writer_terminal_capability_invalid/);
 const completed=fixture(t),c=enroll(completed),completedBefore=facts(completed);
 completed.writers.finish({...completed.worker,taskId:completed.writers.inspect().tasks[0].taskId},'failed');
 assert.equal(completed.admission.commitOutcome(c.cap,c.claim,outcome).code,'writer_terminal_capability_invalid');assert.deepEqual(facts(completed),completedBefore);
 const newCap=completed.admission.admit();assert.throws(()=>completed.admission.bindClaim(newCap,c.claim),/writer_terminal_claim_mismatch/);

});

test('immutable binding rejects every changed primitive and actual wrong rootRun association inside transaction',t=>{
 for(const field of ['dispatchId','traceId','ownerToken','claimEpoch','fencingEpoch','rootRunId']){
  const f=fixture(t),{cap,claim}=enroll(f),before=facts(f),changed={...claim,[field]:typeof claim[field]==='number'?claim[field]+1:'foreign-'+claim[field]};
  assert.equal(f.admission.commitOutcome(cap,changed,outcome).code,'writer_terminal_claim_mismatch');assert.deepEqual(facts(f),before);
 }
 for(const fault of ["UPDATE generation_trace SET root_run_id='other_run'","UPDATE run SET trace_id='other_trace'"]){
  const f=fixture(t),{cap,claim}=enroll(f);
  f.db.exec("INSERT INTO run(id,kind,target,status,started_at) VALUES ('other_run','analyze','{}','running','2026-10-08T00:00:00.000Z')");
  f.db.exec(fault);const before=facts(f);assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'generation_fence_lost');assert.deepEqual(facts(f),before);
 }
});

test('real lease ownership, independent epoch, expiry and takeover deny with zero terminal mutation',t=>{
 for(const fault of ["UPDATE generation_lease SET owner_token='other'",'UPDATE generation_lease SET fencing_epoch=fencing_epoch+1',
 'UPDATE generation_dispatch SET claim_epoch=claim_epoch+1',"UPDATE generation_dispatch SET lease_expires_at='2000-01-01T00:00:00.000Z'",
 "UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z'"]){
  const f=fixture(t),{cap,claim}=enroll(f);f.db.exec(fault);const before=facts(f);
  assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'generation_fence_lost');assert.deepEqual(facts(f),before);
 }
});

test('reverse transaction and native SQLite busy refuse immediately without a legacy retry',t=>{
 const f=fixture(t),a=enroll(f);f.db.exec('BEGIN IMMEDIATE');
 assert.equal(f.admission.commitOutcome(a.cap,a.claim,outcome).code,'writer_terminal_reverse_transaction');f.db.exec('ROLLBACK');
 assert.equal(f.admission.commitOutcome(a.cap,a.claim,outcome).code,'writer_terminal_capability_invalid');
 const other=fixture(t),b=enroll(other),blocker=new Database(other.path,{timeout:0});blocker.exec('BEGIN IMMEDIATE');
 const before=facts(other);assert.equal(other.admission.commitOutcome(b.cap,b.claim,outcome).code,'writer_terminal_busy');
 assert.deepEqual(facts(other),before);blocker.exec('ROLLBACK');blocker.close();
});

test('preCOMMIT rollback, failed rollback, attempted COMMIT and postCOMMIT throw retain exact three-state facts',t=>{
 for(const cut of ['rollback','rollback-failure','commit-before','commit-after']){
  const f=fixture(t),{cap,claim}=enroll(f),before=facts(f),exec=f.db.exec.bind(f.db);
  if(cut.startsWith('rollback'))f.db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE ON run BEGIN SELECT RAISE(ABORT,'fixture_terminal_reject'); END");
  f.db.exec=sql=>{if(cut==='rollback-failure'&&sql==='ROLLBACK')throw new Error('fixture rollback cut');
   if(cut==='commit-before'&&sql==='COMMIT')throw new Error('fixture commit cut');
   const r=exec(sql);if(cut==='commit-after'&&sql==='COMMIT')throw new Error('fixture postcommit cut');return r;};
  const r=f.admission.commitOutcome(cap,claim,outcome);f.db.exec=exec;
  assert.equal(r.kind,cut==='rollback'?'not_committed':'unknown');assert.equal(r.businessCommit,cut==='rollback'?'not_committed':'unknown');
  if(f.db.inTransaction)f.db.exec('ROLLBACK');
  if(cut==='commit-after')assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');else assert.deepEqual(facts(f),before);
  assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'writer_terminal_capability_invalid');
 }
});

test('business COMMIT returned then actual registry connection loss reports unknown/committed; no repeat',t=>{
 const f=fixture(t),{cap,claim}=enroll(f),exec=f.db.exec.bind(f.db);
 f.db.exec=sql=>{const value=exec(sql);if(sql==='COMMIT')f.writers.close();return value;};
 const result=f.admission.commitOutcome(cap,claim,outcome);f.db.exec=exec;
 assert.deepEqual(result,{kind:'unknown',businessCommit:'committed',code:'writer_terminal_registry_commit_unknown'});
 assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'failed');
 // Original open handle lost; a restarted registry retains unfinished task, never reconstructs old cap.
 const restarted=openWriters(f.root);assert.equal(restarted.inspect().tasks[0].outcome,null);
 const newAdmission=restarted.terminalAdmissionFor(f.worker,f.db,f.driver);assert.equal(newAdmission.commitOutcome(cap,claim,outcome).code,'writer_terminal_capability_invalid');restarted.close();
});

const bytes=path=>({size:statSync(path).size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
test('factory and registry physical gates reject foreign/memory/readonly/other handle and malformed scope',t=>{
 const f=fixture(t),other=fixture(t),before=facts(f),memory=new Database(':memory:'),sameFile=new Database(f.path),readonly=new Database(f.path,{readonly:true});
 try{
  for(const db of [memory,sameFile,readonly,other.db])assert.throws(()=>f.writers.terminalAdmissionFor(f.worker,db,f.driver),/writer_terminal_business_mismatch/);
  assert.throws(()=>f.writers.terminalAdmissionFor(f.worker,f.db,other.driver),/writer_terminal_business_mismatch/);
  assert.throws(()=>openTerminalDispatchDriver(':memory:'),/writer_terminal_business_mismatch/);
  assert.throws(()=>f.writers.terminalAdmissionFor({...f.worker,generationToken:'00000000-0000-4000-8000-000000000000'},f.db,f.driver),/writer_owner_lost/);
  assert.deepEqual(facts(f),before);
 }finally{memory.close();sameFile.close();readonly.close();}
});

test('business attachment, closed native handle, unsafe mode/hardlink/symlink/pathswap and marker never retry',t=>{
 for(const fault of ['attached','mode','hardlink','symlink','swap','marker','closed']){
  const f=fixture(t),{cap,claim}=enroll(f);
  if(fault==='attached')f.db.exec("ATTACH ':memory:' AS foreign_db");
  if(fault==='mode')chmodSync(f.path,0o644);
  if(fault==='hardlink')linkSync(f.path,join(f.root,'hardlink.sqlite'));
  if(fault==='symlink'){renameSync(f.path,f.path+'.saved');symlinkSync(f.path+'.saved',f.path);}
  if(fault==='swap'){renameSync(f.path,f.path+'.saved');copyFileSync(f.path+'.saved',f.path);chmodSync(f.path,0o600);}
  if(fault==='marker')writeFileSync(join(f.root,'isolation.json'),'{}');
  if(fault==='closed')f.driver.close();
  const r=f.admission.commitOutcome(cap,claim,outcome);assert.equal(r.kind,'not_committed');assert.equal(r.code,'writer_terminal_business_mismatch');
  assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'writer_terminal_capability_invalid');
 }
});

test('actual SIGKILL unsafe business hot journal is rejected preSQL with original hashes; legal recovery rechecks lease',t=>{
 const f=fixture(t,{journalMode:'DELETE'}),{cap,claim}=enroll(f);
 const code=`import Database from 'better-sqlite3';const d=new Database(process.argv[1]);d.pragma('cache_size=1');d.exec('BEGIN IMMEDIATE');
  d.exec("UPDATE generation_dispatch SET state='alien'");const put=d.prepare("INSERT INTO run(id,kind,target,status,started_at)VALUES(?,'analyze','{}','running','2026-10-08T00:00:00.000Z')");
  for(let i=0;i<10000;i++)put.run('crash_'+i);process.kill(process.pid,'SIGKILL');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.path],{cwd:process.cwd(),env:{PATH:process.env.PATH},stdio:'pipe'});
 assert.equal(child.signal,'SIGKILL',child.stderr.toString());const journal=f.path+'-journal';assert.ok(statSync(journal).size>512);chmodSync(journal,0o644);
 const before={db:bytes(f.path),journal:bytes(journal)};
 assert.throws(()=>openTerminalDispatchDriver(f.root));assert.equal(f.admission.commitOutcome(cap,claim,outcome).kind,'not_committed');
 assert.deepEqual({db:bytes(f.path),journal:bytes(journal)},before);console.log('terminal-hot-journal-original',JSON.stringify(before));
 chmodSync(journal,0o600);const next=f.admission.admit();f.admission.bindClaim(next,{...claim,ownerToken:'invalid-owner'});
 // Legal recovery restores the original claimed row, then full actual lease guard rejects this different owner.
 assert.equal(f.admission.commitOutcome(next,{...claim,ownerToken:'invalid-owner'},outcome).code,'generation_fence_lost');
 assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,'claimed');
});

test('SIGKILL before and after actual business COMMIT keeps registry unfinished and facts unknown without remint',t=>{
 for(const cut of ['before','after']){
  const f=fixture(t),writersUrl=new URL('./writers.mjs',import.meta.url).href,driverUrl=new URL('../../src/lib/runtime/terminal-dispatch-driver.ts',import.meta.url).href,repoUrl=new URL('../../src/lib/db/provenance.ts',import.meta.url).href;
  const code=`import {register} from 'tsx/esm/api';register();import {openWriters} from ${JSON.stringify(writersUrl)};
   const {openTerminalDispatchDriver}=await import(${JSON.stringify(driverUrl)});const {claimNextGenerationDispatch}=await import(${JSON.stringify(repoUrl)});
   const w=openWriters(process.argv[1]),d=openTerminalDispatchDriver(process.argv[1]),a=w.terminalAdmissionFor(w.register('child-cut','generation-dispatch'),d.db,d),cap=a.admit(),claim=claimNextGenerationDispatch(d.db);a.bindClaim(cap,claim);
   const exec=d.db.exec.bind(d.db);d.db.exec=sql=>{if(sql==='COMMIT'&&process.argv[2]==='before')process.kill(process.pid,'SIGKILL');const r=exec(sql);if(sql==='COMMIT')process.kill(process.pid,'SIGKILL');return r;};
   a.commitOutcome(cap,claim,{status:'failed',error:{reason_code:'synthetic_failure',message:'synthetic_failure'}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.root,cut],{cwd:process.cwd(),env:{PATH:process.env.PATH},stdio:'pipe'});
  assert.equal(child.signal,'SIGKILL',child.stderr.toString());
  assert.equal(f.db.prepare('SELECT state FROM generation_dispatch').get().state,cut==='before'?'claimed':'failed');
  const view=f.writers.inspect();assert.equal(view.tasks[0].outcome,null);assert.equal(view.tasks[0].remote_subwork,'unknown');assert.equal(view.writer_quiescence,false);
  console.log('terminal-SIGKILL-cut',JSON.stringify({cut,dispatchState:cut==='before'?'claimed':'failed',taskOutcome:null,termination:'unknown'}));
 }
});

test('actual finish false in the fixed transaction is a guarded denial with confirmed rollback',t=>{
 const f=fixture(t),{cap,claim}=enroll(f),before=facts(f),prepare=f.db.prepare.bind(f.db);
 // Controlled native read fault: full JOIN guard still passes, then actual finish observes a missing claim.
 f.db.prepare=sql=>sql.startsWith('SELECT 1 FROM generation_dispatch WHERE')?{get:()=>undefined}:prepare(sql);
 const result=f.admission.commitOutcome(cap,claim,outcome);f.db.prepare=prepare;
 assert.deepEqual(result,{kind:'not_committed',businessCommit:'not_committed',code:'generation_fence_lost'});
 assert.deepEqual(facts(f),before);assert.equal(f.db.inTransaction,false);
 assert.equal(f.admission.commitOutcome(cap,claim,outcome).code,'writer_terminal_capability_invalid');
});
