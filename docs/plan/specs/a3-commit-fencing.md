# A3-S3：迟到提交 fencing 可行性与最小切片提案

状态：2026-10-08 **只读调查 / 待协调冻结与独立方案评审，未实现**。
来源为工程 `origin/main@41def9a7c75fff488cde206a5a2bfddebb6a9fe8`；另逐文件核对
S1 候选 `7a1ec26653b3dbcb700f9f9de56c0226a6d905a1`（tree 与受审 17f 相同）。
S0 候选 `5a38691d104aadde272c820698f74e2dfa96d92d` 的 CI
`37682264475 / attempt 1 / success` 由协调者告知，两独审 B0/W0；这些是候选证据，
不是本方案或新镜像通过证据。main 41 的精确 CI 尚未满足协调者的依赖合入条件，
本片不先实施 S2/S3、不自行合依赖，不以本方案补签质量、部署或全 writer 静默。

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

port 的类型/adapter API 精确签名仍需两独立方案 review 后由协调者冻结：建议 core
显式参数提供仅接受本次 task 的同步 terminal runner，caller 负责同一 isolate/registry、
固定同步 callsite 与 registry→business 锁序，不把任意回调声称已审。拒绝 foreign profile、
foreign marker/task/owner、已完成 task、business inTransaction 与 async callback；
这些边界不依赖 runtime 字符串断言就能证明所有代码已消费，最终仍核原始调用链。

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
   old token 与 marker/pathswap 各自拒绝；未登记/未配置 writer 不签覆盖。
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
