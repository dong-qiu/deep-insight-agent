import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
 const f=acquired(t,'cli-positive',{task:false});capture(f,'before-cli');const child=spawnSync(process.execPath,['ops/maintenance/owned-drain-cli.mjs',f.root,f.artifactRoot,String(Date.now()+5000),'10'],{input:JSON.stringify(f.input),cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000});assert.equal(child.status,1,child.stderr);const r=JSON.parse(child.stdout);assertBlocked(r);assert.equal(r.final_hold,'committed');capture(f,'after-cli-before-sql');record(f,'cli-result',r);
 const fresh=acquired(t,'cli-input'),before=capture(fresh,'before-cli-input');
 for(const input of ['{bad',Buffer.from([255]),'x'.repeat(65537)]){const c=spawnSync(process.execPath,['ops/maintenance/owned-drain-cli.mjs',fresh.root,fresh.artifactRoot,String(Date.now()+5000),'10'],{input,cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000});assert.equal(c.status,1);assert.equal(c.stdout,'');assert.match(c.stderr,/^[A-Za-z0-9_-]+\n$/);}
 const {spawn}=await import('node:child_process'),c=spawn(process.execPath,['ops/maintenance/owned-drain-cli.mjs',fresh.root,fresh.artifactRoot,String(Date.now()+700),'10'],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.stdin.write(JSON.stringify(fresh.input));const exit=await new Promise(resolve=>c.on('exit',resolve));assert.equal(exit,1);assert.equal(stdout,'');assert.equal(stderr,'task_deadline_exceeded\n');assert.deepEqual(byteFacts(capture(fresh,'after-cli-input-before-sql')),byteFacts(before));record(fresh,'cli-noEOF-output',{exit,stdout,stderr});
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
 const c=spawnSync(process.execPath,['--input-type=module','-e',childPrelude+hook,cut],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},encoding:'utf8',timeout:10000});assert.equal(c.signal,'SIGKILL',c.stdout+c.stderr);
 const f=JSON.parse(c.stdout.trim().split('\n').at(-1));capture(f,cut+'-before-recovery');record(f,cut+'-child',{signal:c.signal,status:c.status,stderr:c.stderr});
 const state=ledgerNow(f),view=writerNow(f),op=state.operations[f.token.operationId];const initialCommitted=cut!=='initial-before',closed=['close-after','final-before','final-after'].includes(cut),finalCommitted=cut==='final-after';
 assert.equal(op.disposition,initialCommitted?'held':'active');assert.equal(view.admission,closed?'closed':'open');assert.deepEqual(op.failures,finalCommitted?['owned_drain_started','writer_drain_timeout']:initialCommitted?['owned_drain_started']:[]);assert.equal(state.revision,f.token.revision+(initialCommitted?1:0)+(finalCommitted?1:0));record(f,cut+'-recovered',{state,view,business:rowsNow(f)});
});
function childRun(f,code,args=[],input,timeout=10000){return spawnSync(process.execPath,['--input-type=module','-e',code,...args],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},input,encoding:'utf8',timeout});}
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
test('same-token concurrent actual processes get one strict initial winner, never duplicate entry or refresh loser',async t=>{
 const f=acquired(t,'two-process',{task:false}),{spawn}=await import('node:child_process');
 const code=`import Database from 'better-sqlite3';import {consumeOwnedDrainIsolated} from './ops/maintenance/owned-drain.mjs';let bytes='';for await(const c of process.stdin)bytes+=c;const input=JSON.parse(bytes),prepare=Database.prototype.prepare,prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let count=0;Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql==='SELECT count(*) AS n FROM events'){const get=stmt.get;stmt.get=function(...a){count++;return get.apply(this,a);};}return stmt;};prototype.run=function(...a){const result=run.apply(this,a);if(count===7&&this.source==='COMMIT'&&this.database.readonly&&this.database.name===input.root+'/ledger.sqlite'){process.send({ready:true});process.kill(process.pid,'SIGSTOP');}return result;};try{const r=await consumeOwnedDrainIsolated(input);console.log(JSON.stringify(r));}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=2;}process.disconnect();`;
 const children=[];const start=()=>{const c=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},stdio:['pipe','pipe','pipe','ipc']});children.push(c);let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);const done=new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',exit=>resolve({exit,stdout,stderr}));});const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill('SIGCONT');reject(new Error('private barrier deadline'));},4000);c.once('message',()=>{clearTimeout(timer);resolve();});c.once('exit',()=>{clearTimeout(timer);reject(new Error('child exited before private barrier: '+stdout+stderr));});});c.stdin.end(JSON.stringify(opts(f,{deadlineAt:Date.now()+10000})));return {c,done,ready};};
 let results;try{const a=start();await a.ready;const b=start();await b.ready;children.forEach(c=>c.kill('SIGCONT'));results=await Promise.all([a.done,b.done]);}finally{children.forEach(c=>{if(c.exitCode===null)c.kill('SIGCONT');});}
 const parsed=results.map(r=>JSON.parse(r.stdout));assert.equal(parsed.filter(r=>r.entry_hold==='committed').length,1);assert.equal(parsed.filter(r=>r.token!==undefined&&r.token!==null).length,1);const op=ledgerNow(f).operations[f.token.operationId];assert.deepEqual(op.failures,['owned_drain_started','writer_drain_coverage_unknown']);record(f,'two-process-results',results);
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
 const f=acquired(t,'stdout',{task:false}),{spawn}=await import('node:child_process'),c=spawn(process.execPath,['ops/maintenance/owned-drain-cli.mjs',f.root,f.artifactRoot,String(Date.now()+5000),'10'],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},stdio:['pipe','pipe','pipe']});let stderr='';c.stderr.on('data',b=>stderr+=b);c.stdout.destroy();c.stdin.end(JSON.stringify(f.input));const exit=await new Promise(resolve=>c.on('exit',resolve));assert.equal(exit,1);assert.equal(stderr,'owned_drain_stdout_failed\n');assert.equal(countAudit(f),4);assert.deepEqual(ledgerNow(f).operations[f.token.operationId].failures,['owned_drain_started','writer_drain_coverage_unknown']);record(f,'stdout-output',{exit,stderr});
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
 const f=acquired(t,'signal-cli'),before=capture(f,'before-signal-cli'),{spawn}=await import('node:child_process');const code=`const on=process.on;process.on=function(event,listener){const result=on.call(this,event,listener);if(event==='SIGTERM')process.stderr.write('PRIVATE_READY\\n');return result;};process.argv=['node','owned-drain-cli',...process.argv.slice(1)];await import('./ops/maintenance/owned-drain-cli.mjs');`;
 const c=spawn(process.execPath,['--input-type=module','-e',code,f.root,f.artifactRoot,String(Date.now()+2500),'10'],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'3150'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);let sent=false;c.stderr.on('data',b=>{stderr+=b;if(!sent&&stderr.includes('PRIVATE_READY')){sent=true;c.stdin.write(JSON.stringify(f.input));c.kill('SIGINT');}});const exit=await new Promise(resolve=>c.on('exit',resolve));assert.equal(exit,1);assert.equal(stdout,'');assert.equal(stderr,'PRIVATE_READY\ncancelled\n');assert.deepEqual(byteFacts(capture(f,'after-signal-cli-before-sql')),byteFacts(before));record(f,'signal-cli-output',{exit,stdout,stderr,sent});
});
test('existing owned handles refuse newly unsafe true hot journal before next SQL and keep initial hold unknown',async t=>{
 const f=acquired(t,'cached-hot'),pending=consumeOwnedDrainIsolated(opts(f)),path=join(f.root,'writers.sqlite');
 const c=childRun(f,`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.pragma('cache_size=1');db.exec('BEGIN IMMEDIATE');const ins=db.prepare('INSERT INTO workers VALUES (?,?,?)');for(let i=0;i<10000;i++)ins.run('hot'+i,'generation'+i,'generation-dispatch');process.kill(process.pid,'SIGKILL');`,[path]);assert.equal(c.signal,'SIGKILL');const journal=path+'-journal';fs.chmodSync(journal,0o644);const original=fs.readFileSync(path),hot=fs.readFileSync(journal);assert.ok(hot.length>512);
 if(evidence){save(join(evidence,'cached-hot-database.bin'),original);save(join(evidence,'cached-hot-journal.bin'),hot);}
 const prototype=Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')),run=prototype.run;let begins=0;prototype.run=function(...args){if(this.source==='BEGIN'||this.source==='BEGIN IMMEDIATE')begins++;return run.apply(this,args);};try{await assert.rejects(pending,/unsafe_owned_drain_path/);}finally{prototype.run=run;}
 assert.equal(begins,0);assert.deepEqual(fs.readFileSync(path),original);assert.deepEqual(fs.readFileSync(journal),hot);record(f,'cached-hot-facts',{signal:c.signal,begins,databaseHash:hash(original),journalHash:hash(hot),journalSize:hot.length,originalJournalMode:644,entry:'confirmed initial hold; unknown task/sidecar; no recovery or continuation'});
});
