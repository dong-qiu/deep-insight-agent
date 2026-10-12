import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize } from '../../../ops/maintenance/ledger.mjs';
import { initializeWritersV2, openWritersV2 } from '../../../ops/maintenance/writers-v2.mjs';
import { closeWritersV2 } from '../../../ops/maintenance/writer-control-v2.mjs';
import { openV2Business } from './writer-admission-v2';
function fixture() {
 const parent=process.env.R3_V2_TEST_ROOT || tmpdir();mkdirSync(parent,{recursive:true,mode:0o700});const root=realpathSync(mkdtempSync(join(parent,'runtime-v2-')));chmodSync(root,0o700);const {publicKey}=generateKeyPairSync('ed25519');
 initialize(root,{target:{region:'isolated',instanceId:'fixture-writers-v2-node',volumeId:'fixture-writers-v2-volume',dataPath:root,serviceSet:['fixture-writers-v2']},approverId:'synthetic',publicKey:publicKey.export({type:'spki',format:'pem'})});initializeWritersV2(root);return root;
}
describe('fixed isolated runtime pre-open',()=>{
 it.each(['startup','local-seed'] as const)('opens only empty business for %s and retains private original cap',entry=>{
  const root=fixture(),w=openWritersV2(root);
  try{const worker=w.register(entry,entry),op=w.admit(worker,entry==='startup'?{kind:entry,configHash:'a'.repeat(64),runtimeVersion:'synthetic',mode:'initialize-existing'}:{kind:entry,configHash:'a'.repeat(64),runtimeVersion:'synthetic',mode:'local-create'},new AbortController().signal);
   const result=openV2Business(op);expect(result.kind).toBe('committed');if(result.kind!=='committed')throw Error('expected fixed open');expect(result.target.db.inTransaction).toBe(false);expect(result.target.db.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);result.target.close();w.finish(op,'completed');expect(w.inspect().production_permitted).toBe(false);
  }finally{w.close();}
 });
 it('same-registry permanent close blocks original runtime operation',()=>{
  const root=fixture(),w=openWritersV2(root);
  try{const worker=w.register('startup','startup'),op=w.admit(worker,{kind:'startup',configHash:'a'.repeat(64),runtimeVersion:'synthetic',mode:'initialize-existing'},new AbortController().signal);closeWritersV2(root);expect(openV2Business(op).kind).toBe('not_committed');expect(w.inspect().bindings).toEqual([]);}finally{w.close();}
 });
});
