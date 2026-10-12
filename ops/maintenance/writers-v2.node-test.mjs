import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { canonical, hash } from './contract.mjs';
import { initialize } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
import { initializeWritersV2, openWritersV2, openV2BusinessTarget } from './writers-v2.mjs';

function fixture(t, create = true) {
  const parent = process.env.R3_V2_TEST_ROOT || tmpdir(); mkdirSync(parent,{recursive:true,mode:0o700});
  const root = realpathSync(mkdtempSync(join(parent,'writers-v2-'))); chmodSync(root,0o700);
  const {publicKey} = generateKeyPairSync('ed25519');
  initialize(root,{target:{region:'isolated',instanceId:'fixture-writers-v2-node',volumeId:'fixture-writers-v2-volume',dataPath:root,serviceSet:['fixture-writers-v2']},approverId:'synthetic',publicKey:publicKey.export({type:'spki',format:'pem'})});
  if(create) initializeWritersV2(root);
  t.diagnostic(`preserved synthetic root ${root}`); return root;
}
function opened(t,root) { const w = openWritersV2(root); t.after(() => w.close()); return w; }
const scope = (kind = 'startup', configHash = 'a'.repeat(64)) => ({kind,configHash,runtimeVersion:'synthetic-v1',mode:kind === 'startup' ? 'initialize-existing' : 'local-create'});
function admitted(t,root,controller = new AbortController()) { const w = opened(t,root), worker = w.register('worker-'+randomUUID(),'startup'); return {w,worker,op:w.admit(worker,scope(),controller.signal),controller}; }
function rawDb(t,root) { const db = new Database(join(root,'writers.sqlite')); t.after(() => db.close()); return db; }
function alter(db,table,sql) { const triggers = db.prepare('SELECT name,sql FROM sqlite_master WHERE type=? AND tbl_name=?').all('trigger',table); for(const t of triggers) db.exec(`DROP TRIGGER ${t.name}`); db.exec(sql); for(const t of triggers) db.exec(t.sql); }
function childClose(root) { return spawnSync(process.execPath,['--input-type=module','-e',`import {closeWritersV2} from ${JSON.stringify(new URL('./writer-control-v2.mjs',import.meta.url).href)};console.log(JSON.stringify(closeWritersV2(${JSON.stringify(root)})));`],{encoding:'utf8',timeout:10000}); }

test('actual exact schema, private caps, required native signal and restart inventory',t => {
  const root = fixture(t), {w,worker,op} = admitted(t,root); const db = rawDb(t,root);
  const inventory = db.prepare('SELECT type,count(*) n FROM sqlite_master GROUP BY type').all(); assert.deepEqual(inventory,[{type:'index',n:12},{type:'table',n:10},{type:'trigger',n:20}]);
  assert.throws(() => w.admit({...worker},scope(),new AbortController().signal),/capability_invalid/);
  assert.throws(() => w.admit(worker,scope(),undefined),/signal_invalid/);
  assert.throws(() => w.admit(worker,scope(),{aborted:false}),/signal_invalid/);
  assert.throws(() => w.admit(worker,scope(),new Proxy(new AbortController().signal,{})),/signal_invalid/);
  const controller = new AbortController(); Object.defineProperty(controller.signal,'aborted',{get:() => {throw Error('caller getter must not run')}});
  const next = w.admit(worker,scope('startup','b'.repeat(64)),controller.signal); assert(next);
  assert.throws(() => w.admit(worker,scope(),new AbortController().signal),/scope_conflict/);
  const restart = opened(t,root); assert.throws(() => restart.finish(op,'denied'),/capability_invalid/);
  assert.throws(() => openV2BusinessTarget({...op}),/capability_invalid/);
  assert.equal(restart.inspect().operations.length,2); assert.equal(restart.inspect().writer_quiescence,false);
  w.finish(op,'denied'); w.finish(op,'denied'); assert.throws(() => w.finish(op,'completed'),/terminal_conflict/);
});

test('accessors, proxies, excess scope fields and pre-cancelled signal are rejected without operation SQL',t => {
  const root = fixture(t), w = opened(t,root), worker = w.register('scope','startup');
  let reads = 0; const accessor = {...scope()};Object.defineProperty(accessor,'configHash',{enumerable:true,get(){reads++;return 'a'.repeat(64)}});
  for(const input of [accessor,new Proxy(scope(),{}),{...scope(),extra:true},scope('local-seed')]) assert.throws(() => w.admit(worker,input,new AbortController().signal));
  assert.equal(reads,0);const c = new AbortController();c.abort('first');assert.throws(() => w.admit(worker,scope(),c.signal),/cancelled/);assert.equal(w.inspect().operations.length,0);
});

test('fixed empty pre-open commits outer SQL and binds actual inode; existing open uses exact prior binding',t => {
  const root = fixture(t), {w,op} = admitted(t,root), result = openV2BusinessTarget(op);
  assert.equal(result.kind,'committed');assert.equal(result.businessCommit,'committed');assert.equal(result.target.db.inTransaction,false);
  assert.deepEqual(result.target.db.prepare('SELECT name FROM sqlite_master').all(),[]);
  assert.deepEqual(result.filesystem.map(e => e.action),['create','open','configure']);const inode = statSync(join(root,'d2-business.sqlite')).ino;
  result.target.close(); w.finish(op,'completed');assert.equal(w.inspect().bindings.length,1);assert.equal(w.inspect().operations[0].terminal.first_reason,'v2_preopen_only');
  assert.equal(openV2BusinessTarget(op).code,'v2_capability_consumed');
  const second = admitted(t,root), existing = openV2BusinessTarget(second.op);assert.equal(existing.kind,'committed');assert.equal(statSync(join(root,'d2-business.sqlite')).ino,inode);assert.equal(JSON.parse(second.w.inspect().bindings[1].identity_json).creation,'existing');existing.target.close();
});

test('close wins after reservation COMMIT: real child control inventories unACK step and zero business open',t => {
  const root = fixture(t), {w,op} = admitted(t,root);const exec = Database.prototype.exec;let first = true, child;
  t.mock.method(Database.prototype,'exec',function(sql){ const out = exec.call(this,sql);if(first && this.name === join(root,'writers.sqlite') && sql === 'COMMIT'){first=false;child=childClose(root);}return out; });
  const result = openV2BusinessTarget(op);assert.equal(child.status,0,child.stderr);const close = JSON.parse(child.stdout);assert.equal(close.close_commit,'committed');assert.equal(close.inventory.steps[0].observed,'unknown');assert.equal(close.inventory.steps[0].result,null);
  assert.equal(result.kind,'not_committed');assert.equal(result.code,'v2_admission_closed');assert.equal(existsSync(join(root,'d2-business.sqlite')),false);assert.equal(w.inspect().admission,'closed');w.finish(op,'denied');
});

test('consumer wins: child close contends while registry held; late signal cannot rewrite committed SQL',t => {
  const root = fixture(t), {w,op,controller} = admitted(t,root);const exec = Database.prototype.exec;let child, once=true;
  t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(once && this.name === join(root,'d2-business.sqlite') && sql === 'COMMIT'){once=false;child=childClose(root);controller.abort('late');}return out;});
  const result = openV2BusinessTarget(op);assert.equal(result.kind,'committed');assert.equal(result.businessCommit,'committed');assert.notEqual(child.status,0);assert.match(child.stderr,/locked/);result.target.close();w.finish(op,'completed');assert.equal(w.inspect().operations[0].terminal.first_reason,'v2_cancelled');assert.equal(childClose(root).status,0);
});

test('cancel after durable reservation has ACK cancelled result and zero filesystem effects',t => {
  const root = fixture(t), {w,op,controller} = admitted(t,root);const exec = Database.prototype.exec;let once=true;
  t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(once && this.name === join(root,'writers.sqlite') && sql === 'COMMIT'){once=false;controller.abort('after-reservation');}return out;});
  const result = openV2BusinessTarget(op);assert.equal(result.kind,'not_committed');assert.equal(result.businessCommit,'not_applicable');assert.deepEqual(result.filesystem,[]);assert.equal(existsSync(join(root,'d2-business.sqlite')),false);assert.equal(w.inspect().steps[0].result.disposition,'cancelled');w.finish(op,'cancelled');
});

test('cancel after actual create preserves inode and occurred effect; no ordinary reopen of unbound residue',t => {
  const root = fixture(t), {w,op,controller} = admitted(t,root);const pragma = Database.prototype.pragma;let once=true;
  t.mock.method(Database.prototype,'pragma',function(sql,...args){if(once && this.name === join(root,'d2-business.sqlite')){once=false;controller.abort('created');}return pragma.call(this,sql,...args);});
  const result = openV2BusinessTarget(op);assert.equal(result.kind,'not_committed');assert(result.filesystem.some(e => e.action === 'create' && e.outcome === 'occurred'));assert.equal(existsSync(join(root,'d2-business.sqlite')),true);w.finish(op,'cancelled');const next=admitted(t,root);assert.equal(openV2BusinessTarget(next.op).code,'v2_business_unbound');
});

for(const failure of ['reservation','business','ack']) test(`real COMMIT then throw: ${failure} remains unknown with actual facts retained`,t => {
  const root=fixture(t),{w,op}=admitted(t,root),exec=Database.prototype.exec;let registryCommits=0,thrown=false;
  t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(sql === 'COMMIT'){if(this.name===join(root,'writers.sqlite'))registryCommits++;const chosen=failure==='business'?this.name===join(root,'d2-business.sqlite'):this.name===join(root,'writers.sqlite') && registryCommits===(failure==='reservation'?1:2);if(chosen&&!thrown){thrown=true;throw Error('synthetic_after_actual_commit');}}return out;});
  const result=openV2BusinessTarget(op);assert.equal(result.kind,'unknown');assert.equal(result.businessCommit,failure==='reservation'?'not_committed':failure==='business'?'unknown':'committed');assert.equal(existsSync(join(root,'d2-business.sqlite')),failure!=='reservation');assert.equal(openV2BusinessTarget(op).code,'v2_capability_consumed');
  const facts=w.inspect();assert.equal(facts.steps.length,1);if(failure==='reservation'){assert.equal(facts.steps[0].observed,'unknown');assert.equal(facts.bindings.length,0);assert.throws(()=>w.finish(op,'completed'),/unknown_terminal/);w.finish(op,'interrupted_unknown');}else if(failure==='business'){assert.equal(facts.steps[0].result.business_commit,'unknown');assert.equal(facts.bindings.length,0);}else{assert.equal(facts.steps[0].result.business_commit,'committed');assert.equal(facts.bindings.length,1);}
});

test('before COMMIT throw proves no new business commit but FS creation is retained',t=>{
  const root=fixture(t),{w,op}=admitted(t,root),exec=Database.prototype.exec;let once=true;
  t.mock.method(Database.prototype,'exec',function(sql){if(once&&this.name===join(root,'d2-business.sqlite')&&sql==='BEGIN IMMEDIATE'){once=false;throw Error('synthetic_before_begin');}return exec.call(this,sql);});
  const result=openV2BusinessTarget(op);assert.equal(result.kind,'not_committed');assert.equal(result.businessCommit,'not_applicable');assert.equal(existsSync(join(root,'d2-business.sqlite')),true);assert.equal(w.inspect().bindings.length,0);
});

for(const corruption of ['extra-object','version','unaudited-worker','row-mismatch','binding-mismatch','closed-mismatch','correct-chain-orphan']) test(`exact physical/row/fact validation rejects ${corruption}`,t=>{
  const root=fixture(t),{op}=admitted(t,root);if(corruption==='binding-mismatch'){const result=openV2BusinessTarget(op);result.target.close();}
  const db=rawDb(t,root);
  if(corruption==='extra-object')db.exec('CREATE TABLE extra (x)');
  if(corruption==='version')db.pragma('user_version = 1');
  if(corruption==='unaudited-worker')db.prepare('INSERT INTO workers VALUES (?,?,?)').run('orphan',randomUUID(),'startup');
  if(corruption==='row-mismatch')alter(db,'workers',"UPDATE workers SET entry_point='local-seed'");
  if(corruption==='binding-mismatch')alter(db,'bindings',"UPDATE bindings SET identity_json='{}'");
  if(corruption==='closed-mismatch')db.exec("UPDATE admission SET mode='closed'");
  if(corruption==='correct-chain-orphan'){const previous=db.prepare('SELECT seq,hash FROM audit_facts ORDER BY seq DESC LIMIT 1').get();const seq=previous.seq+1,previousHash=previous.hash,fact={kind:'registered',workerId:'not-in-rows',generationToken:randomUUID(),entryPoint:'startup'};db.prepare('INSERT INTO audit_facts VALUES(?,?,?,?)').run(seq,previousHash,hash(canonical({seq,previousHash,fact})),canonical(fact));}
  assert.throws(()=>openWritersV2(root),/v2_/);
});

test('marker aliases, hardlinks, registry replacement and S0 generation replacement reject',t=>{
  const root=fixture(t),{w,op}=admitted(t,root);const alias=root+'-alias';symlinkSync(root,alias);assert.throws(()=>openWritersV2(alias),/noncanonical/);
  linkSync(join(root,'writers-isolation.json'),join(root,'marker-link'));assert.throws(()=>w.inspect(),/unsafe/);assert.equal(openV2BusinessTarget(op).kind,'not_committed');assert.equal(existsSync(join(root,'d2-business.sqlite')),false);
  const other=fixture(t);renameSync(join(other,'writers.sqlite'),join(other,'old-writers.sqlite'));writeFileSync(join(other,'writers.sqlite'),'');chmodSync(join(other,'writers.sqlite'),0o600);assert.throws(()=>openWritersV2(other),/generation/);
  const third=fixture(t);const marker=JSON.parse(readFileSync(join(third,'isolation.json'),'utf8'));marker.initId=randomUUID();writeFileSync(join(third,'isolation.json'),canonical(marker));assert.throws(()=>openWritersV2(third));
});

test('v1/v2 mixed initialization and interrupted O_EXCL residues never repair or fallback',t=>{
  const one=fixture(t,false);initializeWriters(one);assert.throws(()=>initializeWritersV2(one),/root_not_empty/);assert.throws(()=>openWritersV2(one));
  const two=fixture(t);assert.throws(()=>initializeWriters(two),/EEXIST/);assert.throws(()=>openWriters(two));
  const three=fixture(t,false);writeFileSync(join(three,'writers.sqlite'),'');chmodSync(join(three,'writers.sqlite'),0o600);assert.throws(()=>initializeWritersV2(three),/root_not_empty/);assert.throws(()=>openWritersV2(three));assert.equal(statSync(join(three,'writers.sqlite')).size,0);
});

test('ACK before actual COMMIT failure preserves confirmed business COMMIT and durable unACK inventory',t=>{
 const root=fixture(t),{w,op}=admitted(t,root),exec=Database.prototype.exec;let commits=0;
 t.mock.method(Database.prototype,'exec',function(sql){if(this.name===join(root,'writers.sqlite')&&sql==='COMMIT'&&++commits===2)throw Error('synthetic_ack_before_actual_commit');return exec.call(this,sql);});
 const result=openV2BusinessTarget(op);assert.equal(result.kind,'unknown');assert.equal(result.businessCommit,'committed');assert.equal(result.coordination,'unknown');assert.equal(existsSync(join(root,'d2-business.sqlite')),true);const inventory=w.inspect();assert.equal(inventory.steps[0].result,null);assert.equal(inventory.steps[0].observed,'unknown');assert.equal(inventory.bindings.length,0);assert.throws(()=>w.finish(op,'completed'),/unknown_terminal/);w.finish(op,'interrupted_unknown');const other=admitted(t,root);assert.equal(openV2BusinessTarget(other.op).code,'v2_business_unbound');
});

test('SIGKILL during real initialization leaves exclusive marker/registry residue and cannot retry',t=>{
 const root=fixture(t,false);const child=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';import{initializeWritersV2}from ${JSON.stringify(new URL('./writers-v2.mjs',import.meta.url).href)};const exec=Database.prototype.exec;Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql.startsWith('CREATE TABLE steps'))process.kill(process.pid,'SIGKILL');return result;};initializeWritersV2(${JSON.stringify(root)});`],{encoding:'utf8',timeout:10000,cwd:process.cwd()});
 assert.equal(child.signal,'SIGKILL');assert.equal(existsSync(join(root,'writers.sqlite')),true);assert.equal(existsSync(join(root,'writers-isolation.json')),true);assert.throws(()=>initializeWritersV2(root),/root_not_empty/);assert.throws(()=>openWritersV2(root));
});

test('SIGKILL after durable reservation is observed unknown after restart and SQL facts do not recreate cap',t=>{
 const root=fixture(t);const child=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';import{openWritersV2,openV2BusinessTarget}from ${JSON.stringify(new URL('./writers-v2.mjs',import.meta.url).href)};const w=openWritersV2(${JSON.stringify(root)});const op=w.admit(w.register('child','startup'),${JSON.stringify(scope())},new AbortController().signal);const exec=Database.prototype.exec;let once=true;Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(once&&this.name===${JSON.stringify(join(root,'writers.sqlite'))}&&sql==='COMMIT'){once=false;process.kill(process.pid,'SIGKILL');}return result;};openV2BusinessTarget(op);`],{encoding:'utf8',timeout:10000,cwd:process.cwd()});
 assert.equal(child.signal,'SIGKILL');const w=opened(t,root),inventory=w.inspect();assert.equal(inventory.steps[0].observed,'unknown');assert.equal(existsSync(join(root,'d2-business.sqlite')),false);assert.throws(()=>openV2BusinessTarget(inventory.operations[0]),/capability_invalid/);assert.equal(childClose(root).status,0);assert.equal(w.inspect().steps[0].observed,'unknown');
});

test('pre-open rejects linked target and unexpected SQLite sidecars before constructor effects',t=>{
 const root=fixture(t),{w,op}=admitted(t,root);const unrelated=join(root,'unrelated');writeFileSync(unrelated,'');chmodSync(unrelated,0o600);symlinkSync(unrelated,join(root,'d2-business.sqlite'));const result=openV2BusinessTarget(op);assert.equal(result.kind,'not_committed');assert.deepEqual(result.filesystem,[]);assert.equal(w.inspect().bindings.length,0);
 const other=fixture(t);writeFileSync(join(other,'writers.sqlite-wal'),'');chmodSync(join(other,'writers.sqlite-wal'),0o600);assert.throws(()=>openWritersV2(other),/sidecar/);
});

for(const failure of ['file-fsync','directory-fsync']) test(`O_EXCL success before ${failure} failure retains occurred create in returned and durable FS facts`,t=>{
 const root=fixture(t),{w,op}=admitted(t,root),path=join(root,'d2-business.sqlite'),fsync=fs.fsyncSync;let injected=false;
 fs.fsyncSync=function(fd){const out=fsync(fd);if(!injected&&existsSync(path)){const info=fs.fstatSync(fd);if((failure==='file-fsync'&&info.ino===statSync(path).ino)||(failure==='directory-fsync'&&info.isDirectory()&&info.ino===statSync(root).ino)){injected=true;throw Error('synthetic_after_durable_create');}}return out;};syncBuiltinESMExports();
 let result;try{result=openV2BusinessTarget(op);}finally{fs.fsyncSync=fsync;syncBuiltinESMExports();}
 assert(injected);assert.equal(result.kind,'not_committed');assert.equal(existsSync(path),true);assert(result.filesystem.some(e=>e.action==='create'&&e.outcome==='occurred'));const inventory=w.inspect();assert.deepEqual(JSON.parse(inventory.steps[0].result.filesystem_json),result.filesystem);assert.equal(inventory.bindings.length,0);
});

for(const alteration of ['replace','missing','link','mode']) test(`bound physical target ${alteration} rejects original inspect, fresh open and actual control close`,t=>{
 const root=fixture(t),{w,op}=admitted(t,root),result=openV2BusinessTarget(op);result.target.close();const path=join(root,'d2-business.sqlite');
 if(alteration==='mode')chmodSync(path,0o644);else{renameSync(path,join(root,'preserved-business.sqlite'));if(alteration==='replace'){writeFileSync(path,'');chmodSync(path,0o600);}else if(alteration==='link')symlinkSync(join(root,'preserved-business.sqlite'),path);}
 assert.throws(()=>w.inspect());assert.throws(()=>openWritersV2(root));const child=childClose(root);assert.notEqual(child.status,0);const db=rawDb(t,root);assert.equal(db.prepare('SELECT mode FROM admission').get().mode,'open');
});

function replaceAudit(db,facts){const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_facts'").all();for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);db.exec('DELETE FROM audit_facts');let previousHash='0'.repeat(64);for(const [i,fact]of facts.entries()){const seq=i+1,h=hash(canonical({seq,previousHash,fact}));db.prepare('INSERT INTO audit_facts VALUES (?,?,?,?)').run(seq,previousHash,h,canonical(fact));previousHash=h;}for(const trigger of triggers)db.exec(trigger.sql);}
for(const illegal of ['unknown-denied','unknown-cancelled','result-after-terminal']) test(`correct full rows and hash chain reject illegal audit state ${illegal}`,t=>{
 const root=fixture(t),{w,op}=admitted(t,root);if(illegal==='result-after-terminal'){const result=openV2BusinessTarget(op);result.target.close();w.finish(op,'denied');}else{const exec=Database.prototype.exec;let once=true;t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(once&&this.name===join(root,'writers.sqlite')&&sql==='COMMIT'){once=false;throw Error('synthetic_reservation_unknown');}return out;});assert.equal(openV2BusinessTarget(op).kind,'unknown');w.finish(op,'interrupted_unknown');}
 w.close();const db=rawDb(t,root),facts=db.prepare('SELECT fact_json FROM audit_facts ORDER BY seq').all().map(r=>JSON.parse(r.fact_json));if(illegal==='result-after-terminal'){const result=facts.splice(facts.findIndex(f=>f.kind==='step_result'),1)[0];facts.push(result);}else{const outcome=illegal==='unknown-denied'?'denied':'cancelled';alter(db,'terminals',`UPDATE terminals SET outcome='${outcome}'`);facts.find(f=>f.kind==='terminal').outcome=outcome;}replaceAudit(db,facts);assert.throws(()=>openWritersV2(root),/v2_(unknown_terminal|invalid_result)/);
});

test('known local business transaction cannot acquire registry or S0, including through a fresh control handle',t=>{
 const root=fixture(t),{w,op}=admitted(t,root),result=openV2BusinessTarget(op);result.target.db.exec('BEGIN IMMEDIATE');const exec=Database.prototype.exec;let coordinationBegins=0;
 t.mock.method(Database.prototype,'exec',function(sql){if(sql==='BEGIN IMMEDIATE'&&[join(root,'writers.sqlite'),join(root,'ledger.sqlite')].includes(this.name))coordinationBegins++;return exec.call(this,sql);});
 assert.throws(()=>w.inspect(),/reverse_business_transaction/);assert.throws(()=>w.register('reverse','startup'),/reverse_business_transaction/);assert.throws(()=>openWritersV2(root),/reverse_business_transaction/);assert.notEqual(childClose(root).status,null);assert.equal(coordinationBegins,0);result.target.db.exec('ROLLBACK');result.target.close();assert.equal(w.inspect().admission,'closed');
});

test('S0 real IMMEDIATE inspections end before business BEGIN; no S0 lock while business transaction is active',t=>{
 const root=fixture(t),{op}=admitted(t,root),exec=Database.prototype.exec,transaction=Database.prototype.transaction;let businessActive=false,businessBegins=0,s0DuringBusiness=0,s0Checks=0;
 t.mock.method(Database.prototype,'transaction',function(fn){const wrapped=transaction.call(this,fn);if(this.name!==join(root,'ledger.sqlite'))return wrapped;return {immediate:(...args)=>{s0Checks++;if(businessActive)s0DuringBusiness++;return wrapped.immediate(...args);}};});
 t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(this.name===join(root,'d2-business.sqlite')){if(sql==='BEGIN IMMEDIATE'){businessActive=true;businessBegins++;}if(['COMMIT','ROLLBACK'].includes(sql))businessActive=false;}return out;});
 const result=openV2BusinessTarget(op);assert.equal(result.kind,'committed');assert.equal(businessBegins,1);assert(s0Checks>0);assert.equal(s0DuringBusiness,0);result.target.close();
});
