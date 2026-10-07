# A3-S1：隔离 writer 登记与停止新准入

工程基线 `81dac77cd27f82d7b554694bf0a12cd82cd0920b`。承接
[A3-S0](a3-maintenance-protocol.md)、[A2](a2-safe-rollback.md)、
[C2a](c2a-task-cancellation.md)、[C2b](c2b-task-budget.md)、
[恢复边界](recovery-time-coverage.md)及[生产硬阻断](security-deploy-preconditions.md)。

## 冻结范围、原始调用链和归属

S1 实现公共持久 worker/task 登记、原子关闭本登记域的新准入，以及一个真实核心入口。
当前生产调用链：`ops/generation-dispatch-worker.mjs` → HTTP
`src/app/api/internal/generation-dispatch/route.ts` → `runGenerationDispatchOnce` →
`claimNextGenerationDispatch` → `executeDispatch` → scheduler/pipeline/Run/usage/report。
本片只在 `runGenerationDispatchOnce` 的 claim 前增加显式可选登记参数；测试调用真实
claim/lease/失败收尾与本参数。HTTP route 与 worker 组合根尚未注入，不冒称生产入口已全部接线。
route 在进入 core 前调用 getDb，启动协调可写 raw/report reconciliation、方向seed，非strict模式还有
bootstrap/orphan回收；这些startup writer不在本片门内。worker SIGTERM仅停止HTTP领取并有限等待，
不能证明app任务/未知子工作停止。

执行 Agent A 独占新 `ops/maintenance/writers.mjs`、其声明与专属 node-test、
`src/lib/agents/generation-dispatch.ts`、专属 maintenance test、本 spec 与专属收据。
不改台账、A2文件、S0账本历史格式、业务 schema、模型/prompt/validator、workflow、policy/gate。
未知 owner/session 的旧 worktree 保留。

## 接口与保证边界

公共协议 `a3-writer-admission-v1`，只接受已初始化 S0 隔离 ledger 根与完整 marker。
`writers-isolation.json` 为O_EXCL永久初始化标记；`writers.sqlite` 是新独立侧车，不更改 `ledger.sqlite` 的 schema、审计或历史记录。
每次registry事务先调用真实openLedger.inspect核完整S0 schema/genesis/audit，损坏或部分账本不得准入。
绑定 `initId`、完整 target（isolated region、fixture instance/volume、canonical dataPath、serviceSet）；
snapshot显式 coreCoverage=`runGenerationDispatchOnce`、entryPoint=`generation-dispatch`；
未配置runtime不产生登记收据。scope 永远 isolated，`production_permitted=false`、`writer_quiescence=false`。

`register(workerId, entryPoint)` 记录调用者指定的全新进程代际 ID，entryPoint 固定
`generation-dispatch`。workerId本身就是唯一generation声明，不是稳定host/OS进程身份。调用者声明未经认证，本模块不识别真实OS进程。
不存在 TTL/过期自动解锁；重启必须提供新 ID，重复或旧 ID 拒绝；新代际不能借旧ID接管旧task，旧遗留记录仍未知。
`admit(workerToken)` 原子检查登记身份、registry=open，然后分配唯一 taskId，先于业务 claim。
`finish(taskToken, outcome)` 仅记录该函数本地 promise 已退出，outcome 为 no_claim/done/failed/threw。
重复同 outcome 幂等，错 token/不同 outcome 拒绝；不能把本地 promise 退出推成 provider/子工作已停止。
不跨 scope 注册，不接受未登记 writer、不允许任意 entryPoint、匿名 ready 或复活登记。

`closeAdmission()` 用同一 SQLite BEGIN IMMEDIATE 将 open 单向关闭；竞争中的 admit 要么完整先登记，
要么被拒绝，不能有未登记的通过。本方法只停这个登记域的新准入，不停止任何生产进程、不调用
A2、不签 ready、不触发维护或 SSM。closed 持久跨 reopen/restart，无解除/reopen/force 参数。
S0 `acquire` 尚不自动调用此方法；S0 CLI 与本登记域之间无跨DB原子事务，不用其成功证明全writer停止。
已登记任务不取消、不改 lease、不删队列；queued/claimed/expired 的业务语义保留。
既有ownership/assertWrite保持；fence > C2a首reason > C3 > budget优先级保持。

侧车只在合法0700/current-uid/no-symlink根中创建一次0600普通单链接文件，O_EXCL + fsync文件/目录。
SQLite DELETE/FULL/timeout=0；竞争不等待。打开SQLite前先核journal/WAL/SHM权限与类型，防hot-journal恢复先删除不安全原证据；
每次事务重核 marker、文件inode、权限、schema/version。
初始化中断或未知schema不自动重建，缺失/损坏/marker替换 fail closed。
append-only worker/task事实保存；completion不删除task。closed不是安全批准或恢复放行。

## 验收和反例

先用真实registry与真实dispatch控制测试：

- 未注册/错worker/旧代际拒绝；新进程代际在open可登记，close后不能继续登记或准入。
- 两连接及两个独立进程的close/admit竞争：无未登记claim；SQLite锁立即失败。
- 空队列的真实claim返回 no_claim；真实入队/claim/执行失败落既有Run/dispatch/trace终态，登记终结。
- close前已claim任务可按既有lease守卫合作收尾；close后queue保持、不建立新Run或lease。
- lease loss仍拒业务失败/usage/报告写；首取消原因、deadline和预算优先级保留，正常模型参数不改。
- taskToken错绑定、伪造代际、重复不同结果拒绝；重开持久closed与未终结任务，不把claimed/expired当停止。
- 本地promise结束仍明确 remote/unknown subwork未证；所有snapshot继续 writer_quiescence=false。
- 文件不存在/不安全权限/symlink/未知schema或损坏/部分初始化拒绝，禁止自动修复旧证据。
  实际SIGKILL形成的0644 hot journal必须拒绝且DB/journal hash不变；合法0600恢复仍保留closed与unfinished/unknown。

验证执行受影响真实dispatch路径，定向C2a/C2b/usage/发布白名单回归、ops、typecheck、lint；
运行时bundle改动补build。不调用真实模型，不以A1替代接线路径。独立方案及完整diff评审；
本登记模块属于维护共享契约，两位独立Reviewer通过后才可合入。

## 分片退出与后续

S1成功只交登记、停止新准入与本地任务状态，A3整体继续未完成。没有完整writer覆盖、
有限drain、lease处置、迟到提交fence及未知子工作终止证据，始终阻断backup/migrate/switch。
下一片串行实现有限drain；再分别核lease和每个实际业务提交的原子fence，不能把读sidecar再
写业务库的检查冒充跨进程原子提交屏障。不能第一轮扩到全部API/cron/CLI/启动入口。
发现必需业务schema/安全边界变化、非取消语义变化或生产/模型调用需求立即退出交协调者。
删除本片代码只能撤回隔离能力，不复活登记任务、不证明生产静默；原证据/worktree不清理。
