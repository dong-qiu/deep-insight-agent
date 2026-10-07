# A3-S2：隔离有限 drain 与 lease 状态观察

依赖已冻结 A3-S1候选 `7a1ec26653b3dbcb700f9f9de56c0226a6d905a1`。
该head仅为已验收types补充正常hook所需Eval-Gate提交trailer，tree与原受审
`17f15fda7a81fa409bc09e7b1f3c46740dfc73a4`完全相同，Reviewer1已独立核对；不重签模型质量。
S0恢复前预检候选 `e668697c290d709ec819e2d51ecf72f01d93976d`已双审通过，但尚未合入main。
S1/S0各自合入、最新主干关系与合后精确main CI核验通过后才能实施本片；
本提案不将方案通过、树相同、PR或待完成CI写成前置已交付。
以上为冻结方案时点。实施启动由协调者核验前置：S0 #448合入`cb2f924`，
精确main CI `37686929840 / attempt 2 / success`；S1 #445合入
`0ca3ec9bfa9d1e7ad7134f027bf1dc7b53b5f813`，精确main CI
`37691558952 / attempt 1 / success`。本分支正常fetch/merge该origin/main，不复制其他Session件。
本片仍为待最终独审/PR/CI候选，未合入、更未上线。
承接 [S1](a3-writer-admission.md)、[S0](a3-maintenance-protocol.md)、
[C2a](c2a-task-cancellation.md)、[C2b](c2b-task-budget.md)、
[A2](a2-safe-rollback.md)、[恢复](recovery-time-coverage.md)与[生产门](security-deploy-preconditions.md)。

## 归属与真实消费路径

执行Agent A独占新 `ops/maintenance/drain.mjs`、专属node-test、声明、本spec与收据，
不改S1源、S0历史schema、业务schema/lease writer、共享入口、policy/gate/workflow或台账。
新独立worktree `insight-agent-a3-drain-20261008`，分支 `feat/a3-bounded-drain-20261008`，
端口3116，配置0600、DB/DATA隔离；不复制任何数据库、报告或.env.development.local。

新增隔离协调函数消费真实 `openLedger`（S0）与 `openWriters`（S1）：
完整校验输入 → 单向close registry → S0 acquire → 有限观察 → S0 hold。
所有结果 `drain_ready=false`、`writer_quiescence=false`、`production_permitted=false`。
不调用SSM/AWS、模型、生产备份/恢复/迁移、部署或任何任意shell，不恢复writer、不调用complete/release。
当前HTTP/worker/startup/CLI未全接线；本地core结束仍不能证明未知子工作或原expired owner终止。

## 冻结接口与双方责任

版本 `a3-drain-observation-v1`，显式入参：
`root`、S0原 `requestSchema` 的完整 `operationId/ownerId/kind/target/executionIdentity`、
必填绝对 `deadlineAt`、必填正整数 `pollEveryMs`、可选 `signal`、本片只读lease源。
不增加全系统默认deadline或任务费用上界；隔离drain单次窗口最多60秒、poll 1–1000ms，
非法/已过期窗口在close/acquire前拒绝。额外用起始剩余窗口的单调时钟上限，
墙钟回拨不延长有限等待，墙钟前跳仍按绝对deadline最先到达者停止。调用者身份仍是fixture声明，不是实名operator或OS认证。
真实协调入口为 `observeDrain({root, request, deadlineAt, pollEveryMs, signal?, leaseSource})`，
leaseSource必须是本模块`openDrainLeaseSource`创建且物理身份已验证的私有绑定对象，不接受
外部仿造sample/ready；返回版本、reason、token或null、最后sample、polls与
`controller_uniqueness=unknown`。deadline限制等待窗口，SQLite timeout=0不等锁；
同步完整清单读取/文件验证的单次耗时并无可中断硬实时保证，不能把60秒写成任意规模DB的
整个函数完成上界。没有根据时间成功签静默的路径。

request用真实strict requestSchema解析；target必须逐字等于S0 marker与S1完整marker，
包括region/instance/volume/dataPath/serviceSet。executionIdentity保持fixture限定。
所有身份、request、时限、来源scope及只读连接验证先于close/acquire，不接受ready布尔值。
A2 `a2-a3-handoff-v1`资格声明本片不消费、不认证；不会批准safe_rollback或改变hold政策。

只读lease源接口已由协调者冻结：`openDrainLeaseSource(root, databasePath)`，返回
`sample(atUnixMs)`及`close()`；只允许同已初始化S0 root内精确
`fixture-business.sqlite`普通0600/current-uid/nlink1/no-symlink文件，canonical路径核验。
实际better-sqlite3 `readonly:true/fileMustExist:true/timeout:0`连接，不初始化/迁移，不执行UPDATE。
new Database及每次BEGIN前先做无SQL路径/marker/inode/侧车权限检查（包括普通600
owned/nlink1/no-symlink的journal/WAL/SHM）；callback内仍复核完整身份。每次sample重核完整S0身份、路径inode与只读连接，真实SQL读取
`generation_dispatch` + `generation_lease`，以migration-definitions.ts与provenance.ts的真实字段为准。
同一SQLite读事务分别完整读取所有dispatch行与所有lease行，再按trace关联检查，不能用INNER JOIN
或仅dispatch驱动的LEFT JOIN作为全域清单。必须独立遍历所有active leases（reserved/owned）；
其他入口、没有dispatch或没有登记task的active lease均不能从清单消失。非法lease state也记unknown，
不能在SQL中过滤成非active而漏掉。

dispatch核 `id/trace_id/state/owner_token/claim_epoch/lease_expires_at`；lease核
`id/trace_id/state/owner_token/fencing_epoch/expires_at/active_key/scope_key`。
claim_epoch与fencing_epoch是provenance独立保存的代际字段，不以猜测两字段恒相等代替守卫：
queued/reserved可为0，claimed/owned必须为正安全整数；负数、非整数、越界等非法值记unknown。
claimed dispatch必须有唯一可关联owned lease，非空owner_token一致，双方expiry合法且一致。
真实topic dispatch的reserved lease expiry可为null（createDeepDiveTraceRequest事实），
source_collect的reserved lease可有合法expiry；两者合法保留，不能把null假判为过期或释放。
owner不匹配、缺lease或关联歧义、两侧expiry不一致、非法epoch/state/time、与dispatch状态矛盾的
active lease都记unknown；无dispatch的reserved/owned lease单独记unknown，包括真实source_collect
入口的lease，不能把“本片未接这个入口”改写成已证明停止。合法且一致的过期双方只能归入
claimedExpired观察，原进程终止仍unknown，不释放lease或抹去未登记writer。

输出仅 `sampledAt/queued/claimedCurrent/claimedExpired/unknown`计数、来源绑定及
`process_termination=unknown`；每次sample仍 `drain_ready=false/writer_quiescence=false/production_permitted=false`。
数据库缺表、读取失败等直接失败阻断，不接受外部提供的聚合ready声明。
必要SQLite正常只读WAL协调不等于业务变更；不将DB文件hash忽略WAL后当一致性快照。
来源只证明这个合成业务库的当前行，不证明生产writer覆盖或进程终止。
测试fixture用真实openDb/provenance migrations/createDeepDiveTraceRequest/claim路径产生，
再有限SQL改expiry制造反例；不把SQL状态机冒充进程静默。
S1登记task未绑定trace/claim字段，本片不能由task completion匹配业务lease所有者，更不处置lease。

## 状态、竞争、取消与失败

close/admit在S1同registry事务原子排序；close与S0 acquire分属两库，没有崩溃原子提交。
close成功后acquire失败保持closed；不能自动重开，也不能用别人的maintenance token写hold。
acquire之后每poll与终态前使用完整当前owner/fence/revision/target/execution绑定CAS；
旧token、控制器重启或并发修订不能推进原流程、重置窗口或释放任何hold。
不同operation busy；精确operation重放只核已有事实，released/submitted/held阶段不恢复drain或副作用。
事前能见的任意同operation阶段均只读replay，不重新close/acquire；不匹配request拒绝。
预取消在身份/来源校验后直接blocked，未close/acquire。close后再inspect和acquire返回的
fence/revision恰+1只为本轮观测校验；S0幂等acquire不返回created标记，同operation/owner
两个同时首次controller可以拿到同token，无法认证唯一controller。真实双handle反例证明
同token，真实双进程drain竞争保持unknown/blocked，仅当前revision CAS胜者能hold；
失败方不重试/续租/越权写hold。这个限制不通过nonce/pre-inspect或新S0授权掩盖。

仅在有未退出登记任务时有限等待；queued保留但不领取，claimed/expired不改lease、不删任务。
本地任务全部退出后仍根据未知子工作、未登记writer/lease等缺口进入既有S0持久hold。
超时记 `writer_drain_timeout`；取消按本drain首次观察的reason固定，清理timer/listener后持久hold，
不abort业务任务、不改C2a首取消reason或fence>C2a>C3>budget优先级。
观察失败立即停止等待并阻断；已记录的首取消reason仍用于主返回reason和持久hold，
没有先取消则为 `writer_drain_observation_failed`。未发布v1候选接口冻结为
`DrainObservation.sample: DrainLeaseSample | null`：仅poll观察失败返回null，不回传最后成功
采样冒称当前证据；正常、replay及预取消保持实际采样。null不证明来源或子工作终止。
最终owned/hold仍在观察catch之外，旧owner/fence/revision优先拒绝，不被取消或采样错误掩盖。
S0写hold失败或revision冲突不能转换ready；只留下closed、既有op事实及明确blocked错误。
只读源遇合法600热journal但SQLite要求写入恢复时也阻断SQLITE_READONLY并保全原字节；
本模块不升级连接或用write-open代替只读，不把只读WAL正常协调外推成所有hotjournal能恢复。
取消返回、控制器重启、迟到本地完成均不解除S0 hold、不重开准入。
不把采样成功、health、expired lease、signal取消或task outcome=done作为静默证明。

## 保护测试与退出

- 错target/identity/request/非法deadline/不安全或错scope来源在准入关闭前拒绝，无新operation。
- 真实registry close先于S0 acquire；竞争失败持久closed，不借旧owner/fence/revision变更他人operation。
- 真实dispatch登记未退出→有限deadline→持久hold；重开控制器/ledger、迟到finish均不放行。
- 已完成本地任务、空任务、queued、claimedCurrent、claimedExpired、缺lease/坏时间分别阻断；
  expired旧owner仍unknown，lease/schema/Run/queue行前后不变。
- 在真实业务fixture中分别构造owner_token不匹配、两侧expiry不一致、claim_epoch与fencing_epoch
  的负数/非整数/越界、非法dispatch/lease state及重复/缺失关联；每例unknown或失败阻断，不能被
  归成合法current/expired而遗漏。合法queued/reserved的0 epoch保留，不引入假的两epoch相等规则。
- 用真实createSourceCollectTrace与claimSourceCollectTrace形成无dispatch的reserved/owned lease，
  配合空登记表以及其他entry/未登记writer，采样unknown必须非0；加JOIN遗漏负控，证明不会只看dispatch。
  另一组同时保留合法dispatch与无dispatch active lease，验证“看见部分正常”不能掩盖未覆盖行。
- 所有sample反例和正常计数例都断言process_termination=unknown及全部ready/许可字段false，
  采样前后核业务lease/dispatch/Run事实不变。
- 取消首reason后真实源关闭导致采样失败：reason/hold保持首因，sample=null；无先取消的
  采样失败用generic reason与null。取消+源失败+并发revision或释放后foreign owner/fence
  仍reject且不写他人hold。deadline与完成竞争、timer/listener清理及重启反例。
- 读取真实业务fixture SQL采样；不以mock-only/fixture状态机或本地promise结束证明全writer停止。
- 实际S0/S1/drain/lease定向ops测试、typecheck/lint；未改src/runtime/build路径时复用S1有效构建。
- 两位独立Reviewer原材料审查；最终PR/tested对象与最新main关系由协调者核验，必需CI不skip。

缺完整writer覆盖、子工作终止或实际提交fencing时本片即收hold，不扩产品范围。
后续lease处置/commit permit必须另片申请真实提交窗口；先读sidecar再写业务DB不是原子维护fence，
也不能把持同registry锁的两DB提交称崩溃原子。生产实际SSM/部署/备份恢复消费前置未满足。
不删除证据、分支或worktree；safe_rollback=null、deployment blocked、原hold和旧冻结镜像身份保持。
