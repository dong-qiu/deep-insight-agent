# A2/A3：真实隔离消费者首片

日期：2026-10-08。状态：仅方案，待协调者及两位独立 Reviewer 冻结；未实现、未运行验收、未盖 Eval/创建 PR。
重新 fetch 的 `origin/main` / 实施建议基线为 `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`。#453 精确 main CI `37710999247 / attempt 1 / success` 为协调者已归档父证据，本方案不将其当作新 consumer 已通过。

## 目标与非目标

新增一条实际 Node CLI `consume-isolated`，消费现有 `assessA2` 和真实 `openLedger`、`openWriters`、`openDrainLeaseSource`，而不是拷贝返回值或把接收范围确认记为运行验收。读有界 owner-private 产物字节，绑定完整 A2 context 与当前 A3 operation/token，并独立报告隔离消费路径是否接通。

只读隔离观察：不 acquire/closeAdmission/observeDrain/hold/cancel/submit/authorize/complete，不执行 writer、SQL UPDATE、transport、shell、网络、AWS/SSM、模型、通知、备份/恢复/迁移/容器操作。不更改旧 A2 contract、任何 policy/gate/workflow、旧 S0/S1/S2/S3 schema/接口或 runtime。新增 staged/SSM 方案尚未冻结，本片不导入或制造它们的字段/验收。

`isolated_consumer_integrated` 只表示本次实际调用、字节和绑定检查成功；不是 authenticated/qualified、镜像实际运行、全 writer 静默、SSM 终止、A2/A3 全部工程完成或上线。保持 `deployment_permitted/rollback_permitted/production_permitted/database_restore_permitted/inverse_migration_permitted/drain_ready/writer_quiescence=false`、`approved_safe_rollback=null`，A2 所有 evidence `verified=false` 原样保留。#435 生产硬阻断与 frozen447 独立，不把 #443 或其他旧镜像矩阵移植到当前源码。

## 文件归属与依赖窗口

执行 Agent B 唯一写新 `ops/maintenance/a2-consumer.mjs`、`.d.mts`、`a2-consumer.node-test.mjs`、本 spec及新专属 receipt；本轮只写本 spec。旧 `ops/aws/a2-*`/policy/gate、ledger/contract/writers/drain、scheduler/runtime、SSM controller/spec及主台账全部只读。A 独占 staged/SSM 专属 spec；跨协议集成由协调者负责。

工程 module/read interfaces 已在基线存在，本片不要求 staged/SSM 新实现、不夺取 A 四 shared 文件。实现须在双方案审查和 root 明确 followup 后；合并前重新同步、核源对象/最终受审 head/tested merge/精确 CI及归档。高风险若触共享维护/SSM入口必须两独审，本片本来也以两独审为冻结门。无新依赖、无历史 schema 或安全边界迁移；一旦需要改它们，暂停并给实际字段/消费者差异，不能先实施。

## 单一新输入与字段绑定

CLI 形态建议 `node ops/maintenance/a2-consumer.mjs <canonical-isolated-root> <canonical-artifact-root> consume-isolated`，严格 JSON 从 stdin（16KiB 上限，固定小chunk消费，至多16KiB+1 sentinel即拒绝，不得先无界读取再检查）；不加载任何 `.env`、不提供 policy/ready/unlock/clock/生产目标参数。两 root 为独立 owner-private fixture目录；A3 初始化前 root 必须空，所以产物置于单独 artifactRoot，不塞入初始化目录。业务 DB只允许 `root/fixture-business.sqlite`。

新 envelope `schema_version='a2-a3-isolated-consumer-v1'`，strict 顶层 `{schema_version,a2,a3,artifacts}`：

- `a2` 保留 `a2-a3-handoff-v1` 的 `schema_version,phase,context,rollback,evidence`。context 包含原七字段 `operation_id,maintenance_holder,operator,schema_sha256,migrations_sha256,configuration_sha256,data_sample_sha256` 及完整 release；三个隔离 evidence 必需，production_compatibility/approval允许缺省；存在的 evidence 的 scope/result/checks/issued_at/expires_at/binding/receipt_sha256 均保留原含义，不新增认证声明。正向集成用明确未运行/未认证的隔离声明，不为凑五类完整性制造生产/人工审批证据。
- `a3` 包含 `{token,binding}`。token 精确复用 tokenSchema `{operationId,ownerId,fence,revision,target,executionIdentity}`；binding 精确复用 bindingSchema（无 revision、带 commandId/submitToken/requestHash）。不接收 caller ready/quiescence/terminated/status 或新 profile 字段。完整 target 是现 literal isolated/fixture instanceId/fixture volumeId/dataPath/排序唯一 serviceSet。
- 映射是 exact string：`context.operation_id===token.operationId`、`context.maintenance_holder===token.ownerId`；不 trim/加 op-前缀/换 holder别名。`operator` 仅原 declaration 的非空身份，不能代替 owner/approver或从 PR 作者填入。
- `token===tokenFor(actualOperation)`、`binding===bindingFor(actualOperation)`、`actualState.active===token.operationId`、operation 未 released，marker/worker marker/lease source marker的 initId及完整 target 相同，target.dataPath===root。operationId/ownerId/fence/revision/执行身份/每个 target字段/commandId/submitToken/requestHash任何错配均拒绝；不调用 acquire 生成或刷新 token。
- release 与 rollback **所有七 identity 字段**分别匹配固定 policy：repository、40hex revision、platform、index_digest、manifest_digest、config_digest、compose_sha256。policy status blocked、safe_rollback null及 schema 仍由原 assessA2 实际拒变。447 同对象依然不能解决自身启动故障；不同版本 pair 资格材料不是本固定 A2接口的自动批准，不能临时换 policy。
- `phase` 仅原已知值，literal unknown或其他值形成 blocked integration（不猜阶段）。其余 phase 只是 caller declaration，不产生 phase_verified；before-writer-stop 若 actual admission已closed需报 mismatch。writers-stopped/backup/migration/deployment-record/readiness/rollback-readiness不由 CLI 判已执行，actual A3 state/disposition 与 phase声明分别输出。未知SSM终止/未覆盖writer不阻止报告“已实际消费”，但始终是 operational blockers；不得把 integrated=true 变成就绪。

## 有界产物读取与四 hash 的真实来源

`artifacts` 最多10个固定角色与 basename，descriptor `{size,sha256}`，不得提供任意路径/URI；四hash/compose/三个隔离声明为8个必需角色，production_compatibility及approval为两个可缺省角色：`schema.txt,migrations.json,configuration.json,data-sample.json,compose.yml`及五 `receipt-identity.json,receipt-security.json,receipt-isolated-compatibility.json,receipt-production-compatibility.json,receipt-approval.json`。

目录必须 canonical、owner/current uid、0700、非 symlink；每个文件普通文件0600/nlink1。lstat→O_NOFOLLOW open→fstat 核同 inode/dev/uid/mode/size；按 FD 用固定≤8KiB chunk读取；每次最多消费min(role剩余额度,batch剩余额度)+1 sentinel，遇overflow立即拒绝、不继续读取/拼接无界内容。不得stat→readFileSync(fd)→事后限额。仅有界已读字节可拼接/hash/解码，验证精确实际 byte length+sha256，并再次 fstat/路径身份核无替换/增减。拒绝 symlink、hardlink、非私有权限、目录穿越、缺文件、额外角色、过大/中途变化/不合法UTF8。单 schema/data各≤1MiB、migrations≤256KiB、其余各≤64KiB、全批≤4MiB；不扫描artifactRoot其他文件，不输出正文/配置/路径/原异常。只报告固定 role/size/hash及稳定错误码。

- `schema_sha256` 是 schema.txt 原字节摘要；内容为显式synthetic schema sample的 canonical JSON，完整 native sqlite_master `{type,name,tbl_name,sql}`有序对象集合（不含SQL为null的内部隐式项）。`migrations_sha256` 是 migrations.json 原字节摘要，内容为真实 fixture schema_migration `{version,checksum}`有序集合，版本不重复；两者都与实际readonly transaction查询逐项比对、集合不跳坏项。`configuration_sha256` 是显式合成配置JSON原字节摘要（有 schema/scope=synthetic，禁止从.env/live配置抽取）。schema/迁移/数据仅证明本隔离工程fixture绑定，不声称是447或新candidate镜像的实际schema/质量/兼容、生产有效配置或可信来源；当前engineering fixture身份与frozen447 policy身份分别记录，不用currentmain字节替换旧447矩阵。
- `data_sample_sha256` 是 data-sample.json 原字节摘要，固定 schema `a2-isolated-dispatch-lease-sample-v1`、scope synthetic、marker initId/target及完整 dispatch/lease 行快照。仅该synthetic inventory，不代表 Content/raw/report新数据兼容或全库无损。
- consumer 新私有只读 native SQLite连接仅固定fixture DB，物理/sidecar/marker/实际 PRAGMA database_list在SQL前/事务内复核；一笔真实 read transaction**先执行下述常量/标量低投影容量准入**，通过后才用LIMIT1025完整列materialize schema objects/schema_migration校验和集合及所有 dispatch字段 `id,trace_id,state,owner_token,claim_epoch,lease_expires_at`及所有lease字段 `id,trace_id,state,owner_token,fencing_epoch,expires_at,active_key,scope_key`，按id排序。每表最多1024行，但LIMIT1025本身不是TEXT限额；全列读取必须在同一readonly snapshot已通过count/type/byte与aggregate准入之后，字符串/JSON编码总量也受对应role上限约束。完整字段与data-sample声明逐项相等，不只比counts/抽样，不filter非dispatchlease；未知/失效row仍由真实leaseSource.sample保持unknown。
- `compose.yml` 实际字节hash匹配 policy.compose_sha256；仅字节相同，不重复 #435 OCI解析/pull/native规则，也不称 compose已运行。冻结447 Git原文件可作为明确fixture来源，CI测试需在新专属测试内保存可重算的公开精确fixture，不依赖未获取历史Git对象或下载镜像。
- 实际存在的 receipt 文件是新显式 `a2-owner-private-receipt-declaration-v1` `{schema_version,kind,claim}`；claim精确包含原 evidence除 receipt_sha256 的所有字段，避免自摘要循环；原 evidence receipt_sha256匹配文件原字节，kind/claim与输入deep exact相等。绑定context七项、完整release/rollback、scope/result/checks及canonical UTC issued≤now<expiry、issued<expiry；必需隔离角色坏/缺/未来/过期/错binding拒绝，已提供的可缺省角色也不能以删掉坏文件当缺证通过。result允许明确not-run/fail及bool checks=false，调用原assessA2保留其missing/stale/misbound诊断，不为integrated要求所有check为true。**正向集成fixture不提供production/approval两类**：返回明确missing、A2 verifiedfalse/全部permissionfalse，仍可isolated_consumer_integrated=true。只有专属untrusted synthetic negative反例可包含假production/approval声明，用于断言即使字节hash/结构齐全也非真实生产/实名批准；不得记为该层正向事实。

生产/批准声明不因私有权限、结构齐全或 hash匹配升级。输出每个实际读取 artifact `bytes_bound=true,authenticated=false`，两个未提供生产/批准角色明确`missing=true,bytes_bound=false,authenticated=false`，`A2.declarations[*].verified=false`仍原样；不签 fixtureReceipt为 production/current-production pass，不复用签名stop声明作事实。

## 新 consumer 的容量准入与继承限制（W1 修正，未实施）

仅新增consumer私有固定fixture preflight，不更改旧reader接口/DDL或引入公共框架。三份固定DB与markers/sidecars先完成owner/private/inode/非链接物理门，再允许新的readonly native连接、pragma或SQL；不repair/chmod/截断以通过，unsafe hot journal原字节保留。原S0/S1inspect可按原协议进行合法SQLite recovery；新readonly准入若不能安全读取则unknown拒绝，不能为兼容恢复改写旧API或发送成功。

- 固定fixture文件上限（非可配置环境门）：ledger.sqlite/writers.sqlite各≤16MiB、fixture-business.sqlite≤64MiB；原允许的ledger/writer -journal各≤16MiB、业务-journal/-wal/-shm各≤64MiB，非法sidecar继续原规则拒绝；各marker≤16KiB且使用同样有界FD消费。尺寸门不是可信freshness或整库防回滚证明。
- 在任何原openLedger/openWriters及inspect（它们自己也读取snapshot）前，对固定ledger/writers以新私有低投影SQL做fixture准入：ledger events≤512行、seq为safe integer、previous_hash/hash是UTF8≤64bytes的原允许字符串、单snapshot UTF8 bytes≤64KiB、总snapshot bytes≤4MiB；S1 workers/tasks/completions各≤1024行、identity/admission各1行。S1 worker_id≤128bytes、generation_token/task_id≤36bytes、entry_point≤128bytes、outcome≤32bytes、identity.marker≤16KiB、admission.mode≤6bytes且id为safe integer；对应column类型/null策略必须符合现字段的允许类型，不把坏行过滤掉。schema对象先只查count/type/length，S0/S1各≤32个SQL非null对象、单SQL≤64KiB/总≤256KiB，之后才允许原验证器完整schema比较。超限/坏类型整次拒绝，不只读前512/1024条作为通过。
- business读取用同一新readonly native read transaction先constant/scalar projection：`COUNT(*) FROM (SELECT 1 ... LIMIT1025)`验证每表/DDL对象集合≤1024；`typeof(column)`与`length(CAST(column AS BLOB))`的EXISTS/MAX/SUM仅返回有限标量，不投影原大TEXT/SQL。schema SQL单值≤64KiB、name/type/tbl_name各≤512bytes；migration version为safe integer且checksum为64byte hex；dispatch/lease selected TEXT各≤512bytes，numeric/null按原列允许类型（epoch等必须safe integer），不以新分类隐藏unknown/orphan。列门通过后aggregate byte预算按最坏JSON escaping（≤6×TEXT UTF8 bytes）加每row固定metadata保守额度（schema/data各1024bytes，migrations256bytes，另加固定header256bytes）核对应schema≤1MiB/migrations≤256KiB/data≤1MiB，再完整列materialize并再核编码实际bytes。不先.all()拿大列做JS判断，不将LIMIT行数当单行字节约束；SQLite内部解析/页读取的分配不由这门宣称严格内存上界。
- 旧S2的constructor会立即sample(Date.now())，sample全表.all；以上**实际fixture容量准入必须发生在其open之前**，不是随后拒绝。原S0/S1也仍全audit/snapshot materialize；前置容量门不改变这些原API。每次再开/inspect/sample前重核容量，返回前重核size/count/byte及绑定；任一已观察增长/替换/容量race→unknown/integrated=false/无成功旧结果，所有权限仍false。
- 新FD和新native完整投影在其消费/同read snapshot中有上述有限输入界；**旧API在另一个connection/snapshot中的继承全量读取限制仍在**。preflight到原sample/inspect间同uid并发变化可能先触发旧API大分配、阻塞/失败，本方案不伪称跨连接容量锁或整个进程/全系统内存上界，不证明ABA不存在。若实际实现/验收需要绝对限制旧API allocation，则先报告新公共bounded-reader接口/消费者差异并停止这片，不偷偷改原reader或用截断/替代分类通过。

新增保护必须在实际new CLI消费路径：小fstat/descriptor之后FD或stdin增长越cap+1；单条超限schema SQL/lease TEXT（行数仍1）；>1024业务/registry行、>512 audit或总snapshot超限；metadata门证明overflow在新完整列与原reader调用前被拒（private spy只能辅助次数，native物理对象/真实模块证据为主）；容量检查后变化→unknown/无成功。断言无protocol/business行修改、无原文/巨大异常打印；这些仍是待执行测试，不是已证明的内存/性能结果。

## 实际消费路径与一致性限制

新 module导出唯一 `consumeA2Isolated(...)` 与新 main；`.d.mts`完整 typed 输入/输出，CLI不提供任意callback/政策seam。内部测试可冻结clock以验证有效期，CLI只取实际Date.now。

1. strict解析/有限stdin与固定role文件门；固定URL读repository policy（只版本化文件，非外部URL），实际调用原 `assessA2(a2,policy,now)`。
2. 先执行已定义的fixture容量/物理准入，再 `openLedger(root).inspect()`、`openWriters(root).inspect()`，实际 token/binding/marker核；任何文件/schema/audit/hash链损坏拒绝，不把输入a3作为观察替身。
3. 新私有native连接先容量准入→有界完整schema/migrations/rows与真实artifact比对；**原S2 open即调用sample/.all()，所以fixture容量准入必须先于openDrainLeaseSource本身，并在每次显式sample前重核**。随后实际 `openDrainLeaseSource(root,root/fixture-business.sqlite).sample(now)`，保留queued/claimedCurrent/claimedExpired/unknown、remote_subwork unknown及其他entry未覆盖。
4. 八个必需及已提供可缺省产物实际字节/typedclaim校验；两个可缺省缺证仅追加missing blocker，随后重读ledger token/binding和writer snapshot；业务完整行前后核一致。旧revision、late change或观测失败不复用上次good值，不刷新/重试重签。一切 connection/FD在finally关闭，cleanup错误不发成功。
5. 输出新 schema `a2-a3-isolated-consumer-result-v1`：精确input/a3 binding摘要、actual module版本/来源、artifact计数/hash/缺证角色、原A2结果、A3真实state/disposition/admission/leasecounts与所有 blocker；`isolated_consumer_integrated=true`仅上述实际路径/硬绑定通过，且绝不移除原A2 blockers。CLI成功消费也非零退出1（production仍blocked）；库单独返回结构。校验失败同样权限false、integrated=false，稳定码且无敏感详情。

这些ledger/registry/business/artifact是不同快照；前后相等检查能发现已观察变化，**不能证明全局原子性/无ABA/独立新鲜度/唯一控制器**。`observation_atomic=false,controller_uniqueness='unknown',process_termination='unknown',all_writer_coverage=false`永久保留，本输出永远不能用为writer/SSM操作许可。不会持ledger事务执行外部I/O、调用writer锁公开callback或更改CAS。当前partial S3 terminal不使本consumer新增全覆盖断言。

## 验收与退出（尚未执行）

先保护/真实反例，再最小实现；不以mock assessA2/ledger/writers/nativeLease或 fixture状态机代替实际模块。

| 用例 | 必须断言 |
| --- | --- |
| 合法typed synthetic envelope+ownerprivate8文件（缺production/approval）+真实初始化ledger/writers/实际openDb+applyProvenanceMigrations业务DB | 新CLI subprocess实际模块链，精确token/data bytes映射及integrated=true；exit1、全部permission/readyfalse/null；所有已读receipt authenticated/verifiedfalse、两个production/approval明确missing，原A2blockers逐项保留；无协议/业务事件或row写入。 |
| context映射/每个target/执行身份/owner/fence/revision、command/submit/request字段逐个错配 | integratedfalse；不acquire/刷新/写held/清任务；原S0/S1 exact schema/事件与DB行不变。 |
| 必需artifact缺失/size/hash损坏/错receiptkind/内容与input不等/存在receipt的scope/date/binding错配；production/approval缺省与假声明negative | 必需读取/提供却错配拒绝、canonical UTC边界expiry等于now拒；可缺省缺证不阻真实集成却仍blocked。原assessA2对false/not-run checks诊断保留；假production/approval只untrusted negative、hash匹配不签认证。 |
| symlink/hardlink/权限错/path escape/oversize/FD或stdin读中增长/替换/非UTF8/额外role、单条超限TEXT/SQL、超过fixture审计或row/byte限额 | 无越界/无原文泄露/无部分成功旧输出复用；拒绝输出稳定码。 |
| native data同counts但换owner/epoch/trace/id、orphans/queued/claimed/expired/source_collect lease | 完整列差异拒绝；未知lease被实际sample计unknown；不给quiet/ready，不能清/强制release lease来造通过。 |
| stale input/读取间ledger revision改变/marker替换/writer task完成或新增/数据库行变动 | 前后检查拒绝已观测race；保持globalatomicfalse/唯一controllerunknown，不宣称防ABA或共享维护线性化。 |
| unknown phase、after-stop声称ready、terminal_pending/Success/cancel_requested/未知终止 | unknown phase integratedfalse；已知phase保持声明与实际state分列；Success、取消返回、health或emptytasks都不能消除SSM/allwriter blocker；永不 authorize/complete/resume。 |
| 旧漏洞/换OCI/批准rollback/改policy、环境A2_READY/A3_READY/解锁参数 | 不同于fixed447逐身份字段拒；原policy/gate/workflow字节不变；无AWS/exec/实际fetch/model/通知；未知参数拒绝。 |

定向consumer/原A2契约/S0/S1/S2/S3 ops回归与dual typecheck/lint；CLI才新增，无HTTP/build/Docker变更，本片不为凑验收重跑447/#443镜像矩阵。命中构建闭包再补相称build，不拿不执行路径的A1作证。最终完整原diff/负例/私有raw index双独审、正常hooks/PR/精确CI；预算0，无Eval预签。缺证、oversize、终态/子工作未知始终阻断；同问题先诊断，不能无限重跑。

退出：首consumer专属receipt只记录受审head/tested/mainCI/实际调用/字段及字节绑定、原红/绿与限制。未接staged/真实SSM/完整维护适配、当前生产数据/IAM/历史覆盖、回退批准及生产执行分别保留工程/缺证/外部授权待办，不能从 integrated 关闭它们。全局schema/安全边界或正常产品/AI语义变化需要先报告批准；本版本无需这些变化。下一片由root冻结新协议后串行接入，禁止自行扩展。
