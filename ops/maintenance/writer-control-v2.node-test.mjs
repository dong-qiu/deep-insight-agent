import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initialize } from './ledger.mjs';
import { initializeWritersV2, openWritersV2, openV2BusinessTarget } from './writers-v2.mjs';
import { inspectWritersV2, closeWritersV2 } from './writer-control-v2.mjs';
function fixture(t) {
  const parent = process.env.R3_V2_TEST_ROOT || tmpdir();mkdirSync(parent,{recursive:true,mode:0o700});const root = realpathSync(mkdtempSync(join(parent,'control-v2-')));chmodSync(root,0o700);
  const {publicKey}=generateKeyPairSync('ed25519');initialize(root,{target:{region:'isolated',instanceId:'fixture-writers-v2-node',volumeId:'fixture-writers-v2-volume',dataPath:root,serviceSet:['fixture-writers-v2']},approverId:'synthetic',publicKey:publicKey.export({type:'spki',format:'pem'})});initializeWritersV2(root);t.diagnostic(`preserved synthetic root ${root}`);return root;
}
const h='a'.repeat(64);
const scopes={
 'generation-dispatch':{kind:'dispatch',purpose:'usage',claim:{dispatchId:'dispatch',traceId:'trace',ownerToken:'owner',claimEpoch:1,fencingEpoch:1,rootRunId:'run'}},
 'source-collect':{kind:'source-prelude',sourceId:'source',triggerKind:'retry',scopeKey:'source_collect_retry:source:run',retryOfTraceId:'trace',retryOfRunId:'run',requestTimeIso:'2026-10-11T00:00:00.000Z'},
 startup:{kind:'startup',configHash:h,runtimeVersion:'synthetic',mode:'initialize-existing'},
 'local-seed':{kind:'local-seed',configHash:h,runtimeVersion:'synthetic',mode:'local-create'},
 'raw-recovery':{kind:'raw-recovery',effectId:'effect',idempotencyKey:'key',manifestHash:h,payloadHash:h},
 'report-recovery':{kind:'report-recovery',effectId:'effect',idempotencyKey:'key',manifestHash:h,payloadHash:h},
};
test('new real control sees all six entries in same registry; unsupported domains never create effects',t=>{
 const root=fixture(t),w=openWritersV2(root);t.after(()=>w.close());const ops=[];
 for(const [entry,scope]of Object.entries(scopes)){const worker=w.register(entry,entry),op=w.admit(worker,scope,new AbortController().signal);ops.push([entry,op]);if(!['startup','local-seed'].includes(entry)){assert.equal(openV2BusinessTarget(op).code,'unsupported_step');w.finish(op,'denied');}}
 const inventory=inspectWritersV2(root);assert.equal(inventory.workers.length,6);assert.equal(inventory.operations.length,6);assert.equal(inventory.steps.length,0);assert.equal(existsSync(join(root,'d2-business.sqlite')),false);
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import{closeWritersV2}from ${JSON.stringify(new URL('./writer-control-v2.mjs',import.meta.url).href)};console.log(JSON.stringify(closeWritersV2(${JSON.stringify(root)})));`],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.close_commit,'committed');assert.equal(result.inventory.workers.length,6);assert.equal(result.inventory.writer_quiescence,false);assert.equal(result.inventory.drain_ready,false);assert.equal(result.inventory.production_permitted,false);
 for(const [entry,op]of ops.filter(([entry])=>['startup','local-seed'].includes(entry))){assert.equal(openV2BusinessTarget(op).kind,'not_committed');w.finish(op,'denied');assert.throws(()=>w.register('new-'+entry,entry),/closed/);}
 assert.equal(existsSync(join(root,'d2-business.sqlite')),false);const repeat=closeWritersV2(root);assert.equal(repeat.close_commit,'not_committed');assert.equal(repeat.disposition,'observed_closed');const db=new Database(join(root,'writers.sqlite'));t.after(()=>db.close());assert.equal(db.prepare("SELECT count(*) n FROM audit_facts WHERE json_extract(fact_json,'$.kind')='closed'").get().n,1);assert.throws(()=>db.exec("UPDATE admission SET mode='open'"),/permanent/);
});
test('real close COMMIT then throw returns unknown, restart observes closed without retry COMMIT',t=>{
 const root=fixture(t),exec=Database.prototype.exec;let calls=0;
 t.mock.method(Database.prototype,'exec',function(sql){const out=exec.call(this,sql);if(this.name===join(root,'writers.sqlite')&&sql==='COMMIT'&&++calls===2)throw Error('synthetic_close_after_actual_commit');return out;});
 const result=closeWritersV2(root);assert.equal(result.close_commit,'unknown');assert.equal(result.writer_quiescence,false);assert.equal(inspectWritersV2(root).admission,'closed');assert.equal(closeWritersV2(root).disposition,'observed_closed');
});
