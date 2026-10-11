import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';
import { initialize, openLedger } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
import { openDrainLeaseSource, observeDrain } from './drain.mjs';
import { consumeA2Isolated } from './a2-consumer.mjs';
import { canonical, bindingFor, hash, DOMAIN } from './contract.mjs';
register();
const { openDb } = await import('../../src/lib/db/index.ts');
const { applyProvenanceMigrations } = await import('../../src/lib/db/provenance-migrations.ts');
const { insertTopic, insertSource } = await import('../../src/lib/db/repos.ts');
const { createDeepDiveTraceRequest, claimNextGenerationDispatch, createSourceCollectTrace } = await import('../../src/lib/db/provenance.ts');
process.umask(0o077);
// Exact public compose bytes from the frozen security-policy identity; never executed.
const compose="# 自托管单实例编排（architecture「部署」）：app(Web/Job Runner) + cron(容器内调度) + 持久卷。\n# 用法：cp .env.example .env.local 并填好 ANTHROPIC_API_KEY / AUTH_SECRET / ADMIN_* / CRON_SECRET，\n#       然后 `docker compose up -d --build`。两服务复用同一镜像（tag 锁定，不用 latest）。\n#\n# 工程名 = compose 自动取的目录 basename（本文件不写死 name:）。各 worktree 目录不同 →\n#   容器名与数据卷 <工程名>_insight-data 默认天然隔离，零配置即可并行起多套、互不串库。\n# ⚠️ 权威/生产实例（拥有真数据）必须在自己目录的 .env 钉 COMPOSE_PROJECT_NAME=deep-insight，\n#   否则换目录跑会回落新工程名 → 挂到新空卷、孤立现有数据（见 .env.compose.example）。\n# 同时起多套时各 worktree 还需设 APP_PORT（端口不随目录自动分配，缺省 3000 会相互占用）。\n\nservices:\n  migrate:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: \"no\"\n    env_file: [.env.local]\n    volumes:\n      - insight-data:/data\n    command: [\"node\", \"/app/ops/run-provenance-migrations.mjs\"]\n    healthcheck:\n      disable: true\n\n  # Strict production boot appends the already-resolved OCI digest before the Web\n  # process is allowed to become a writer.  Development explicitly leaves the gate\n  # at 0, so no made-up local image identity enters the audit trail.\n  deployment-record:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: \"no\"\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n    env_file: [.env.local]\n    volumes:\n      - insight-data:/data\n    environment:\n      PROVENANCE_DEPLOYMENT_REQUIRED: ${PROVENANCE_DEPLOYMENT_REQUIRED:-0}\n      INSIGHT_IMAGE_DIGEST: ${INSIGHT_IMAGE_DIGEST:-}\n      GIT_SHA: ${GIT_SHA:-}\n      DEPLOY_ACTOR: ${DEPLOY_ACTOR:-compose}\n    command: [\"node\", \"/app/ops/record-deployment.mjs\"]\n    healthcheck:\n      disable: true\n\n  app:\n    build:\n      context: .\n      args:\n        # 本机构建用 host 架构；amd64/arm64 均有 supercronic 校验和（见 Dockerfile）\n        TARGETARCH: ${TARGETARCH:-amd64}\n    # 本地开发默认用同名本地镜像；生产发布由 INSIGHT_IMAGE 注入不可变 GHCR sha 标签。\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n      deployment-record:\n        condition: service_completed_successfully\n    env_file: [.env.local]\n    ports:\n      - \"${APP_PORT:-3000}:3000\"\n    volumes:\n      - insight-data:/data\n    environment:\n      # Do not allow env_file to turn a production service into a development\n      # runtime and bypass the P1 admission gate.\n      NODE_ENV: production\n      # 只有 migration ledger 已确认最新 provenance schema 后，Web 才可成为写者。\n      PROVENANCE_SCHEMA_REQUIRED: \"1\"\n      # Release workflow sets this to 1 only after resolving repo@sha256 and\n      # passing it through the deployment-record writer.\n      PROVENANCE_DEPLOYMENT_REQUIRED: ${PROVENANCE_DEPLOYMENT_REQUIRED:-0}\n      INSIGHT_IMAGE_DIGEST: ${INSIGHT_IMAGE_DIGEST:-}\n    # 运行镜像是 slim、无 curl（见 Dockerfile）——healthcheck 必须用 Node fetch，否则探针永远失败、\n    # app 永不 healthy、cron(depends_on service_healthy) 起不来。与 Dockerfile 的 HEALTHCHECK 一致。\n    healthcheck:\n      test: [\"CMD\", \"node\", \"--no-warnings\", \"-e\", \"fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 20s\n\n  cron:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      app:\n        condition: service_healthy\n    env_file: [.env.local]\n    # 挂同一持久卷：cron 内每日备份任务（ops/backup-db.mjs）要直接读 /data/insight.db\n    # 并把备份写进 /data/backups。SQLite 在线备份 API 对 app 的并发写安全（WAL + 页级锁）。\n    volumes:\n      - insight-data:/data\n    environment:\n      # crontab 内 curl 的目标（容器网络内按服务名解析）\n      APP_URL: http://app:3000\n    command: [\"supercronic\", \"/app/ops/crontab\"]\n    # cron 跑 supercronic、非 Web 服务——禁用从镜像继承的 Web 健康探针（否则 fetch :3000 永远失败、误报 unhealthy）。\n    healthcheck:\n      disable: true\n\n  generation-dispatch-worker:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      app:\n        condition: service_healthy\n    env_file: [.env.local]\n    environment:\n      APP_URL: http://app:3000\n    command: [\"node\", \"/app/ops/generation-dispatch-worker.mjs\"]\n    # Give an in-flight request one 120s lease window to finish before Docker\n    # kills the worker.  Compose stops dependents before app, so app can keep\n    # heartbeating the current fenced claim during this drain.\n    stop_grace_period: 2m15s\n    healthcheck:\n      test: [\"CMD\", \"node\", \"--no-warnings\", \"/app/ops/generation-dispatch-healthcheck.mjs\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 30s\n\nvolumes:\n  insight-data:\n";
const policy=JSON.parse(fs.readFileSync(new URL('../aws/security-release-policy.json',import.meta.url),'utf8'));
const identity=Object.fromEntries(['repository','revision','platform','index_digest','manifest_digest','config_digest','compose_sha256'].map(k=>[k,policy[k]]));
const databases=['ledger.sqlite','writers.sqlite','fixture-business.sqlite','staged-terminal-v1/gate.sqlite'];
const markers=['isolation.json','writers-isolation.json','staged-terminal-v1/stage-isolation.json'];
const roles={schema:'schema.txt',migrations:'migrations.json',configuration:'configuration.json',data_sample:'data-sample.json',compose:'compose.yml',identity:'receipt-identity.json',security:'receipt-security.json',isolated_compatibility:'receipt-isolated-compatibility.json'};
const evidence=process.env.OWNED_DRAIN_TEST_EVIDENCE;
function privateDirectory(path){const s=fs.lstatSync(path);assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o700);assert.equal(s.uid,process.getuid());assert.equal(fs.realpathSync(path),path);}
function save(path,bytes){fs.writeFileSync(path,bytes,{flag:'wx',mode:0o600});assert.equal(hash(fs.readFileSync(path)),hash(bytes));assert.equal(fs.statSync(path).mode&0o777,0o600);}
// This always reads physical bytes before the following SQLite observation. Present and absent sidecars are explicit.
function capture(f,label){
 const files=[];let destination;
 if(evidence){privateDirectory(evidence);destination=join(evidence,f.label+'-'+label);fs.mkdirSync(destination,{mode:0o700});}
 privateDirectory(f.root);
 for(const relative of [...markers,...databases.flatMap(p=>[p,...['-journal','-wal','-shm'].map(s=>p+s)]),...[...Object.values(roles),'receipt-production-compatibility.json','receipt-approval.json'].map(p=>'../artifacts/'+p)]){
  const path=join(f.root,relative);let st;try{st=fs.lstatSync(path);}catch(e){if(e.code!=='ENOENT')throw e;files.push({relative,present:false});continue;}
  assert.ok(st.isFile()&&!st.isSymbolicLink(),relative);assert.equal(st.mode&0o777,0o600,relative);assert.equal(st.uid,process.getuid());assert.equal(st.nlink,1);
  const bytes=fs.readFileSync(path),record={relative,present:true,sourceMode:st.mode&0o777,uid:st.uid,nlink:st.nlink,dev:st.dev,ino:st.ino,size:bytes.length,sha256:hash(bytes)};
  if(destination){record.archive=join(destination,relative.replaceAll('../','').replaceAll('/','__')+'.bin');save(record.archive,bytes);}
  files.push(record);
 }
 const result={fixture:f.root,label,files};if(destination)save(join(destination,'inventory.json'),JSON.stringify(result,null,2)+'\n');return result;
}
const byteFacts=s=>s.files.filter(x=>databases.includes(x.relative)||x.relative.endsWith('-journal')||x.relative.endsWith('-wal')||x.relative.endsWith('-shm')).map(({relative,present,size,sha256})=>({relative,present,...(present?{size,sha256}:{})}));
function fixture(t,label){
 const parent=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'insight-a2-owned-drain-')));fs.chmodSync(parent,0o700);
 const root=join(parent,'maintenance'),artifactRoot=join(parent,'artifacts');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(artifactRoot,{mode:0o700});
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const target={region:'isolated',instanceId:'fixture-controller-node',volumeId:'fixture-controller-volume',dataPath:root,serviceSet:['fixture-controller']};
 initialize(root,{target,approverId:'fixture-reviewer',publicKey:publicKey.export({type:'spki',format:'pem'})});initializeWriters(root);
 const path=join(root,'fixture-business.sqlite'),seed=openDb(path);fs.chmodSync(path,0o600);applyProvenanceMigrations(seed);
 insertTopic(seed,{id:'integration-topic',name:'Synthetic',keywords:[],language:'en',brief_schedule:'daily',enabled:true,archetype:'deep_vertical',facets:[]});
 createDeepDiveTraceRequest(seed,{topicId:'integration-topic',idempotencyKeyHash:'a'.repeat(64),planning:true});seed.pragma('wal_checkpoint(TRUNCATE)');seed.pragma('journal_mode=DELETE');seed.close();
 const request={operationId:'op-'+label,ownerId:'fixture-owner',kind:'backup',target,executionIdentity:'fixture-controller-v1'};
 t.diagnostic('retained own fixture '+parent);return {parent,root,artifactRoot,path,target,request,label,signingKey:privateKey};
}
function business(db,marker){return {schema:{schema_version:'a2-isolated-schema-sample-v1',scope:'synthetic',objects:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all()},migrations:{schema_version:'a2-isolated-migrations-sample-v1',scope:'synthetic',migrations:db.prepare('SELECT version,checksum FROM schema_migration ORDER BY version').all()},data_sample:{schema_version:'a2-isolated-dispatch-lease-sample-v1',scope:'synthetic',initId:marker.initId,target:marker.target,dispatches:db.prepare('SELECT id,trace_id,state,owner_token,claim_epoch,lease_expires_at FROM generation_dispatch ORDER BY id').all(),leases:db.prepare('SELECT id,trace_id,state,owner_token,fencing_epoch,expires_at,active_key,scope_key FROM generation_lease ORDER BY id').all()}};}
function fullBusiness(db){return ['generation_dispatch','generation_lease','run','generation_event'].map(table=>({table,rows:db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()}));}
function logical(f){const l=openLedger(f.root),w=openWriters(f.root),db=new Database(f.path,{readonly:true,fileMustExist:true});try{return {ledger:l.inspect(),writers:w.inspect(),business:fullBusiness(db)};}finally{db.close();w.close();l.close();}}
function record(f,label,value){if(evidence)save(join(evidence,f.label+'-'+label+'.json'),JSON.stringify(value,null,2)+'\n');}
function falsePerms(r){for(const k of ['production_permitted','drain_ready','writer_quiescence'])assert.equal(r[k],false,k);assert.equal(r.process_termination,'unknown');}
function artifacts(f,state,token,now){
 const input={schema_version:'a2-a3-isolated-consumer-v1',a2:{schema_version:'a2-a3-handoff-v1',phase:'before-writer-stop',context:{operation_id:token.operationId,maintenance_holder:token.ownerId,operator:'fixture-operator',release:identity},rollback:identity,evidence:{}},a3:{token,binding:bindingFor(state.operations[token.operationId])},artifacts:{}};
 const put=(role,value)=>{const bytes=Buffer.from(typeof value==='string'?value:canonical(value));save(join(f.artifactRoot,roles[role]),bytes);input.artifacts[role]={size:bytes.length,sha256:hash(bytes)};return hash(bytes);};
 const db=new Database(f.path,{readonly:true,fileMustExist:true});try{const facts=business(db,state.marker);assert.equal(facts.migrations.migrations.length,48);for(const role of ['schema','migrations','data_sample'])input.a2.context[role+'_sha256']=put(role,facts[role]);}finally{db.close();}
 input.a2.context.configuration_sha256=put('configuration',{schema_version:'a2-isolated-configuration-v1',scope:'synthetic',values:{fixture:'integration',port:3150}});assert.equal(hash(compose),policy.compose_sha256);put('compose',compose);
 const clauses={identity:['isolated-runner',['actual_pull','compose_binding']],security:['isolated-runner',['native_six','builder_source_map_magicast','runtime_source_map','auth_reader_contract']],isolated_compatibility:['synthetic',['pre_release','target_new_data','post_migration','rollback_read_update','no_data_loss']]};
 for(const [kind,[scope,checks]]of Object.entries(clauses)){const claim={scope,result:'not-run',issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),binding:{...input.a2.context,rollback:identity},checks:Object.fromEntries(checks.map(k=>[k,false]))};const receipt_sha256=put(kind,{schema_version:'a2-owner-private-receipt-declaration-v1',kind,claim});input.a2.evidence[kind]={...claim,receipt_sha256};}
 return input;
}

function acquired(t,label,{task=true,claimed=false}={}){const f=fixture(t,label),l=openLedger(f.root);const token=l.acquire(f.request),state=l.inspect();l.close();const w=openWriters(f.root);if(task)f.task=w.admit(w.register('owned-worker','generation-dispatch'));w.close();if(claimed){const db=new Database(f.path);try{claimNextGenerationDispatch(db);}finally{db.close();}}f.input={schema:'a2-a3-owned-drain-v1',consumer:artifacts(f,state,token,Date.now())};f.token=token;return f;}
function opts(f,extra={}){return {root:f.root,artifactRoot:f.artifactRoot,inputJson:JSON.stringify(f.input),deadlineAt:Date.now()+5000,pollEveryMs:10,...extra};}
function assertBlocked(r){falsePerms(r);assert.equal(r.approved_safe_rollback,null);assert.equal(r.observation_atomic,false);assert.equal(r.controller_uniqueness,'unknown');assert.equal(r.phase_verified,false);assert.equal(r.all_writer_coverage,false);assert.equal(r.commands_executed,false);}
// Original real path limitation, not a new-module import failure labelled behavior red.
test('original real acquired operation S2 replay cannot provide owned positive drain',async t=>{const f=acquired(t,'baseline'),before=capture(f,'before-old-s2');const source=openDrainLeaseSource(f.root,f.path);let result;try{result=await observeDrain({root:f.root,request:f.request,deadlineAt:Date.now()+1000,pollEveryMs:10,leaseSource:source});}finally{source.close();}assert.equal(result.reason,'writer_drain_replay');assert.equal(result.token,null);assert.equal(result.polls,0);assert.deepEqual(byteFacts(capture(f,'after-old-s2-before-sql')),byteFacts(before));record(f,'baseline-old-s2-result',result);});
const {consumeOwnedDrainIsolated}=await import('./owned-drain.mjs');
function rowsNow(f){const db=new Database(f.path,{readonly:true});try{return fullBusiness(db);}finally{db.close();}}
function ledgerNow(f){const l=openLedger(f.root);try{return l.inspect();}finally{l.close();}}
function writerNow(f){const w=openWriters(f.root);try{return w.inspect();}finally{w.close();}}
function countAudit(f){const db=new Database(join(f.root,'ledger.sqlite'),{readonly:true});try{return db.prepare('SELECT count(*) AS n FROM events').get().n;}finally{db.close();}}

// Private test processes only. Exit records status; close freezes all output.
function freezeNativeFacts(message,expected){
 assert.deepEqual(Object.keys(message).sort(),[...Object.keys(expected),'pid','firstReadyCount','firstReleaseObserved','secondReleaseObserved','initialBeginAttempts','initialBeginReturned','initialDatabaseBound','successfulInitialInserts','entryReadyCount','armPresent','readonlyCommitReturns','nonInitialWritableCommitReturns','rollbackReturns','nativeErrors','facilityErrors'].sort());
 for(const [key,value]of Object.entries(expected))assert.equal(message[key],value,key);
 for(const key of ['firstReadyCount','initialBeginAttempts','successfulInitialInserts','entryReadyCount','readonlyCommitReturns','nonInitialWritableCommitReturns','rollbackReturns'])assert.ok(Number.isSafeInteger(message[key])&&message[key]>=0,key);
 for(const key of ['firstReleaseObserved','secondReleaseObserved','initialBeginReturned','initialDatabaseBound','armPresent'])assert.equal(typeof message[key],'boolean',key);
 for(const key of ['nativeErrors','facilityErrors'])assert.ok(Array.isArray(message[key]),key);
 for(const error of message.nativeErrors){assert.deepEqual(Object.keys(error).sort(),['phase','database','readonly','initialDatabase','source','code','message'].sort());assert.equal(typeof error.readonly,'boolean');assert.equal(typeof error.initialDatabase,'boolean');for(const key of ['phase','database','source','message'])assert.equal(typeof error[key],'string');assert.ok(error.code===null||typeof error.code==='string');}
 for(const error of message.facilityErrors){assert.deepEqual(Object.keys(error).sort(),['phase','message'].sort());assert.equal(typeof error.phase,'string');assert.equal(typeof error.message,'string');}
 return Object.freeze({...message,nativeErrors:Object.freeze(message.nativeErrors.map(error=>Object.freeze({...error}))),facilityErrors:Object.freeze(message.facilityErrors.map(error=>Object.freeze({...error})))});
}
function spawnOwnedChild(children,args,{label,ready,entryReady,nativeFacts,readyMs=4000,watchdogMs=12000,executable=process.execPath}={}){
 const c=spawn(executable,args,{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},stdio:ready?['pipe','pipe','pipe','ipc']:['pipe','pipe','pipe']});
 const expectedReady=ready&&Object.freeze({...ready,pid:c.pid}),expectedEntry=entryReady&&Object.freeze({...entryReady,pid:c.pid}),expectedFacts=nativeFacts&&Object.freeze({...nativeFacts});
 let resolveClose,resolveFailure,resolveReady,resolveEntry;
 const state={child:c,label,phase:'spawned',closed:false,exit:null,failure:null,ready:false,cleaning:false,cleanupErrors:[],stdout:[],stderr:[],signals:[],events:['spawn'],
  entryReady:false,released1:false,released2:false,done:new Promise(resolve=>{resolveClose=resolve;}),failed:new Promise(resolve=>{resolveFailure=resolve;}),prepared:new Promise(resolve=>{resolveReady=resolve;}),entryPrepared:new Promise(resolve=>{resolveEntry=resolve;})};
 children.push(state);
 const fail=error=>{if(!state.cleaning&&!state.failure){state.failure=error;resolveFailure(error);}};
 const stream=(name,bytes)=>{if(!state.closed)state[name].push(Buffer.from(bytes));};
 c.on('error',error=>{if(state.cleaning)state.cleanupErrors.push(error);else fail(new Error('child process error: '+error.message,{cause:error}));});
 c.on('exit',(code,signal)=>{state.exit={code,signal};state.events.push('exit');if(ready&&!state.ready)fail(new Error('child exited before private barrier'));if(state.entryReady&&!state.released2)fail(new Error('initial winner exited before second release'));});
 c.on('close',(code,signal)=>{clearTimeout(state.readyTimer);clearTimeout(state.watchdog);if(expectedFacts&&!state.nativeFacts)fail(new Error('child closed without native facts'));state.closed=true;state.events.push('close');
  state.result=Object.freeze({label,pid:c.pid,exit:code,signal,stdout:Buffer.concat(state.stdout).toString('utf8'),stderr:Buffer.concat(state.stderr).toString('utf8'),
   ready:state.ready,readyMessage:state.readyMessage,entryReady:state.entryReady,entryMessage:state.entryMessage,nativeFacts:state.nativeFacts,events:Object.freeze([...state.events]),signals:Object.freeze([...state.signals])});resolveClose(state.result);
 });
 c.stdout.on('data',bytes=>stream('stdout',bytes));c.stderr.on('data',bytes=>stream('stderr',bytes));
 c.stdout.on('error',error=>fail(new Error('child stdout error: '+error.message,{cause:error})));
 c.stderr.on('error',error=>fail(new Error('child stderr error: '+error.message,{cause:error})));
 c.stdin.on('error',error=>fail(new Error('child stdin error: '+error.message,{cause:error})));
 if(ready){c.on('message',message=>{
  if(expectedEntry&&message?.kind===expectedEntry.kind){
   try{assert.ok(state.ready&&state.released1&&!state.entryReady&&!state.nativeFacts,'entry ready out of order or duplicate');assert.deepEqual(message,expectedEntry);assert.equal(children.some(child=>child.entryReady),false,'multiple initial commit winners');}
   catch(error){fail(new Error('invalid private entry ready',{cause:error}));return;}
   state.entryReady=true;state.entryMessage=Object.freeze({...message});state.phase='initial-committed';state.events.push('entry-ready');resolveEntry();return;
  }
  if(expectedFacts&&message?.kind===expectedFacts.kind){
   try{assert.ok(state.ready&&state.released1&&!state.nativeFacts,'native facts out of order or duplicate');assert.ok(!state.entryReady||state.released2,'winner facts before second release');assert.equal(message.pid,c.pid);assert.equal(message.firstReadyCount,1);assert.equal(message.entryReadyCount,Number(state.entryReady));state.nativeFacts=freezeNativeFacts(message,expectedFacts);}
   catch(error){fail(new Error('invalid private native facts',{cause:error}));}return;
  }
  try{assert.equal(state.ready,false,'duplicate private ready');assert.deepEqual(message,expectedReady);}
  catch(error){fail(new Error('invalid private ready',{cause:error}));return;}
  state.ready=true;state.readyMessage=Object.freeze({...message});state.phase='ready';state.events.push('ready');clearTimeout(state.readyTimer);resolveReady();
 });c.on('disconnect',()=>{if(expectedFacts&&!state.nativeFacts)fail(new Error(state.entryReady&&!state.released2?'initial winner IPC disconnected before second release':'child IPC disconnected before native facts'));});state.readyTimer=setTimeout(()=>fail(new Error('private ready deadline exceeded')),readyMs);}
 state.watchdog=setTimeout(()=>fail(new Error('child completion watchdog exceeded')),watchdogMs);
 return state;
}
function childDiagnostic(state){return {label:state.label,pid:state.child.pid,phase:state.phase,closed:state.closed,exit:state.exit,
 failure:state.failure?.message,readyMessage:state.readyMessage,entryMessage:state.entryMessage,nativeFacts:state.nativeFacts,events:state.events,signals:state.signals,stdout:state.result?.stdout??Buffer.concat(state.stdout).toString('utf8'),stderr:state.result?.stderr??Buffer.concat(state.stderr).toString('utf8')};}
async function waitOwnedReady(state){await Promise.race([state.prepared,state.failed.then(error=>{throw error;})]);if(state.failure)throw state.failure;}
async function waitOwnedClose(state){const result=await Promise.race([state.done,state.failed.then(error=>{throw error;})]);if(state.failure)throw state.failure;return result;}
async function boundedEntryPhase(children,body){let timer,ended=false;const until=performance.now()+4000,active=()=>assert.ok(!ended&&performance.now()<until,'private entry phase no longer active');try{return await Promise.race([body(active),...children.map(child=>child.failed.then(error=>{throw error;})),new Promise((resolve,reject)=>{timer=setTimeout(()=>{ended=true;reject(new Error('private entry phase deadline exceeded'));},4000);})]);}finally{ended=true;clearTimeout(timer);}}
async function boundedChildClose(state,ms){let timer;try{return await Promise.race([state.done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}}
async function cleanupOwnedChild(state){
 clearTimeout(state.readyTimer);clearTimeout(state.watchdog);if(state.closed)return;
 state.cleaning=true;
 const signal=name=>{if(!state.closed&&state.exit===null){state.signals.push(name);try{state.child.kill(name);}catch(error){state.cleanupErrors.push(error);}}};
 signal('SIGTERM');let closed=await boundedChildClose(state,500);
 if(!closed){signal('SIGKILL');closed=await boundedChildClose(state,2000);}
 if(!closed){
  // Unknown close remains a failure; these refs cannot leave the test runner hanging.
  state.child.unref();state.child.stdin.unref?.();state.child.stdout.unref?.();state.child.stderr.unref?.();state.child.channel?.unref();
  state.cleanupErrors.push(new Error('owned child close unconfirmed: '+JSON.stringify(childDiagnostic(state))));
 }
 if(state.cleanupErrors.length)throw new AggregateError(state.cleanupErrors,'owned child signal or close cleanup failed');
}
async function withOwnedChildren(t,body){
 const children=[];let primary;
 try{return await body(children);}catch(error){primary=error;throw error;}
 finally{
  const settled=await Promise.allSettled(children.map(cleanupOwnedChild)),errors=settled.filter(x=>x.status==='rejected').map(x=>x.reason);
  if(primary||errors.length)t.diagnostic('owned child diagnostics '+JSON.stringify(children.map(childDiagnostic)));
  if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'owned child cleanup failed',{cause:primary});
 }
}
function parseChildJson(result){assert.equal(result.events.at(-1),'close');try{return JSON.parse(result.stdout);}catch(error){throw new Error('malformed child JSON output',{cause:error});}}

test('real consumer owned hold-first closes same root and finishes timeout with two confirmed strict holds; late finish/replay stay held',async t=>{
 const f=acquired(t,'positive',{claimed:true}),before=rowsNow(f),audit=countAudit(f);capture(f,'before-positive');
 const r=await consumeOwnedDrainIsolated(opts(f));record(f,'positive-result',r);capture(f,'after-positive-before-sql');assertBlocked(r);
 assert.equal(r.consumer.isolated_consumer_integrated,true);assert.equal(r.entry_hold,'committed');assert.equal(r.final_hold,'committed');assert.equal(r.reason,'writer_drain_timeout');assert.equal(r.admission,'closed');assert.equal(r.sample.claimedCurrent,1);assert.deepEqual(rowsNow(f),before);assert.equal(countAudit(f),audit+2);
 const state=ledgerNow(f),op=state.operations[f.token.operationId];assert.equal(state.fence,f.token.fence);assert.deepEqual(op.failures,['owned_drain_started','writer_drain_timeout']);assert.equal(op.disposition,'held');
 const w=openWriters(f.root);w.finish(f.task,'done');w.close();const after=countAudit(f);const retry=await consumeOwnedDrainIsolated(opts(f));assertBlocked(retry);assert.equal(retry.token,null);assert.equal(retry.entry_hold,'not_attempted');assert.equal(countAudit(f),after);assert.equal(writerNow(f).admission,'closed');
});
test('empty/completed registry and unknown subwork never ready; actual queued inventory remains',async t=>{
 for(const task of [false,true]){const f=acquired(t,'empty-'+task,{task});if(task){const w=openWriters(f.root);w.finish(f.task,'done');w.close();}const before=rowsNow(f),r=await consumeOwnedDrainIsolated(opts(f));assertBlocked(r);assert.equal(r.reason,'writer_drain_coverage_unknown');assert.equal(r.sample.queued,1);assert.deepEqual(rowsNow(f),before);record(f,'coverage-result',r);}
});
test('fresh invalid deadline/poll/outer/fixed binding and pre-abort have no writes',async t=>{
 const f=acquired(t,'invalid'),before=capture(f,'before-invalid');
 for(const change of [{deadlineAt:Date.now()-1},{deadlineAt:1.1},{deadlineAt:Date.now()+120000},{pollEveryMs:0},{inputJson:'not-json'},{inputJson:JSON.stringify({...f.input,extra:true})},{inputJson:JSON.stringify({...f.input,consumer:{...f.input.consumer,a3:{...f.input.consumer.a3,token:{...f.token,executionIdentity:'fixture-other'}}}})}])await assert.rejects(consumeOwnedDrainIsolated(opts(f,change)));
 const ctl=new AbortController();ctl.abort({reasonCode:'cancelled'});const r=await consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));assert.equal(r.reason,'cancelled');assert.equal(r.entry_hold,'not_attempted');assert.equal(r.final_hold,'not_attempted');assert.equal(r.token,null);assert.equal(r.sample,null);
 assert.deepEqual(byteFacts(capture(f,'after-invalid-before-sql')),byteFacts(before));
});
test('setup synchronous abort and expiry are checked again before any initial CAS',async t=>{
 for(const mode of ['abort','expiry']){const f=acquired(t,'setup-'+mode),before=capture(f,'before-setup'),prepare=Database.prototype.prepare,ctl=new AbortController();let gateCounts=0,hit=false;
  Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(this.name===join(f.root,'ledger.sqlite')&&sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...args){const value=get.apply(this,args);if(++gateCounts===7){hit=true;if(mode==='abort')ctl.abort({reasonCode:'cancelled'});else {const until=performance.now()+1100;while(performance.now()<until){/* private synchronous setup cut */}}}return value;};}return stmt;};
  let r;try{r=await consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal,deadlineAt:Date.now()+1000}));}finally{Database.prototype.prepare=prepare;}
  assert.equal(hit,true,'actual setup gate cut reached');assert.equal(r.reason,mode==='abort'?'cancelled':'task_deadline_exceeded');assert.equal(r.entry_hold,'not_attempted');assert.equal(r.final_hold,'not_attempted');assert.equal(r.token,null);assert.equal(r.sample,null);assert.deepEqual(byteFacts(capture(f,'after-setup-before-sql')),byteFacts(before));record(f,'setup-result',r);
 }
});
test('first cancellation survives actual failed source sample; generic failure has null current sample',async t=>{
 for(const cancelled of [true,false]){const f=acquired(t,'failedsample-'+cancelled),prepare=Database.prototype.prepare,ctl=new AbortController(),p=consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));if(cancelled)ctl.abort({reasonCode:'cancelled'});
  Database.prototype.prepare=function(sql){if(this.name===f.path&&sql==='SELECT id,trace_id,state,owner_token,claim_epoch,lease_expires_at FROM generation_dispatch')throw new Error('private sample cut');return prepare.call(this,sql);};let r;try{r=await p;}finally{Database.prototype.prepare=prepare;}
  assert.equal(r.sample,null);assert.equal(r.reason,cancelled?'cancelled':'writer_drain_observation_failed');assert.equal(r.final_hold,'committed');assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started',r.reason]);record(f,'failedsample-result',r);
 }
});
test('final current revision wins over cancellation/observation and never appends stale hold',async t=>{
 const f=acquired(t,'final-owner'),ctl=new AbortController(),p=consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));ctl.abort({reasonCode:'cancelled'});
 const l=openLedger(f.root),state=l.inspect();l.hold({...f.token,revision:state.revision},'foreign_continuation');l.close();const before=countAudit(f);await assert.rejects(p,/owned_drain_owner_revision_lost/);assert.equal(countAudit(f),before);assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','foreign_continuation']);
});
test('actual expired claims and orphan active lease are observed without mutation or release',async t=>{
 const f=acquired(t,'expired',{claimed:true}),db=new Database(f.path);db.exec("UPDATE generation_dispatch SET lease_expires_at='2000-01-01T00:00:00.000Z';UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z'");insertSource(db,{id:'synthetic_source',name:'Synthetic',type:'rss',endpoint:'https://fixture.invalid/feed',topic_ids:['integration-topic'],fetch_interval:3600,enabled:true});createSourceCollectTrace(db,{sourceId:'synthetic_source'});db.close();
 // Fresh truthful artifacts must bind the actual mutated native rows.
 for(const name of Object.values(roles))fs.renameSync(join(f.artifactRoot,name),join(f.artifactRoot,name+'.original'));
 f.input.consumer=artifacts(f,ledgerNow(f),f.token,Date.now());const before=rowsNow(f),r=await consumeOwnedDrainIsolated(opts(f));assertBlocked(r);assert.equal(r.sample.claimedExpired,1);assert.ok(r.sample.unknown>0);assert.deepEqual(rowsNow(f),before);record(f,'expired-result',r);
});
test('unsafe journal and capacity gates reject before any BEGIN and preserve original bytes',async t=>{
 const f=acquired(t,'unsafe'),journal=join(f.root,'writers.sqlite-journal');fs.writeFileSync(journal,'unsafe',{mode:0o600});fs.chmodSync(journal,0o644);
 const b=fs.readFileSync(journal),before=fs.readFileSync(join(f.root,'writers.sqlite'));const prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let begins=0;
 prototype.run=function(...args){if(this.source==='BEGIN'||this.source==='BEGIN IMMEDIATE')begins++;return run.apply(this,args);};try{await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/unsafe_owned_drain_path/);}finally{prototype.run=run;}
 assert.equal(begins,0);assert.deepEqual(fs.readFileSync(journal),b);assert.deepEqual(fs.readFileSync(join(f.root,'writers.sqlite')),before);
 // Explicitly archive unsafe original mode separately; no recovery or permission repair.
 if(evidence){save(join(evidence,'unsafe-original-journal.bin'),b);record(f,'unsafe-preserved',{journalMode:644,journalSize:b.length,journalHash:hash(b),databaseHash:hash(before),begins});}
});
test('real CLI legal positive and finite noEOF/overcap/invalid input have sanitized output',async t=>{
 const f=acquired(t,'cli-positive',{task:false});capture(f,'before-cli');const child=spawnSync(process.execPath,['ops/maintenance/owned-drain-cli.mjs',f.root,f.artifactRoot,String(Date.now()+5000),'10'],{input:JSON.stringify(f.input),cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});assert.equal(child.error,undefined,child.stdout+child.stderr);assert.equal(child.status,1,child.stderr);const r=JSON.parse(child.stdout);assertBlocked(r);assert.equal(r.final_hold,'committed');capture(f,'after-cli-before-sql');record(f,'cli-result',r);
 const fresh=acquired(t,'cli-input'),before=capture(fresh,'before-cli-input');
 for(const input of ['{bad',Buffer.from([255]),'x'.repeat(65537)]){const c=spawnSync(process.execPath,['ops/maintenance/owned-drain-cli.mjs',fresh.root,fresh.artifactRoot,String(Date.now()+5000),'10'],{input,cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});assert.equal(c.error,undefined,c.stdout+c.stderr);assert.equal(c.status,1);assert.equal(c.stdout,'');assert.match(c.stderr,/^[A-Za-z0-9_-]+\n$/);}
 await withOwnedChildren(t,async children=>{
  const c=spawnOwnedChild(children,['ops/maintenance/owned-drain-cli.mjs',fresh.root,fresh.artifactRoot,String(Date.now()+700),'10'],{label:'CLI noEOF'});
  c.child.stdin.write(JSON.stringify(fresh.input));const result=await waitOwnedClose(c);
  assert.equal(result.exit,1);assert.equal(result.signal,null);assert.equal(result.stdout,'');assert.equal(result.stderr,'task_deadline_exceeded\n');assert.deepEqual(byteFacts(capture(fresh,'after-cli-input-before-sql')),byteFacts(before));record(fresh,'cli-noEOF-output',result);
 });
});
// Fixed real code helpers are embedded only in private child tests, not exposed by runtime.
const testCode=fs.readFileSync(new URL(import.meta.url),'utf8');
const childPrelude=testCode.slice(0,testCode.indexOf("test('original real acquired"))
 .replaceAll("from './",`from '${new URL('.',import.meta.url).pathname}`)
 .replaceAll("import('../../src/", "import('./src/")
 .replaceAll("new URL('../aws/security-release-policy.json',import.meta.url)",JSON.stringify(new URL('../aws/security-release-policy.json',import.meta.url).pathname));
for(const cut of ['initial-before','initial-after','close-before','close-after','final-before','final-after'])test(`actual owned SIGKILL ${cut} preserves complete before-recovery bytes and durable phase facts`,t=>{
 const hook=`const f=acquired({diagnostic:()=>{}},'crash');console.log(JSON.stringify(f));const {consumeOwnedDrainIsolated}=await import('./ops/maintenance/owned-drain.mjs');const prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let phase;prototype.run=function(...args){if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='INSERT INTO events VALUES(?,?,?,?)'){const state=JSON.parse(args[3]),failures=state.operations[f.token.operationId].failures;phase=failures.length===1?'initial':'final';}if(this.database.name===join(f.root,'writers.sqlite')&&this.source.includes("UPDATE admission SET mode='closed'"))phase='close';const commit=this.source==='COMMIT'&&['ledger.sqlite','writers.sqlite'].some(n=>this.database.name===join(f.root,n));if(commit&&phase&&process.argv[1]===phase+'-before')process.kill(process.pid,'SIGKILL');const value=run.apply(this,args);if(commit&&phase&&process.argv[1]===phase+'-after')process.kill(process.pid,'SIGKILL');if(commit)phase=undefined;return value;};await consumeOwnedDrainIsolated(opts(f,{deadlineAt:Date.now()+1500}));throw new Error('cut_not_hit');`;
 if(evidence)save(join(evidence,cut+'-actual-child.mjs'),childPrelude+hook);
 const c=spawnSync(process.execPath,['--input-type=module','-e',childPrelude+hook,cut],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});assert.equal(c.error,undefined,c.stdout+c.stderr);assert.equal(c.signal,'SIGKILL',c.stdout+c.stderr);
 const f=JSON.parse(c.stdout.trim().split('\n').at(-1));capture(f,cut+'-before-recovery');record(f,cut+'-child',{signal:c.signal,status:c.status,stderr:c.stderr});
 const state=ledgerNow(f),view=writerNow(f),op=state.operations[f.token.operationId];const initialCommitted=cut!=='initial-before',closed=['close-after','final-before','final-after'].includes(cut),finalCommitted=cut==='final-after';
 assert.equal(op.disposition,initialCommitted?'held':'active');assert.equal(view.admission,closed?'closed':'open');assert.deepEqual(op.failures,finalCommitted?['owned_drain_started','writer_drain_timeout']:initialCommitted?['owned_drain_started']:[]);assert.equal(state.revision,f.token.revision+(initialCommitted?1:0)+(finalCommitted?1:0));record(f,cut+'-recovered',{state,view,business:rowsNow(f)});
});
function childRun(f,code,args=[],input){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},input,encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});assert.equal(result.error,undefined,result.stdout+result.stderr);return result;}
test('fixed CLI queued deadline callback cannot renew EOF window or setup budget under wall rollback',t=>{
 for(const mode of ['EOF','CAS']){const f=acquired(t,'mono-'+mode),before=capture(f,'before-mono'),body=mode==='EOF'?
  `const decode=TextDecoder.prototype.decode;let hit=false;TextDecoder.prototype.decode=function(...args){const text=decode.apply(this,args);if(!hit&&text.startsWith('{"schema":"a2-a3-owned-drain-v1","consumer":')){hit=true;const until=performance.now()+1400;while(performance.now()<until){}const wall=Date.now();Date.now=()=>wall-10000;}return text;};`:
  `const prepare=Database.prototype.prepare;let n=0;Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...args){const value=get.apply(this,args);if(++n===7){const until=performance.now()+1400;while(performance.now()<until){}const wall=Date.now();Date.now=()=>wall-10000;}return value;};}return stmt;};`;
  const c=childRun(f,`import Database from 'better-sqlite3';import {performance} from 'node:perf_hooks';${body}process.argv=['node','owned-drain-cli',...process.argv.slice(1)];await import('./ops/maintenance/owned-drain-cli.mjs');`,[f.root,f.artifactRoot,String(Date.now()+1200),'10'],JSON.stringify(f.input));assert.equal(c.status,1,c.stderr);
  if(mode==='EOF'){assert.equal(c.stdout,'');assert.equal(c.stderr,'task_deadline_exceeded\n');}else {const r=JSON.parse(c.stdout);assert.equal(r.reason,'task_deadline_exceeded');assert.equal(r.entry_hold,'not_attempted');assert.equal(r.final_hold,'not_attempted');assert.equal(r.token,null);}
  assert.deepEqual(byteFacts(capture(f,'after-mono-before-sql')),byteFacts(before));record(f,'mono-output',{mode,status:c.status,stdout:c.stdout,stderr:c.stderr});
 }
});
test('actual competing process wins revision immediately after cached inspect COMMIT; stale initial CAS cannot close or refresh',async t=>{
 const f=acquired(t,'race-initial'),prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let afterSetup=false,commits=0,hit=false;
 // Private native metadata count pins the exact last caller inspect boundary, not a public hook.
 const prepare=Database.prototype.prepare;let n=0;Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...args){const value=get.apply(this,args);if(++n===5)afterSetup=true;return value;};}return stmt;};
 prototype.run=function(...args){const value=run.apply(this,args);if(afterSetup&&!this.database.readonly&&this.database.name===join(f.root,'ledger.sqlite')&&this.source==='COMMIT'&&++commits===1){hit=true;const c=childRun(f,`import {openLedger} from './ops/maintenance/ledger.mjs';const l=openLedger(process.argv[1]);l.hold(JSON.parse(process.argv[2]),'other_cas_winner');l.close();`,[f.root,JSON.stringify(f.token)]);assert.equal(c.status,0,c.stderr);}return value;};
 try{await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/maintenance_revision_conflict/);}finally{prototype.run=run;Database.prototype.prepare=prepare;}
 assert.equal(hit,true);assert.equal(writerNow(f).admission,'open');assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['other_cas_winner']);record(f,'race-result',{hit,view:writerNow(f),state:ledgerNow(f)});
});
const privateReleaseWait=`const until=performance.now()+4000,sleeper=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(release)){if(performance.now()>=until)throw new Error('private release deadline exceeded');Atomics.wait(sleeper,0,0,5);}`;
const initialReady=(root,release)=>({kind:'owned-drain-initial-ready-v1',root,release,count:7,phase:'readonly-commit-returned'});
const entryReadyFor=(f,release)=>({kind:'owned-drain-entry-ready-v1',root:f.root,release,operationId:f.token.operationId,ledgerPath:join(f.root,'ledger.sqlite'),phase:'writable-commit-returned',successfulInitialInserts:1,inTransaction:false});
const nativeFactsFor=f=>({kind:'owned-drain-native-facts-v1',root:f.root,operationId:f.token.operationId,ledgerPath:join(f.root,'ledger.sqlite')});
// Resolve-only sends cannot create an unhandled rejection. A pending callback keeps
// this private IPC channel referenced until close or the existing parent watchdog.
const nativeIPCProtocol=`const pendingIPC=[];
function send(message){process.channel.ref();const completed=new Promise(resolve=>{let settled=false;const done=error=>{if(settled)return;settled=true;if(error)facility('IPC',error);resolve(error??null);};try{process.send(message,done);}catch(error){done(error);}});pendingIPC.push(completed);return completed;}
async function finishIPC(){await Promise.all(pendingIPC);facts.armPresent=armDb!==undefined;const finalError=await send(facts);if(finalError||facts.facilityErrors.some(error=>error.phase==='IPC')){process.stderr.write('owned_drain_private_IPC_failed\\n');process.exitCode=2;}if(process.connected)process.disconnect();}`;
// Seventh same-ledger readonly metadata count, after that native COMMIT returns.
// Only a normally returned, ended initial write transaction can arm stage two.
const nativeInitialChild=`import fs from 'node:fs';import {performance} from 'node:perf_hooks';import Database from 'better-sqlite3';import {consumeOwnedDrainIsolated} from './ops/maintenance/owned-drain.mjs';
let bytes='';for await(const c of process.stdin)bytes+=c;const input=JSON.parse(bytes),release=process.argv[1],release2=process.argv[2],mode=process.argv[3]??'normal',token=JSON.parse(input.inputJson).consumer.a3.token,ledgerPath=input.root+'/ledger.sqlite',prepare=Database.prototype.prepare,prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;
let count=0,hit=false,initialDb,armDb;const facts={kind:'owned-drain-native-facts-v1',pid:process.pid,root:input.root,operationId:token.operationId,ledgerPath,firstReadyCount:0,firstReleaseObserved:false,secondReleaseObserved:false,initialBeginAttempts:0,initialBeginReturned:false,initialDatabaseBound:false,successfulInitialInserts:0,entryReadyCount:0,armPresent:false,readonlyCommitReturns:0,nonInitialWritableCommitReturns:0,rollbackReturns:0,nativeErrors:[],facilityErrors:[]};
function facility(phase,error){facts.facilityErrors.push({phase,message:error.message});return error;}
${nativeIPCProtocol}
function waitRelease(path,phase){const release=path;try{${privateReleaseWait}}catch(error){throw facility(phase,error);}}
Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(this.readonly&&this.name===input.root+'/ledger.sqlite'&&sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...a){const result=get.apply(this,a);count++;return result;};}return stmt;};
prototype.run=function(...a){const db=this.database,isLedger=db.name===ledgerPath,initialBegin=isLedger&&!db.readonly&&this.source==='BEGIN IMMEDIATE'&&facts.firstReleaseObserved&&facts.initialBeginAttempts===0;
 if(initialBegin){initialDb=db;facts.initialDatabaseBound=true;facts.initialBeginAttempts++;}
 const initialCommit=armDb===db&&this.source==='COMMIT';if(this.source==='ROLLBACK')armDb=undefined;
 let result;try{result=run.apply(this,a);}
 catch(error){armDb=undefined;facts.nativeErrors.push({phase:initialBegin?'initial-begin':initialCommit?'initial-commit':'native-statement',database:db.name,readonly:db.readonly,initialDatabase:db===initialDb,source:this.source,code:error.code??null,message:error.message});throw error;}
 if(initialBegin)facts.initialBeginReturned=true;if(this.source==='ROLLBACK')facts.rollbackReturns++;
 if(isLedger&&this.source==='COMMIT'){if(db.readonly)facts.readonlyCommitReturns++;else if(!initialCommit)facts.nonInitialWritableCommitReturns++;}
 if(db===initialDb&&!db.readonly&&this.source==='INSERT INTO events VALUES(?,?,?,?)'){const state=JSON.parse(a[3]),op=state.operations[token.operationId];if(state.active===token.operationId&&op?.operationId===token.operationId&&op.ownerId===token.ownerId&&op.fence===token.fence&&op.disposition==='held'&&op.state==='pre_submit'&&JSON.stringify(op.failures)==='["owned_drain_started"]'){facts.successfulInitialInserts++;armDb=db;}}
 if(initialCommit){armDb=undefined;if(db.inTransaction!==false)throw facility('initial COMMIT',new Error('private initial transaction still active'));facts.entryReadyCount++;
  if(facts.entryReadyCount!==1||facts.successfulInitialInserts!==1)throw facility('initial COMMIT',new Error('private duplicate initial COMMIT'));
  const message={kind:'owned-drain-entry-ready-v1',pid:process.pid,root:input.root,release:release2,operationId:token.operationId,ledgerPath,phase:'writable-commit-returned',successfulInitialInserts:1,inTransaction:false};
  if(mode!=='missing-entry')send(mode==='wrong-entry'?{...message,root:input.root+'-wrong'}:message);if(mode==='duplicate-entry')send(message);
  if(mode==='winner-exit'){waitRelease(release2+'.exit','winner-exit');process.exit(0);}waitRelease(release2,'release2');facts.secondReleaseObserved=true;
 }
 if(!hit&&count===7&&this.source==='COMMIT'&&db.readonly&&isLedger){hit=true;facts.firstReadyCount++;send({kind:'owned-drain-initial-ready-v1',pid:process.pid,root:input.root,release,count,phase:'readonly-commit-returned'});waitRelease(release,'release1');facts.firstReleaseObserved=true;}
 return result;};
try{const result=await consumeOwnedDrainIsolated(input);if(!hit){process.stderr.write(JSON.stringify({phase:'before-private-barrier',count,result})+'\\n');throw facility('ready1',new Error('private barrier not reached'));}
 if(mode==='non-initial'){const db=new Database(ledgerPath,{fileMustExist:true,timeout:0});try{db.transaction(()=>{})();db.transaction(()=>{}).immediate();try{db.transaction(()=>{throw new Error('private noninitial rollback');}).immediate();}catch(error){if(error.message!=='private noninitial rollback')throw error;}}finally{db.close();}}
 console.log(JSON.stringify(result));}catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=2;}
finally{await finishIPC();}`;
function launchNativeChild(children,f,release,release2,{label='native child',mode='normal',code=nativeInitialChild}={}){
 const c=spawnOwnedChild(children,['--input-type=module','-e',code,release,release2,mode],{label,ready:initialReady(f.root,release),entryReady:entryReadyFor(f,release2),nativeFacts:nativeFactsFor(f)});
 c.child.stdin.end(JSON.stringify(opts(f,{deadlineAt:Date.now()+10000})));return c;
}
function assertNativeLoser(result){
 assert.equal(result.signal,null);assert.equal(result.stderr,'','CAS loser emitted private failure diagnostic');assert.equal(result.ready,true);assert.equal(result.entryReady,false);const facts=result.nativeFacts;assert.ok(facts,'missing frozen native loser facts');
 assert.equal(facts.firstReadyCount,1);assert.equal(facts.firstReleaseObserved,true);assert.equal(facts.initialDatabaseBound,true);assert.equal(facts.initialBeginAttempts,1);assert.equal(facts.successfulInitialInserts,0);assert.equal(facts.entryReadyCount,0);assert.equal(facts.secondReleaseObserved,false);assert.equal(facts.armPresent,false);assert.deepEqual(facts.facilityErrors,[]);
 const parsed=parseChildJson(result);
 if(result.exit===2){assert.deepEqual(parsed,{error:'maintenance_revision_conflict'});assert.equal(facts.initialBeginReturned,true);assert.deepEqual(facts.nativeErrors,[]);}
 else {assert.equal(result.exit,0);assert.equal(parsed.schema,'a2-a3-owned-drain-result-v1');assert.equal(parsed.reason,'owned_drain_initial_commit_unknown');assert.equal(parsed.entry_hold,'unknown');assert.equal(parsed.final_hold,'not_attempted');assert.equal(parsed.token,null);assertBlocked(parsed);assertOwnedPermitsBlocked(parsed);
  assert.equal(facts.initialBeginReturned,false);assert.equal(facts.nativeErrors.length,1,'unknown loser requires only actual initial BEGIN busy');const error=facts.nativeErrors[0];
  assert.equal(error.phase,'initial-begin');assert.equal(error.database,facts.ledgerPath);assert.equal(error.readonly,false);assert.equal(error.initialDatabase,true);assert.equal(error.source,'BEGIN IMMEDIATE');assert.equal(error.code,'SQLITE_BUSY');
 }
 return parsed;
}
function assertOwnedPermitsBlocked(result){for(const key of ['deployment_permitted','rollback_permitted','database_restore_permitted','inverse_migration_permitted'])assert.equal(result[key],false,key);}
async function runInitialRace(t,f,{a={},b={},prematureRelease2=false,onChildren}={}){
 const release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release');if(prematureRelease2)save(release2,'private-entry-release-v1\n');
 return withOwnedChildren(t,async children=>{
  onChildren?.(children);
  const first=launchNativeChild(children,f,release,release2,{label:'same-token A',...a});await waitOwnedReady(first);
  const second=launchNativeChild(children,f,release,release2,{label:'same-token B',...b});await waitOwnedReady(second);
  for(const child of children)if(child.failure)throw child.failure;
  assert.ok(children.every(c=>c.ready&&!c.closed&&!c.failure));assert.equal(fs.existsSync(release2),false,'premature private second release');
  children.forEach(c=>{c.released1=true;c.phase='released-1';c.events.push('release-1');});save(release,'private-release-v1\n');
  let winner,loser,loserResult;
  await boundedEntryPhase(children,async active=>{
   winner=await Promise.race(children.map(c=>c.entryPrepared.then(()=>c)));loser=children.find(c=>c!==winner);loserResult=await waitOwnedClose(loser);assertNativeLoser(loserResult);
   active();assert.equal(children.filter(c=>c.entryReady).length,1);assert.ok(children.every(c=>!c.failure));assert.ok(!winner.closed&&winner.exit===null&&winner.child.exitCode===null&&winner.child.signalCode===null,'winner must remain live before release2');assert.equal(fs.existsSync(release2),false,'premature private second release');
   winner.released2=true;winner.phase='released-2';winner.events.push('release-2');save(release2,'private-entry-release-v1\n');
  });
  const winnerResult=await waitOwnedClose(winner),results=children.map(c=>c===winner?winnerResult:loserResult);t.diagnostic('same-token close outcomes '+JSON.stringify(results));record(f,'two-process-results',results);
  const parsed=results.map(parseChildJson);assert.equal(parsed.filter(r=>r.entry_hold==='committed').length,1);assert.equal(parsed.filter(r=>r.token!==undefined&&r.token!==null).length,1);
  const op=ledgerNow(f).operations[f.token.operationId];assert.deepEqual(op.failures,['owned_drain_started','writer_drain_coverage_unknown']);
  assert.equal(winnerResult.exit,0);assert.equal(winnerResult.signal,null);assert.equal(winnerResult.stderr,'');assertBlocked(parseChildJson(winnerResult));assertOwnedPermitsBlocked(parseChildJson(winnerResult));assert.equal(winnerResult.entryReady,true);assert.ok(winnerResult.events.indexOf('entry-ready')<winnerResult.events.indexOf('release-2'));
  const facts=winnerResult.nativeFacts;assert.equal(facts.entryReadyCount,1);assert.equal(facts.successfulInitialInserts,1);assert.equal(facts.initialBeginReturned,true);assert.equal(facts.secondReleaseObserved,true);assert.equal(facts.armPresent,false);assert.deepEqual(facts.nativeErrors,[]);assert.deepEqual(facts.facilityErrors,[]);
  return {results,parsed};
 });
}
test('same-token concurrent actual processes get one strict initial winner, never duplicate entry or refresh loser',async t=>{
 const f=acquired(t,'two-process',{task:false});await runInitialRace(t,f);
});
test('native initial barrier accepts a durable release created before ready without external rescue',async t=>{
 const f=acquired(t,'early-release',{task:false}),release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release');save(release,'private-release-v1\n');save(release2,'private-entry-release-v1\n');
 await withOwnedChildren(t,async children=>{
  const c=launchNativeChild(children,f,release,release2,{label:'early durable releases'});c.released1=true;c.released2=true;await waitOwnedReady(c);const result=await waitOwnedClose(c),parsed=parseChildJson(result);
  assert.equal(result.exit,0);assert.equal(result.signal,null);assert.equal(result.stderr,'');assert.equal(parsed.entry_hold,'committed');assert.notEqual(parsed.token,null);assert.equal(parsed.final_hold,'committed');assertBlocked(parsed);
  assert.equal(result.entryReady,true);assert.equal(result.nativeFacts.entryReadyCount,1);assert.equal(result.nativeFacts.successfulInitialInserts,1);assert.equal(result.nativeFacts.secondReleaseObserved,true);assert.deepEqual(result.nativeFacts.nativeErrors,[]);assert.deepEqual(result.nativeFacts.facilityErrors,[]);
  assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','writer_drain_coverage_unknown']);record(f,'early-release-result',result);
 });
});
test('actual initial BEGIN busy has frozen native evidence and no successful INSERT or entry ready',async t=>{
 const f=acquired(t,'native-busy',{task:false}),release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release'),before=capture(f,'before-native-busy');
 await withOwnedChildren(t,async children=>{
  const c=launchNativeChild(children,f,release,release2,{label:'actual initial BEGIN busy'});await waitOwnedReady(c);
  const lock=new Database(join(f.root,'ledger.sqlite'),{fileMustExist:true,timeout:0});try{lock.exec('BEGIN IMMEDIATE');c.released1=true;save(release,'private-release-v1\n');const result=await waitOwnedClose(c);assertNativeLoser(result);const parsed=parseChildJson(result);assert.equal(parsed.reason,'owned_drain_initial_commit_unknown');assert.ok(Object.isFrozen(result.nativeFacts));assert.ok(Object.isFrozen(result.nativeFacts.nativeErrors[0]));
   for(const key of ['deployment_permitted','rollback_permitted','database_restore_permitted','inverse_migration_permitted'])for(const variant of ['true','missing']){const mutated=structuredClone(parsed);if(variant==='true')mutated[key]=true;else delete mutated[key];const changed=Object.freeze({...result,stdout:JSON.stringify(mutated)});assert.equal(changed.nativeFacts,result.nativeFacts);assert.throws(()=>assertNativeLoser(changed),error=>{assert.ok(error instanceof assert.AssertionError);assert.equal(error.message.split('\n')[0],key);assert.equal(error.actual,variant==='true'?true:undefined);assert.equal(error.expected,false);return true;});}
   record(f,'native-busy-result',result);}
  finally{try{if(lock.inTransaction)lock.exec('ROLLBACK');}finally{lock.close();}}
 });
 assert.deepEqual(byteFacts(capture(f,'after-native-busy-before-sql')),byteFacts(before));assert.equal(countAudit(f),2);
});
test('actual initial COMMIT exception clears arm, keeps successful INSERT history and never signs entry ready',async t=>{
 const f=acquired(t,'commit-no-ready',{task:false}),release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release');
 await withOwnedChildren(t,async children=>{
  const c=launchNativeChild(children,f,release,release2,{label:'actual native COMMIT busy'});await waitOwnedReady(c);
  const reader=new Database(join(f.root,'ledger.sqlite'),{readonly:true,fileMustExist:true,timeout:0});try{
   reader.exec('BEGIN');reader.prepare('SELECT count(*) AS n FROM events').get();c.released1=true;save(release,'private-release-v1\n');const result=await waitOwnedClose(c),parsed=parseChildJson(result),facts=result.nativeFacts;
   assert.equal(result.exit,0);assert.equal(parsed.reason,'owned_drain_initial_commit_unknown');assert.equal(parsed.entry_hold,'unknown');assert.equal(parsed.token,null);assert.equal(result.entryReady,false);assert.equal(facts.successfulInitialInserts,1);assert.equal(facts.entryReadyCount,0);assert.equal(facts.armPresent,false);assert.equal(facts.nativeErrors.length,1);assert.equal(facts.nativeErrors[0].source,'COMMIT');assert.equal(facts.nativeErrors[0].phase,'initial-commit');assert.equal(facts.nativeErrors[0].code,'SQLITE_BUSY');assert.equal(facts.nativeErrors[0].initialDatabase,true);assert.ok(facts.rollbackReturns>0);assert.deepEqual(facts.facilityErrors,[]);
   assert.throws(()=>assertNativeLoser(result),assert.AssertionError);assert.equal(fs.existsSync(release2),false);record(f,'commit-no-ready-result',result);
  }finally{try{if(reader.inTransaction)reader.exec('ROLLBACK');}finally{reader.close();}}
 });
 assert.equal(countAudit(f),2);
});
test('actual readonly, inspect, final and noninitial rollback commits cannot produce extra entry ready',async t=>{
 const f=acquired(t,'noninitial-ready',{task:false}),release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release');save(release,'private-release-v1\n');save(release2,'private-entry-release-v1\n');
 await withOwnedChildren(t,async children=>{
  const c=launchNativeChild(children,f,release,release2,{label:'actual noninitial commits',mode:'non-initial'});c.released1=true;c.released2=true;await waitOwnedReady(c);const result=await waitOwnedClose(c),facts=result.nativeFacts;
  assert.equal(result.exit,0);assert.equal(result.entryReady,true);assert.equal(facts.entryReadyCount,1);assert.equal(facts.successfulInitialInserts,1);assert.ok(facts.readonlyCommitReturns>0);assert.ok(facts.nonInitialWritableCommitReturns>0);assert.ok(facts.rollbackReturns>0);assert.equal(facts.armPresent,false);assert.deepEqual(facts.nativeErrors,[]);assert.deepEqual(facts.facilityErrors,[]);assert.equal(parseChildJson(result).final_hold,'committed');assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','writer_drain_coverage_unknown']);record(f,'noninitial-ready-result',result);
 });
});
function nativeIPCCallbackChild(phase,behavior){
 const kind={ready:'owned-drain-initial-ready-v1',entry:'owned-drain-entry-ready-v1',facts:'owned-drain-native-facts-v1'}[phase];
 // Deliver through the real IPC transport, then fault only its caller's callback.
 const complete=behavior==='late-error'?`setTimeout(()=>callback(new Error('private late ${phase} IPC callback error')),150);`:'';
 return `const actualSend=process.send;process.send=function(message,callback){if(message.kind!==${JSON.stringify(kind)})return actualSend.call(this,message,callback);return actualSend.call(this,message,error=>{if(error)callback(error);else {${complete}}});};${nativeInitialChild}`;
}
for(const phase of ['ready','entry','facts'])for(const behavior of ['late-error','no-callback'])test('actual native IPC '+phase+' '+behavior+' cannot publish a successful closed race',async t=>{
 const f=acquired(t,'ipc-'+phase+'-'+behavior,{task:false}),code=nativeIPCCallbackChild(phase,behavior);let observed;
 await assert.rejects(runInitialRace(t,f,{a:{code},b:{code},onChildren:children=>{observed=children;}}),error=>{
  if(behavior==='no-callback')assert.equal(error.message,phase==='entry'?'child completion watchdog exceeded':'private entry phase deadline exceeded');
  else if(phase==='entry'){assert.ok(error instanceof assert.AssertionError);assert.equal(error.actual,2);assert.equal(error.expected,0);}
  else assert.match(error.message,/^CAS loser emitted private failure diagnostic/);
  return true;
 });
 assert.equal(observed.length,2);assert.ok(observed.every(child=>child.closed&&child.result.events.at(-1)==='close'));
 assert.equal(fs.existsSync(join(f.parent,'private-entry-release')),phase==='entry');
 if(behavior==='late-error'){
  const failed=observed.filter(child=>child.result.stderr==='owned_drain_private_IPC_failed\n');assert.ok(failed.length>0);assert.ok(failed.every(child=>child.result.exit===2));
  if(phase==='facts'){const loser=failed.find(child=>!child.result.entryReady);assert.ok(loser);assert.deepEqual(loser.result.nativeFacts.facilityErrors,[]);assert.throws(()=>assertNativeLoser(loser.result),/CAS loser emitted private failure diagnostic/);}
  else assert.ok(failed.some(child=>child.result.nativeFacts.facilityErrors.some(error=>error.phase==='IPC'&&error.message==='private late '+phase+' IPC callback error')));
 }else {assert.ok(observed.some(child=>child.result.signal==='SIGTERM'));assert.ok(observed.every(child=>!child.cleanupErrors.length));}
});
function adversaryInitialChild(f,mode){
 const release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release'),first=initialReady(f.root,release),entry=entryReadyFor(f,release2);
 const unknown={schema:'a2-a3-owned-drain-result-v1',reason:'owned_drain_initial_commit_unknown',entry_hold:'unknown',final_hold:'not_attempted',token:null,deployment_permitted:false,rollback_permitted:false,database_restore_permitted:false,inverse_migration_permitted:false,production_permitted:false,drain_ready:false,writer_quiescence:false,process_termination:'unknown',approved_safe_rollback:null,observation_atomic:false,controller_uniqueness:'unknown',phase_verified:false,all_writer_coverage:false,commands_executed:false};
 const facts={...nativeFactsFor(f),firstReadyCount:1,firstReleaseObserved:true,secondReleaseObserved:false,initialBeginAttempts:1,initialBeginReturned:false,initialDatabaseBound:true,successfulInitialInserts:0,entryReadyCount:0,armPresent:false,readonlyCommitReturns:1,nonInitialWritableCommitReturns:0,rollbackReturns:0,nativeErrors:[],facilityErrors:[]};
 if(mode==='unknown-wrong-native')facts.nativeErrors.push({phase:'initial-commit',database:facts.ledgerPath,readonly:false,initialDatabase:true,source:'COMMIT',code:'SQLITE_BUSY',message:'forged unknown COMMIT'});
 if(mode==='unknown-facility'){facts.nativeErrors.push({phase:'initial-begin',database:facts.ledgerPath,readonly:false,initialDatabase:true,source:'BEGIN IMMEDIATE',code:'SQLITE_BUSY',message:'forged busy with wait failure'});facts.facilityErrors.push({phase:'release1',message:'private wait failed'});}
 let body;
 if(mode==='entry-before-ready')body=`process.send(entry);process.send(first);setInterval(()=>{},1000);`;
 else if(mode==='entry-before-release')body=`process.send(first);process.send(entry);setInterval(()=>{},1000);`;
 else {body=`process.send(first);${privateReleaseWait}`;
  if(mode==='two-winners')body+=`process.send(entry);setInterval(()=>{},1000);`;
  else if(mode==='loser-hang')body+=`setInterval(()=>{},1000);`;
  else if(mode==='loser-output-hang'){facts.initialBeginReturned=true;body+=`console.log(JSON.stringify({error:'maintenance_revision_conflict'}));process.send(facts);setInterval(()=>{},1000);`;}
  else body+=`console.log(JSON.stringify(${JSON.stringify(unknown)}));process.send(facts);process.disconnect();`;
 }
 return `import fs from 'node:fs';import {performance} from 'node:perf_hooks';let bytes='';for await(const c of process.stdin)bytes+=c;const release=process.argv[1],first={...${JSON.stringify(first)},pid:process.pid},entry={...${JSON.stringify(entry)},pid:process.pid},facts={...${JSON.stringify(facts)},pid:process.pid};${body}`;
}
for(const mode of ['entry-before-ready','entry-before-release','wrong-entry','duplicate-entry','missing-entry','two-winners','premature-release2','loser-hang','loser-output-hang','unknown-no-native','unknown-wrong-native','unknown-facility'])test('private two-stage supervision rejects '+mode+' without treating it as a business loser',async t=>{
 const f=acquired(t,'phase-'+mode,{task:false});let config;
 if(['wrong-entry','duplicate-entry','missing-entry'].includes(mode))config={a:{mode},b:{mode}};
 else if(mode==='premature-release2')config={prematureRelease2:true};
 else if(mode.startsWith('entry-before'))config={a:{code:adversaryInitialChild(f,mode)}};
 else config={b:{code:adversaryInitialChild(f,mode)}};
 await assert.rejects(runInitialRace(t,f,config),error=>{
  if(mode==='premature-release2')assert.match(error.message,/premature private second release/);
  else if(mode==='unknown-no-native')assert.match(error.message,/unknown loser requires only actual initial BEGIN busy/);
  else if(mode==='unknown-wrong-native')assert.equal(error.actual,'initial-commit');
  else if(mode==='unknown-facility')assert.ok(error instanceof assert.AssertionError);
  else if(['missing-entry','loser-hang','loser-output-hang'].includes(mode))assert.match(error.message,/private entry phase deadline exceeded|invalid private native facts/);
  else assert.match(error.message,/invalid private entry ready/);
  return true;
 });
 assert.equal(fs.existsSync(join(f.parent,'private-entry-release')),mode==='premature-release2');
});
test('private two-stage supervision rejects winner-exit without treating it as a business loser',async t=>{
 const f=acquired(t,'phase-winner-exit',{task:false}),release=join(f.parent,'private-release'),release2=join(f.parent,'private-entry-release'),exitRelease=release2+'.exit';let child;
 await assert.rejects(withOwnedChildren(t,async children=>{
  child=launchNativeChild(children,f,release,release2,{label:'actual committed winner exit',mode:'winner-exit'});await waitOwnedReady(child);
  child.released1=true;child.events.push('release-1');save(release,'private-release-v1\n');
  await boundedEntryPhase(children,async active=>{
   await child.entryPrepared;active();assert.equal(child.entryReady,true);assert.equal(child.entryMessage.successfulInitialInserts,1);assert.equal(child.entryMessage.inTransaction,false);
   assert.ok(!child.closed&&child.exit===null&&child.child.exitCode===null&&child.child.signalCode===null);assert.equal(child.released2,false);assert.equal(fs.existsSync(release2),false);assert.equal(fs.existsSync(exitRelease),false);
   active();child.events.push('exit-injection');save(exitRelease,'private-winner-exit-v1\n');await waitOwnedClose(child);
  });
 }),error=>{assert.match(error.message,/^initial winner (exited|IPC disconnected) before second release$/);return true;});
 assert.equal(child.closed,true);assert.equal(child.result.exit,0);assert.equal(child.result.signal,null);assert.equal(child.result.entryReady,true);assert.equal(child.result.events.at(-1),'close');
 const events=child.result.events;assert.ok(events.indexOf('entry-ready')<events.indexOf('exit-injection'));assert.ok(events.indexOf('exit-injection')<events.indexOf('exit'));assert.ok(events.indexOf('exit')<events.indexOf('close'));
 assert.equal(child.released2,false);assert.equal(fs.existsSync(release2),false);assert.equal(countAudit(f),3);assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started']);record(f,'winner-exit-result',child.result);
});
test('private message snapshots cannot change when expected or received ready objects are mutated',async t=>{
 const ready={kind:'owned-drain-mutable-ready-v1'};
 await withOwnedChildren(t,async children=>{
  const c=spawnOwnedChild(children,['--input-type=module','-e',`process.send({kind:'owned-drain-mutable-ready-v1',pid:process.pid});console.log('{}');process.disconnect();`],{label:'immutable ready snapshot',ready});ready.kind='changed after spawn';c.child.stdin.end();await waitOwnedReady(c);const result=await waitOwnedClose(c);
  assert.equal(result.readyMessage.kind,'owned-drain-mutable-ready-v1');assert.ok(Object.isFrozen(result.readyMessage));assert.throws(()=>{result.readyMessage.kind='changed after close';},TypeError);assert.equal(result.exit,0);
 });
});
test('private cleanup signal failure cannot replace the primary error or prevent bounded KILL and close',async t=>{
 let child;const primary=new Error('private primary cleanup assertion'),ready={kind:'owned-drain-cleanup-ready-v1'};
 await assert.rejects(withOwnedChildren(t,async children=>{
  child=spawnOwnedChild(children,['--input-type=module','-e',`process.on('SIGTERM',()=>{});process.send({kind:'owned-drain-cleanup-ready-v1',pid:process.pid});setInterval(()=>{},1000);`],{label:'cleanup signal failure',ready});child.child.stdin.end();await waitOwnedReady(child);
  const kill=child.child.kill;child.child.kill=function(signal){if(signal==='SIGTERM')throw new Error('private TERM send failure');return kill.call(this,signal);};throw primary;
 }),error=>{assert.ok(error instanceof AggregateError);assert.equal(error.cause,primary);assert.equal(error.errors[0],primary);assert.match(error.errors[1].errors[0].message,/private TERM send failure/);return true;});
 assert.equal(child.closed,true);assert.equal(child.result.signal,'SIGKILL');assert.deepEqual(child.result.signals,['SIGTERM','SIGKILL']);
});
for(const mode of ['early-exit','fake-ready','no-ready','post-release-hang','ignore-TERM'])test('private child supervision rejects '+mode+' and confirms bounded owned cleanup',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'insight-owned-child-')));fs.chmodSync(root,0o700);t.diagnostic('retained own child fixture '+root);
 const release=join(root,'private-release'),ready=initialReady(root,release),send=`process.send({...ready,pid:process.pid});`,idle=`setInterval(()=>{},1000);`;
 const body=mode==='early-exit'?`process.stderr.write('before-ready-exit\\n');process.exit(0);`:mode==='fake-ready'?`process.send({ready:true});${idle}`:mode==='no-ready'?idle:
  mode==='ignore-TERM'?`process.on('SIGTERM',()=>{});${send}${idle}`:`${send}${privateReleaseWait}${idle}`;
 const code=`import fs from 'node:fs';import {performance} from 'node:perf_hooks';const release=process.argv[1],ready=JSON.parse(process.argv[2]);${body}`;
 let child;
 await assert.rejects(withOwnedChildren(t,async children=>{
  child=spawnOwnedChild(children,['--input-type=module','-e',code,release,JSON.stringify(ready)],{label:mode,ready,...(mode==='no-ready'?{readyMs:500}:{})});child.child.stdin.end();
  await waitOwnedReady(child);
  if(mode==='ignore-TERM')throw new Error('private primary assertion failure');
  save(release,'private-release-v1\n');child.phase='released';child.events.push('release');await waitOwnedClose(child);
 }),{message:mode==='early-exit'?'child exited before private barrier':mode==='fake-ready'?'invalid private ready':mode==='no-ready'?'private ready deadline exceeded':mode==='ignore-TERM'?'private primary assertion failure':'child completion watchdog exceeded'});
 assert.equal(child.closed,true);assert.equal(child.result.events.at(-1),'close');
 if(mode==='early-exit'){assert.equal(child.result.exit,0);assert.equal(child.result.stderr,'before-ready-exit\n');}
 else {assert.equal(child.result.exit,null);assert.equal(child.result.signal,mode==='ignore-TERM'?'SIGKILL':'SIGTERM');assert.deepEqual(child.result.signals,mode==='ignore-TERM'?['SIGTERM','SIGKILL']:['SIGTERM']);}
});
test('private child supervision captures spawn and stdin errors without unhandled rejection',async t=>{
 let missing;
 await assert.rejects(withOwnedChildren(t,async children=>{
  missing=spawnOwnedChild(children,[],{label:'missing executable',executable:'/private/insight-owned-child-not-present'});await waitOwnedClose(missing);
 }),/child process error:.*ENOENT/);assert.equal(missing.closed,true);
 let input;const ready={kind:'owned-drain-stdin-ready-v1'};
 await assert.rejects(withOwnedChildren(t,async children=>{
  input=spawnOwnedChild(children,['--input-type=module','-e',`import fs from 'node:fs';fs.closeSync(0);process.send({kind:'owned-drain-stdin-ready-v1',pid:process.pid});setInterval(()=>{},1000);`],{label:'closed child stdin',ready});
  await waitOwnedReady(input);input.child.stdin.end(Buffer.alloc(1024*1024));await waitOwnedClose(input);
 }),/child stdin error:.*EPIPE/);assert.equal(input.closed,true);assert.equal(input.result.signal,'SIGTERM');
});
test('private child close freezes complete large stdout and stderr before JSON parsing',async t=>{
 await withOwnedChildren(t,async children=>{
  const c=spawnOwnedChild(children,['--input-type=module','-e',`process.stdout.write(JSON.stringify({payload:'x'.repeat(2*1024*1024)})+'\\n');process.stderr.write('e'.repeat(65536)+'tail\\n');`],{label:'complete large output'});c.child.stdin.end();
  const result=await waitOwnedClose(c);assert.equal(c.closed,true);assert.ok(Object.isFrozen(result));assert.equal(result.exit,0);assert.equal(result.signal,null);
  assert.equal(parseChildJson(result).payload,'x'.repeat(2*1024*1024));assert.equal(result.stdout.length,2*1024*1024+15);assert.equal(result.stderr,'e'.repeat(65536)+'tail\n');assert.deepEqual(result.events,['spawn','exit','close']);
 });
});
test('private child malformed JSON fails after close and retains the original output',async t=>{
 let child;
 await assert.rejects(withOwnedChildren(t,async children=>{
  child=spawnOwnedChild(children,['--input-type=module','-e',`process.stdout.write('{bad\\n');process.stderr.write('malformed-tail\\n');`],{label:'malformed output'});child.child.stdin.end();parseChildJson(await waitOwnedClose(child));
 }),{message:'malformed child JSON output'});
 assert.equal(child.closed,true);assert.equal(child.result.exit,0);assert.equal(child.result.stdout,'{bad\n');assert.equal(child.result.stderr,'malformed-tail\n');assert.equal(child.result.events.at(-1),'close');
});
test('actual SIGKILL hot journal is rejected before new SQL and original bytes are retained',async t=>{
 const f=acquired(t,'hot-journal'),path=join(f.root,'writers.sqlite');const code=`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.pragma('cache_size=1');db.exec('BEGIN IMMEDIATE');const ins=db.prepare('INSERT INTO workers VALUES (?,?,?)');for(let i=0;i<10000;i++)ins.run('hot'+i,'generation'+i,'generation-dispatch');process.kill(process.pid,'SIGKILL');`;
 const c=childRun(f,code,[path]);assert.equal(c.signal,'SIGKILL');const journal=path+'-journal';assert.ok(fs.statSync(journal).size>512);fs.chmodSync(journal,0o644);const originals=[path,journal].map(p=>({path:p,bytes:fs.readFileSync(p),mode:fs.statSync(p).mode&0o777}));
 if(evidence)for(let i=0;i<originals.length;i++)save(join(evidence,'actual-hot-'+i+'.bin'),originals[i].bytes);
 const prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let begins=0;prototype.run=function(...args){if(this.source==='BEGIN'||this.source==='BEGIN IMMEDIATE')begins++;return run.apply(this,args);};try{await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/unsafe_owned_drain_path/);}finally{prototype.run=run;}
 assert.equal(begins,0);for(const x of originals)assert.deepEqual(fs.readFileSync(x.path),x.bytes);record(f,'actual-hot-originals',{signal:c.signal,begins,files:originals.map(({path,bytes,mode})=>({path,size:bytes.length,sha256:hash(bytes),originalMode:mode}))});
});
test('native initial and final COMMIT return-loss preserve unknown and never retry control writes',async t=>{
 for(const phase of ['initial','final']){const f=acquired(t,'unknown-'+phase,{task:false}),prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let count=0,hit=false;
  prototype.run=function(...args){const value=run.apply(this,args);if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='INSERT INTO events VALUES(?,?,?,?)')count++;if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='COMMIT'&&count===(phase==='initial'?1:2)&&!hit){hit=true;throw new Error('private COMMIT return loss');}return value;};
  let r;try{r=await consumeOwnedDrainIsolated(opts(f));}finally{prototype.run=run;}assert.equal(hit,true);assertBlocked(r);assert.equal(r.token,null);assert.equal(r[phase==='initial'?'entry_hold':'final_hold'],'unknown');assert.equal(writerNow(f).admission,phase==='initial'?'open':'closed');assert.equal(countAudit(f),phase==='initial'?3:4);record(f,'unknown-result',{result:r,state:ledgerNow(f),writer:writerNow(f)});
 }
});
test('confirmed final hold cleanup failure preserves first cancellation and COMMIT facts; no-cancel and owner error remain distinct',async t=>{
 for(const mode of ['cancel','generic','owner']){const f=acquired(t,'cleanup-'+mode,{task:mode!=='generic'}),close=Database.prototype.close,ctl=new AbortController(),prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let hit=false,armed=false;
  prototype.run=function(...args){const value=run.apply(this,args);if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='INSERT INTO events VALUES(?,?,?,?)'&&String(args[3]).includes('owned_drain_started'))armed=true;return value;};
  Database.prototype.close=function(){const matches=armed&&!this.readonly&&this.name===join(f.root,'writers.sqlite'),value=close.call(this);if(matches){hit=true;throw new Error('private cleanup failure');}return value;};
  try{const p=consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));if(mode!=='generic')ctl.abort({reasonCode:'cancelled'});
   if(mode==='owner'){const l=openLedger(f.root),state=l.inspect();l.hold({...f.token,revision:state.revision},'other_owner');l.close();}
   if(mode==='owner')await assert.rejects(p,/owned_drain_owner_revision_lost/);else {const r=await p;assert.equal(r.reason,mode==='cancel'?'cancelled':'owned_drain_cleanup_failed');assert.equal(r.token,null);assert.equal(r.entry_hold,'committed');assert.equal(r.final_hold,'committed');assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started',mode==='cancel'?'cancelled':'writer_drain_coverage_unknown']);record(f,'cleanup-result',r);}
  }finally{Database.prototype.close=close;prototype.run=run;}assert.equal(hit,true);
 }
});
test('opaque or throwing cancellation reason maps safely without asynchronous abort error',async t=>{
 const f=acquired(t,'reason-getter'),ctl=new AbortController(),p=consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));ctl.abort({get reasonCode(){throw new Error('private opaque cancellation');}});const r=await p;assert.equal(r.reason,'writer_drain_cancelled');assert.equal(r.final_hold,'committed');assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','writer_drain_cancelled']);record(f,'reason-getter-result',r);
});
test('event/row/TEXT and predicted two-hold capacities fail before initial mutation',async t=>{
 for(const mode of ['events','text','predicted']){const f=acquired(t,'capacity-'+mode),db=new Database(mode==='text'?f.path:join(f.root,'ledger.sqlite'));
  if(mode==='events') {const insert=db.prepare('INSERT INTO events VALUES (?,?,?,?)');for(let i=0;i<513;i++)insert.run(10000+i,'p','h','{}');}
  else if(mode==='text')db.prepare('UPDATE schema_migration SET version=? WHERE rowid=(SELECT min(rowid) FROM schema_migration)').run('x'.repeat(513));
  else {const snapshot=ledgerNow(f),insert=db.prepare('INSERT INTO events VALUES (?,?,?,?)');let previous=db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get().hash;delete snapshot.production_permitted;for(let seq=3;seq<=511;seq++){snapshot.revision++;snapshot.operations[f.token.operationId].revision=snapshot.revision;snapshot.operations[f.token.operationId].failures.push('r'+seq);const bytes=canonical(snapshot),next=hash(previous+'\n'+bytes);insert.run(seq,previous,next,bytes);previous=next;}f.token={...f.token,revision:snapshot.revision};f.input.consumer.a3.token=f.token;}
  db.close();const before=capture(f,'before-capacity');await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/owned_drain_capacity_exceeded|owned_drain_column_invalid/);assert.deepEqual(byteFacts(capture(f,'after-capacity-before-sql')),byteFacts(before));record(f,'capacity-output',{mode,noEntryOrClose:true});
 }
});
test('first cancel during actual COMMIT return-loss preserves primary reason with unknown phase and null authority',async t=>{
 for(const phase of ['initial','final']){const f=acquired(t,'cancel-unknown-'+phase,{task:false}),ctl=new AbortController(),prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let count=0,hit=false;
  prototype.run=function(...args){const value=run.apply(this,args);if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='INSERT INTO events VALUES(?,?,?,?)')count++;if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='COMMIT'&&count===(phase==='initial'?1:2)&&!hit){hit=true;ctl.abort({reasonCode:'cancelled'});throw new Error('private COMMIT return loss');}return value;};
  let r;try{r=await consumeOwnedDrainIsolated(opts(f,{signal:ctl.signal}));}finally{prototype.run=run;}assert.equal(hit,true);assert.equal(r.reason,'cancelled');assert.equal(r.token,null);assert.equal(r[phase==='initial'?'entry_hold':'final_hold'],'unknown');assert.equal(countAudit(f),phase==='initial'?3:4);record(f,'cancel-unknown-result',r);
 }
});
test('actual disconnected stdout yields fixed nonzero diagnostic, two durable holds and no retry',async t=>{
 const f=acquired(t,'stdout',{task:false});await withOwnedChildren(t,async children=>{
  const c=spawnOwnedChild(children,['ops/maintenance/owned-drain-cli.mjs',f.root,f.artifactRoot,String(Date.now()+5000),'10'],{label:'CLI disconnected stdout'});
  c.child.stdout.destroy();c.child.stdin.end(JSON.stringify(f.input));const result=await waitOwnedClose(c);
  assert.equal(result.exit,1);assert.equal(result.signal,null);assert.equal(result.stderr,'owned_drain_stdout_failed\n');assert.equal(countAudit(f),4);assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','writer_drain_coverage_unknown']);record(f,'stdout-output',result);
 });
});
test('actual signed fixture release/new owner between own check and close permits only conservative partial stop, never foreign hold',async t=>{
 const f=acquired(t,'partial-stop'),prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let snapshot,committed=false,hit=false;
 prototype.run=function(...args){
  if(this.database.name===join(f.root,'ledger.sqlite')&&this.source==='INSERT INTO events VALUES(?,?,?,?)'){const s=JSON.parse(args[3]);if(s.operations[f.token.operationId].failures.includes('owned_drain_started'))snapshot=s;}
  if(committed&&!hit&&this.database.name===join(f.root,'writers.sqlite')&&this.source==='BEGIN IMMEDIATE'){
   hit=true;const op=snapshot.operations[f.token.operationId],binding=bindingFor(op),evidenceBytes=canonical({schema:'fixture-process-stop-v1',...binding,remoteFixtureStopped:true,localControllerStopped:true,continuationsStopped:true,outcome:'NotSubmitted'}),digest=hash(evidenceBytes);
   fs.writeFileSync(join(f.root,'evidence-'+digest+'.json'),evidenceBytes,{mode:0o600});const payload={schema:'a3-authorization-v1',...binding,revision:op.revision,approverId:'fixture-reviewer',action:'release',reason:'synthetic partial stop race only',processesStopped:true,evidenceHash:digest},signed={payload,signature:sign(null,Buffer.from(DOMAIN+canonical(payload)),f.signingKey).toString('hex')};
   const c=childRun(f,`import {openLedger} from './ops/maintenance/ledger.mjs';const l=openLedger(process.argv[1]);l.authorize(JSON.parse(process.argv[2]));const req=JSON.parse(process.argv[3]);const token=l.acquire({...req,operationId:'op-foreign',ownerId:'foreign-owner'});console.log(JSON.stringify(token));l.close();`,[f.root,JSON.stringify(signed),JSON.stringify(f.request)]);assert.equal(c.status,0,c.stderr);
  }
  const value=run.apply(this,args);if(snapshot&&this.database.name===join(f.root,'ledger.sqlite')&&this.source==='COMMIT')committed=true;return value;
 };
 try{await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/owned_drain_owner_revision_lost/);}finally{prototype.run=run;}
 assert.equal(hit,true);const state=ledgerNow(f);assert.equal(state.active,'op-foreign');assert.deepEqual(state.operations['op-foreign'].failures,[]);assert.equal(writerNow(f).admission,'closed');assert.equal(state.operations[f.token.operationId].disposition,'released');record(f,'partial-stop-facts',{state,view:writerNow(f),authority:'none',fixtureSignedNegativeOnly:true});
});
test('physical marker/inode replacement after setup cannot reach initial hold',async t=>{
 const f=acquired(t,'marker-swap'),prepare=Database.prototype.prepare;let n=0,hit=false;
 Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...args){const value=get.apply(this,args);if(++n===7){hit=true;const path=join(f.root,'isolation.json');fs.renameSync(path,path+'.original');fs.writeFileSync(path,fs.readFileSync(path+'.original'),{mode:0o600});}return value;};}return stmt;};
 try{await assert.rejects(consumeOwnedDrainIsolated(opts(f)),/owned_drain_marker_changed/);}finally{Database.prototype.prepare=prepare;}assert.equal(hit,true);assert.equal(countAudit(f),2);assert.equal(writerNow(f).admission,'open');record(f,'marker-swap-result',{hit,audit:2});
});
test('actual earlier SIGINT during finite CLI stdin preserves cancelled rather than later deadline',async t=>{
 const f=acquired(t,'signal-cli'),before=capture(f,'before-signal-cli');const code=`const on=process.on;process.on=function(event,listener){const result=on.call(this,event,listener);if(event==='SIGTERM'){process.stderr.write('PRIVATE_READY\\n');process.send({kind:'owned-drain-signal-ready-v1',pid:process.pid});}return result;};process.argv=['node','owned-drain-cli',...process.argv.slice(1)];await import('./ops/maintenance/owned-drain-cli.mjs');process.disconnect();`;
 await withOwnedChildren(t,async children=>{
  const c=spawnOwnedChild(children,['--input-type=module','-e',code,f.root,f.artifactRoot,String(Date.now()+2500),'10'],{label:'CLI SIGINT',ready:{kind:'owned-drain-signal-ready-v1'}});
  await waitOwnedReady(c);c.child.stdin.write(JSON.stringify(f.input));assert.equal(c.child.kill('SIGINT'),true);const result=await waitOwnedClose(c);
  assert.equal(result.exit,1);assert.equal(result.signal,null);assert.equal(result.stdout,'');assert.equal(result.stderr,'PRIVATE_READY\ncancelled\n');assert.deepEqual(byteFacts(capture(f,'after-signal-cli-before-sql')),byteFacts(before));record(f,'signal-cli-output',{...result,sent:true});
 });
});
test('existing owned handles refuse newly unsafe true hot journal before next SQL and keep initial hold unknown',async t=>{
 const f=acquired(t,'cached-hot'),pending=consumeOwnedDrainIsolated(opts(f)),path=join(f.root,'writers.sqlite');
 const c=childRun(f,`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.pragma('cache_size=1');db.exec('BEGIN IMMEDIATE');const ins=db.prepare('INSERT INTO workers VALUES (?,?,?)');for(let i=0;i<10000;i++)ins.run('hot'+i,'generation'+i,'generation-dispatch');process.kill(process.pid,'SIGKILL');`,[path]);assert.equal(c.signal,'SIGKILL');const journal=path+'-journal';fs.chmodSync(journal,0o644);const original=fs.readFileSync(path),hot=fs.readFileSync(journal);assert.ok(hot.length>512);
 if(evidence){save(join(evidence,'cached-hot-database.bin'),original);save(join(evidence,'cached-hot-journal.bin'),hot);}
 const prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let begins=0;prototype.run=function(...args){if(this.source==='BEGIN'||this.source==='BEGIN IMMEDIATE')begins++;return run.apply(this,args);};try{await assert.rejects(pending,/unsafe_owned_drain_path/);}finally{prototype.run=run;}
 assert.equal(begins,0);assert.deepEqual(fs.readFileSync(path),original);assert.deepEqual(fs.readFileSync(journal),hot);record(f,'cached-hot-facts',{signal:c.signal,begins,databaseHash:hash(original),journalHash:hash(hot),journalSize:hot.length,originalJournalMode:644,entry:'confirmed initial hold; unknown task/sidecar; no recovery or continuation'});
});
