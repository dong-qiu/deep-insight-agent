# A3-S3：迟到提交 fencing 可行性与最小切片提案

状态：2026-10-08 **只读调查 / 待协调冻结与独立方案评审，未实现**。
来源为工程 `origin/main@41def9a7c75fff488cde206a5a2bfddebb6a9fe8`；另逐文件核对
S1 候选 `7a1ec26653b3dbcb700f9f9de56c0226a6d905a1`（tree 与受审 17f 相同）。
S0 候选 `5a38691d104aadde272c820698f74e2dfa96d92d` 的 CI
`37682264475 / attempt 1 / success` 由协调者告知，两独审 B0/W0；这些是候选证据，
不是本方案或新镜像通过证据。main 41 的精确 CI 尚未满足协调者的依赖合入条件，
本片不先实施 S2/S3、不自行合依赖，不以本方案补签质量、部署或全 writer 静默。

本轮修订时协调者更新：S0 已独立合入 `cb2f924`，精确 main CI
`37686929840 / attempt 1` 尚 pending；S1 正常同步 main 后候选 `9b80a7`
（原源文件同字节），正在73 guards/core/typecheck及正常 push 流程。此处保留原调查时点，
不把候选/合入/pending 写成主干验证通过。S2/S3实施仍须协调者核对前置精确 main success。

方案审查历史保留：`b4d68790dc0b03ec9b1b08df7813fc8527ce9514` 两位独立 Reviewer
均 B0/W1；原3W已解决，剩同一项 freshcap↔实际claim关联缺口。本次只补该关联和保护反例，
新head待协调者/独立delta复核，不把此前Warning改签为当时W0。

承接 [S0](a3-maintenance-protocol.md)、[S1](a3-writer-admission.md)、
[S2 提案](a3-bounded-drain.md)、[C2a](c2a-task-cancellation.md)、
[C2b](c2b-task-budget.md)、[恢复边界](recovery-time-coverage.md)与
[生产阻断](security-deploy-preconditions.md)。S1/S2 文档在各自冻结候选/独立 plan 分支，
尚未存在于本提案的 main 41 tree；链接表达依赖，不冒称已经主干集成。

## 调查归属与非目标

执行 Agent A 独占本新 spec，工作树
`/Users/dongqiu/Dev/code/insight-agent-a3-fencing-plan-20261008`，分支
`docs/a3-commit-fencing-plan-20261008`，PORT/APP_PORT `3119`，独立 DB_PATH/DATA_DIR；
仅复制必要 `.env.local` 并收紧 0600，没有启动服务、初始化业务库或运行模型。
S0/S1 源冻结不动，S2 spec 仍由本 Agent 独占；本轮不修改源、台账、历史 migration/schema、
模型、prompt、validator、评测、policy、Docker allowlist、SSM 或任何生产入口。

不建立全局任务平台，不替换 SQLite，不把所有 `assertWrite` 机械替换成一次 sidecar 查询，
不对所有 API/cron/CLI/startup 一轮接线，不重开休眠 P1 产品工程。
调查现有可选 anchor 只是识别提交风险，不启用或扩展它。

## 原始真实调用链与提交清单

`ops/generation-dispatch-worker.mjs` → internal HTTP route（先 `getDb`）→
`runGenerationDispatchOnce` → `claimNextGenerationDispatch` → `executeDispatch` →
scheduled/deep-dive scheduler → pipeline → `runJob` / C3 usage / report persistence。
S1 只在 core 最外层 `admit`，其 `finally.finish` 表达本地函数退出；未向 scheduler、Job、
usage 或 report 传递维护 commit capability。HTTP/worker composition root 尚未注入 S1，
`getDb` 的 startup reconciliation/seed/orphan writer 也不在登记域内。

下列行号绑定 main 41，S1 对 dispatch 增加 wrapper 后行号变化，不以行号代替 source hash：

| 真实路径 | 同步提交边界 / await | 当前 guard 与 S3 缺口 |
| --- | --- | --- |
| `db/provenance.ts:654` claim | 一个短业务事务改 dispatch/lease/trace，必要时创建 root Run | S1 admit 与此事务分别提交；登记先于 claim 不等于维护 close 与 claim 原子 |
| `agents/generation-dispatch.ts:89` heartbeat、`:125` done、`:140` failed | 定时 heartbeat 是独立业务事务；execute await 后 done/failed 调真实 finish | 内存 lostLease 与完整 claim guard 保留；S1 不封闭完成事务 |
| `db/provenance.ts:716` finish | 同一业务事务写 root failed、event、trace projection、dispatch、request、释放 lease | 函数内先验 dispatch owner/claim epoch/expiry；完整 lease owner/fencing guard 是 core 外部的 assertWrite，S3 必须在覆盖的**同一外层业务事务内**再次执行完整 guard，不能只靠原调用前读 |
| `runtime/jobs.ts:53,88,102` / `db/repos.ts:464,480` | 建 Run 是同步 INSERT；fn await 后 done/failed 的 finishRun 是独立同步事务并 projectTrace | 写前 assertWrite；未持 registry 锁，两个库间仍有检查后竞争 |
| `runtime/model-usage.ts:107` / `db/model-usage.ts:48,72` | transport 前 unknown、SSE/Responses 迟到 usage 各自同步业务事务 | 原 assertWrite 在事务内；signal 取消后仍允许真实 usage，lease-loss 拒写，未检查维护 gate |
| `agents/pipeline.ts:77,194` / `db/analysis.ts:112,222` | 模型 await 后 batch/citations/audits 或 validation/checks 与 event/revision 同业务事务 | afterSave 内 guard 抛错会回滚整事务；cache、coverage diagnostics、telemetry 和 failed event 另有事务，不是一个大提交 |
| `agents/pipeline.ts:258` leads/directions/opportunities | 多个独立同步事务；部分投影失败 non-blocking | 不可将某一派生事务安全外推到其他 writer，不能吞维护拒写后假报覆盖 |
| `db/reports.ts:172` ordinary publication | planned report/effect/review intent 事务 → 同步 staging/hash → attempted → 双文件 rename → reader projection/effect committed 事务 | 每个 guard、validator/raw/review 白名单保留；最终事务才是 reader 可见性边界；FS 与 SQLite 不具备单事务 crash 原子性 |
| `db/reports.ts:258` anchored publication | 相同 intent/FS，随后 Promise.all(sign/store)，再 commitAnchoredPublications 的同步业务事务 | await 前后 guard 阻止后续写，不能撤回在途 external I/O；不能锁 registry 或业务 DB 横跨 await |
| `db/integrity-publication.ts:105,152,209` | planned 候选在外部条件写前持久化；外部 await 后 anchor_written；最终 manifest/report/event/effect 投影同业务事务 | 外部 anchor 可能已写但 SQLite 未提交，必须保留 anchor_written/unknown 与专属恢复，不改写成远端取消成功 |
| `db/reports.ts:408,506` startup / anchored recovery | 普通 recovery 可 rename+发布；anchored recovery 会 resume planned 条件写并 await 验证，再最终事务 | 独立 writer，不自动继承 dispatch/task token；函数注释不能替代原始实现，实际 partial planned 恢复可能发外部写 |

报告白名单真实路径为 report-gen `selectReaderEligibleInsights`（`:174`）→ audited v6
reader binding / kept decision → `pass + support` citation → `buildReport`；最终 pipeline
`assertReportPublicationEvidence` 再核真实 raw archive 与精准 readerCitationBindings，
`assertReviewPackageForPublish` 验 trace/event/decision。fencing 不得绕过、删减或改变这些语义。
failed Report 没有 reader artifact/index/FTS，重试新建尝试；effect 保留 planned/attempted/
committed/unknown，anchor 另有 planned/anchor_written/committed。不能为了“清理成功”强改状态。

## 可证明的原子性与明确不可证明的部分

仅 `registry.check()` → 返回 → business write，无论 check 放在 async 返回后还是业务事务中，
只要 registry 锁已经释放，另一进程仍能在检查和 commit 间 close；这是必须保留的负控。
两个独立 DB 的一般跨库 crash 原子性不能由两个 BEGIN 或 finally/audit 宣称成立。

可交付的窄同步序列化是：同一 registry `BEGIN IMMEDIATE` 持锁，完整校验 marker/path/schema/
task generation/任务尚未本地完成/被选定的 commit gate，然后同步执行真实业务外层事务，
事务内重核完整 dispatch+lease owner/claimEpoch/fencingEpoch/expiry，执行唯一受审操作，
等待**同步**业务 COMMIT 返回后才释放 registry 锁。close/revoke 用同一个 registry 锁，因此
该注册消费者要么先完整提交，要么在 close/revoke 之后不进入其业务写入。
保证只覆盖这些显式消费者与此进程间 gate；不是 S0 acquire 与业务/registry 的统一原子事务，
不是 filesystem/remote 原子提交，也不证明同 uid 恶意篡改可防御。

锁序固定 registry → business；进入 permit 时 business `inTransaction` 必须 false，
否则 fail closed，不从已有业务事务 callback 内反向申请 registry 锁。短同步提交 timeout=0
遇 SQLite busy 立即拒绝，不 sleep/retry，不持任一 SQLite 锁跨 await/Promise/store/sign/fetch。
所有初始化/open/pre-BEGIN 延续 S0/S1 无 SQL path/marker/inode/journal preflight，事务内仍完整验证。
permit 不能公开任意异步回调执行器：只审计固定同步 callsite；仅 runtime 检测 thenable 是不足的，
async callback 在返回 Promise 前可能已产生副作用。不得将 async saveReport 整体塞进 permit。

业务 COMMIT 成功、registry 后续失败或进程退出可能发生；此时业务事实已经保留，
不能报告 rollback、重发 commit 或以 registry 没有 completion 推断未提交。登记记录保留 unknown，
用精确业务事实定向诊断；不新增自动恢复/接管。锁被 OS 释放也不能证明 remote subwork 停止。

## 最小可实施片 S3a 与必须先冻结的语义

建议 S3a 首先仅覆盖 core dispatch 的 done/failed **终态同步事务**，通过新增可选 types port
和 isolated adapter 传入；默认/未配置 core 路径保持原样。真实 `finishGenerationDispatch`
被包在上述外层业务事务中，完整 assertWrite 在同事务执行；claim、heartbeat、Job、usage、
分析/cache/report/notification/startup 继续列为未覆盖。一个 terminal transaction 的保护
不能写成“生成流程迟到结果全部拒写”或“报告发布维护安全”。不把改所有 repository 作为首片。

**S1 的 closed 是停止新准入，允许已登记任务合作收尾；S2 的有限 drain 依赖这个契约。**
不能默默将原 closeAdmission 改为全部提交撤销。按协调者进一步边界，提案限定为
**独立可选 port `a3-terminal-commit-v1` / profile `close-fences-terminal`**：

- 仅显式注入 S3 adapter 的 core 调用选择该 profile；adapter 绑定本次 S1 taskId、workerId、
  generationToken 与完整 isolation marker。profile/version 为公开消费契约，不给所有
  S1 task 自动加意义，也不是 OS/调用者身份认证。没有精确绑定或 S1 admission 时，
  配了 S3 的调用必须执行前拒绝，不能降级到无 guard。未配置 S3 保留 S1 既有行为。
- guard 消费端只允许同步 terminal done/failed callsite；同一 registry 锁内复核绑定 task
  尚无 completion 与 admission=open，再执行上述真实同步事务。close 后只对选择此
  profile 的消费者拒绝 terminal commit；S1 `finish` 仍允许记录本地退出，不授予业务写。
  S3 token/capability 不能由旧 token 隐式升级、重启接管或跨 task 借用。
- S2 的 profile 是现有 `cooperative-admission-v1`（文档消费名，不新增持久字段）：close
  → bounded cooperative drain → hold；不得自动注入 S3 strict profile。同一 fixture 如果
  混合选择 strict 的任务，S2 必须明确记录它们可能被阻止终态并保持 unknown/blocked，
  不能把这种组合解释成合作 drain 完成。消费负责人要在收据逐调用记录选择，registry
  尚无持久 profile 字段，因此不能从 S1 task 表推断全任务都消费了 S3。
- **实际阶段边界**：本最小 strict profile 中，close 本身就是该 terminal consumer 的
  revocation 时点，没有“先 close 合作收尾、再 S3 revoke”第二阶段。其 close-before-late
  execute 测试只证明 terminal 拒绝；其余阶段可能继续写，claimed/lease 仍留原事实。
  对需要先 close、等待合作 drain 后才 revoke 的维护流程，本片无法提供该分阶段 fence；
  必须继续 blocked，不能使用 strict profile 冒充。未来另冻结独立持久 revocation phase/
  generation/new sidecar 契约才可接这种流程，不在本片改 S0/S1 历史格式或业务 schema。

### 最终接口提案、同连接实现与文件窗口

下面为两独立方案 delta review 的精确提案，不是已经实现或最终通过的 API。
执行 Agent A 拟独占 `ops/maintenance/writers.mjs`、其 declarations、专属 terminal node-test、
新 `src/lib/runtime/terminal-dispatch-driver.ts` 与专属测试、
`src/lib/runtime/writer-admission.ts` types、core `generation-dispatch.ts` 与专属测试、
本 spec/后续新 receipt。实际窗口由协调者确认后才实施，不动 provenance/repos 等业务
repository 源或历史 schema，也不把本 spec 当全部 source 文件写入授权。
runtime driver 只向下依赖 db/provenance，不依赖 app/agent；core 只 typeimport runtime port。
ops 接收固定 driver 对象，避免 Node `.mjs` 直接 import 尚未编译的 TS，Docker 不新增 ops runtime依赖。

```ts
// 精确职责签名；品牌类型与错误值的声明只放 shared runtime types。
type TerminalCommitResult =
  | { kind: "committed"; businessCommit: "committed" }
  | { kind: "not_committed"; businessCommit: "not_committed"; code: TerminalDenyCode }
  | { kind: "unknown"; businessCommit: "committed" | "unknown"; code: TerminalUnknownCode };

// 固定 factory 无 callback/agent/function 输入。负责亲自 preflight/open 唯一业务连接。
declare function openTerminalDispatchDriver(root: string): FixedTerminalDispatchDriver;
// Driver 自有 readonly db 属性；核心必须使用这个同一 DB 对象，不接受另一个连接。
// 唯一同步方法内部固定调用 assertGenerationDispatchClaim + finishGenerationDispatch。
interface FixedTerminalDispatchDriver {
  readonly db: DB;
  commit(claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult;
  close(): void;
}

// writers 的一个新 opt-in API；不建立第二 registry connection，不公开 lock/check/work callback。
interface WritersTerminalExtension {
  terminalAdmissionFor(worker: WriterGenerationToken,
    businessDb: DB, driver: FixedTerminalDispatchDriver): TerminalWriterAdmission;
}
interface TerminalWriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  readonly version: "a3-terminal-commit-v1";
  readonly profile: "close-fences-terminal";
  admit(): FreshTerminalTaskCapability;
  bindClaim(capability: FreshTerminalTaskCapability, actualClaim: DispatchClaim): void;
  commitOutcome(capability: FreshTerminalTaskCapability,
    claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult;
  finish(capability: FreshTerminalTaskCapability, outcome: WriterOutcome): void;
}
```

DispatchOutcome 精确复用 `Parameters<typeof finishGenerationDispatch>[2]`，不新增业务终态。
driver.commit 是 writer内固定合作方法，core/API/CLI不直接调用它；最终全diff核callsite只有
writer的同连接transact路径。module导出或可被同uid调用不等于授予生产安全权限。

`FreshTerminalTaskCapability` 是当前 admission closure 的非持久 opaque 对象，包含 S1
task 身份但不是可序列化的 S1 token 升级。`admit()` 在同一 registry transaction 建新 task，
当场用本 admission 私有 WeakMap/对象身份 mint capability；不提供 `resume/bindExistingTask/
capabilityFor(taskId)`。读 DB 的旧 task、JSON clone、另一次 factory、另一个 openWriters
handle/connection、重启后的同 worker/token 都不能重建/借用 capability。
一次 terminal attempt 开始即消费 capability 的 terminal 权限（包括拒绝/busy/unknown），
没有第二次自动 done/failed 尝试；本地 `finish` 权限独立，只写原 S1 本地退出事实。
不新增 persisted profile/task 字段，不声明 OS 身份认证或防恶意同 uid 注入。

### Freshcap 一次绑定真实领取结果

core真实 `claimNextGenerationDispatch(db)` 返回非null后、任何 `execute`/外部工作之前，
必须立即以同一调用刚mint的cap调用 `bindClaim(cap, actualClaim)`。这就是唯一受审bind
callsite，不能从execute传参、fixture推导、旧task查询或别的任务选择一个claim绑定。
bind在writer同privateclosure内一次成功后不可重绑，保存六个 primitive 字段的不可变快照：
`dispatchId / traceId / ownerToken / claimEpoch / fencingEpoch / rootRunId`，不保存可变claim引用。
epoch必须保持实际claim数值，不做字符串转换/归一化；业务payload和claim事务原契约不改。
`no_claim` 只进行S1 localfinish，cap没有terminal权限；未bind或localfinish后不可bind/commit。
bind失败按严格profile的控制拒绝直接退出，不进入execute，也不借普通catch执行failed终态。

同openWriters私有closure维护“已绑定claim六字段tuple → 唯一cap”的进程内索引，覆盖
该handle产生的所有terminalAdmission实例；首次bind即登记且不在finish/deny/unknown时删除。
因此同claim不能换一个freshcap重新bind/重复terminal attempt，不能借另一个worker/admission
绕过原cap已消费状态。此索引不持久化、不支持从旧claim重建cap；重启或跨connection
没有旧cap权限。受审core只绑定自己这次实际claim返回，真实claim事务原有owner/epoch
递增保持；不声称该进程内索引防恶意同uid跨handle手工伪造claim。

commitOutcome进入driver前必须核cap对象身份、尚有本次terminal权限及该不可变六字段
逐字段完全一致；capA合法但传同closure真实claimB、改rootRunId、bind后改claim对象或已消费
claim换cap，都固定拒绝 `writer_terminal_claim_mismatch`，先于任何业务写。
不满足fresh/bind条件仍用 `writer_terminal_capability_invalid`；不能把失败后的同cap/
同claim重新bind作为自动重试。

`terminalAdmissionFor` 必须直接复用 `openWriters` 的**同一个私有 db/transact/validate/owned**
closure。每次 commitOutcome 调单次 transact；callback 内只用私有校验/查询，不能调用
inspect/admit/admissionFor/finish 等会再次自起 BEGIN 的 public method。新 adapter connection
先持 registry 锁再调 public inspect 会 busy，这不是正确实现。不得 check后释放锁再调driver，
也不把 nested registry transaction 错误自动降级。public closeAdmission 与 terminal transact
使用同一现有 BEGIN IMMEDIATE 锁域，marker/S0完整检查仍在同事务内保留。

### 物理业务身份，不靠调用者 scope 字符串

root 必须是此 openWriters 已验证的完整 S0 root/marker；driver factory 仅打开
`join(root, "fixture-business.sqlite")`，拒绝可选 filename、memory/URI/temporary DB、其他目录，
不初始化/migrate/seed/reconcile 业务库。测试先在自有同 root 通过真实 openDb/provenance
migrations/createRequest 建 fixture，关 seed handle 后由此 factory 重新打开。

factory 在 `new Database`/任何 pragma/BEGIN 前以零SQL确认 canonical root与完整marker，
root700/DB600/current UID/regular/no-symlink/nlink1、真实路径精确等于上述路径，记录 dev/ino；
open 必须 fileMustExist/timeout0，不新建文件；open 前后 inode相同才继续。factory 自己
持有这个 native connection，从而不会只用 `.name` 推定一个既有任意 handle 已绑定 inode。
admission 要求传入 `businessDb === driver.db`，core 使用同一引用；driver/DB对象关闭、readonly、
foreign connection、root/marker 不同均拒绝。固定factory的审核来源、不可变对象与同步实码
是消费前置；不能仅靠 caller声明 profile 或运行时 thenable检测证明某任意 driver安全。

每个 registry BEGIN 与业务 BEGIN 前均做零SQL physical preflight：native db.open/name/
inTransaction、canonical root、marker/dev/ino/owner/mode/nlink，合法隔离 journal/WAL/SHM
也必须600/currentUID/regular/no-symlink/nlink1。出现 unsafe 热 journal 时任何可能触发
恢复的 SQL/pragma之前拒绝并保留原DB/sidecar size/hash，禁止 chmod修复、复制live WAL
或切换journalmode消除证据；合法隔离WAL允许native协调，不声称文件静态不变。
初次及事务内在完整 preflight后再用实际 `PRAGMA database_list`核main的精确filename、
禁止额外attached业务库，并复核真实provenance tables与claim，外部DB不由普通业务schema
“有同名表”授权。路径swap/marker变更后不换连接重试。

### 固定同步 driver、提交事实与 done/failed 实际控制流

driver 是唯一 factory产出的冻结固定同步实现，commit只接 claim/outcome值，**没有 work/
callback/assertWrite函数或 async输入**。本地 lostLease 在core选择终态前先按既有路径拒写；
driver内部显式短 `BEGIN IMMEDIATE`，同一外层业务事务内先执行真实完整
`assertGenerationDispatchClaim(db, claim)`，并用同事务真实行核
`generation_dispatch.id=claim.dispatchId`、`generation_dispatch.trace_id=claim.traceId`、
该 `generation_trace.id=claim.traceId` 的 `root_run_id=claim.rootRunId`，且root Run真实存在并
`run.trace_id=claim.traceId`，随后 `finishGenerationDispatch(db, claim, outcome)`
（其原事务为嵌套savepoint、旧业务契约不变），`false` 作拒绝而非成功，最后同步 COMMIT。
原 assertGenerationDispatchClaim 不验证rootRunId；不能省略新增的只读关联校验，否则
failed路径会按错误输入修改另一Run。关联不一致以generation_fence_lost拒写并按pre-COMMIT
rollback事实返回，不能改历史repository/schema或用caller给的rootRunId当事实。
固定实码+两独审确认无await、无传入可执行函数、无业务逆向锁，才是同步性证据；
thenable检查只能额外拒误用，不能把任意 async callback 变安全。

拒绝代码固定脱敏：closed=`writer_terminal_closed`，foreign/invalid capability=
`writer_terminal_capability_invalid`，business身份不符=`writer_terminal_business_mismatch`，
reverse transaction=`writer_terminal_reverse_transaction`，known busy=`writer_terminal_busy`；
cap与实际claim六字段绑定不符/同claim换cap=`writer_terminal_claim_mismatch`；
完整lease/dispatch guard失效或finish false=`generation_fence_lost`，确认pre-COMMIT
rollback的其他固定终态错误=`writer_terminal_commit_failed`。未知代码只用
`writer_terminal_business_commit_unknown` 或 `writer_terminal_registry_commit_unknown`，
不保存错误正文、配置或SQL原文。

- `not_committed` 只在业务未进入写事务，或**尚未尝试 COMMIT且显式 ROLLBACK返回成功**时
  可以给出；完整 guard/finish false/业务callback抛错不一概表示 rollback。
- 只有真实业务 COMMIT 返回后才标 businessCommit=committed；registry最终COMMIT也成功
  才整体结果kind=committed。业务 COMMIT已尝试但抛错、rollback失败或无法确定切点时
  kind=unknown/businessCommit=unknown，禁止自动再finish。
- business COMMIT已返回、registry结束失败则kind=unknown/businessCommit=committed，
  保全业务事实，不能宣称business rolled_back或重发。SIGKILL无法返回result时，旧task/
  未完成登记及现有业务事实保持，诊断按unknown处置，不从cap丢失推断没有提交。

core done分支在原lease/首cancel/deadline/C3/budget checks之后调用commitOutcome；
得到not_committed或unknown直接返回本执行器failed并记录固定拒绝/未知诊断，**不throw到
普通execute catch然后再调用failed**。若adapter抛出未分类错误（含registry身份检查），
单独terminal尝试边界catch保全unknown并return，不落普通catch、不调用无guard finish。
execute本身失败的既有catch先保持lease guard与既定首因/预算分类，再仅一次guarded
failed commit；deny/false/throw同样return failed，绝无legacy fallback。
未配置S3的路径仍调用原finish，两条路径由显式profile选择，不通过“guard可选?失败用原路径”
实现。Lease loss优先拒写；固定cancel/deadline reason不被新诊断覆盖，C3/预算顺序保持。
S1最外层finally只记录本地 outcome，不能重建cap、发新的terminal write或签quiescence。
terminalAttempted标记必须涵盖整个之后的traceStatus读取/状态校验路径：业务已COMMIT
返回后若后置读取/校验失败，保留businessCommit事实并返回failed/unknown诊断，不重入普通
catch尝试新的failed终态。不能以“最终函数返回failed”推断已经提交的dispatch事务回滚。

选择与字段冻结、实际消费窗口确认、两独立 Reviewer 方案复核前不写实现。
新维护侧车协议/可选消费者属于协调者可讨论的工程范围；若必要方案触及历史业务
schema/data contract、改变引用校验/模型/评测、批准策略、安全边界或生产解锁，
立即停止并由协调者向用户请求明确批准。迁到 business DB/ATTACH 多库持久 fence 或
增加历史表字段不属于本片可擅自采取的替代方案。

## 控制优先级、迟到工作与退出

原 claim ownership 优先：旧 owner、wrong claim/fencing epoch、租约到期/接管在真实业务事务内
拒绝零业务写，含 failed Run/event/usage；维护拒写也是提交授权拒绝，不能拿取消/预算理由
绕过。仍先保持 C2a 首次已观察 cancel/deadline reason，再 C3 sticky persistence fault，
再 task budget sticky；permit 不能 abort/rewrite signal，也不能用新 Error 遮蔽已固定的首因。
维护 diagnostic 应独立保留固定授权拒绝事实，不能把它灌为模型失败或“成功取消”。

C3 取消后实际迟到 usage 可以在原 lease 允许时落盘；全关闭后的维护 fence 是否也拒这种
授权观测必须逐 writer 冻结，不能为了保全成本绕过 fence，也不能直接吞掉并宣称费用齐备。
本 S3a 不改 usage 路径；未覆盖 usage 是持续阻断条件。Run.cost 兼容估价、C3 attempt 与
P1 不相加，未知金额不写零，不改变预算默认值/结算等待或 manual/cron 取舍。
模型与子 Promise 无可靠终止回执始终 unknown，保留 rejection handler，迟到完成不能
启动未授权后续阶段。S1 本地 finish 可以照旧写本地退出事实，不把它当业务 commit permit。

每个 snapshot/收据仍固定 `writer_quiescence=false`、`production_permitted=false`、
`process_termination=unknown`、maintenance ready=false；没有 coverage、原始证据过期、
marker/owner 不明、跨库结果不明或终止未知时 blocked/hold，不自动重开/清理/删除记录。

## 实施前保护反例与验收计划（尚未执行）

1. 真正双进程两个 SQLite connection：负控 sidecar 单次检查后 pause，让另一进程 close/revoke，
   再真实 terminal commit，证明旧方案可跨门；正控 permit 持锁覆盖真实业务 COMMIT，
   close/revoke 要么 busy 拒绝后有界重取、要么提交发生在其前；绝不能 claim close 已成功而后来穿门。
2. close/revoke 先持久成功，再放行 execute 的 deferred promise：通过真实
   runGenerationDispatchOnce 的 done 与 catch/failed 两支，受保护 terminal 写为零，
   claimed/lease/Run/event 原事实保持，登记本地 outcome 与 remote unknown 不混为一谈。
3. 旧 owner/epoch、期限到达、另一 worker 接管、wrong task/generation、completed task、重启
   old token 与 marker/pathswap 各自拒绝；JSON clone、跨admission/connection借cap、从旧task
   恢复cap、已消费cap都拒绝；未登记/未配置 writer 不签覆盖。
4. 同时 cancel/deadline/lease loss/C3 fault/budget，原首因与优先级回归；持有 lease 的原取消/
   预算 failure 不改现有状态语义，strict gate 拒绝时不借失败收尾越门。
5. reverse lock order/已在 business transaction、SQLite busy、no-SQL preflight hot journal
   0644、legal0600 recovery、外层业务 rollback、业务已 commit 后 registry failure、SIGKILL
   每个切点：保全原 size/hash，未知不清零，不自动重发；原数据契约未变。
6. 固定同步 consumer 的 TS/运行时限制及 callback 返回 Promise 的负控不能当安全授权；
   没有 lock跨await，原正常路径成功/失败仍走真实 repo/state projection。
7. 必须包含部分覆盖反例：terminal 被拒而 usage/report/startup 未登记路径仍写，
   必须保持 ready=false。旧 pass/support/raw/review 白名单定向生产路径回归保留；
   mock只证明控制协议，不是模型质量。anchored partial write 最终 unknown，不签远端终止。
8. memory/foreign DB、另一同filename root、同文件另handle、DB与driver对象不一致、closed/
   readonly/native handle、symlink/pathswap/permissions/sidecars/额外ATTACH，各自先于任何
   business写拒绝；有同schema但物理身份不同不能通过。existing open handle遇真实SIGKILL
   热journal0644必须零SQL拒绝并原hash保全，合法600允许native恢复后重核binding。
9. 同连接private transaction正控，不用另registry handle套锁再call public method；busy失败
   不能改走legacy。done deny返回、done adapter throw、failed finish false、failed adapter
   throw、precommit rollback success/failure、businessCOMMIT返回前后、registryCOMMIT失败
   全部分别验证：正确三态、terminal一次调用、无catch→failed二次提交、无旁路、未知不清零。
10. 同closure真实两个createRequest/claim、两个freshcaps，先各自bind真实返回后交叉commit
    capA+claimB/capB+claimA；wrong rootRunId（指向另一合法running Run）、bind后修改任一六字段、
    不可重绑、同claim尝试替换freshcap（含同handle另一admission）、已deny/unknown/finish后
    再mintcap、旧task/重启重建cap、no_claim cap调用terminal，全部拒绝零业务写。
    数据库真实trace.root_run_id被改/与dispatch或Run.trace_id不一致的变体必须在同外层事务
    guard拒绝；保护另一Run状态/hash，不能靠cap六字段匹配就接受错误业务关联。
    正控核bind在真实claim之后execute之前，claim事务不在permit、不改provenance/schema/
    S1默认准入；no_claim仅localfinish、没有可恢复terminal授权。

验证在全新真实 provenance fixture seed/createRequest/claim 上执行实际 core/repo路径，
不构造仅状态机 observations 替身。源改动后按风险跑专属并发/故障测试、C2a/C2b/C3/发布
回归、ops、双 typecheck/lint；src/bundle改动补build和实际 Docker。相同最终 tree 的有效结果
可以绑定复用，但本方案没有测试通过章，没有预签 Eval-Gate skip，没有使用不跑改动路径的 A1。
最终 head、tested merge、main CI 与新镜像分别记录，两独立最终 reviewer 无未解 Blocking。

## 本次调查结论与后续唯一动作

无需历史业务 schema 改动即可研究一个注册域的**同步 terminal transaction**关闭竞争屏障，
但现有 S1 接口本身不提供 commit permit；S2 合作 drain 和 S3 revoke 的语义也尚未冻结。
全生成提交封闭仍是逐 writer 工程待办，外部 I/O/unknown termination 与全入口覆盖是缺证，
生产集成/执行是授权阻塞，真实模型质量是预算阻塞，不能被该最小片消除。

下一步仅由协调者与独立 Reviewer 选择并冻结 S3a gate 语义/实际 source 文件窗口，
等待前置合入及精确 main CI 后再授权分片实现；不重复 S1、同镜像矩阵或追加性能实验。


## S3a 实施候选增量（原调查与review时点保留）

协调者核验S0 #448、S1 #445已合入且精确main CI通过；本独立实现从最新
`56c7ddbcf0bc9d6a7d84f231e6804896d76d0841`开始，直接核GitHub
`37696229494 / attempt1 / completed / success / headSha=56c7ddb`。
已冻结4998提案两独立方案B0/W0，不将此前b4d B0/W1改签当时W0。
S2源8d9bff双实际review通过，但PR/main流程由协调者进行；本S3不依赖S2源，
不将S2合入或精确main待办写通过，也不修改S2文件。
实施WT `/Users/dongqiu/Dev/code/insight-agent-a3-terminal-20261008`，分支
`feat/a3-terminal-fencing-20261008`，PORT/APP_PORT3123，自有DB/DATA与0700/0600配置/产物。
冻结提案三专属spec commits正常顺序cherry-pick，原完整31794bytes及
SHA256 `5f8d6798c7c424700f661c4c8cbbaf98aa2b19bcba81cfc729ffaa03a3dfe7e9`保留。

最小实现窗口仍为writer私有registry扩展、shared types、固定runtime driver、core terminal
可选消费端和各自专属tests/本spec/新receipt；没有修改provenance/repos/schema/validator/
models/prompts/SSM/policy/Docker allowlist。fixed factory只接root，没有custom-driver factory
或可执行callback输入；真实受审composition只由openTerminalDispatchDriver产出driver。

协调者追加冻结两项内部只读数据桥与一项可选诊断，公开admit/bind/commit/finish签名不变：

- `Symbol.for('insight-agent.a3-terminal-driver-v1')`：factory冻结descriptor
  `{root,marker,fileDev,fileIno}`，marker嵌套deep freeze，与冻结driver绑定。
  registry在自己的BEGIN之前核完整S0 marker/原inode/native exactDB及sidecars；driver
  在business BEGIN前及事务内重核自己的open-time物理事实。此数据桥不认证OS/调用者，
  不防同uid恶意伪造，Symbol/shape/freeze/thenable不证明任意callback安全。
- admission的独立 `Symbol.for('insight-agent.a3-terminal-admission-v1')`：
  `Object.freeze({businessDb})`；native DB不deep freeze。core在admit/claim之前精确
  比较此引用与本次db；缺桥、错db、错literal profile/version、同时配置旧S1 port都直接
  拒绝，无claim/execute/failed fallback。此桥不提供method或新授权。
- strict opt-in真实terminal尝试后可返回 `terminalCommit?: TerminalCommitResult`。
  default/S1/preclaim/no_claim形状不变。diagnostic只保全同步COMMIT事实与固定脱敏code，
  不修改Run/usage/trace历史数据契约，不覆盖首cancelreason/lease>C2a>C3>budget，
  不从core status=failed推断business回滚，也不授予retry/fallback或fullwriterready。

在固定同步driver同外层业务事务内核完整真实dispatch/lease及trace.root_run_id、Run.trace_id，
finish false显式rollback；COMMIT尝试后抛错保unknown。business COMMIT已返回但registry
失败保unknown/committed；SIGKILL无法返回时从真实保留facts定向诊断，task未完成/remote
仍unknown，不恢复cap。终态attempt开始即消费cap，包括未绑定的拒绝，claimtuple索引
不因finish/deny/unknown删除；S1合作close/localfinish/default不改。

原始反例执行情况与最终head/source/raw/hash、完整验证、尚待两独立最终review/PR/CI见
[本片收据](../../verify/a3-terminal-fencing-2026-10-08.md)。本候选不是新镜像或生产验收。
全writer覆盖、Job/usage/report/startup提交与未知子工作仍阻断；不持锁跨await，
不增加global deadline、阶段revoke字段、历史schema或生产解除入口。


协调者进一步冻结strict-only收尾保真：若已实际terminalAttempt且已形成terminalCommit，
最外localfinish失败返回status=failed并保留原诊断三态，登记task仍unfinished/remoteunknown，
不补写、重试或删除；没有terminaldiagnostic的preclaim/no_claim失败仍异常拒绝。Default/S1
不变。真实factory businessCOMMIT返回→registry handle丢失→实际core localfinish抛错，
独立fresh连接核业务已提交与task未完成；原遮蔽诊断红反例保留，不能当成本地退出已确认。
