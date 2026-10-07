# A3：维护与执行状态协议（S0 隔离切片）

工程基线 `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71`（fetch 后 origin/main）。
承接 [身份硬阻断](security-deploy-preconditions.md)、[原收据](../../verify/security-deploy-preconditions-2026-10-07.md)、
[C1](backup-recovery-integrity.md)、[恢复边界](recovery-time-coverage.md)、[D1](d1-database-lifecycle.md)、
[C2a](c2a-task-cancellation.md)、[C2b](c2b-task-budget.md)、[发布契约](generation-provenance.md)。

## 范围与文件交接

S0 只新增 `ops/maintenance/*`、专属 spec/verify。先独立方案审查，再实现、反例、最终审查和 PR。
真实 deploy、backup、restore、runtime、schema、公共文档零修改。用户要求范围过大时可交小片；
S0 不提供生产执行 adapter，不接全 writer，不签 drain-ready，不接 AWS SDK，不执行任意 shell。
所有 CLI 只接受明确初始化的隔离根；输出永远 `production_permitted=false`。
A2 Session 不可直接联系；不读取/修改其工作区，不冒充同意。接口为待双方确认提案，S0 不依赖 A2 ready。
下一片须串行交接共享文件；#435 硬阻断、恢复启动阻断和 P1 dormant 保留。

## 当前入口盘点（源码事实，非当前生产观察）

下表区分可写入口、只读/封闭入口与 dormant 分支；所有可写入口需统一准入。S0 全部业务调用方尚未接入，阻塞全覆盖。
归属是协议领域/待协调负责人，未指定实名 operator/on-call，不由作者代填。

| 启用/可调用入口及文件 | 写入对象 | 当前取消/状态来源 | 缺口与归属 |
| --- | --- | --- | --- |
| deploy.yml → security-release-gate | runner 临时证据/镜像；生产硬阻断 | Actions/identity receipt；无生产调用 | A2/A3 未来串行接线；concurrency 不覆盖其他入口 |
| crontab 18:00 → backup-db.mjs → backup-integrity | 快照 DB、reports/raw、manifest、轮转删除 | 子进程退出/manifest；无取消或维护互斥 | C1/A3；在线 DB 一致不证明文件与全部 writer 静默 |
| host cron 18:30 → aws/sync-dr-backups.sh | S3 备份对象、host 日志 | shell exit/选择性校验；无共同锁 | C1/ops/A3；独立 host 安装版本未知 |
| db-snapshot.mjs / db-restore.mjs | 本地快照、DB/WAL/SHM 删除/覆盖 | CLI exit；restore 拒生产/严格 provenance | C1/A3；worktree 本地入口也需目标核实 |
| run-provenance-migrations.ts / record-deployment.ts | schema/ledger/部署身份 | SQLite 事务/exit；无维护准入 | D1/A2/A3；启动资格与维护资格独立 |
| replay-redaction-registry.ts / aws/migrate-db.sh | 恢复 replay/卷与权限 | exit；旧恢复成功不准启动 | C1；前者仍有恢复阻塞，后者历史工具不得用于已有生产卷 |
| cron API pipeline/collect → trigger.mjs | ContentItem/raw/Run/trace/dispatch/审计 | 请求与管线 promise、Run；任务 signal 可选 | runtime/A3；新 cron 未停，全进程内工作未登记 |
| internal/generation-dispatch + worker | claim/heartbeat/Run/模型用量/报告/通知 | DB CAS lease/fencing、首个取消原因；worker SIGTERM 停领取、有限等待 | C2a/C2b/A3；app 执行与 worker 生命周期不同 |
| topics/[id]/brief、deep-dive；admin generation-traces retry | durable 请求/trace/dispatch | 幂等请求/queue/claim；HTTP 断开不取消 durable 工作 | runtime/A3；queued/claimed/expired 不可一笔删掉 |
| admin sources collect、runs retry；collector/scheduler/pipeline 独立函数 | fire-and-forget ingest、raw/Run/cache/trace/report | C2a 可选 signal/deadline，trace claim/assertWrite | runtime/A3；缺全进程 task registry；独立调用可绕 HTTP |
| reports/[id]/followup POST → answerFollowup | 模型调用、followup、audit | 请求 promise；独立路径非 dispatch lease | runtime/A3；迟到结果/诊断均是 writer |
| reports/[id]/pptx GET → services/ppt-export | 内存 PPT 制品；getDb 初始化可能写（当前 v6 无 cache/文件写或 polish） | async promise、发布可见性复核 | export/A3；需登记异步生成，GET 可触发 startup writer |
| admin topics/sources/users/recipients；directions CRUD/reproject | 配置、实体、audit/trace | 同步事务/请求，乐观版本 | app/A3；短事务也需准入覆盖 |
| leads/opportunities POST、reader-evidence | 读者行动/audit；reader-evidence 本身只读 | 请求/事务 | app/A3；需核对读路径派生 writer |
| admin reports redaction/retention | 外部 registry、tombstone、cache/index/生命周期 | 外部先写、本地事务；无统一 maintenance signal | C1/A3；不能强停后丢失远端事实 |
| getDb/openDb startup；health/登录等触发初始化 | mkdir/pragmas、legacy bootstrap/orphan recovery/raw/report reconciliation/方向 seed | D1 readiness/cache；失败关闭连接 | D1/A3；HTTP GET/health 也可触发启动 writer |
| metrics late-events reconcile | reconciliation 投影/审计 | 请求；P1 配置门 | P1/A3；dormant 保持，启用分支不可作为已覆盖 |
| normalize-published-at.mjs / cost-backfill.mjs | DB published_at / Run cost / audit；cost preview 亦可写打开建库 | 独立 CLI/事务，cost --apply | ops/C1/A3；历史修复另授权；无共同准入 |
| cleanup-reports.mjs / regenerate-reports-cites.mjs / backfill-report-chain.mjs / backfill-highlights.mjs | 当前仅显式 standalone snapshot 只读预览，旧写入已封闭 | readonly snapshot guard，拒 apply/write | ops/C1；不重新启用，不计为现行 live writer |
| evals seed/local-bootstrap、controller store/replay、隔离发布 receipt/观察工具 | seed/独立 DB/收据 | 独立进程；不等于 live writer | tools/A3；仅隔离可用，目标路径与 live 共用须拒绝 |
| aws seed/disable/probe 系列、gen-env/setup/provision/destroy | 配置/源/host/IAM/日志等副作用，probe 可能记录业务事实 | shell/SSM exit，未统一状态 | ops/A3；当前无运行授权，不以名字推只读 |

封闭 `aws/deploy.sh` 保持 exit 2，不重新启用。P1 integrity/dashboard/controller 生产 seam 保持 dormant/fail closed。
盘点为本基线仓库入口清单，不能证明 host 上没有 ad-hoc SSH、其他 SSM 或未知进程；未知 writer 阻塞。

## A2/A3 接口提案与后续 writer/drain

版本 `maintenance-contract-v1`：target 精确字段 region/instanceId/volumeId/dataPath/serviceSet（排序唯一服务名），
operationId、kind(deploy/backup/restore)、ownerId、单调 fence、revision、候选执行身份 executionIdentity。
目标不能仅用标签、路径或容器名；跨入口保护同一 instance+volume+目录+服务集合，错目标直接拒绝。
A2 交付资格收据引用+hash，绑定 operationId/target/candidate/rollback/data-phase（before_stop/after_backup/after_migration）；
A3 不验证漏洞/原生闭包/数据兼容，不从 null 回退或 mock ready 推许可。S0 不消费该收据，不提供资格 boolean。

后续 writer 协议必须原子停止新 dispatch/API/cron/启动/CLI 准入，记录所有进程与任务代际，再 drain。
准入停止不等于在途终止，signal 不代替写入 fencing。对每个异步 await 后的业务提交和失败/用量写入
保留 C2a 首个原因、lease-loss 拒写、C2b 优先级，以及发布 validator 白名单/planned/committed/failed。
queued 保留但不领取；claimed 合作完成或取消并在 owner guard 下收尾；expired 仍不能证明原进程已停止，
禁止篡改 lease、删 Run/Job 或强杀制造静默。有限 drain deadline 超时进入持久 hold，禁止 backup/migrate/switch。
未知进程/无覆盖或过期证据不能放行。外部模型/registry 子工作未能证明终止仍按未知保留。
停 writer 后失败只接 A2 已批准安全处置；无资格则保持停止和值守接管，不自动恢复镜像/DB/逆迁移。

## S0 持久化与保证边界

未来单 EC2 host 的候选位置 `/var/lib/insight-maintenance/`，与业务卷/备份独立，host 控制进程独占写；
app/writer 未来通过受控接口只读准入/注册任务，不直接拥有维护账本权限。身份 provision、只读挂载/接口、
备份恢复防回滚、host 重建/卷丢失策略均未部署，不能用该路径名作为生产覆盖证据。
S0 target.region 固定 isolated，instanceId/volumeId 为 fixture- 前缀，dataPath 必须为该隔离根，不能登记生产目标。
本轮仅允许 current-uid-owned 0700 **隔离绝对目录**，init 为该目录写一次 `isolation.json` (0600)、独立
`ledger.sqlite` (0600)。marker 用 O_EXCL 写入、fsync 文件及目录，再 O_EXCL 创建 DB，fsync 目录后初始化。
初始化中断/缺一文件永不自动重建；重新 init 必须拒绝既有标记或 DB，原证据保留。
路径不得有 symlink，文件普通且 nlink=1、owner=current uid；权限不符拒绝，不自动 chmod 修复现存证据。
SQLite DELETE journal + synchronous FULL + busy_timeout=0；BEGIN IMMEDIATE，获取竞争非等待失败。
所有状态变更与 append-only 审计同一个事务；版本/身份/目标检查在事务内；已有 handle 每次事务重核 journal/schema/application_id/user_version。进程退出、重启不释放维护锁。
SQLite journal 恢复由引擎处理；损坏、半初始化、未知版本、audit hash-chain/状态校验失败均 fail closed。
审计全量 snapshot hash-chain，UPDATE/DELETE trigger 拒绝；不是对恶意同 uid/root 或全目录旧快照替换的防篡改。
生产整账本回滚/丢失必须外部锚或人工重建协议，S0 没有自动恢复权限。

operation 记录永不删除：idle 取得新操作会分配新 fence；同 operation+全部身份重复只返回既有状态，不能重复执行。
不同操作 busy；同 ID 不同 owner/kind/identity 冲突；任何旧 owner/fence/revision 不得改新状态。
无 TTL/自动解锁；正常完成只允许 pre_submit（没有副作用）或已核终态 + success，失败持久 hold，禁止后续维护。
解除不会复活 writers，也不会使 deployment_permitted=true。

## SSM v1 状态机（仅 fixture adapter）

`pre_submit → submission_unknown → submitted → running → terminal_pending → terminal_verified`
以及 `submitted/running → cancel_requested → terminal_pending`；submission_unknown 及任一已提交路径可进入 `manual_takeover`。
提交前先持久 `submission_unknown` 和 operation+target+executionIdentity+requestHash；再调用一次 transport。
submit timeout/进程退出不重发，commandId 未知持续阻断；接受响应必须精确 token/request 绑定且 CAS 当前 revision。
command ID 只允许首次写入并保持不变，其他 command/target/身份拒绝；重启仍保持该事实。
重复、迟到较早状态不倒退也不解除，错误关联非零；terminal observation 仍仅 `terminal_pending`。
cancel 先记 cancel_requested；API success/timeout 不证明任何远端进程已停止，poll failure 不释放。
SSM Status Success/Cancelled/Failed 等仅观测证据，不证明 shell 派生/脱离的所有子进程终止。
S0 仅可验证隔离 fixture 的精确进程退出证据，永不冒充真实 SSM 远端子进程证明；无可信证明则人工接管。

人工协议：初始化固定 Ed25519 approver 公钥/授权人 ID（测试随机密钥）；签名授权单绑定完整 target、
operationId/owner/fence、当前 revision、commandId（未知则 null）、requestHash、executionIdentity、action、
reason、证据 SHA256；release/terminal_verify 必须 `processesStopped=true`，takeover 可以 false。签名数据为规范 JSON；无授权/缺证据/绑定错/旧 revision 拒绝。
S0 仅证明签名和字段约束，不证明签名者观察真实 host，证据充分性/角色职责须生产专项授权审查。
签名停止声明必须同时覆盖 fixture 子工作、本地提交控制进程和待恢复 continuation；不能仅观察远端停止。
SSM 不能对本地暂停后恢复的 submit 做远端 fencing；CAS 只阻止旧 owner 写回，不能撤销已过发送边界的 API。
没有上述全范围证据就不能解除；S0 测试拒绝未停止本地提交者的授权单，不冒充能检测签名者的虚假陈述。
manual takeover 保留 hold；核终态可记录证据；人工解除只允许已持久失败 hold/接管并且签名证据满足约束，
账本记录原始授权单，不删除记录，不提供 env override、删除 hold 或泛化 force 参数。解除仅允许下一隔离维护。

## 验收与停止点

- 真实隔离 CLI 的 deploy/backup/restore 三种 acquisition 竞争，同 ID 重放，精确 target/owner/fence/revision CAS。
- 两独立进程并发请求；SQLite 锁立即拒绝；kill/重启保留 hold；损坏/缺文件/权限/部分初始化不续执行。
- mock transport 走真实 module 提交/状态路径，submit timeout、poll fail、cancel unknown、迟到/重复/错 command。
- 签名无授权、证据缺失/绑定错/重放拒绝；失败后 fixture 副作用不重发；旧 owner 不能 release 新操作。
- 真实 CLI 的生产许可恒 false；扫描 #435 workflow 不变且无新增解锁/AWS/任意 shell adapter。
- S0 不覆盖业务 drain/lease/writer/cancel-late-write；运行既有回归只证明保留契约，不能填为 A3 集成通过。
- 定向与完整 ops、受影响 runtime/C1/D1/C2a/C2b 回归、typecheck、lint、文档检查；无构建/镜像路径变化时不重复 Docker。
- 最终 diff 决定 eval-gate，禁止预签 skip；不调用付费模型。独立完整 diff/修正复核；正常 hooks/PR/精确 CI。

生产访问、SSM/AWS、deploy dispatch、生产 drain/stop/restart/backup/migrate/restore/config/history repair、
自动合并和清理均未授权。未来另申请精确目标、命令、窗口、副作用、operator/on-call/reviewer/approver，
避 16:50–17:30 UTC，所有维护串行。本模块交付不证明全 writer 已覆盖、部署条件满足、修复上线或 TD-19 关闭。

## 方案审查后的冻结补充

独立 `a3_plan_review`：Blocking 0，五项 Warning 在此冻结，待复核后实施。
marker/genesis 同一 initId、target、approver ID/key 必须逐字绑定；DB user_version=1/application_id 固定。
SQLite schema/genesis 未完整提交则拒绝，双 init 仅一个成功，部分文件保持原样供审计。
只有赢得 pre_submit→submission_unknown 的 transaction 返回 submit token 才能调用 fixture transport。
重复/并发 submit、重启、unknown 绝不重发；响应全绑定验证后，精确重放无 revision/audit 增加；
非精确且旧 revision mutation 拒绝。commandId 首次绑定后不可改。冲突终态不得把失败改为 success，保持锁。

| action | 合法执行阶段 | 结果 |
| --- | --- | --- |
| begin_submit | pre_submit 且 active | unknown，唯一一次发送资格（仅 fixture） |
| bind_command | submission_unknown | submitted；精确重放无变化 |
| observe | submitted/running/cancel_requested/terminal_pending | running/保持取消/terminal_pending；旧非终态不倒退；冲突终态拒绝 |
| cancel_request | submitted/running | cancel_requested，只有请求事实 |
| hold | 任意未 released 阶段 | sticky disposition=held；不清除 command/观测 |
| takeover（签名） | 任意未 released 阶段，含 unknown | manual_takeover + held；不要求 stopped |
| terminal_verify（签名） | terminal_pending | terminal_verified；失败保持 held |
| complete | active pre_submit，或 active terminal_verified+Success | released；不得清 held |
| release（签名） | held | released；不启动 writer，不继续原操作 |

canonical JSON：递归对象键按 JS code unit 排序；数组原顺序；JSON primitive 标准 stringify；
reject 非 JSON、额外字段、未知版本、NaN/Infinity。签名为 Ed25519，domain=`insight-a3-authorization-v1\n` + canonical bytes。
授权单字段白名单绑定 action、approverId、operationId/owner/fence/revision、完整 target/executionIdentity、
commandId/null、submitToken/null、requestHash/null、reason、processesStopped（boolean）、evidenceHash/null。
takeover 可无停止证据；release/terminal_verify 要求实际普通文件 `evidence-<64hex>.json` 位于根目录，
0600/current uid/nlink1/no symlink，读取有界原字节复算 hash。文件 schema=`fixture-process-stop-v1`，
绑定完整 operation/owner/fence/target/executionIdentity/command/submitToken/requestHash，并显式声明
remoteFixtureStopped/localControllerStopped/continuationsStopped 三项 true 与 outcome。
证据及原始授权单在同一 audit transaction 保存，不能只收任意 hash 格式。签名者必须人工核这些断言；
S0 验证文件存在、hash/schema/关联与签名，不检验真实 OS/远端停进程事实，虚假签名不能靠本模块自动发现。
删除证据文件不删除持久 hold 或 audit。证据文件不是生产收据，不允许 production target。
