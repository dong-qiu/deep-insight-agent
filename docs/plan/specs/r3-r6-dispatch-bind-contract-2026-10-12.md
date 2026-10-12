# Dispatch-bind：固定值桥、单步 catalog 与合成 fixture 合同

## 执行单与状态

本线为 sole 作者；本片仅新增本 spec、[移交收据](../../verify/r3-r6-dispatch-bind-owner-transfer-2026-10-12.md)与专属私有证据，不创建/修改源码或执行 SQL/DB/runtime/测试/模型/资格/生产。主控接受 bind-only 子步方向；本文的精确新 marker/catalog/fingerprint/API 仍为新提案，需主控及原架构/DB owner 对新增语义认领后才可授予代码窗，文档审查不代签实现。截止 2026-10-12T01:26:40Z 不延长。

文档分支基线是 actual main `e5239dfbdcdb822bac58bb11cae21444300f03c2`。S2a 实现事实源是未合入的 [6a180fc7](https://github.com/dong-qiu/deep-insight-agent/blob/6a180fc7cb5545a922531152011c6ee3ef25fded/ops/maintenance/writers-v2.mjs)，不能冒称 main 已有这些 API。其 source 两轮、独立 build 一轮和 baseline CI38182763609/1 full success 只解释原实现；PR480 未获合入授权；旧 main479 失败原件保留，PR481 的独立修复及新 main CI 不回填旧失败。本合同不是旧 S2a/S2b 第三轮。

范围只有预置可信合成 claim/run 上的单个 dispatch-bind SELECT + 空业务 COMMIT + registry ACK。0 newDatabase、claimNext、insertRun、usage/model/terminal DML；没有 preclaim producer、真实任务接线、source 七字段 cap、observer/M1/M2、raw/report 或完整 dispatch 完成。现三 runtime 候选、三 native 值桥候选均未创建、未开启源码用途。

## 必需的新 profile 与精确 registry DDL 增量

actual S2a 的 `markerRead`（6a:106–116）先 exact 六键/原 schema/targets，再 `openWritersV2`（204–207）构造 SQLite。其 row validator 只支持 open-business/ordinal0、每 op 一步、纯物理 binding。原 marker 下扩 payload 会让旧 reader 在新 fact 写入前仍接收旧 startup，不能声称格式未变且前置拒绝。因此提出 **独立新 root/profile**，绝不原地升级旧 v2 root，旧默认 API 不自动协商新 profile。

原 default v2 的 application_id `0x41335732`、user_version `2`、10 tables/20 triggers/12 autoindices manifest SHA256 `69808d1c66bc7b155dccb1387f4e8af626ef71fa2a08fbf8536227af79c3c480` 与 [原精确格式](r3-r6-s2a-v2-format-2026-10-12.md)一致。原 terminals.outcome **有五值 CHECK**，不能写入 binding_completed；首轮发现该冲突，原错误候选保留。

新 profile 使用同 application_id、**user_version `3`**，仅新 root 的 terminals CREATE SQL 增加一个 CHECK 成员，精确 SQL如下（不含末semicolon）。其它九表 SQL、二十 trigger、十二 autoindex_columns 原字节不变；无新增 column/table/trigger/index。新完整 manifest SHA256 `ca0a81b1ada410e0f52d9d3be233377771e7f959b405ac81cbf3e855c7427e5d`，由原manifest仅改 user_version 与该SQL得到，原 inputs/registry-format-v2.json 不覆盖；新增 inputs/dispatch-bind-registry-format-v1.json 保留逐字节定义。新header/SQL/catalog仅是待冻结提案，不凭旧审查批准。

```sql
CREATE TABLE terminals (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), outcome TEXT NOT NULL CHECK(outcome IN ('completed','completed_with_diagnostics','denied','cancelled','interrupted_unknown','binding_completed')), first_reason TEXT NOT NULL)
```

新 opener 在 marker 通过后、任何业务操作前严格核 user_version3 与新manifest；原默认 v2仍核 user_version2 与原manifest。不得 ALTER/迁移既有root；伪造旧六键marker也会在原registry header/schema验证拒绝，不可绕过到业务。steps.ordinal/input_hash 和 bindings.identity_json 沿原列承载严格载荷。

新 marker exact 八键：`schema,initId,ledgerMarkerHash,root,registry,targets,catalog,fixtureFingerprint`。schema 固定 `a3-writers-isolation-v3-dispatch-bind-v1`，catalog 固定 `dispatch-bind-v1`，fixtureFingerprint 固定 `cc57b8b610500d9b57f0a41ead782df4a4ea7eaef359c87eda94adbcfd44a5c3`。其余值沿原 root/dev/ino、writers.sqlite/dev/ino、S0 marker hash；targets 固定 `{business:'d2-business.sqlite',raw:'raw',report:'report'}`。新 root 必须新建并隔离，uid/mode/link/sidecar、固定 isolated S0 target 与原 v2 相同；禁止旧 identity/marker/registry/business 迁移或重写，不 copy live DB/旧 fixture/env。

拟新增两 core exports：`initializeDispatchBindRegistryV2(root)`（仅固定新 registry/profile）、`openDispatchBindRegistryV2(root)`。原 `initializeWritersV2/openWritersV2` 仍只接受原六键/schema，原 marker、SQL、startup/local-seed 输入与 empty-preopen 语义不改；新 opener只接受上述八键、catalog、固定F，unknown marker/catalog/F 在任何 SQLite constructor 前拒绝。新 registry 的 startup/local-seed cap 仍由原私有映射登记；原 `openV2BusinessTarget` 通过实际原 owner handle 内固定 preopen 闭包取得 target，不通过 caller DB。测试 fixture 先以 local-seed 原 scope/原signal 准入、固定空 target pre-open，再由另授予的 fixture-setup actor应用下述数据定义；**初始化业务 fixture不在 bind API内、不在本片执行**。该测试安排不证明实际 producer 已获准入。

| 读者/动作 | 对新 root 的真实拒绝/接受前置 |
| --- | --- |
| actual6a 原 openWritersV2/control/runtime 对八键 marker | marker exact 六键先报 `v2_invalid_record`，在 registry SQLite constructor 与业务前失败；无自动fallback |
| 未来原默认 opener /旧 marker reader | 保留上述顺序，不能把新版识别写入旧默认 API；原旧 root字节可继续旧 startup/local-seed |
| 新 opener遇未知catalog/F/篡改schema | marker读取阶段拒绝，0SQLite构造；不能先register/step再发现不认识 |
| 新 bind factory遇旧root cap/跨handle cap或旧target | 私有 owner/profile/cap检查拒绝，0reservation/business；同路径/inspect/SQL值不是cap |
| 新profile新reader遇未知 step/fact/extra payload或ordinal>0 | registry validate-before-mutation 拒绝并保原件；不泛化接受任意step |
| 旧 v1/S0/直接SQL等其它未接线消费者 | 不冒称全writer fence；S0不改、不把新profile资格向其它consumer外推 |

本 profile只认可原 startup/local-seed open-business 和新的 dispatch-bind 单步；其它 entry 可以观察既有六类inventory，但不能通过本新catalog获业务操作。原预打开 cap与dispatch cap必须来自**同一个原 registry handle**；同根的另handle、克隆或重启读行也不等于原cap。闭合目标范围的新 inspect/close 由新 opener返回的固定 handle 执行；旧 control wrapper仍拒绝新marker，不能冒称旧control已支持。runtime新模块可提供具名 inspect/close wrappers，native child直接使用新 core handle，0新CLI/新通用controller。所有 inventory继续 writer_quiescence/drain_ready/production_permitted=false。

## 单步接口、输入和固定值桥

新 core具名 export `bindDispatchDomainV2(operation,target,run)`；三参数只能是原 operation、原target和strict `{runId,traceId}`。operation scope沿已有 exact `{kind:'dispatch',purpose:'usage'|'terminal',claim:{dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId}}`，entry是generation-dispatch、required原native AbortSignal；不新增claim-next/prelude/observer scope。scope值只登记意图，下面真实SQL才认证claim/run。terminal目的 runId必为scope.rootRunId；usage目的 child run须running。所有 id按既有对象ID值规则冻结且最大128，epoch正safe integer，额外键/Proxy/accessor/symbol/非plain值拒绝。

固定值桥候选 `ops/maintenance/dispatch-bind-values-v2.mjs` 仅导出深冻结固定 SELECT/fixture manifest、strict primitive参数/row校验函数，声明与node-test另两新文件。**不导出接受connection、SQL、driver、factory或callback的函数，不 import runtime TS/虚构repo.js，不执行SQL/构造DB/读env/Date。** core静态import固定值，DB只来自targetCaps私有原native connection；SQL由core用固定文本和内部参数执行，不能从 public target.db getter/用户替换方法取得授权或SQL方法。业务native prepare/exec调用应绑定真实原生连接/方法，单测fault只能在owned test process观测真实原调用，不给product callback/test-hook入口。

下面 SELECT 固定文本（不含末尾LF/semicolon）SHA256 `d26881b619b0918acb4176b751a98728a7d314be9b04943ae4cb6be573e1a2dc`。core在business BEGIN后私有采样 current ISO `nowPre`，在COMMIT前重新采样 `nowCommit`、重跑同 SELECT并核物理/原signal。caller无clock参数；clock回退则保守拒绝，记录首因而不伪造新时间。两个时钟记录在结果binding，不作为caller输入或重放权限。

```sql
SELECT d.id AS dispatch_id,d.trace_id,d.owner_token,d.claim_epoch,l.fencing_epoch,
       t.root_run_id,child.id AS run_id,child.trace_id AS run_trace_id,child.status AS run_status
FROM generation_dispatch d
JOIN generation_lease l ON l.trace_id=d.trace_id
JOIN generation_trace t ON t.id=d.trace_id
JOIN run root ON root.id=t.root_run_id
JOIN run child ON child.id=@run_id AND child.trace_id=t.id
WHERE d.id=@dispatch_id AND d.trace_id=@trace_id AND d.state='claimed'
  AND d.owner_token=@owner_token AND d.claim_epoch=@claim_epoch AND d.lease_expires_at>=@now_iso
  AND l.state='owned' AND l.owner_token=@owner_token AND l.fencing_epoch=@fencing_epoch AND l.expires_at>=@now_iso
  AND t.root_run_id=@root_run_id AND root.trace_id=t.id
  AND (@purpose='terminal' OR child.status='running')
  AND (@purpose='usage' OR child.id=root.id)
```

命名参数exact：`dispatch_id,trace_id,owner_token,claim_epoch,fencing_epoch,root_run_id,run_id,purpose,now_iso`。除run外从私有原 scope提取；now从core current clock；run.traceId必须等scope.traceId。返回exact九列为SQL AS字段，native数值仍须safe整数。dispatch/lease predicates逐条件等价于 provenance.ts:133–142（claimed/owned、token/epoch、两 expiry>=current）；root/child join沿旧usage-driver:113–127；usage要求running仅对应旧 usage begin 分支；旧 observation settle 允许非running，本 bind 不接 observer，因此统一running是明确的新保守限制，不声称全旧driver等价。terminal强制child就是root，等价原terminal-driver:77–81 implicit root选择。第二次同query/clock回退拒绝是明确的保守COMMIT前约束。桥语义仍须原 provenance/schema owner只读认领，不因新文件归S就说canonical SQL已获签；无需移交或编辑这些既有DB文件。

## 逐字节 input/hash/ACK/terminal 关系

catalog唯一新step是 `dispatch-bind`，ordinal恒0；一个dispatch op只能一次。其pre-open在**不同 startup/local-seed operation**，不在dispatch op先插open-business。保留全op steps<=1，不顺带开放多步。私有 target的creator operation/step必须已有原open-business committed+ACK result/binding，native DB open、同owner、同marker/S0/路径/inode/parent，且无已有business transaction；creator已正常finish不撤销已确认preopen，但其真实step/原target不能被重建。

步骤 inputJson 是 canonical 以下exact字段对象；所有派生身份由core取原映射/已ACK行，caller不提供scopeHash/targetStepId/F/clock：

```text
{kind:'dispatch-bind',catalog:'dispatch-bind-v1',operationId,scopeHash,targetStepId,
 targetIdentity:{path,dev,ino,parent:{path,dev,ino},creation},
 fixtureFingerprint:F,purpose,claim:{dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId},
 run:{runId,traceId}}
inputHash = SHA256(UTF8(canonical(inputJson parsed value)))
scopeHash = SHA256(UTF8(original canonical scope_json))
```

`step_reserved` fact在本step exact增加 `inputJson`（canonical JSON字符串）；其它字段仍kind/stepId/operationId/stepKey/ordinal/inputHash。rows.steps的每列完整由fact覆盖，fact内canonical input重新strict解析/hash，并核operation.scope/creator targetStepId/F。open-business fact在新profile仍用原字段/hash，不能把新inputJson放宽到旧step。

第二阶段顺序固定：reservation事务确定COMMIT →重新registry BEGIN IMMEDIATE核门/代际/原cap/未消费step → S0同步inspect事务结束 →同私有business BEGIN IMMEDIATE →完整schema fingerprint/原claim/run SELECT →原signal/物理/currentclock再次核及同SELECT →空outer业务COMMIT →同registry ACK(result+binding+terminal/facts)确定COMMIT →返回cap。锁不跨await；不能持business txn再取S0或registry，已有reverse transaction在任何S0/registry锁前拒绝。业务SQL全部SELECT，没有schema/claim/Run/usage/terminal写。多库不承诺原子。

success rows.step_results exact仍 `{step_id,business_commit:'committed',filesystem_json:'[]',disposition:'completed',reason:'dispatch_bind_verified'}`。fact exact仍kind/stepId/businessCommit/filesystemJson/disposition/reason/binding；bindings.target_kind仍business，identity_json新增**仅dispatch-bind**的exact domain字段：

```text
{path,dev,ino,parent:{path,dev,ino},creation,
 domain:{catalog:'dispatch-bind-v1',inputHash,fixtureFingerprint:F,targetStepId,purpose,
 claim:{dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId},run:{runId,traceId},
 checkedAtPre,checkedAtCommit}}
```

physical字段继承原target binding（creation记录原目标创建事实，不说bind创建文件），domain/input/clock与reservations及原scope/creator关联全核。success唯一追加terminal为 `binding_completed` / first_reason `dispatch_bind_verified`，与ACK同registry事务；这是新的**绑定phase enum**，不是dispatch业务done/finished/Run完成。原terminals五值CHECK不允许此enum，故仅新profile采用上文精确六值CHECK/user_version3；新profile reader只对该已committed result允许该enum，原profile OUTCOMES不改且仍拒绝。不允许调用普通completed来签整个usage/terminal op。cap是新Object.freeze空opaque对象，只有core私有WeakMap记录binding；不能从JSON/SQL/restart恢复，不含DB，也未授权任何后续业务。

七种fact kind仍initialized/registered/admitted/step_reserved/step_result/terminal/closed，hash链与表→fact双向完整覆盖不变。newmarker在identity/initialized完整覆盖；newstep extra inputJson、binding domain、binding_completed只由新profile exact reader认可。零步拒绝可terminal denied/cancelled；未ACK reservation/unknown result只interrupted_unknown；成功bind却无binding_completed或终态先于result均拒绝。已经close后的合法phase ACK只可记录拒绝，不执行业务；COMMIT先胜过晚取消/close的已确认事实不改写。close自己串行在registry锁后只能见已ACK成功或pending库存；它不是drain。

返回新bind result有限union：

```text
committed: {kind:'committed',businessCommit:'committed',coordination:'acknowledged',
            replayed:false,noop:false,binding:opaqueBoundCap}
not_committed: {kind:'not_committed',businessCommit:'not_committed'|'not_applicable',
                coordination:'acknowledged'|'not_attempted',code}
unknown: {kind:'unknown',businessCommit:'committed'|'unknown'|'not_committed'|'not_applicable',
          coordination:'acknowledged'|'unknown',code}       // never binding cap
consumed: {kind:'consumed',businessCommit:'not_applicable',coordination:'not_attempted',
           code:'bind_capability_consumed'}                // no new SQL/COMMIT/ACK
```

这是bind-specific新值类型，原PreopenResult不改；not_attempted明确没有本次registry ACK，不冒称新提交。第一次调用消耗此attempt；同cap重复只是consumed，不重放cap、不改首因、不把原成功改为rollback；同worker同scope再admit仍冲突。无 completed_noop/replay-success 本片API；零DML仍执行真实empty COMMIT，所以replayed/noop均false。业务COMMIT抛错时business=unknown，即使clean-up ROLLBACK成功；ACK已明确落unknown记录则coordination=acknowledged，如ACK抛错则unknown。业务正常COMMIT后ACK失败为business=committed/coordination=unknown、0cap。reservation COMMIT unknown不进business；unknown全部停后续，不恢复旧cap。错误首因固定并持久化于可确认的phase fact；ack失败留下pending/unknown，不能invent terminal/写旁路诊断。此精确union比旧S2b概念模板细分ACK与未尝试，作为新增bind值合同待冻结，不回写旧spec。

## 精确最小业务 fixture（只定义，未执行）

fixture application_id `0x44324231`、user_version1；不是生产schema版本/全迁移证明。对象20：七表+十二autoindex+一个explicit partial unique index，无trigger/其它对象（sqlite内部不可见持久对象也不得偷加）。DELETE/FULL/FK ON、database_list恰一main且是原target路径；foreign_key_check须空。current S2a只做empty pre-open，不初始化该fixture，不publish_db。另授予的test-setup actor需在同target/owned root建立这些初始状态，不能生产getDb/bootstrap/migrate或复制旧/live DB。

下面 final fixture DDL来源为版本化schema.ts的source/topic/run及migration-definitions core/v08，run.trace_id/source_id在**final CREATE**显式列出；不声称执行原迁移。schema_migration不在fixture，不写假48checksum；原assertProvenanceSchema会拒绝它，这是预期，binder使用独立完整fixtureF，不称全应用ready。model_usage_attempt/generation_event等后续表故意不在profile，usage/terminal/source/observer明确unsupported。production readiness、preclaim与M1/M2一律不因本fixture成立。

```sql
CREATE UNIQUE INDEX idx_generation_lease_active ON generation_lease(active_key) WHERE state IN ('reserved','owned');
```

```sql
CREATE TABLE generation_dispatch (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES generation_trace_request(id),trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,claim_epoch INTEGER NOT NULL DEFAULT 0,owner_token TEXT,claimed_at TEXT,heartbeat_at TEXT,lease_expires_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
```

```sql
CREATE TABLE generation_lease (id TEXT PRIMARY KEY,active_key TEXT NOT NULL,scope_key TEXT NOT NULL,trace_id TEXT NOT NULL REFERENCES generation_trace(id),state TEXT NOT NULL,owner_token TEXT,fencing_epoch INTEGER NOT NULL DEFAULT 0,heartbeat_at TEXT,expires_at TEXT,created_at TEXT NOT NULL,released_at TEXT);
```

```sql
CREATE TABLE generation_trace (id TEXT PRIMARY KEY,request_id TEXT UNIQUE,scope_kind TEXT NOT NULL,trigger_kind TEXT NOT NULL,topic_id TEXT REFERENCES topic(id),root_run_id TEXT REFERENCES run(id) DEFERRABLE INITIALLY DEFERRED,status TEXT NOT NULL,completion_policy TEXT NOT NULL,coverage TEXT NOT NULL DEFAULT 'complete',runtime_version TEXT NOT NULL DEFAULT '{}',summary TEXT NOT NULL DEFAULT '{}',next_sequence INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT,retry_of_trace_id TEXT REFERENCES generation_trace(id),source_id TEXT REFERENCES source(id));
```

```sql
CREATE TABLE generation_trace_request (id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,active_key TEXT NOT NULL,idempotency_key_hash TEXT,request_sequence INTEGER NOT NULL DEFAULT 1,trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),state TEXT NOT NULL,retained_until TEXT NOT NULL,created_at TEXT NOT NULL);
```

```sql
CREATE TABLE run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ingest','analyze','validate','report-gen')),
  target      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  cost        TEXT,
  error       TEXT,
  retry_of    TEXT REFERENCES run(id),
  inserted    INTEGER,
  trace_id TEXT
);
```

```sql
CREATE TABLE source (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('rss','arxiv','api')),
  endpoint       TEXT NOT NULL,
  topic_ids      TEXT NOT NULL DEFAULT '[]',
  fetch_interval TEXT NOT NULL,
  backfill       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  fetch_mode     TEXT NOT NULL DEFAULT 'feed' CHECK (fetch_mode IN ('feed','full_text')),
  content_container TEXT,
  transcript_mode TEXT NOT NULL DEFAULT 'off' CHECK (transcript_mode IN ('off','observe','enabled')),
  transcript_strategy TEXT NOT NULL DEFAULT 'relevant_only' CHECK (transcript_strategy IN ('all','relevant_only')),
  transcript_max_items_per_run INTEGER NOT NULL DEFAULT 5 CHECK (transcript_max_items_per_run > 0),
  transcript_max_bytes_per_run INTEGER NOT NULL DEFAULT 5242880 CHECK (transcript_max_bytes_per_run > 0),
  transcript_timeout_budget_ms INTEGER NOT NULL DEFAULT 30000 CHECK (transcript_timeout_budget_ms > 0),
  transcript_host_qps REAL NOT NULL DEFAULT 0.5 CHECK (transcript_host_qps > 0),
  transcript_policy_version TEXT,
  disabled_reason TEXT,
  disabled_at     TEXT,
  circuit_reset_at TEXT,
  last_probe_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (transcript_mode = 'off' OR (transcript_policy_version IS NOT NULL AND length(trim(transcript_policy_version)) > 0))
);
```

```sql
CREATE TABLE topic (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',
  language       TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),
  brief_schedule TEXT NOT NULL CHECK (brief_schedule IN ('daily','weekly')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  -- ADR-0010 行为原型：无 DB CHECK（app 层 ARCHETYPE_VALUES 校验，加原型零迁移，reference-data 模式）
  archetype      TEXT NOT NULL DEFAULT 'deep_vertical',
  -- ADR-0010 分面标签（JSON 数组，如 ["domain:software-engineering","lens:business"]）：分类维度 domain(必填)+lens(选填)。
  facets         TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

exact autoindex null-SQL名字：source_1、topic_1、run_1、generation_trace_1/_2、generation_trace_request_1/_2/_3、generation_dispatch_1/_2/_3、generation_lease_1，均加 `sqlite_autoindex_` 前缀；type=index/tbl_name各原表/sql=null。完整对象按(type,name,tbl_name)排序，每个actual sqlite_master(type,name,tbl_name,sql)必须逐值等上述CREATE文本去末semicolon及null索引；无宽松“表存在”。F=SHA256(UTF8(canonical({format:'dispatch-bind-fixture-v1',application_id:0x44324231,user_version:1,objects:[上述20exact对象]})))=`cc57b8b610500d9b57f0a41ead782df4a4ea7eaef359c87eda94adbcfd44a5c3`。manifest保存于专属证据inputs/fixture-manifest-v1.json；comment/空白均属这里明确的SQL字节，不按regex近似SQLite规则。**本片只声明expected元数据，未在SQLite执行/证成；实现验收先用真实native SQLite创建并逐对象核其实际输出，不一致即停/fix新合同，不放宽fingerprint。**

合成正例：topic_bind_fixture、trace_bind_fixture、request_bind_fixture、dispatch_bind_fixture、lease_bind_fixture、owner_bind_fixture；claimEpoch=fencingEpoch=1，root run_bind_root(analyze)、child run_bind_child(validate)均running且trace_id=trace_bind_fixture；dispatch claimed/lease owned，两个expiry=2099-01-01T00:00:00.000Z，scope_key=bind_fixture_scope、active_key=bind_fixture_active。按source/topic/run/trace/request/dispatch/lease顺序设置；source空，topic有name/language zh/brief_schedule daily，其它合法默认值；run target合成topic JSON、started_at=2026-10-12T00:00:00.000Z；trace scope_kind topic_pipeline、trigger_kind api、completion_policy='{}'仅bind fixture不用于projection；request accepted/retained_until2099；dispatch合法payload {schema_version:1,topic_id,planning:false,report_type:'brief'}及requiredcreated/updated时间。余NOT NULL用本文DDL默认；完整正例row集见inputs/fixture-positive-rows-v1.json。usage run=child；terminal run=root，允许fixture单独把root.status置done仍owned来验证terminal选择。无调用真实claimNext来制造这些值，无模型，fixture setup不是业务准入成果。

负例以独立owned初始SQL mutation逐一变 dispatch token/claimEpoch/state/expiry、lease token/fencingEpoch/state/expiry、trace.root_run_id/root.trace_id/child.trace_id/child.status/terminal runId、drop/extra对象/DDL/check/FK/header/sidecar/inode；每次实际SQL事实可观察，不能mock .prepare结果或只测regex。sourcebound7与prelude7不在新scope，同类值或cap拒绝，不能cast代入。

## 收敛验收与后续实施包

| 路径（全部待未来执行） | 实际证明 / 范围 |
| --- | --- |
| 新profile registry精确格式 | 新header3/单表CHECK增量/10·20·12全元数据；默认v2及伪旧marker拒绝路径，先证真实SQL后谈ACK |
| 原S2a回归 | 原root startup/local-seed 37Node/3runtime受影响原用例必要复用/执行；默认marker/DDL/输入/COMMITunknown保持，不重审旧算法 |
| 1. native fixture manifest | 7/12/1真实sqlite_master/header/FK/同connectionF，先证schema；0getDb/migration/livecopy |
| 2. usage/terminal目的bind正例 | 两真实JOIN条件、空outerCOMMIT/ACK+binding_completed，仅boundcap；0constructor/claim/Run/model/usage/terminal DML |
| 3. 真claim/run/时钟负例 | 每列与pre/commit expiry/clock回退变体SQL拒绝，第一首因/0cap；terminal不要求root.running但runId=root |
| 4. 未初始化/变schema/header/extra对象 | 固定F拒绝，0补建/修复/迁移；placeholder测试不代真实SQL |
| 5. 原cap clone/Proxy/跨handle/oldroot/restart/SQL重建 | pre-reservation拒绝，不能从publicdb或inspect授权 |
| 6. target inode/parent/sidecar/closed/已有txn | 原连接物理核及reverse锁序，0newopen/新business effect |
| 7. cancel pre-admit/pre-reserve/pre-COMMIT | 原signal严格，0未准入写；不能新signal绕过，sticky首因 |
| 8. child close胜reservation后/consumer先胜 | 同newregistry真实串行库存；close胜0业务，consumer胜COMMIT保真；pending/unknown非quiescence |
| 9. 真实businessCOMMIT后throw/SIGKILL | unknown业务事实，不以cleanup ROLLBACK当撤销，0boundcap |
| 10. ACK提交前/后throw或死亡 | business committed+coordunknown分别持久row/fact/无cap；未ACK不恢复 |
| 11. COMMIT正常后latecancel | binding COMMIT事实保留，不授业务完成/后续权限，不退款 |
| 12. 同cap重复/同scope再admit/phase错误 | consumed或scope conflict，无新SQL/ACK/cap；无completed_noop；binding_completed不等dispatch completed |
| 13. unknownconsumer/profile/catalog/fact/order | 旧reader对新marker在constructor前拒绝；新reader exact拒绝unknown；错误result/terminal/audit覆盖真native篡改行反例，保原件 |

未来实施只在主控新源码用途窗、原DB只读canonical SELECT认领、架构owner新profile/值格式确认、schema fixture/setup窄许可到位后：同S两个core加fixed bind用途 + 六新候选；不改旧DB/S0源码。core静态import新值桥时Docker白名单必须另加两个精确mjs/d.mts正例及其余负例，由既有build owner同S另获 **.dockerignore/checker增量窗**，不暗含在六源码许可/不放整个目录。native node-test不进builder，真实CI新head全scope gate不由docs/旧CI代签。若实现需要其它源码/marker/DDL增量，精确列回主控，不能放宽旧reader或改generic callback框架。

单阶段实现Agent提示：仅新profile/single dispatch-bind/constant-value bridge/native fixture tests；旧S2a defaults保留，无preclaim/usage/terminal/observer/AP/W/D3接线，无环境/model/production。真实同connection/root/claims +outerCOMMIT/ACK反例，用新双非作者最多两轮评新增实现，原source审查不补签；交新head/完整CI/原失败/realmetadata/fact覆盖/旧unsupported收据。此提示不授予实施、测试或合入权。
