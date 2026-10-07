# TD-10 独立 collector 控制首片：本地工程收据

基线 `41def9a7c75fff488cde206a5a2bfddebb6a9fe8`；对应
[冻结 spec](../plan/specs/c2d-collector-task-control.md)。本地实现完成，最终独立
diff review、Eval-Gate 判断、PR/受审 head/tested merge/main CI 尚待协调者登记。
不代表合入、上线、来源网络已停止、全 writer 静默或 TD-10 整体关闭。

## 已执行的实际路径

`collectSource` 显式可选 signal/deadlineAt/taskBudgetUsd → collector-owned cancellation
scope + 原 withTaskBudget → 原 runJob/UsageJob → 真实 source/article await →
SQLite Content/intent/revision → 原同步 raw archive → observer/shadow → Run/trace 收尾。
collector 外层 scope 保留至 trace finish/return/finally，未复用已 dispose 的 Job scope。
无隐式 env deadline、HTTP 断开、来源/模型/prompt/策略/schema/预算金额口径改动。

取消/预算检查先检查 ownership；Run assertWrite 保持 ownership-only，合法 failed Run
可以收尾，lost lease 旧 owner 不能写 collector 的 Run/event/trace/显式 markUnknown。
heartbeat false/SQL throw 均置 lostLease；SQL throw 不逃逸 interval。
父 budget 继承不被子 cap 覆盖，只复用既有兼容估价；collector 不调用 LLM、不创建
新金额事实，也不能将这个 cap 宣称网络费用、真实账单或全局金额上界。

source/article 成功与异常返回后都检查，metadata 每次事实写入前检查，控制不被
best-effort 吞掉。raw helper 成功立即登记 exact committed ref，之后检查或 telemetry
失败不能让它消失；intent 已提交而归档未启动是 exact unknown ref/非 reader eligible，
仍持 owner 才能显式标 unknown；失 owner 保留 planned intent 交原恢复流程。

observe shadow 保留现有启用、筛选、QPS/item/bytes/time 策略、source 参数。
guarded sink 的 append/nextAttempt/archive 在准入前检查；fetcher/program-page 的
beforeRequest 按 check → await 原 policy/QPS → check，真实 settle/异常后再检查。
完整 await 原 sampler，最后 close，一次取消不提前 race-close 独立 shadow.db。
默认无控制/trace/父 budget 时仍使用原 sink/fetcher；普通 shadow 错误仍不阻断 RSS。

## 保护反例与结果

| 场景 | 实际证据 |
| --- | --- |
| 首次已取消、过期/非法 deadline、0/非法 cap | 真实 collector/runJob；零 source/article/shadow 请求，原 failed Run 载体或非法输入执行前拒绝 |
| source/article 迟到成功/失败、首原因、父预算竞争 | 真实 scope 与 controlled barrier；提交被抑制，lease 优先于取消/预算，取消首因不被 deadline/budget 改写 |
| raw planned/committed/unknown、telemetry/cancel | 真实 SQLite/raw helper/文件，exact refs/reader eligibility；第一条 committed 保留，后续条目拒绝；失 lease 后 collector 显式 unknown/失败写入为零 |
| heartbeat false/throw、实际 expired claim | DB 状态与 fake timer，旧 Run 不补写 failed，timer 清理 |
| Job done → outer trace gap | 真实 Job 完成后注入取消/失 owner；外层检测拒绝成功返回/成功 trace 收尾，已 done Run/committed facts 不改成回滚 |
| shadow transcript/program-page late resolve/reject、sink/QPS wait | 真实 sampler/store；close 在实际 settle 后一次执行，无新 terminal/archive；普通 shadow 失败仍正常 RSS |
| RSS/article/robots/redirect | 真实 registry/RSS/parser/article/robots/safeFetch 与 fake DNS/HTTP，真实生产 DB/raw 与独立 shadow DB/archive，不调用实际网络 |
| 默认与足额 | 原 collector 32 项回归，以及真实 RSS/shadow 请求顺序/正文/raw envelope/reader 数据等价 |

先补协议用例运行原基线。首轮测试 fixture 遗漏播客原必填限额、错误期待 request
状态 running（原为 accepted），属于测试错误；修正后绑定原基线源码重新跑
35 项：**25 fail / 10 pass**。保留原测试、两轮原失败日志与修正 fixture 快照；
红阶段还有 1 个测试 assertion Promise 的 unhandled rejection，不冒称生产缺陷。
修复代码后增加两项预算/intent fencing 反例；独立最终 review 修正见下文，
最终新增 38 协议 + 9 HTTP 路径用例。

| 最终本地门 | 结果 |
| --- | --- |
| collector/new protocol+HTTP/shadow/store/C2a/C2b/jobs/raw archive/pipeline budget | 最小 nested reason 修复后，11 文件、178 项通过，0 skip、0 unhandled errors |
| `npm run typecheck` | TS7+TS6 app/tools 均通过 |
| `npm run lint` | `0f3f9a3` 全库通过；最小 reason/测试修复后两个受影响文件 lint 再通过 |
| `npm run build` | 绑定 `0f3f9a3` 成功；本轮仅诊断字段 delta，复用既有 build；保留 middleware→proxy 弃用 warning |
| `npm run test:ops` | 绑定 `0f3f9a3`：367 项、364 pass、0 fail、3 既有 Linux Docker image-only skip；本轮无 ops 变化，复用 |
| `git diff --check` | 通过 |

ops 的 3 个 skip 是 frozen447 HTTP 矩阵、旧 A2 native/迁移、#435 GHCR 真 pull。
这些不执行本片 collector 控制，不当成本片证明或镜像资格；对应专属 PR/Linux CI
仍须执行实际镜像路径，不以本地 skip 补签。build 不改变路由；本片未声称 HTTP
caller 已接入可选控制，未新增 browser 门或以页面 health 当维护静默。

独立 Reviewer1 对 `0f3f9a324f43bb3b633192eb30443aea0a64f983` 原最终 diff 为
Blocking0/Warning0；Reviewer2 原同 head 为 Blocking0/Warning1：普通
`provenance_revision_conflict` 的 top-level reason 仍为 conflict，但 nested
`error.reason_code` 被意外从原 `${stage}_failed` 改为 conflict。该发现来自
原始/最终 diff，Reviewer2 没有运行失败字段反例，不能冒称其运行产物存在。

作者随后新增真实 collector/runJob/SQLite/trace 反例，在原 `0f3f9a3` 消费代码
执行：唯一选中用例 **1 fail**，nested 实际 conflict、期望 collect_failed。
修复仅让 TaskCancellationError/TaskBudgetError 使用标准 nested reason；其他普通
错误仍保留原 stage_failed，top-level conflict 与普通 retryable=true 不变。
取消/deadline/budget 用例补 nested 标准 reason/retryable=false SQL 断言。
修后完整 178 项、双 typecheck、受影响 lint 均通过，最终双 delta review 尚待登记。

已完整读取 eval-gate：最终 diff 仅 collector 控制接线，来源文件/正常选择/正文/
模型/prompt/校验/评测口径不变；真实控制与 source HTTP 回归提供对应证据。
尚未预签 skip；两位独立 Reviewer 复核后由协调者按实际 diff 决定盖章。
未运行 A1：它不执行本片独立 collector/shadow 控制，模型预算为 0。

## 保留的限制、归属与原材料

**本片不能证明底层源及时取消或严格 deadline 返回。** 真实 article 反例表明：
任务取消时原 robots availability catch 可 fail-open，随后内部文章请求仍会发生；
collector 只在实际 await 结束后拒绝结果。RSS/arXiv 队列/退避、source 诊断、响应
reader 与 raw helper 内部跨进程每次 finalize/markUnknown fencing 仍是工程待办。
未知子工作终止继续保持维护 blocked，不把上述缺口归成模型预算或生产授权阻塞。
已发出的工作与已 committed 输出不回滚，不认证 whole-writer quiescence。

私有原材料根：
`/Users/dongqiu/.local/share/insight-agent/evidence/td10-collector-plan-20261008/implementation/`。
初版 `index.json` 绑定 `0f3f9a3`、源码/测试/原基线对象 size/hash、原始失败与最终日志、
命令/结果、专属文档及 Reviewer2 原方案 review；索引 hash 在最终交接提供。
原 proposal/index 完整保留，非覆盖追加；dirs0700/files0600，不将日志或原文入 Git。
最小 nested reason 修复另归档 `../nested-reason-fix/index.json`，绑定新增提交、
before 红、178 项/双 typecheck/lint 原日志、最终 delta、Reviewer2 原 review；
不覆盖初版索引或将旧 head 的完整审查直接移植到新 head。

worktree `insight-agent-td10-collector-plan-20261008`、port3118、独立 DB/DATA；Agent B
独占 collector.ts、两项新测试及专属 spec/receipt。其他 shared 文件零修改；不清理
旧 branch/worktree/原证据。未生产访问、部署、真实模型/通知/实际 source 抓取，
未改变 safe_rollback/null、hold 或 #435 生产硬阻断。

## 最终修正评审与质量门判断

源码最终受审 `74053b6292f06c1499c071e6db5936e87ff6d399`；修正普通错误 nested reason
后，Reviewer1与Reviewer2分别独立38项控制回归通过，两位最终 Blocking0/未解决Warning0。
Reviewer2原记录 `a3-reviewer-two-20261008/collector-delta-review-v1.md` SHA256
`fcd4789cfc9fdc3b6878f1f2264119b6f1c1df933297aa96f37123f5c3c488ef`。
两位逐一核原15份修正材料、5文件Git源码绑定、旧head真实单红和新178项/双TS日志。
修正专属index `td10-collector-plan-20261008/nested-reason-fix/index.json` SHA256
`eb861b09277d3bb73e17056400971d66914476122fa28e3a10c18d751ab5b2ab`；初始实现27份index
SHA256 `10fd7552f48bccb97c998ded0f7630148938a86f0a9e8a31963d4205e19487ef` 继续保留。

协调者完整读取适用 eval-gate 与最终 collector diff/spec/receipt后，核正常/default/足额
来源参数/筛选/QPS/正文/reader/模型/prompt/validator/评测口径未变，选择控制协议回归例外：
Eval-Gate skip，理由为纯显式取消/预算/ownership接线，178项真实collector/job/SQLite/raw/shadow及
fakeHTTP source回归、双TS、两独立最终review提供对应证据。不是模型质量通过，不运行不执行
此路径的A1。本次记录在证据与两评审完成后追加；原0f3时点未盖章及Warning1保留。

后续最终feature head/tested merge/必需CI/精确main/私有原包由协调者绑定；正文追加不改变
74053源码字节，不预签合入或上线，不关闭底层source取消/raw内部fencing等工程缺口。
