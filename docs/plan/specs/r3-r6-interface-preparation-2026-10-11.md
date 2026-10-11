# R3–R6：接口、归属与独立实施准备

## 执行单与证据身份

这是新方案准备，不是源码实现、全 writer 准入或旧 R2 候选补签。调查基线为重新 fetch 的
`origin/main@ff7820af9d6517a7543355fd58524fccac6bbc19`。源码事实绑定该 SHA；历史 spec 中
“尚未实现”的时点不能覆盖现在已存在的 S1、strict terminal、staged terminal 实码。

本聊天独占新增本 spec、[实施交接包](r3-r6-implementation-slices-2026-10-11.md)及
[收据](../../verify/r3-r6-interface-preparation-2026-10-11.md)。复用主控确认属于本聊天的
`/Users/dongqiu/.codex/worktrees/bcba/insight-agent`，建立
`codex/r3-r6-interface-prep-20261011`；不使用清理中的 17 个目录或 r2-native 目录。
只做静态读取、专属文档、双独审与文档检查；不启动应用，所以不需要本地运行配置，
未读写 `.env*`、业务 DB、依赖/构建目录。后续若新建运行 worktree，须按 AGENTS 复制必要
gitignored 配置、0600 并改独立 DB_PATH/DATA_DIR；不得复制 live 数据或借共享依赖目录。

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-interface-prep-20261011/`，
目录 0700、文件 0600。`inventory-v1.json` 绑定 35 份当前源码/规则快照的 Git blob、size/hash，
以及三份历史交接原件的实核 hash。聊天读取只提取本次工作区和保留边界，不提交私人聊天。
该盘点不证明运行版本、CI、镜像、生产状态或原测试仍适用于未来实现。

已有授权：只读盘点、新文档、隔离分支/worktree、两位非作者方案审查。源码、共享文档移交、
运行模型/资格矩阵/生产操作均未获本轮授权。历史协调文档的 Git/合入授权属于原任务，
不能转为本轮合入授权；本轮停在可评审交付。归属缺口只阻止相关实现，不阻止本准备交付。

## 当前调用图

以下每个节点都是基线上的实际函数；虚线式的“已经传了控制对象”不算消费证明。

```text
worker.mjs -> internal/generation-dispatch POST
  -> getDb -> openDb -> openConnection(mkdir/native open/WAL)
           -> [非 strict] bootstrapLegacySchema + recoverOrphanedRuns
           -> [strict] schema ledger/deployment identity 校验
           -> reconcileRawArchiveEffects -> reconcileReportEffects -> seedDefaultDirections
  -> runGenerationDispatchOnce(db, undefined, {telemetry})
           -> claimNextGenerationDispatch -> executeDispatch
           -> scheduler.runScheduledTopicPipeline / runPipelineForTopic
           -> pipeline.runAnalysis / runValidation / runReportGen
           -> runJob -> insertRun / finishRun
                    -> usage scope -> callStructured -> withUsageCall
                         -> Anthropic actual fetch / Responses actual fetch
                         -> beginUsageAttempt -> beginModelUsageAttempt
                         -> SSE observer -> observeModelUsage
           -> dispatch done/failed -> finishGenerationDispatch

cron collect / manual collect -> createScheduledSourceCollectTrace / createSourceCollectTrace
  -> claimSourceCollectTrace
  -> collectSource -> runJob -> sources fetch -> normalize
  -> collector outer transaction: ContentItem upsert + planRawArchive + revision
  -> writePlannedRawArchive: attempted -> staging -> final rename -> finalize
  -> collector events / counts / telemetry / source trace terminal

pipeline.runReportGen -> validator/reader selection -> buildReport
  -> saveFailedReport, 或 saveReport
     ordinary: report+review+effect intent -> staging -> attempted -> two renames
               -> report/index/FTS/review/event/effect final transaction
     anchored: same local files -> writePlannedAnchor (sign/plan/putIfAbsent await)
               -> anchor_written -> commitAnchoredPublications + reader final transaction

getDb startup -> ordinary raw/report reconciliation
cron all modes -> getDb -> recoverOrphanedRuns (anchor disabled也先清扫)
cron integrity -> runIntegrityMaintenance -> claimIntegrityMaintenanceLease
  -> heartbeat timer -> reconcileAnchoredReportEffects
  -> planned anchor: writePlannedAnchor (可能外部条件写)
  -> anchor_written: store.get + verification -> whole report final transaction
  -> runAutomaticIntegrityChecks -> integrity_check / alert claim -> notifyIntegrityFailure
  -> runDailyAnchorSchedule -> writeDailyMerkleRoot (sign/put/get/SQL/audit)
  -> finally releaseIntegrityMaintenanceLease

evals/seed.ts -> openLocalBootstrapDb -> openDb + explicit migration/meta init -> seedDefaults
config.getEffectiveSources -> empty DB: seedDefaults + seedDefaultDirections
```

HTTP 当前只注入 telemetry（`src/app/api/internal/generation-dispatch/route.ts:17`）。core 已支持
S1/strict/staged 三个互斥 opt-in，但未向 scheduler/jobs/usage/raw/report 传维护写许可。
core `assertWrite` 是原 dispatch/lease guard，不是维护 COMMIT fencing。
source collect 是独立三字段 claim（traceId/ownerToken/fencingEpoch），不能套用 dispatch 六字段。
`runCollectionCycle`、手动 collect、cron/manual request 还有受理/claim/健康状态写入。
页、auth、health、email 等读调用也使用 `getDb`，第一次调用可能触发上述隐式 writer。

## 持久副作用与真实边界

行号只作导航，私有快照 hash/Git blob 才绑定版本。清单覆盖本轮路径，非全系统静默声明。

| 域 / 源码定位 | 实际副作用、外层 COMMIT / await | 当前保障及接线缺口 |
| --- | --- | --- |
| usage `db/model-usage.ts:40,56` | begin INSERT started/unknown；observe UPDATE 累计快照、价格、hash；各自同步 db.transaction | assertWrite 在事务内；缺维护锁。嵌套调用只形成 savepoint，不能误算外层 COMMIT |
| usage `runtime/model-usage.ts:96,194` | 每次底层 fetch 前 begin；每个 observer 同步提交后才向 SDK 放字节；transport/reader.read 是 await | sticky failure 阻止 SDK/runtime 后续 transport；不增加取消后追读器 |
| jobs `runtime/jobs.ts:53,89,105` | running INSERT；done/failed finishRun，含原 Run.cost、trace 投影；fn/settle await | 写前 lease guard；catch 能写 failed，后续必须防已提交后二次收尾；notifyFailure 是独立外部效应 |
| raw `collector.ts:324` + `raw-archive.ts:50` | Content upsert+raw planned+raw_ref+reader_eligible=0+真实 revision 同外层 txn | plan 自身不建立外层事务；不能从该事务内部倒取 registry 锁 |
| raw `raw-archive.ts:120` | attempted 自提交；mkdir/write/hash/rename；finalize txn 同写 committed 与 reader_eligible=1 | 无内部 lease/maintenance guard；caller checkpoint 是检查后竞争；catch markUnknown 也是 writer |
| raw `raw-archive.ts:148` | recovery 可 mkdir/rename/finalize 或 markUnknown | 不是只读 repair；不删 orphan。当前 startup 无独立准入 |
| report `reports.ts:151,188,220` | failed metadata/afterSave；ordinary planned metadata/review/effect；文件 staging/attempted/双 rename；最终 done/body_path/index/FTS/review/effect/event/revision | final 白名单由生产 pipeline assertPublish 消费；恢复直接调用证据函数。维护拒绝不能进 catch 补业务失败写 |
| report `reports.ts:266,295` | anchored 本地 intent/文件；两 artifact Promise.all sign/put；anchor_written；整报告 final projection | await 不在 SQLite 写事务内；既有检查无法撤回在途外部写。partial anchor 不等于 reader committed |
| anchor `integrity-publication.ts:105,152,209` | signing key 注册也是 SQL；签名 await 后 planned INSERT；putIfAbsent/get await；anchor_written/audit txn；manifest+report final txn | signer/key/revocation、provider version/完整 bytes 检查必须保留；只传 assertWrite 仍非维护锁 |
| report recovery `reports.ts:408,506` | ordinary 可 rename+发布或 unknown/failed；anchored planned 可条件写、anchor_written 可验远端+发布；失败还写 audit/unknown | `:503` 注释称 never putIfAbsent 与 `:557–562` 实码不一致。按实码验收，不能视为只读恢复 |
| legacy report `reports.ts:353` | 无 effect 表时 metadata、直接双文件写、final index/FTS；失败 rmSync 清理 | 当前兼容路径存在；新 opt-in 缺 schema 必须拒绝，不准自动落回此路径 |
| startup `connection.ts:10` / `startup.ts:32` | mkdir/new Database/WAL pragma；bootstrap/orphan；raw→report reconcile；directions seed；缓存连接发布 | strict 仅关 bootstrap/orphan，仍写 reconciliation/seed；缓存命中也须重新核本次许可与物理身份 |
| seed `local-bootstrap.ts:11` / `config/index.ts:77,106` | explicit migrations/meta init、Topic/Source INSERT、空源隐式 seed directions | 本轮不运行 seed；迁移须另片明确所有权，不能用启动准入覆盖 schema 变更 |
| cron `api/cron/route.ts:45` | 三种mode在anchor判断前均recoverOrphanedRuns；更新过期Run的status=failed、ended_at、duration_ms、error | strict启动检查不保护此周期清扫；属于W2入口首效应，不能称anchor disabled无副作用 |
| integrity入口 `integrity-publication.ts:377–409` | claimIntegrityMaintenanceLease自提交；timer/phase checks heartbeat；finally release；await恢复/自动检查/daily | 不同于dispatch/source lease；本轮只盘点。W4 report recovery不覆盖这些writer，完整cron安全仍blocked |
| integrity checks `integrity-checks.ts:49,135,151` | await文件/store读取；integrity_check INSERT、alert幂等claim、notifyIntegrityFailure外发 | 不是只读检查；各SQL与外部通知无本轮维护许可，待原owner另冻窗口 |
| daily root `integrity-publication.ts:291–363` | signing-key注册；sign/putIfAbsent/get await；integrity_daily_root+material同txn；recovered/conflict/missing audit | 与per-report anchor不同effect/幂等身份；不纳R5，W4不自动取得此改写权，完整cron终止/维护仍unknown |
| pipeline `pipeline.ts:43–335` | input/diagnostic revisions、started/completed/failed events；saveAnalysisBatch/ValidationResult及原afterSave；cache；leads/directions/opportunities多个txn | 除本轮report固定final外仍未覆盖，不得吞维护拒写为nonblocking成功；原owner另冻具体窗口 |
| collection `scheduler.ts:95,110` / `collector.ts:73,205,363,403` | P1 freezeDueDay、scheduled collect受理/claim；normalize events/revisions、transcript acquisition facts、telemetry.recordCollector、setRunInserted、trace terminal | 各自实际writer而非raw同事务；R4 adapter安全不代表这些writer已覆盖 |
| source health `source-health.ts:40,64,75` | setCircuit/setLastProbe/reviveSource及探测collector；源健康/零产出notify外发 | 与R3/R4合同分开；现时未覆盖，保持原owner，不在准备期修实现 |
| shadow `podcast-shadow-store.ts:34` | 条件启用observe shadow：mkdir/archive不可变文件、openDb(shadow.db)及bootstrap/orphan、source INSERT、acquisition事实 | 独立DB和DATA_DIR副作用，单business DB cap不能授权它；延期/保留Brief-shadow归属，不重开模块 |
| notifications `jobs.ts:108` / `pipeline.ts:506–533` | notifyFailure、Brief acceptance/thin brief、notifyReport（配置允许时email/webhook等外发） | 在业务COMMIT后，失败不抹已提交事实；未知外部continuation不得签quiescence |

当前 C3 契约已存在：logical call 与实际 attempt 区分；unknown/partial nullable；provider 真零不同于缺失；
原价格快照不重估；同语义重放幂等、冲突拒绝；Run.cost、attempt、P1 不相加。取消不能把真实调用或
unknown/partial 费用改零。lease 丢失后既有观测保留，不能另造费用 writer 绕 fence。
Job 取消后可能仍有 observer：原 `job.finished` 是诊断字段，observe 仍消费原 guard；新接线须保留这一语义。

## 文件—owner—移交证据—依赖矩阵

“历史 owner”不是当前接收人；下面拟任角色必须由主控指定具体 Agent 并完成逐文件移交后生效。
现时已确认只有本聊天的新文档归属。未发现有效释放不代表永远无人拥有。

| 精确文件窗口 | 历史归属证据 | 当前移交状态 | 拟唯一 owner / 依赖 |
| --- | --- | --- | --- |
| 两新 spec、本轮新 receipt、私有根 | 本轮用户指令及主控对本聊天 bcba 的确认 | 已确认专属；未释放 worktree/证据 | 本准备作者；reviewer 仅写各自私有目录 |
| `ops/maintenance/writers.mjs`, `writers.d.mts`, `src/lib/runtime/writer-admission.ts`；新 fixed driver/types/tests | A3 S1/S3/staged spec 原 Agent A；历史 retained 记录声明 existing runtime/dispatch/DB commit sources 保留 | **待逐文件移交**；新相邻 driver 也要纳合同窗口 | S：共享接口 owner；所有域依赖 S，其他 Agent 禁改 |
| `src/lib/db/model-usage.ts`, `src/lib/runtime/model-usage.ts`, 两模块 `.test.ts` 和 runtime `.integration.test.ts` | C3 #410；C2b #412 修改 runtime；10-09 R3 行 | 历史 C3/C2b，共享源保留；现 owner/释放待确认 | U：R3；jobs 归 W，不共享写 |
| `src/lib/db/raw-archive.ts`, `raw-archive.test.ts`；新 raw fixed adapter/test | 10-09 R4 行；retained 的 DB/collector 类别 | 精确原 owner 缺，禁止猜一个原 Agent | A：R4；Content 外层消费由 W 后串行接 |
| `src/lib/db/reports.ts`, `reports.test.ts`, `reports-cancellation.test.ts` | C1/Brief/D3 交叠，10-09 R5 行；最近 commits 不能视为移交 | 精确当前 writer 和各边界保留范围待确认 | P：R5 普通+anchored 同一 owner；依赖 A/S |
| `src/lib/db/integrity-publication.ts`, `.test.ts`；新 report adapter/tests | C1/P1c anchor 历史 spec，10-09 R5 行 | 现 owner 及 anchored 写窗口待确认 | P；不能与 ordinary 并行写 reports.ts |
| `src/lib/db/startup.ts`, `connection.ts`, `local-bootstrap.ts`, `planning.ts`, `src/lib/config/index.ts`, `evals/seed.ts`；相应新测试 | D1 #411 / seed/planning 原 owner；retained shared DB 类别 | **待移交**，migration runner/schema 仍只读 | W：R6 串行统一 owner；S 启动准入合同是前置 |
| `src/app/api/internal/generation-dispatch/route.ts`, `src/lib/agents/generation-dispatch.ts`, `src/lib/runtime/jobs.ts`, `cancellation.ts`, 相应现有测试 | A3 Agent A、C2a/C2b/C3、10-09 R6 行 | 多 owner 边界；未释放 | W；cancellation 默认只读，确需改须另列 delta |
| `src/lib/agents/scheduler.ts`, `collector.ts`, `pipeline.ts`, `report-gen.ts` 及定向测试 | D1/C2b/续批 B/Brief；10-09 R6 行；Brief/shadow 保留 | 未交接，reports/report-gen 拆分延期仍有效 | W；只接固定消费，不重排选择/渲染模块 |
| `src/app/api/cron/route.ts`, `api/admin/sources/[id]/collect/route.ts`, `api/topics/[id]/{brief,deep-dive}/route.ts`, `api/admin/runs/[id]/retry/route.ts`, `api/admin/generation-traces/[id]/retry/route.ts`；worker `ops/generation-dispatch-worker.mjs` | 实际 getDb/request/collect/retry 消费扫描；不因此新增归属 | 路由/worker 各 owner 未确认；按入口小片逐一冻结 | W；每片只有明确移交路由可写，其余保持未覆盖 |
| `src/lib/db/provenance.ts`, `repos.ts`, `report-review.ts`, `reader-evidence.ts`, schema/migrations、anchor store/signer | 现有协议/白名单事实源 | 本方案只读；需改立即交主控，禁域 Agent 自扩窗 | 原 owner；只复用真实函数，不复制弱化版 |
| ADR、architecture、三主台账、旧 spec/receipt | 10-08 retained root_exclusive / 10-09 矩阵 | 本轮不接管 | 原协调者，主控另行办理设计决定落账 |

定向实核历史原件：`refactor-continuation-20261008-224349/coord/final-retained-ownership-v2.json`
SHA256 `dd9fca64f568ece874c34d349cb09c82b0f5581637142563bd2abf37dcdee886`，
`completed-deliveries-v2.json` 为 `cf50c596bedf11240f121a510f2779a307f61fc6d8b283f9fc54f49b54033f5a`，
`handoff-search-v3.json` 为 `8183d6a357ecaecadc55780a9ba9854ed1daf56817be46f33325d05ca3da7500`。
这是历史保留/搜索证据，不是本轮释放证据；没有重新广搜会话、读取原业务日志或递归重验旧矩阵。
2026-10-11 当前聊天核实：Dev-Agent-重构仍占 r2-native；清理只处置指定依赖/构建目录，源码归属仍保留。
clean、合入 PR、聊天结束、删依赖或 meta/Git 权限均不释放源码。

移交收据必须逐文件给：原 owner→唯一接收 owner、base/head/blob 或 hash、未提交内容的保全入口、
精确释放写窗口、仍保留窗口、共享依赖冻结版本、是否允许结束使用路径。主控不能用“R3 已交接”
代替 runtime/DB/tests/jobs 分属窗口；无法找到原 owner 时须由用户明确指定该文件接管。

## 最小共享接口提案与待决策边界

复用 [S1](a3-writer-admission.md)、[strict](a3-commit-fencing.md)、
[staged](a3-staged-terminal.md)、[C3](c3-model-usage-persistence.md)。不新建任意 gate、
callback、可插拔 driver 平台；现有 `FixedTerminalDispatchDriver.commit` 保持 terminal 专责。
下面是固定消费者职责签名提案，**不是已存在 API，也不是批准后的实现合同**。

### S：先冻结唯一共享窗口

建议最先交一个 isolated dispatch 子域的固定 usage 消费者。沿原 openWriters 私有 registry
connection 增加具名同步方法及受审 factory 固定 driver；旧 S1/strict/staged 协议不改义。
新 opt-in 明确选择 `close` 对本子域立即 fencing：它不能被解释为 staged 合作关闭；未配置维持原行为。
暂称 profile `close-fences-usage-v1`（提案名，须 S owner/主控冻结才生效）。raw/report 用各自明确
固定消费者，不能给一个 `commit(kind, work)` 或外部 callback 让 Agent 任意扩写。

| 固定消费者提案 | 值参数 / 身份 | 固定实际工作与返回 |
| --- | --- | --- |
| usage.beginAttempt | fresh usage capability；原 UsageIdentity | 固定 beginModelUsageAttempt，同连接外层短 txn，返回原 replayed 加 COMMIT 三态 |
| usage.observeAttempt | 同 closure、已绑定 attemptId；原 UsageObservation | 固定 observeModelUsage；原观测序号/hash/价格规则不变，禁止借别 Job attempt |
| raw.commitContentIntent | fresh source-collect capability；冻结内容候选、原 claim、raw envelope、trace/event | 固定 upsert+plan+真实行 revision 同外层 txn；不接受传入 transaction callback |
| raw.publishPlanned / reconcileOne | fresh capability；精确 effect/target/hash/size/content revision | 固定同步 attempted/staging/rename/finalize 或单 effect 恢复；任何 unknown 标记也须同门 |
| report.plan / publishLocal / finalizeReader / reconcileOne | fresh capability；完整 report/index/bindings/固定 review intent/trace refs；effect identity | 固定原 ordinary intent、文件阶段与整报告 final txn；不公开 before/after/finalize 任意函数 |
| report.persistAnchorCandidate / observeAnchorWritten / finalizeAnchored | fresh capability；原 exact manifest/candidate/key/version/effect 元数据 | 固定短 SQL；sign/store await 留在外层受控异步序列，不能塞进同步提交方法 |
| startup.initializeExisting / seedLocal | 独立 fresh 启动身份；精确 root/marker/db、启动步骤与静态 config | 准入先于 mkdir/write-open；逐固定初始化步骤。现 S1 entryPoint 不支持此身份，D2 前阻断 |

现有 report 内部 callback 并非新增维护许可接口。P/W 必须把真正的 review/event/evidence 固定操作
归入受审同连接 final txn；可内部复用现有函数，不能将 caller 提供的函数作为新的共享 driver 参数。
签名写成“value-only”不保证实际 bytes：还须完整源码与真实调用点核验同步性与唯一 factory 来源。

### 身份和锁序

S0 完整 root/marker/init/target；业务 DB canonical 文件、dev/ino、UID/mode/nlink/sidecars；同一个
native DB 对象及唯一 main（拒 ATTACH/memory/readonly/closed/foreign root）一并绑定。只从审核过
factory open 已存在的 fixture DB，不 bootstrap/迁移/seed。signal 保持原对象实时取消，其他控制与
claim 保存 primitive 不可变快照；对象/brand/freeze/路径字符串不认证恶意同 UID。

dispatch 绑定真实六字段及 trace.root_run_id/Run.trace_id 关联；source collect 独立绑定三字段、
scope/source/rootRun 的实际 DB 关系。usage 的子 Run 与 rootRun 不一定同 ID，必须核子 Run.trace_id
确实属于同 trace；不能仅比较 runId=rootRunId。attempt/run/call/effect/report/raw revision 全部精确关联。

每次固定提交：零 SQL preflight → 同私有 registry `BEGIN IMMEDIATE` / validate →（明确选择
staged 的固定 terminal 方法才有 stage 锁）→ business 外层 `BEGIN IMMEDIATE` →完整原 lease/claim
及实体关联 guard →固定操作→**同步 business COMMIT 返回**→退出 registry。锁序 registry→stage→business；
strict 子域无 stage 则 registry→business。不得业务已有 inTransaction 时进入许可，不从现有 callback
反向取锁；仓库 db.transaction 的 savepoint 返回不能作 COMMIT 收据。timeout=0/busy 有界拒绝，
不 sleep/retry、不持任一 SQLite 写事务跨 await，不先释放维护锁再写业务。

raw/local report 文件步骤同步且固定：registry 锁覆盖每个实际 mkdir/write/rename 及紧接的
finalize COMMIT；business 写事务仅包 DB 同步段，不持到外部 await。对 publication 段，在
business guard 取得写锁后持有到 rename/finalize 可防原 lease takeover 穿越；不能只在 rename 前
查一次 lease。staging 可以是独立固定段，但也须许可。同步 FS 在锁内不证明 crash 原子性，
部分 rename 原样留下；不能复制远端 backup 的许可假设。原 root() 对 DATA_DIR 的动态回读必须
改为受控固定 root 绑定后再消费，不能用环境变值把同一 cap 的文件写到另一根。

COMMIT 返回前异常：业务写事务尚未开始，或已经开始但未尝试 COMMIT且显式 ROLLBACK
成功，才可将该 DB 阶段称 not_committed；preflight/BEGIN 前拒绝不执行补偿 SQL。
尝试 COMMIT/rollback 不明→unknown。business 返回后 registry/读校验/localfinish 失败→
unknown + businessCommit=committed；不进入普通 catch 改 failed、重发或删文件。multi-phase
结果逐阶段保留 committed/not_committed/unknown；后段失败不能把已提交 intent/文件写称全回滚。
未知 filesystem/external 效应单独记录，不用 DB businessCommit=not_committed 推断文件/远端零写。

### 取消、迟到观测、重启与恢复

lease ownership 拒写最高；首 C2a cancel/deadline 保留；然后 C3 sticky failure，再 budget。
维护拒写以独立固定诊断保留，不覆盖已观察首因，不伪装为模型失败或成功终止。
取消后不允许新的 transport/业务结果；已开始 attempt 的本地迟到 usage 在**原 lease有效、维护域
仍允许**时同步观察。usage 的 observation 许可独立于 Job result/local finish：取消已收尾可保留
已有 observer 的 closure 与 attempt 白名单，不能再 beginAttempt 或改已收尾 Run；DB closed、lease
失权或维护 close 后拒绝且保留原 started/partial/reported。该例外须 D1 明确冻结，不能套用
terminal 的“completion 后 cap 一概无效”规则吞掉 C3 观测。

unknown/partial 金额保持 NULL/unknown；真实成本不归零，不把 attempt 与 Run/P1 累加。
开始观测写失败/unknown 时不发送；观测后失败/unknown sticky 停下一次 SDK fetch，不重发已发生请求；
observer rejection 有 handler、不重新开库、不延长 drain。成功路径必须先提交观测再放原字节。

不从 task/claim/inspect/JSON clone 或重启恢复旧 capability。取消后存活 observer 是原进程的限定
continuation，不是重启恢复权。重启恢复须**全新 recovery 准入身份**，在许可内只消费持久 effect
与相同 bytes/key/hash，重验白名单/当前 binding；不能把旧 unknown 当 ready，不解除 hold/重置 epoch。
业务原有幂等事实支持已知结果读核，unknown 不自动重试。raw/report reconciliation 是新的 writer，
不能继承旧 task 权限或仅拿一个 effectId 放行。已 reader committed 事实不能改写成 rollback。

### 必须交主控冻结的决定

| ID | 必要决定 / 推荐最小动作 | 未决时精确阻断 |
| --- | --- | --- |
| D1 | 明确选 isolated dispatch usage strict-close 子域，以及原 lease下取消后既有 observer 可写的生命周期；旧 terminal/staged close 不改义 | S usage 合同及 U 接线，不挡静态准备 |
| D2 | source-collect、startup/seed/recovery 如何正式登记。现 writers exact schema/entryPoint 仅 generation-dispatch；扩旧字段/DDL不在本轮授权。共享 owner 先给新版本/兼容提案，再由主控取得必要设计决定与写窗 | raw 实际 collector 与 startup/recovery 不能伪称已有 permit；U 的 dispatch 窄片可先行 |
| D3 | anchored sign/store 的真实 async admission/owned operation 与取消回执合同。同步 SQLite fencing 不能保证远端在撤销后不落地；只能保证撤销后 reader 不公开、已在途效应未知且保留 exact candidate | anchored 外部写安全、完整 R5b/R6 integrity 接线仍 blocked；普通 report 可独立推进 |
| D4 | 主控是否将本提案纳正式 ADR/架构、如何授权仅文档 PR；本轮不改既有共享文档、没有合入授权 | 正式设计落账/合入，不阻止专属文档交付 |

不为 D2/D3 发明泛化框架，也不声称选择新 profile 就有持久 reservation。若需要新持久 schema、
独立阶段 revoke 或 remote reservation，须先另冻 exact 合同/归属/验收；本文件不授予此扩展。
R3/R4/R5 每个 writer 的安全保证止于其固定受审边界；startup、claim、heartbeat、analysis/cache、
telemetry、通知、其他入口未覆盖前，writer_quiescence/maintenance ready/production_permitted 仍 false，
process_termination=unknown。既有 hold、safe_rollback=null、#435 阻断保留。
