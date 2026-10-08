/** New isolated sidecar only. No business initialization, callbacks, transport or readiness. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, fstatSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { canonical, check, hash, same, markerSchema, parse } from './contract.mjs';
import { openWriters } from './writers.mjs';
export const STAGED_APP_ID = 0x41335434;
export const STAGED_VERSION = 'a3-staged-terminal-v1';
export const STAGED_PROFILE = 'cooperative-close-then-revoke-terminal';
export const revokeReasons = Object.freeze(['writer_drain_timeout', 'writer_drain_cancelled', 'cancelled', 'task_deadline_exceeded', 'generation_fence_lost', 'writer_drain_coverage_unknown', 'writer_drain_observation_failed', 'staged_terminal_manual_block']);
const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const physical = z.strictObject({ businessPath: z.string(), businessDev: safeInt, businessIno: safeInt, registryDev: safeInt, registryIno: safeInt });
export const stagedMarkerSchema = physical.extend({ schema: z.literal('a3-staged-terminal-isolation-v1'), stageId: z.uuid(), stageInitId: z.uuid(), s0Marker: markerSchema, s0MarkerSha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal(STAGED_VERSION), profile: z.literal(STAGED_PROFILE), entryPoint: z.literal('generation-dispatch') });
export const stagedObjects = {
 identity: 'CREATE TABLE identity (marker TEXT NOT NULL)',
 stage: "CREATE TABLE stage (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, epoch INTEGER NOT NULL, worker_id TEXT, generation_token TEXT, admission TEXT NOT NULL CHECK(admission IN ('open','closed')), terminal TEXT NOT NULL CHECK(terminal IN ('live','revoked')), revoke_reason TEXT, drain_record TEXT, revoke_record TEXT)",
 tasks: 'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, generation_token TEXT NOT NULL, epoch INTEGER NOT NULL)',
 claims: 'CREATE TABLE claims (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), dispatch_id TEXT NOT NULL, trace_id TEXT NOT NULL, owner_token TEXT NOT NULL, claim_epoch INTEGER NOT NULL, fencing_epoch INTEGER NOT NULL, root_run_id TEXT NOT NULL, UNIQUE(dispatch_id,trace_id,owner_token,claim_epoch,fencing_epoch,root_run_id))',
 attempts: 'CREATE TABLE attempts (task_id TEXT PRIMARY KEY REFERENCES claims(task_id), attempt_id TEXT UNIQUE NOT NULL)',
 attempt_outcomes: 'CREATE TABLE attempt_outcomes (task_id TEXT PRIMARY KEY REFERENCES attempts(task_id), result TEXT NOT NULL)',
 completions: 'CREATE TABLE completions (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), outcome TEXT NOT NULL)',
 events: 'CREATE TABLE events (seq INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL)',
};
for (const table of ['identity','tasks','claims','attempts','attempt_outcomes','completions','events']) for (const action of ['UPDATE','DELETE']) stagedObjects[`${table}_no_${action.toLowerCase()}`] = `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'staged_facts_append_only'); END`;
stagedObjects.stage_no_delete = "CREATE TRIGGER stage_no_delete BEFORE DELETE ON stage BEGIN SELECT RAISE(ABORT, 'staged_state_permanent'); END";
stagedObjects.stage_permanent = "CREATE TRIGGER stage_permanent BEFORE UPDATE ON stage WHEN (OLD.admission='closed' AND NEW.admission!='closed') OR (OLD.terminal='revoked' AND NEW.terminal!='revoked') OR (OLD.epoch=1 AND (NEW.epoch!=1 OR NEW.worker_id IS NOT OLD.worker_id OR NEW.generation_token IS NOT OLD.generation_token)) OR (OLD.drain_record IS NOT NULL AND NEW.drain_record IS NOT OLD.drain_record) OR (OLD.revoke_record IS NOT NULL AND NEW.revoke_record IS NOT OLD.revoke_record) OR (OLD.revoke_reason IS NOT NULL AND NEW.revoke_reason IS NOT OLD.revoke_reason) BEGIN SELECT RAISE(ABORT, 'staged_state_permanent'); END";
Object.freeze(stagedObjects);
export function stagedSafe(path, directory = false) {
 const s=lstatSync(path); check((directory?s.isDirectory():s.isFile())&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===(directory?0o700:0o600)&&(directory||s.nlink===1),'unsafe_staged_path');return s;
}
export function stagedRoot(root) { check(isAbsolute(root)&&realpathSync(root)===root,'staged_terminal_business_mismatch');stagedSafe(root,true); }
export function stagedJournals(path) { for(const suffix of ['-journal','-wal','-shm'])try{stagedSafe(path+suffix);check(suffix==='-journal','unexpected_staged_sidecar');}catch(e){if(e.code!=='ENOENT')throw e;} }
function readOrdinary(path) { const st=stagedSafe(path);check(st.size<=16384,'staged_marker_too_large');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);check(s.dev===st.dev&&s.ino===st.ino&&s.nlink===1&&(s.mode&0o777)===0o600&&s.uid===process.getuid(),'unsafe_staged_path');const b=readFileSync(fd);check(Buffer.from(b.toString('utf8'),'utf8').equals(b),'staged_marker_changed');return b.toString('utf8');}finally{closeSync(fd);} }
export function stagedPreflight(root, expected) {
 stagedRoot(root);const dir=join(root,'staged-terminal-v1');check(realpathSync(dir)===dir,'staged_marker_changed');stagedSafe(dir,true);
 const raw=readOrdinary(join(dir,'stage-isolation.json')),marker=parse(stagedMarkerSchema,JSON.parse(raw));check(raw===canonical(marker)&&marker.s0Marker.target.dataPath===root&&marker.businessPath===join(root,'fixture-business.sqlite')&&marker.s0MarkerSha256===hash(canonical(marker.s0Marker)),'staged_marker_changed');
 check(same(marker.s0Marker,parse(markerSchema,JSON.parse(readOrdinary(join(root,'isolation.json'))))),'staged_marker_changed');
 const registry=stagedSafe(join(root,'writers.sqlite')),business=stagedSafe(marker.businessPath);check(realpathSync(marker.businessPath)===marker.businessPath&&registry.dev===marker.registryDev&&registry.ino===marker.registryIno&&business.dev===marker.businessDev&&business.ino===marker.businessIno,'staged_marker_changed');
 stagedJournals(join(root,'writers.sqlite'));stagedJournals(join(dir,'gate.sqlite'));const gate=stagedSafe(join(dir,'gate.sqlite'));
 for(const suffix of ['-journal','-wal','-shm'])try{stagedSafe(marker.businessPath+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(expected)check(same(marker,expected.marker)&&gate.dev===expected.dev&&gate.ino===expected.ino,'staged_marker_changed');return {marker,dev:gate.dev,ino:gate.ino,path:join(dir,'gate.sqlite')};
}
const denyCodes=new Set(['writer_terminal_closed','writer_terminal_capability_invalid','writer_terminal_business_mismatch','writer_terminal_reverse_transaction','writer_terminal_busy','writer_terminal_claim_mismatch','generation_fence_lost','writer_terminal_commit_failed','staged_terminal_capability_invalid','staged_terminal_claim_mismatch','staged_terminal_business_mismatch','staged_terminal_owner_lost','staged_terminal_closed','staged_terminal_revoked','staged_terminal_busy']);
const unknownCodes=new Set(['writer_terminal_business_commit_unknown','writer_terminal_registry_commit_unknown','staged_terminal_reservation_unknown','staged_terminal_gate_commit_unknown']);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const heldToken=z.strictObject({operationId:id,ownerId:id,fence:safeInt.min(1),revision:safeInt,target:markerSchema.shape.target,executionIdentity:z.string().regex(/^fixture-/)});
const stableBinding=heldToken.omit({revision:true}).extend({kind:z.enum(['deploy','backup','restore']),state:z.literal('pre_submit'),submitToken:z.null(),requestHash:z.null(),commandId:z.null()});
const stageOwner=z.strictObject({stageId:z.uuid(),stageInitId:z.uuid(),workerId:id,generationToken:z.uuid(),epoch:z.literal(1)});
const source=physical.extend({root:z.string()});
const observation=z.strictObject({schema:z.literal('a3-staged-drain-record-v1'),heldToken,stableBinding,stageOwner,expectedStageRevision:safeInt,resultStageRevision:safeInt,source,sampledAt:safeInt,leaseSampleHash:digest,S0snapshotHash:digest,registrysnapshotHash:digest});
const revocation=observation.extend({schema:z.literal('a3-staged-revoke-record-v1'),drainRecordHash:digest,reason:z.enum(revokeReasons)});
/** Pure validation of fixed rows; the caller's native connections remain private. */
export function validateStagedRows(rows, marker) {
 const st=rows.stage;check(st&&st.id===1&&Number.isSafeInteger(st.revision)&&st.revision>=0&&[0,1].includes(st.epoch)&&['open','closed'].includes(st.admission)&&['live','revoked'].includes(st.terminal),'invalid_staged_state');
 if(st.epoch===0)check(st.worker_id===null&&st.generation_token===null&&rows.tasks.length===0&&st.drain_record===null&&st.revoke_record===null&&st.terminal==='live','invalid_staged_state');else{parse(id,st.worker_id);parse(z.uuid(),st.generation_token);}
 for(const t of rows.tasks){parse(z.uuid(),t.task_id);check(t.worker_id===st.worker_id&&t.generation_token===st.generation_token&&t.epoch===1,'invalid_staged_task');}
 for(const c of rows.claims){for(const k of ['dispatch_id','trace_id','owner_token','root_run_id'])check(typeof c[k]==='string'&&c[k].length>0,'invalid_staged_claim');for(const k of ['claim_epoch','fencing_epoch'])check(Number.isSafeInteger(c[k])&&c[k]>0,'invalid_staged_claim');}
 for(const a of rows.attempts)parse(z.uuid(),a.attempt_id);
 for(const c of rows.completions)check(['no_claim','done','failed','threw'].includes(c.outcome),'invalid_staged_completion');
 for(const o of rows.attempt_outcomes){const r=JSON.parse(o.result);check(o.result===canonical(r)&&same(Object.keys(r).sort(),r.kind==='committed'?['businessCommit','kind']:['businessCommit','code','kind'])&&['committed','not_committed','unknown'].includes(r.kind),'invalid_staged_outcome');check(r.kind==='committed'?r.businessCommit==='committed':r.kind==='not_committed'?r.businessCommit==='not_committed':['not_committed','committed','unknown'].includes(r.businessCommit),'invalid_staged_outcome');if(r.kind!=='committed')check((r.kind==='not_committed'?denyCodes:unknownCodes).has(r.code),'invalid_staged_outcome');}
 let drain=null,revoke=null;
 for(const [key,schema]of [['drain_record',observation],['revoke_record',revocation]])if(st[key]!==null){const r=parse(schema,JSON.parse(st[key]));check(canonical(r)===st[key]&&r.resultStageRevision===r.expectedStageRevision+1&&r.resultStageRevision<=st.revision&&same(r.stageOwner,{stageId:marker.stageId,stageInitId:marker.stageInitId,workerId:st.worker_id,generationToken:st.generation_token,epoch:1})&&same(r.source,{root:marker.s0Marker.target.dataPath,businessPath:marker.businessPath,businessDev:marker.businessDev,businessIno:marker.businessIno,registryDev:marker.registryDev,registryIno:marker.registryIno}),'invalid_staged_observation');check(same({...r.heldToken,revision:0},{operationId:r.stableBinding.operationId,ownerId:r.stableBinding.ownerId,fence:r.stableBinding.fence,revision:0,target:r.stableBinding.target,executionIdentity:r.stableBinding.executionIdentity}),'invalid_staged_observation');if(key==='drain_record')drain=r;else revoke=r;}
 if(st.terminal==='live')check(st.revoke_reason===null&&revoke===null,'invalid_staged_revocation');else check(st.admission==='closed'&&drain&&revoke&&st.revoke_reason===revoke.reason&&revoke.drainRecordHash===hash(canonical(drain))&&same(drain.stableBinding,revoke.stableBinding),'invalid_staged_revocation');
 return rows;
}
function syncDir(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function create(path,content,dir){const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);try{if(content!==undefined)writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}syncDir(dir);}
export function initializeStagedTerminal(root) {
 stagedRoot(root);const writers=openWriters(root);let view;try{view=writers.inspect();check(view.admission==='open','staged_terminal_closed');}finally{writers.close();}
 const businessPath=join(root,'fixture-business.sqlite'),business=stagedSafe(businessPath),registry=stagedSafe(join(root,'writers.sqlite'));check(realpathSync(businessPath)===businessPath,'staged_terminal_business_mismatch');
 for(const suffix of ['-journal','-wal','-shm'])try{stagedSafe(businessPath+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
 const businessDb=new Database(businessPath,{fileMustExist:true,readonly:true,timeout:0});try{const list=businessDb.prepare('PRAGMA database_list').all();check(list.length===1&&list[0].name==='main'&&list[0].file===businessPath,'staged_terminal_business_mismatch');for(const table of ['generation_dispatch','generation_lease','generation_trace','run'])businessDb.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();}finally{businessDb.close();}
 const dir=join(root,'staged-terminal-v1');mkdirSync(dir,{mode:0o700});syncDir(root);
 const marker={schema:'a3-staged-terminal-isolation-v1',stageId:randomUUID(),stageInitId:randomUUID(),s0Marker:view.marker,s0MarkerSha256:hash(canonical(view.marker)),version:STAGED_VERSION,profile:STAGED_PROFILE,entryPoint:'generation-dispatch',businessPath,businessDev:business.dev,businessIno:business.ino,registryDev:registry.dev,registryIno:registry.ino};
 create(join(dir,'stage-isolation.json'),canonical(marker),dir);create(join(dir,'gate.sqlite'),undefined,dir);stagedPreflight(root);const db=new Database(join(dir,'gate.sqlite'),{fileMustExist:true,timeout:0});
 try{db.pragma('journal_mode=DELETE');db.pragma('synchronous=FULL');db.pragma('foreign_keys=ON');db.transaction(()=>{for(const sql of Object.values(stagedObjects))db.exec(sql);db.pragma(`application_id=${STAGED_APP_ID}`);db.pragma('user_version=1');db.prepare('INSERT INTO identity VALUES (?)').run(canonical(marker));db.prepare("INSERT INTO stage VALUES (1,0,0,NULL,NULL,'open','live',NULL,NULL,NULL)").run();const rows={stage:db.prepare('SELECT * FROM stage').get(),tasks:[],claims:[],attempts:[],attempt_outcomes:[],completions:[]};const snapshot=canonical(rows);db.prepare('INSERT INTO events VALUES (1,?,?,?)').run('genesis',hash(`genesis\n${snapshot}`),snapshot);}).immediate();}finally{db.close();}syncDir(dir);
}
