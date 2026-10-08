import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';
import { initialize, openLedger } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
import { initializeStagedTerminal } from './staged-terminal.mjs';
import { openDrainLeaseSource, observeDrain } from './drain.mjs';
import { consumeA2Isolated } from './a2-consumer.mjs';
import { canonical, bindingFor, hash } from './contract.mjs';
register();
const { openDb } = await import('../../src/lib/db/index.ts');
const { applyProvenanceMigrations } = await import('../../src/lib/db/provenance-migrations.ts');
const { insertTopic } = await import('../../src/lib/db/repos.ts');
const { createDeepDiveTraceRequest, claimNextGenerationDispatch } = await import('../../src/lib/db/provenance.ts');
const { openTerminalDispatchDriver } = await import('../../src/lib/runtime/terminal-dispatch-driver.ts');
process.umask(0o077);
// Exact public compose bytes from the frozen security-policy identity; never executed.
const compose="# 自托管单实例编排（architecture「部署」）：app(Web/Job Runner) + cron(容器内调度) + 持久卷。\n# 用法：cp .env.example .env.local 并填好 ANTHROPIC_API_KEY / AUTH_SECRET / ADMIN_* / CRON_SECRET，\n#       然后 `docker compose up -d --build`。两服务复用同一镜像（tag 锁定，不用 latest）。\n#\n# 工程名 = compose 自动取的目录 basename（本文件不写死 name:）。各 worktree 目录不同 →\n#   容器名与数据卷 <工程名>_insight-data 默认天然隔离，零配置即可并行起多套、互不串库。\n# ⚠️ 权威/生产实例（拥有真数据）必须在自己目录的 .env 钉 COMPOSE_PROJECT_NAME=deep-insight，\n#   否则换目录跑会回落新工程名 → 挂到新空卷、孤立现有数据（见 .env.compose.example）。\n# 同时起多套时各 worktree 还需设 APP_PORT（端口不随目录自动分配，缺省 3000 会相互占用）。\n\nservices:\n  migrate:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: \"no\"\n    env_file: [.env.local]\n    volumes:\n      - insight-data:/data\n    command: [\"node\", \"/app/ops/run-provenance-migrations.mjs\"]\n    healthcheck:\n      disable: true\n\n  # Strict production boot appends the already-resolved OCI digest before the Web\n  # process is allowed to become a writer.  Development explicitly leaves the gate\n  # at 0, so no made-up local image identity enters the audit trail.\n  deployment-record:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: \"no\"\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n    env_file: [.env.local]\n    volumes:\n      - insight-data:/data\n    environment:\n      PROVENANCE_DEPLOYMENT_REQUIRED: ${PROVENANCE_DEPLOYMENT_REQUIRED:-0}\n      INSIGHT_IMAGE_DIGEST: ${INSIGHT_IMAGE_DIGEST:-}\n      GIT_SHA: ${GIT_SHA:-}\n      DEPLOY_ACTOR: ${DEPLOY_ACTOR:-compose}\n    command: [\"node\", \"/app/ops/record-deployment.mjs\"]\n    healthcheck:\n      disable: true\n\n  app:\n    build:\n      context: .\n      args:\n        # 本机构建用 host 架构；amd64/arm64 均有 supercronic 校验和（见 Dockerfile）\n        TARGETARCH: ${TARGETARCH:-amd64}\n    # 本地开发默认用同名本地镜像；生产发布由 INSIGHT_IMAGE 注入不可变 GHCR sha 标签。\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n      deployment-record:\n        condition: service_completed_successfully\n    env_file: [.env.local]\n    ports:\n      - \"${APP_PORT:-3000}:3000\"\n    volumes:\n      - insight-data:/data\n    environment:\n      # Do not allow env_file to turn a production service into a development\n      # runtime and bypass the P1 admission gate.\n      NODE_ENV: production\n      # 只有 migration ledger 已确认最新 provenance schema 后，Web 才可成为写者。\n      PROVENANCE_SCHEMA_REQUIRED: \"1\"\n      # Release workflow sets this to 1 only after resolving repo@sha256 and\n      # passing it through the deployment-record writer.\n      PROVENANCE_DEPLOYMENT_REQUIRED: ${PROVENANCE_DEPLOYMENT_REQUIRED:-0}\n      INSIGHT_IMAGE_DIGEST: ${INSIGHT_IMAGE_DIGEST:-}\n    # 运行镜像是 slim、无 curl（见 Dockerfile）——healthcheck 必须用 Node fetch，否则探针永远失败、\n    # app 永不 healthy、cron(depends_on service_healthy) 起不来。与 Dockerfile 的 HEALTHCHECK 一致。\n    healthcheck:\n      test: [\"CMD\", \"node\", \"--no-warnings\", \"-e\", \"fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 20s\n\n  cron:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      app:\n        condition: service_healthy\n    env_file: [.env.local]\n    # 挂同一持久卷：cron 内每日备份任务（ops/backup-db.mjs）要直接读 /data/insight.db\n    # 并把备份写进 /data/backups。SQLite 在线备份 API 对 app 的并发写安全（WAL + 页级锁）。\n    volumes:\n      - insight-data:/data\n    environment:\n      # crontab 内 curl 的目标（容器网络内按服务名解析）\n      APP_URL: http://app:3000\n    command: [\"supercronic\", \"/app/ops/crontab\"]\n    # cron 跑 supercronic、非 Web 服务——禁用从镜像继承的 Web 健康探针（否则 fetch :3000 永远失败、误报 unhealthy）。\n    healthcheck:\n      disable: true\n\n  generation-dispatch-worker:\n    image: ${INSIGHT_IMAGE:-deep-insight:0.1.0}\n    restart: unless-stopped\n    depends_on:\n      app:\n        condition: service_healthy\n    env_file: [.env.local]\n    environment:\n      APP_URL: http://app:3000\n    command: [\"node\", \"/app/ops/generation-dispatch-worker.mjs\"]\n    # Give an in-flight request one 120s lease window to finish before Docker\n    # kills the worker.  Compose stops dependents before app, so app can keep\n    # heartbeating the current fenced claim during this drain.\n    stop_grace_period: 2m15s\n    healthcheck:\n      test: [\"CMD\", \"node\", \"--no-warnings\", \"/app/ops/generation-dispatch-healthcheck.mjs\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 30s\n\nvolumes:\n  insight-data:\n";
const policy=JSON.parse(fs.readFileSync(new URL('../aws/security-release-policy.json',import.meta.url),'utf8'));
const identity=Object.fromEntries(['repository','revision','platform','index_digest','manifest_digest','config_digest','compose_sha256'].map(k=>[k,policy[k]]));
const databases=['ledger.sqlite','writers.sqlite','fixture-business.sqlite','staged-terminal-v1/gate.sqlite'];
const markers=['isolation.json','writers-isolation.json','staged-terminal-v1/stage-isolation.json'];
const roles={schema:'schema.txt',migrations:'migrations.json',configuration:'configuration.json',data_sample:'data-sample.json',compose:'compose.yml',identity:'receipt-identity.json',security:'receipt-security.json',isolated_compatibility:'receipt-isolated-compatibility.json'};
const evidence=process.env.A2_A3_INTEGRATION_TEST_EVIDENCE;
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
 const parent=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'insight-a2-a3-combination-')));fs.chmodSync(parent,0o700);
 const root=join(parent,'maintenance'),artifactRoot=join(parent,'artifacts');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(artifactRoot,{mode:0o700});
 const {publicKey}=generateKeyPairSync('ed25519');const target={region:'isolated',instanceId:'fixture-controller-node',volumeId:'fixture-controller-volume',dataPath:root,serviceSet:['fixture-controller']};
 initialize(root,{target,approverId:'fixture-reviewer',publicKey:publicKey.export({type:'spki',format:'pem'})});initializeWriters(root);
 const path=join(root,'fixture-business.sqlite'),seed=openDb(path);fs.chmodSync(path,0o600);applyProvenanceMigrations(seed);
 insertTopic(seed,{id:'integration-topic',name:'Synthetic',keywords:[],language:'en',brief_schedule:'daily',enabled:true,archetype:'deep_vertical',facets:[]});
 createDeepDiveTraceRequest(seed,{topicId:'integration-topic',idempotencyKeyHash:'a'.repeat(64),planning:true});seed.pragma('wal_checkpoint(TRUNCATE)');seed.pragma('journal_mode=DELETE');seed.close();
 const request={operationId:'op-'+label,ownerId:'fixture-owner',kind:'backup',target,executionIdentity:'fixture-controller-v1'};
 t.diagnostic('retained own fixture '+parent);return {parent,root,artifactRoot,path,target,request,label};
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
 input.a2.context.configuration_sha256=put('configuration',{schema_version:'a2-isolated-configuration-v1',scope:'synthetic',values:{fixture:'integration',port:3140}});assert.equal(hash(compose),policy.compose_sha256);put('compose',compose);
 const clauses={identity:['isolated-runner',['actual_pull','compose_binding']],security:['isolated-runner',['native_six','builder_source_map_magicast','runtime_source_map','auth_reader_contract']],isolated_compatibility:['synthetic',['pre_release','target_new_data','post_migration','rollback_read_update','no_data_loss']]};
 for(const [kind,[scope,checks]]of Object.entries(clauses)){const claim={scope,result:'not-run',issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),binding:{...input.a2.context,rollback:identity},checks:Object.fromEntries(checks.map(k=>[k,false]))};const receipt_sha256=put(kind,{schema_version:'a2-owner-private-receipt-declaration-v1',kind,claim});input.a2.evidence[kind]={...claim,receipt_sha256};}
 return input;
}
test('actual A2 before-stop consumer then same-operation S2 replay cannot stop admission or acquire authority',async t=>{
 const f=fixture(t,'consumer-replay');capture(f,'initialized-before-sql');const l=openLedger(f.root);let token,state;try{token=l.acquire(f.request);state=l.inspect();}finally{l.close();}
 const w=openWriters(f.root);try{w.admit(w.register('integration-open-worker','generation-dispatch'));}finally{w.close();}
 const now=Date.now(),input=artifacts(f,state,token,now);record(f,'consumer-input',input);
 const before=capture(f,'before-consumer'),facts=logical(f);record(f,'before-logical',facts);
 const consumed=consumeA2Isolated({root:f.root,artifactRoot:f.artifactRoot,input,now});record(f,'consumer-output',consumed);
 assert.equal(consumed.isolated_consumer_integrated,true);assert.equal(consumed.phase_verified,false);assert.equal(consumed.observation_atomic,false);assert.equal(consumed.controller_uniqueness,'unknown');falsePerms(consumed);assert.equal(consumed.all_writer_coverage,false);assert.equal(consumed.commands_executed,false);assert.equal(consumed.a3.admission,'open');assert.equal(consumed.a3.queued,1);
 for(const key of ['deployment_permitted','rollback_permitted','database_restore_permitted','inverse_migration_permitted'])assert.equal(consumed[key],false);
 for(const role of ['identity','security','isolated_compatibility']){assert.equal(consumed.artifacts[role].authenticated,false);assert.equal(consumed.a2.declarations[role].verified,false);}
 assert.equal(consumed.approved_safe_rollback,null);assert.equal(consumed.a2.declarations.approval.verified,false);assert.ok(consumed.a2.blockers.includes('approval_missing_stale_or_misbound'));
 for(const role of ['production_compatibility','approval']){assert.equal(consumed.artifacts[role].missing,true);assert.equal(consumed.artifacts[role].authenticated,false);}
 assert.deepEqual(byteFacts(capture(f,'after-consumer-before-sql')),byteFacts(before));assert.deepEqual(logical(f),facts);
 const source=openDrainLeaseSource(f.root,f.path);let observed;try{observed=await observeDrain({root:f.root,request:f.request,deadlineAt:Date.now()+1000,pollEveryMs:10,leaseSource:source});}finally{source.close();}
 record(f,'drain-output',observed);assert.equal(observed.reason,'writer_drain_replay');assert.equal(observed.token,null);assert.equal(observed.polls,0);falsePerms(observed);
 assert.deepEqual(byteFacts(capture(f,'after-replay-before-sql')),byteFacts(before));const after=logical(f);record(f,'after-logical',after);assert.deepEqual(after,facts);assert.equal(after.writers.admission,'open');assert.equal(after.ledger.operations[token.operationId].state,'pre_submit');assert.equal(after.ledger.operations[token.operationId].disposition,'active');
});
test('actual S2 held timeout binds staged revoke, rejects late terminal, and offline S4a CLI cannot submit',async t=>{
 const f=fixture(t,'held-revoke-cli');capture(f,'initialized-before-sql');const driver=openTerminalDispatchDriver(f.root),db=driver.db;initializeStagedTerminal(f.root);const w=openWriters(f.root),control=w.stagedTerminalControl();
 t.after(()=>{w.close();driver.close();});const {admission}=w.registerStagedTerminal('integration-staged-worker',db,driver),cap=admission.admit(),claim=claimNextGenerationDispatch(db);assert.ok(claim);admission.bindClaim(cap,claim);
 const closed=control.closeAdmission(control.inspect().token),source=openDrainLeaseSource(f.root,f.path),businessBefore=fullBusiness(db),bytesBefore=capture(f,'before-drain');let observed;
 try{observed=await observeDrain({root:f.root,request:f.request,deadlineAt:Date.now()+1000,pollEveryMs:10,leaseSource:source});}finally{source.close();}
 record(f,'drain-output',observed);assert.equal(observed.reason,'writer_drain_timeout');assert.ok(observed.polls>0);assert.ok(observed.token);assert.equal(observed.sample.claimedCurrent,1);assert.equal(observed.sample.queued,0);assert.equal(observed.controller_uniqueness,'unknown');falsePerms(observed);const afterDrain=capture(f,'after-drain-before-sql');assert.deepEqual(fullBusiness(db),businessBefore);
 assert.equal(byteFacts(afterDrain).find(x=>x.relative==='fixture-business.sqlite').sha256,byteFacts(bytesBefore).find(x=>x.relative==='fixture-business.sqlite').sha256);
 const heldBefore=logical(f);record(f,'held-logical',heldBefore);const bound=control.bindDrain(closed,observed.token),revoked=control.revoke(bound,observed.token,'writer_drain_timeout');record(f,'stage-tokens',{closed,bound,revoked});
 capture(f,'after-revoke-before-sql');const stage=control.inspect();record(f,'revoked-stage',stage);falsePerms(stage);assert.equal(stage.stage.terminal,'revoked');assert.deepEqual(JSON.parse(stage.stage.drain_record).heldToken,observed.token);assert.deepEqual(JSON.parse(stage.stage.revoke_record).heldToken,observed.token);
 const beforeTerminal=capture(f,'before-terminal'),terminal=admission.commitOutcome(cap,claim,{status:'failed',error:{reason_code:'dispatch_failed',message:'dispatch_failed',retryable:false}});record(f,'terminal-result',terminal);
 assert.equal(terminal.code,'staged_terminal_revoked');assert.equal(terminal.kind,'not_committed');assert.equal(terminal.businessCommit,'not_committed');const afterTerminal=capture(f,'after-terminal-before-sql');assert.deepEqual(fullBusiness(db),businessBefore);
 assert.deepEqual(byteFacts(afterTerminal),byteFacts(beforeTerminal));const view=control.inspect();assert.equal(view.attempts.length,0);assert.equal(view.attempt_outcomes.length,0);
 const beforeCli=capture(f,'before-cli'),input={schema:'a3-ssm-controller-v1',token:observed.token};record(f,'cli-input',input);
 const cli=spawnSync(process.execPath,[join(import.meta.dirname,'controller-cli.mjs'),f.root,'stage-submit'],{input:JSON.stringify(input),encoding:'utf8',env:{PATH:process.env.PATH},timeout:5000});record(f,'cli-output',{status:cli.status,signal:cli.signal,stdout:cli.stdout,stderr:cli.stderr});
 assert.equal(cli.status,1);assert.equal(cli.signal,null);assert.equal(cli.stdout,'');assert.equal(cli.stderr,'invalid_maintenance_transition\n');
 assert.deepEqual(byteFacts(capture(f,'after-cli-before-sql')),byteFacts(beforeCli));const after=logical(f);record(f,'after-logical',after);assert.deepEqual(after.ledger,heldBefore.ledger);assert.deepEqual(after.business,heldBefore.business);
 const op=after.ledger.operations[observed.token.operationId];assert.deepEqual(op.failures,['writer_drain_timeout']);assert.equal(op.disposition,'held');assert.equal(op.commandId,null);assert.equal(op.submitToken,null);assert.equal(op.requestHash,null);
});
