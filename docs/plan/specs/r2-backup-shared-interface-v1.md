# R2：backup-only 共享接口条件合同 v1

## 0. 授权、身份和状态

2026-10-10，基线 `22fc151ec5d452efc06527987b2a48af93d21524`。
用户授权本轮**仅设计共享接口并独立评审**，未授权共享源码实现或生产操作。
状态为 `post_review_corrected_not_accepted`；两轮评审原件与后置修正身份见
[本轮收据](../../verify/r2-backup-shared-design-2026-10-10.md)。本轮不签条件设计通过；
接口设计通过亦不等于实现就绪或合法正例通过。
[上轮移交](../../verify/r2-backup-handoff-2026-10-10.md)已恢复移交三个 C1 文件；
原源、工作区、证据保留。本轮只写专属文档，不接管三主台账。

目标是为隔离备份定义真实准入、一次 attempt、固定发布/轮转及取消/unknown 契约。
不把 scope 字符串、marker、签名 stopped 声明、空 task 表或 manifest complete 当作许可。
不实现全 writer 平台、生产 SSM、自动恢复或 ready 解锁。

## 1. 当前事实与强制前置

当前 S0 的 acquire 只生产 operation token；owned-drain 始终 held/coverage false/
termination unknown。writer 只登记 generation-dispatch，HTTP/startup 等未完整消费。
现真实锁为 writers→S0 短读，staged 为 writers→stage→S0 短读；这些 S0 读锁
在返回时已释放。现 terminal driver 只提交 dispatch，不能用于备份 FS。

完整 R2 正向准入依赖 **A3/R6 的实际覆盖生产者**；本设计不代交该工程。
该生产者必须由固定受审组合根执行下面的真实流程，而不是接收调用方证明文件：

1. 用新 operation 在同一物理 target 上登记本次 backup，拒绝 held/unknown 或旧 operation。
2. 对该 target 的已冻结入口清单逐入口确认实际准入及提交 guard 已接线，关闭新准入；
   覆盖至少 startup/reconciliation/seed、HTTP 管理/任务、cron/dispatch、独立与进程内任务、
   usage/raw/report/文件发布及其他修改 DB/reports/raw 的路径。
3. 有界等待本地 task、完整 lease 和可能修改该 target 的原生/远端 continuation。
   本地 promise 退出、expired lease 或 SSM Success 不单独证明它们已停止。
4. 在固定锁域内校验实际登记/终态/fence、覆盖代际、target 物理绑定和本次 owner，
   由私有 closure 生成不可序列化的 `ClosedBackupSource`。没有公共 constructor、
   `markCovered`、`acceptProof(json)`、test-ready 开关或任意 callback。

该对象只能由上述实际生产者签发；它不是 S0 token 的包装，也不从 inspect 重建。
生产者实现、冻结入口清单及真实消费验收未交付时，固定返回
`backup_source_coverage_unavailable`，不得 mint attempt capability 或进入业务 FS。
受控 fixture 可以验证未来同一生产者的行为，但不补签未接线的实际 CLI/生产入口。
现有 main 没有合法生产者，因此 `positive_admission_ready=false`。

## 2. 最小文件窗口（提案，不是实现授权）

| 文件 | 责任 | 本轮状态 |
| --- | --- | --- |
| NEW `ops/maintenance/backup-entry.mjs`、`.d.mts` | 固定 consumer、不可变输入、stage/attempt/结果与诊断 | 仅接口设计 |
| NEW `ops/maintenance/backup-store.mjs` | 独立 attempt 账本、永久初始化 marker、追加事实 | 仅接口设计 |
| NEW `ops/maintenance/backup-fs.mjs` | 唯一固定 FS 适配器，不导出通用执行 callback | 仅接口设计 |
| NEW `ops/maintenance/backup-entry.node-test.mjs`、`backup-fs.node-test.mjs` | 专属协议/实际 FS/多进程/崩溃测试 | 待实现 |
| 既有 `ops/maintenance/ledger.mjs` | 固定 backup 动作进入其真实私有 owned/CAS 锁域 | 尚未移交 |
| 既有 `ops/maintenance/writers.mjs`、`writers.d.mts` | 固定组合进入同一 registry closure，消除嵌套第二次 S0 BEGIN | 尚未移交 |
| 既有 C1 三文件 | 最后消费新接口及 cron 配置，保留原完整性/轮转语义 | 已恢复移交；本轮不改 |

`ledger.d.mts` 目前不存在，不虚构既有文件。旧 S0、writer、staged schema/audit
不扩表、不重写；attempt 使用新侧车。`contract.mjs` 和 owned-drain 不改为授许可。
A3/R6 实际入口接线另有唯一 owner，不在上表实现窗口内。
原子 no-replace 原语的实现及构建接线须单独冻结最小文件窗口，见第 6 节；
不得因本接口签名需要它而自动取得 Docker/npm/CI/native 文件的写权限。

## 3. 对外职责签名与输入

下列是责任签名，不是已存在的 API；唯一公开 consumer factory 在 backup-entry。
固定组合内部复用同一 private registry/ledger handle，CLI 不拿裸 lock 或 FS driver。

```ts
type BackupCapability = opaque; // 本 closure 的对象身份；不是可序列化 token。
type Effect = "not_attempted" | "not_committed" | "committed" | "unknown";
type BackupResult = {
  kind: "denied" | "staged" | "published" | "cancelled" | "unknown";
  attemptId: string | null;
  publication: Effect;
  controlReceipt: "confirmed" | "unknown";
  durability: "not_applicable" | "confirmed" | "unknown";
  code: string;
};
type PruneResult = {
  kind: "denied" | "deleted" | "complete" | "cancelled" | "unknown";
  attemptId: string;
  actionId: string | null;
  object: Readonly<{ relativeName: string; dev: string; ino: string;
    type: "file" | "directory"; initialInventoryHash: string }> | null;
  deletion: Effect;
  controlReceipt: "confirmed" | "unknown";
  durability: "not_applicable" | "confirmed" | "unknown";
  firstStop: "signal" | "deadline" | "owner_lost" | "unknown" | null;
  code: string;
};
interface FixedBackupEntry {
  prepare(input: BackupInput, signal: AbortSignal): Promise<
    { kind: "denied"; result: BackupResult } |
    { kind: "reserved"; capability: BackupCapability; attemptId: string }>;
  stage(capability: BackupCapability): Promise<BackupResult>;
  publish(capability: BackupCapability): BackupResult;
  pruneNext(capability: BackupCapability): PruneResult;
  cancel(capability: BackupCapability, reason: "signal" | "deadline"): BackupResult;
  inspectAttempt(attemptId: string): Readonly<AttemptFacts>; // 只诊断，无恢复执行权。
  close(): void; // 不完成 attempt、不释放 hold、不证明异步任务已停止。
}
```

`BackupInput` 只接受协议版本、全新 operation/request ID、owner/execution generation、
已初始化 isolationRoot、完整固定 target、C1 keep/raw 配置及显式执行窗口。
target 保持 isolated；源 DB 固定为该 root 的 `fixture-business.sqlite`，reports/raw
来自同 root，输出固定为 `backups/<UTC stamp>`；CLI 的 DB_PATH/DATA_DIR 必须精确匹配。
不接收 driver、proof boolean、任意命令、可执行函数、任意输出名或未知对象字段。
配置在首个副作用前保存完整不可变 primitive 快照；AbortSignal 必须是真实活信号。
窗口是有限正 safe integer 且不超过 Node timer 上限，无无穷、溢出、延长或隐式 fallback。
同时绑定 admission 时的绝对截止时间和单调时钟余额，不靠可变环境或系统时钟回拨续命。
prepare 内固定调用第 1 节的异步生产者；执行窗口从 prepare 开始，等待生产者不重置预算。
capability 的私有状态绑定**原始同一 signal**及首个已观察停止原因；后续消费没有 signal
替换参数。clone、另一个未取消 signal 或后续环境修改均不能替换原源或延长窗口。
stage 的块/文件之间及固定 consumer 的 publish/prune 调用之间，必须在锁外异步让出
事件循环，处理已排队 timer/SIGINT/SIGTERM。同步门在全部 hash/inventory 复核之后、
**每个副作用 syscall 前**直核原 signal、原绝对和单调截止余额；不能仅依赖 timer 回调。
syscall 已开始后的取消只能在其返回后记录实际结果，不倒写 committed 为未执行。

## 4. attempt 与首次副作用

新 `backup-attempts.sqlite` 和 marker 由**显式隔离初始化**创建，不由 backup CLI 自动创建。
初始化须在新独立空目录/固定绑定位置验证 0700/0600/current UID/no-symlink/nlink；
永久 marker、FULL synchronous、追加审计及 schema 版本严格验证；半初始化/缺失/损坏拒绝。
所有可能触发 SQLite recovery 的 open/pragma/BEGIN 之前先做零 SQL 物理检查；
不 chmod 修复、不删 journal、不把 unsafe 原件恢复成“通过”。

拒绝的“零副作用”精确定义为：业务 DB 不写开、不建立/复制 staging/backups/reports/raw、
不发布、不删除、不外发。许可判断可读取既有安全控制账本；可信 controller 的操作登记、
关闭准入及审计是显式控制面副作用，不冒称整个流程所有文件 byte-for-byte 不变。
配置/物理绑定损坏在任何控制面写前拒绝；缺生产者不得自动初始化控制环境。

先在**既有控制目录**写本次不可变 intent，再持久化唯一 attempt/reservation；之后才允许
业务 mkdir/source DB open/backup。intent 使用固定私有适配器 O_EXCL 创建 0600 普通文件，
绑定 target/root/marker、operation/owner/fence、attempt ID 和原窗口的 canonical hash，
写完须文件 fsync 和 intent 父目录 fsync 均确认，才允许首次 reservation SQL。
intent 文件永久保留，不因 S0 complete/release 或 attempt 行回滚删除；本轮不引入通用
intent 写入 API。任意残缺/未匹配/未确认 intent 都是 unresolved target 阻断。
下一次登记须在相同锁域比对所有 intent 与追加 attempt 事实；只允许全部旧 intent 已有
精确确认终结且无未知 continuation 时新建 intent，不能仅以“未发现 attempt 行”为 fresh。
初始 reservation COMMIT/ACK unknown 即使事务实际回滚，已 fsync 的 intent 仍保留阻断。
尚未确认 intent 耐久性的 pre-intent crash，若文件未落盘，不声称可识别该历史尝试；
此时从未 mint capability 或准许业务副作用。若留下半文件，重启拒绝而非自动补写。
私有 capability 只在 reservation 已确认返回且生产者闭包仍有效时 mint；保存不可变
root/marker、已存在对象 inode、完整 owner/fence/revision、覆盖代际、原 signal/窗口及 attempt 绑定。
同 operation 最多一 attempt；ACK unknown、崩溃或未解释的 attempt 对该 target 持久阻断，
换 request ID、新 operation、S0 release/acquire、TTL 或重启均不能绕过它。
JSON clone、外部 mutate、另一 handle、旧 task/inspect/snapshot 都没有执行权。

事实序列为 `reserved → staging → sealed → publish_attempted → published → retention`；
unknown、cancelled、owner_lost 为保留分支，不回到 reserved，不自动重试。
publish 与每个 prune action 都先有独立持久 action reservation，然后才进入固定同步门。
“检查后拒绝”仍消费本次 action 权；只读重复诊断可返回原事实，不重新执行副作用。

## 5. 固定锁域与异步执行

固定序为 **writer registry → S0 owned/CAS → backup attempt store → 固定同步 FS 动作**。
不使用 staged terminal gate 或 dispatch business driver，不扩现有锁域到异步函数。
先取得 registry 时允许既有 validate 的 S0 短读结束；随后取得同一固定 S0 私有锁。
之后不再调用会另起 BEGIN 的 public inspect/owned/drain 方法；复核使用已锁 handle 的
私有校验。ledger→writers 反向申请、第二 registry connection、已有业务 transaction
进入此协议都拒绝。所有锁 timeout=0，busy 是明确未准入，不当作撤销/提交成功。

S0 hold/complete/authorize 与 FS 门竞争同一真实 S0 锁；它们持久 hold 或 owner/CAS 失效
是 backup 失权事实。registry close 只关闭 writer 新准入，已 closed 再次 close 是 no-op，
既不授予也不撤销 backup 许可；不虚构既有非 staged revoke API。
backup 的独立取消/撤销由固定 cancel 在上述相同锁序中追加 attempt 停止事实；该 COMMIT
确认点才是跨进程有效撤销点。原 signal 取消同时立即在本 handle 保留 sticky 首因；
取消记录 ACK unknown 保持 target 阻断。有效 S0 失权或 attempt 停止提交后不得 publish/prune。
撤销请求返回 busy 不证明它已生效；在本地观察到首取消原因也立即阻止后续消费。
FS 动作全部由固定适配器在该锁域内执行，不能将返回的 allow boolean 交给 CLI rename。
不声称多库事务具有统一 crash 原子性；每层 COMMIT 已返回与未确认分别保存。

`stage` 固定执行 SQLite backup、规范化 DELETE 快照、分块/逐文件复制、C1 manifest 与 hash。
不持控制 SQLite 写锁跨 await；private staging 在 backups 外且从 reservation 起绑定 attempt。
原生 backup settle 之前不关闭其 handle/删除 staging；进程退出或取消 ACK 不证明停止。
取消后在途 private staging 可能迟到完成，但不能成为 published/reader eligible 或开始轮转。
每个下一步/块/文件之间观察取消；不用一次 cpSync(recursive) 承诺硬实时 deadline。
没有平台硬终止 SLA；同步 syscall/fsync 仍可能阻塞，实际超窗必须如实报告。

## 6. 发布、耐久性、轮转及恢复

固定 publish 重核完整权限及 stage inventory/hash/inode，C1 manifest 不改变旧版本字段。
attempt/控制来源另存控制侧车并绑定 manifest hash，不向旧备份清单写敏感源路径/正文。
目标名只是兼容 C1 的展示布局，不作为幂等键；幂等键是持久 attempt/action。

物理绑定按角色区分：root、既有控制目录/marker/DB、源 reports/raw 及既有 backup root
在首个控制面写前绑定 dev/ino/type/UID/mode；普通文件 nlink=1，目录不套用此值。
target.dataPath === DATA_DIR === canonical isolationRoot（目录）；
DB_PATH === join(isolationRoot, 'fixture-business.sqlite')（普通文件）。两种对象独立绑定，
不修改既有 S0 marker 的 dataPath 目录契约；
目录链必须 canonical/no-symlink，发布的 stage 与目的父目录必须同设备。
未创建的 stage/输出目录只绑定固定父目录及 absence；实际创建时在固定门追加对象身份，
不能声称 reservation 已记录不存在对象的 inode。seal 后保持源/目标父 FD 至 publish 结束，
并复核路径仍指向原目录；缺省对象迟到出现不能被收编为本 attempt 的 stage/输出根。
本协议依赖受信命名空间及合作 writer 的真实覆盖，不认证恶意同 UID、特权用户删账本、
整集控制旧副本回滚，亦不宣称 renameat2 能原子校验 expected 源 inode/hash。
根或已绑定目录替换即拒绝，不用新的“安全目录”接管旧 capability。

**no-replace 是必需原语。** `existsSync + renameSync` 不满足外部空目标出现反例。
v1 选择 Linux 同进程固定原语 `renameat2(RENAME_NOREPLACE)`，基于已验证目录 FD 和
固定 basename，拒绝 EXDEV/不支持的平台或 FS；不 fallback 到普通 rename/复制发布。
不使用锁内 shell/子进程 helper，不向调用方暴露任意系统命令。
最小 Node-API 原语、专属 Linux 测试和构建接线须另冻结/取得归属，才可实现本 publish；
本轮未引入 native 依赖或承诺平台支持。Mac 可运行拒绝/逻辑测试，不能替代真实 Linux 正例。
[Node 24 API](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html#fsrenamesyncoldpath-newpath)
只提供两路径 rename；[Linux 定义](https://github.com/torvalds/linux/blob/master/include/uapi/linux/fs.h)
及[内核实现](https://github.com/torvalds/linux/blob/master/fs/namei.c)给出 no-replace 原语。

seal 先同步每个普通文件及各级 stage 目录；rename 返回后同步源/目标父目录。
namespace commit、目录同步、控制 outcome 是不同事实。rename 已成功时 publication
恒为 committed；父目录同步失败只令 durability=unknown，outcome/外层 COMMIT 未确认
只令 controlReceipt=unknown；两者可独立或同时未知。任一未知即持久阻断 target，
保留已发布备份，
禁止 rollback 冒充、catch 删除已发布目录或再次 publish。
crash 不知道 rename 是否完成时 publication=unknown，不因缺 outcome 推断未发布。
参考 [Linux fsync 合同](https://github.com/mkerrisk/man-pages/blob/master/man2/fsync.2)。

轮转开始及每步继续的必要条件为 publication=committed、durability=confirmed、
controlReceipt=confirmed，原窗口未耗尽、未取消且 permission 仍有效；任一未知都不删旧
恢复点。复用 C1 实际 `planBackupPrune`，冻结每个精确候选的初始 inventory/inode/hash、
保护恢复点及保留边界，并生成不可扩展的 postorder 精确动作序列。
不公开 delete(path)。每次 `pruneNext` 只对既定候选中的一个普通文件 unlink 或一个
已空目录 rmdir，在上述固定门内重核权限/目标并持久记录；不跨锁做递归 rm。
预期剩余树仅由本 handle 的已确认删除事实推进，永不重扫扩大权限；每个动作保留初始
dev/ino/type/name/hash 绑定，目录保留 identity，允许本序列已确认动作带来的预期目录项、
nlink/mtime 变化，不允许外部新增、替换或无法归因变化。无可证明变化边界则拒绝而非刷新。
每次成功 unlink/rmdir 后同步受影响父目录；删除 namespace 事实、父目录耐久性和控制
收据分别写入 PruneResult/逐项 AttemptFacts。任一同步或收据 unknown 停止后续动作及
剩余树推进，保持 target 阻断；重启仅诊断初始树和逐项事实，不恢复执行权。
候选或受保护点漂移立即拒绝；对象已删除而 fsync/outcome 失败保存 deletion=committed
及对应 durability/controlReceipt=unknown，
整批部分删除不能记为“全未删除”。每步 ACK unknown 不自动重发或换新 action 绕过。
轮转失败独立于备份发布结果；非零退出不能否认已发布事实。

v1 不自动清理失败/取消/unknown staging；已成功 rename 自然移走 stage。
恢复诊断只核精确 inode/inventory/attempt 和既有事实，不建立 continuation。
S0 签名 release 不能移除 backup unknown 的 target 阻断；后续清理/解除需另立
精确证据及人工接管合同。保留原材料与容量告警，不自动恢复 DB、逆迁移或删除新数据。

## 7. AC / 必须转成实际测试的矩阵

下表全部是待实现/待执行。上轮 26 项旧 C1 通过与 held 红例不补签这些 AC。

| AC | 场景 | 判据 |
| --- | --- | --- |
| A01 | 未交付覆盖生产者/held/unknown/缺配置 | 无 capability；业务目录/DB hash 不变、无 source write-open、无外发 |
| A02 | 同一实际生产者与真实隔离 CLI 正例 | 真实 coverage path、reservation、固定 FS 和 C1 verify 全链成立；不签生产 ready |
| A03 | 伪造 proof/空 tasks/签名 stopped/clone/输入改值 | 固定拒绝；没有 test-ready 或 legacy fallback |
| A04 | S0 hold/失权或 attempt cancel 与 publish/prune 竞争；已有 closed 的再次 close | 实际失权/停止先提交则无 FS 副作用；close no-op 不授也不撤销 backup 权；既有 FS 事实不倒写 |
| A05 | 缺 schema/不安全 hot journal/替换 root、父目录或固定 DB inode | SQL/recovery 前拒绝，原 DB/旁文件 hash 保留；不接管新目录 |
| A06 | intent 已确认、initial reservation 回滚无行/ACK unknown、旧 token、新 request | 对照 intent 持久目标阻断；S0 complete/release 后新 operation 不能绕过 |
| A07 | 原 signal 取消后试图替换；queued timer/SIGTERM；hash 后窗口耗尽 | 无替换接口；让出事件循环并 syscall 前直核；首因保持、迟到仅 private stage、不假停止 |
| A08 | seal 后空目标/缺省输出根迟到出现、父目录替换、EXDEV/不支持 | 原对象 hash/inode 不变；无普通 rename/copy fallback，不收编迟到对象 |
| A09 | rename 成功后仅 fsync 失败、仅 outcome/外层 COMMIT 失败及同时失败 | committed 与两个 unknown 独立分列；备份保留、旧恢复点不删、零重发 |
| A10 | SIGKILL 在 intent 创建/同步、reservation/stage/seal/rename/outcome 周围 | pre-intent 未耐久不签可识别历史；已耐久 intent 即使无 attempt 行也阻断；新进程仅诊断 |
| A11 | 两文件+嵌套目录的逐步正常删除；间隙新增/替换、取消、保护点漂移；删除后 fsync/outcome 失败 | 剩余树只按已确认动作推进；未授权零执行，已删与耐久/收据逐项分列，unknown 后停止 |
| A12 | cleanup/close/S0 release 后的新 begin | 不删除未知材料，不因退出、TTL、S0 解除而消除独立 target 阻断 |
| A13 | C1 缺引用/hash/raw opt-out/版本化保留规则 | 原判断和历史事实不退化；complete 不等于静默证明 |
| A14 | 实际 npm/CLI/cron 消费路径及配置错误 | 首业务副作用前走同一固定入口；不能只验证方便替身 |

## 8. 实施顺序与并行边界

1. **本轮**：条件合同、两个独立新上下文 review、精确 source/window/证据保全；不实现。
2. **窗口确认后**：NEW attempt/拒绝状态机 与 Linux no-replace 原语资格可独占并行；
   仅证明各自内核，不算 A02/A14，不将 native helper 直接接现有生产 cron。
3. **唯一共享 owner 串行**：ledger/writers 的固定同连接组合与生产者交接；
   A3/R6 入口覆盖、延迟写入及 continuation 证据未完成就保持正向拒绝。
4. **前置齐备后**：真实隔离 producer→CLI→发布→轮转组合、反例、双非作者实现 review。
5. **另批切换**：C1 实际入口/cron 的消费及部署影响评估。严格入口启用会使未具备许可的
   备份失败，故不能静默改变现在线上每日备份；需要独立确认切换与实现窗口。

不创建大而全平台、不重复已完成 R1/TD-12、不运行模型评测，不清理保留环境。
实现前必要 ADR/架构入口由其归属协调者签收，不以本文代写现有共享文档。
`safe_rollback=null`、deployment blocked、hold、#435 全部保留。
