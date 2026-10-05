# C2b / TD-10：任务预算检查（候选契约）

日期：2026-10-04 启动，2026-10-05 收尾。初始基线 `origin/main` @ `c7648986d96e040dcad8c7e6dd01e75759c2bbee`。
当前基线为 D1 合入后的 `4e09ec93923a0d7bece2b282045a18c98eb3a1c8`，精确 main CI 37219844193 success。
状态：用户已确认最小策略、repos.ts 只读接口及 relay-recovery.ts 最小交接；实现及最终验证阶段，未接入生产。
承接 [技术债](technical-debt-remediation.md)、[C2a](c2a-task-cancellation.md)、
[C3](c3-model-usage-persistence.md) 及各自专属验证收据。

## 现场事实

- C2a #406、C3 #410、D4 #404 已合入；该精确 main SHA 的 CI 37213415190 success。
  镜像发布不是部署证据。本任务不访问生产、付费模型或历史数据。
- `cost-guard.getBudgetStatus → repos.sumRunCostSince` 仅消费 Run.cost.amount，按 Run.started_at
  所在 UTC 日/月窗口累计，不按 usage 到达时间重分桶。
- ADR-0003 / operations §14 的实际预算策略：自动调度每 topic 入队前硬拦，手动深挖/追问只提示。
  当前 cron 是 durable 请求入队，worker 异步执行；旧文档“单 topic 过冲上界”不能证明当前全局上界。
- Job.recordCost 累计本 Run 的既有兼容估价，在 done/failed 时 finishRun 落盘；LLM 的
  onCost 在 finalMessage/Responses 返回或有 usage 的 formal terminal 失败处调用。
  SDK HTTP 失败、SSE 中断、取消和部分事件不一定产生 onCost。
- C3 在真实 transport 前写 unknown；SSE 边界提交 partial/reported。它是独立观测，不是账单，
  与 Run/P1 投影禁止相加。Responses legacy normalizer 缺失归零不能证明免费，Coding Plan 无可信价格/余额。
- Anthropic 的 SDK retry 重入 usageTrackedAnthropicFetch；runtime transient/refusal、validator
  retryJudge/relay recovery、coverage 外层 retry、Analyzer split 均可能再进入 callStructured。
  部分 agent 会吞错误转为 unavailable/空结果，预算故障必须 sticky，并在业务 checkpoint 再检查。
- PPT polish 已有独立成本上限路径；本切片不统一它、token 输出上限或套餐额度。

## 已确认的最小策略

1. 新增可选 `taskBudgetUsd?: number`，同一单主题 generation 从 analyze 到 report/通知共用一个作用域；
   独立 runJob / pipeline 阶段可显式传入。建议 worker 支持 opt-in `COST_LIMIT_TASK`（USD），
   显式参数优先、缺失不设上限，绝不新增默认数值或默认 deadline。
   此显式任务上限适用于自动/手动 generation；既有日/月的自动硬拦与手动提示保持原样。
   参数为有限非负数，0 代表禁止新模型 dispatch；空 env、NaN、Infinity、负数拒绝，
   固定 `invalid_task_budget`，不回显原值。非法配置在执行模型请求之前拒绝。
   未配置时不增加金额检查、预算数据库读取或失败条件，合法正常路径与现状等价。
2. 日/月限额不细化到每请求。本切片只加任务内门，不偷偷在 worker 加日/月硬拦，
   不改变原定时/手动策略；当前排队竞态是保留并明确的限制。
3. **唯一金额口径是既有 Run 兼容估价**：历史已落盘 Run.cost + 当前作用域 recordCost 增量，
   attempt.estimate_usd 与 P1 cost_ledger/rollup 绝不加入。既有 fallback/estimated 也维持原值，
   明确这是本地预算数值，不能称实际费用；未知价格不会从 attempt=NULL 推成 $0。
4. **unknown/partial/价格未知：建议继续，保留不确定事实，不推定金额、不做预留**。
   这保持既有 retry 和 Coding Plan 可用性，但只约束兼容估价累计，不能约束真实账单。
   当前请求刚写 unknown 不能反过来阻止该请求；partial 的累计 token 快照不转成增量费用。
   如选择遇到已结束的未知请求就停止，需另定 `task_budget_usage_unknown`，且 HTTP 500/SSE
   timeout 后现有重试可能被停止，Coding Plan 也可能在首个调用后停止；不是等价替换。
5. **并发：建议检查式停止，不引入 reservation/schema/财务账本**。
   不承诺实际费用、日/月或多进程全局绝不超额；检查与发出请求之间不取得全球原子授权。

上述五项已经用户确认。若未来要严格 reservation，先单独确认设计与文件交接：
至少需要 SQLite 原子授权、唯一 attempt reservation、跨 worker 锁/余额、崩溃后不可随意退款的
unknown 保留，以及可信的每请求最大费用或实际套餐授权。现有价格/余额不足，单靠预估预留最多
证明“所用估价和预留不超过限额”，不能证明真实账单绝不超额；成本包括 schema/migration、协调、
回收和不可确定请求长期占用额度。不能把最大 token × 本地价冒充 provider 费用上限。

## 任务身份、消费和生命周期

- durable generation 的任务身份为当前 trace，同一 trace 的阶段/内部重试共用 scope；新用户重试
  创建的新 trace 是新任务，旧费用仍在日/月累计。无 trace 的显式 Job/单主题调用为本次作用域。
- 若已有同 trace Run，初始化只读加载其 id/cost（含 failed 的已知费用）；root Run 用原 ID 加入，
  不把它既有金额丢弃或再次累加。进程崩溃/lease 丢失未落入 Run 的费用仍未知，不从 attempt 补账。
- scope 使用 `Map<runId, cumulativeCost>`：初始化金额、当前新增回调、Job 终态落盘都是同一 Run
  的生命周期。新回调只加该 delta，Run 落盘后不再对 task total 加同一笔；后续阶段不会再重复读入。
  不用全进程 meter 差值，不跨并发任务共享 Map，不借 retry_of 自动合并不同 task。
  配置任务预算时复用 existingRunId 的 Job 本身也继承该 Run 的既有 Cost，再加新回调；finishRun
  保存累计值而非覆盖成仅本轮 delta。未配置时保留现有 existingRunId 行为，不顺带历史修复。
- Run 已有金额非法时，配置预算的执行拒绝继续，固定 `task_budget_cost_invalid`；不修历史 JSON。
  新 recordCost 的非法金额亦拒绝，保留已有事实。未配任务预算不扩大到历史数据审计。
- 不新增 Run 进行中金额持久化或成本 writer。crash 后只能恢复已落盘的兼容金额，不声称任务
  剩余额度完全可恢复；晚到的 C3 usage 不反写 Run，也不改变已终结 Run/trace。
  task 上限不持久化；同 trace 被重新领取时按本次有效配置解析上限，继承已落盘消费。
  若配置被改变/移除，不能承诺保留最初的 cap；此边界用恢复后的变更/移除配置反例证明。
- 配置预算的 Job 内，runtime 将每次兼容估价送入 recordCost；已有 onCost 调用它时只记一次，
  调用方仅观察或省略 callback 也不能漏掉可计金额。未配置时维持原 callback 行为。
  Provider 缺失字段可能使既有 SDK 兼容计算产生 NaN：配置预算时不将这种未知估价写成金额或零，
  保留 C3 unknown/partial，按已确认未知继续策略执行；显式 recordCost 非法金额仍拒绝。

## 检查位置与停止状态

- 在 task/job 入场、阶段切换、每个 logical call、每次实际 dispatch 检查；dispatch 检查在
  C3 begin unknown **之前**，并保留 C3 的写前拒绝 transport 策略。
- 每个 onCost/recordCost 更新立即标记触顶（`spent >= limit`），sticky 于整个任务；不在记账前抛错。
  回调本身要完成记账；返回后的业务 checkpoint 拒绝当前尚未提交结果，当前 Run.failed 保留成本。
  预算低于上限也不证明下一请求付得起；不预估或预约该请求。
- Anthropic SDK 隐藏 retry 的每次 fetch、Responses 的每次真实 fetch 都跨门。
  SDK 包装本地错误不能复活请求；在 callStructured 返回/错误及 Job 业务提交检查固定本地错误。
  runtime retry/refusal、validator/coverage/relay/split 的下一 logical call 或 transport 仍跨门。
  必要时在 retry 边界显式重新检查 sticky fault，避免把预算故障吞成业务成功或继续无效退避。
  未故障时重试次数、等待、模型参数、prompt、判定和 cache 语义保持原值。
- 预算不重写 C2a signal/deadline 原因、不把 drain 当取消。已 dispatch 请求可能继续产生费用和 C3
  观测；本切片停止新调用和新业务提交，不承诺退款或 provider 停止计费。
  预算在在途请求返回后才被 onCost 观察到也可能已经跨界，仍保存已返回费用。
- Analyzer 存在 Promise.all 并发 coverage，不能以一个分支 fail-fast 就宣称其他费用已经收齐。
  建议只在预算失败收尾时，Job 跟踪并收拢其已启动的 callStructured 工作，再 finishRun：
  其他分支必须仍执行 account/onCost 记录已返回用量，然后才由 sticky gate 拒绝业务结果；
  不能在记账之前因为任务已预算失败就跳过该分支的已 dispatch 响应。
  新逻辑调用/实际 dispatch 一律禁止；await 已启动工作不授予新请求权限、不重试已完成请求。
  收拢受现有 request timeout、任务 signal/deadline 和 ownership 约束；显式取消/deadline/lease
  loss 不等待不合作 provider，以 C2a 及时退出为准；C3 writer fault 亦不延迟成业务成功。
  跟踪的是 callStructured 内已有 timeout/race 约束的工作 Promise，不能等待 SDK 忽略取消的
  后台裸 transport Promise；所有被停止等待的 Promise 仍附 rejection handler。
  不新增无限等待或全任务 deadline，不改变 worker drain grace。未配置/未触顶不新增结算等待。
  预算专属并发反例必须暂停一个分支：另一分支先触顶，后者返回的兼容 Cost 仍在终态前落盘；
  同时取消/失租约的变体只保证已提交 C3/Run 事实保留，未知或终态后才收到的费用不可补推断。
- 所有权/fencing 每次写仍优先；失去 lease 时旧 worker 无权写 failed Run、trace 或 usage。
  同时已观察的原因优先级为：fencing 拒写 > C2a 已观察首个取消/deadline > C3 sticky persistence
  failure > budget sticky。C2a 首个取消 reason 不改；C3 failure 仍拒绝新 transport 和业务提交，
  预算不能遮蔽/绕过它。竞争测试验证 Run/dispatch/trace 一致，
  不声称预算检测是原子且能抢先所有同时到达的错误。
- 持有 lease 的预算失败使用现有 Run.failed、阶段 failed event，固定 `task_budget_exceeded`，
  dispatch error `retryable=false`；不新增 status、不冒充用户取消。
  trace 终态由现有 projectTrace 规则决定：已提交 completed/业务事实不回滚；保留 failed reason
  和既有 partial 投影，不能把所有预算失败概括为强制 trace.failed。
- 沿用 Job 的 notifyFailure（silent 原样），不新增通知渠道/自动重跑；无成功 report 就不发成功报告通知。
  固定诊断只含应用 ID/可验证数值，不含配置原文、provider 正文、URL 或密钥。

## 并发保证范围

只保证同一作用域已经观察并生效的 sticky failure 之后，新的底层 transport 不再发生。
同任务多个请求已通过检查或已在途时仍可能继续计费；不同任务各自额度互不抵扣。
跨 worker 无全局锁、没有 reservation，日/月先检查后排队/发送的竞态保留。
没有可信单请求费用上限，不能给美元过冲固定上界；串行且每次费用完整返回的条件下，
最多是首次跨界的已授权请求，unknown/partial、多并发在途和崩溃则不具备此界。

## 文件归属和交接申请

- C2b：新增 runtime/task-budget，最小修改 runtime/jobs/model-usage/llm/diagnostics、
  agents/pipeline/scheduler/generation-dispatch 的调用/状态接线；必要 retry 入口只改控制检查。
  新增专属 `*.task-budget.test.ts` / integration 测试，保留 C2a/C3 与既有日/月回归测试。
- D1 当前 spec、未提交列表已只读核对：专属 spec、db/d1-database-contract.test.ts、v48 fixture。
  D1 申请连接/index、migration、startup/legacy 模块；C2b 不修改这些、auth-reader 或 D1 测试。
- **用户已确认 repos.ts 的一个新增只读接口交接**：按 traceId 返回 Run id/cost，用于恢复当前 trace 的
  已知消费，避免扫描全库/依赖 admin 分页截断。现有接口、schema、写入/迁移/启动语义不变。
  已确认后仅新增 listRunCostsForTrace；独立新增专属测试不修改 repos.test.ts。
- schema、其他 repositories、types.ts、shared tests、architecture/ADR/roadmap、认证、D4、
  package/lock、CI、Docker、ops/env 生成规则均不改；确有必要再交接。
  env 配置先在本 spec 说明，不以改全量部署脚本接入或发布配置。
- 独立实现评审发现共享 relay recovery 会把 leader 的 TaskBudgetError 传播给独立且有额度的
  follower。用户“请按照建议的顺序继续”确认 relay-recovery.ts 最小交接：仅将 leader 的预算
  停止视为本地中断，follower 回到自身 operation/预算门。退避、重试次数、阈值和 D1 文件不变。
  同任务 follower 仍被自身 sticky gate 拒绝；跨任务错误不得借共享 gate 串预算。

## 先反例、后实现的验收

合成内存/临时文件库、mock provider transport，真实 runJob/callStructured/SDK 和生产 pipeline：

| 场景 | 必须证明 |
| --- | --- |
| 未配置任务上限 | 正常输出/参数/重试/cache/Run 兼容不变；无新增预算 DB 查询 |
| 足够/刚好触顶/超过/0/非法 | `<` 放行、`>=` 后续零 transport；非法值脱敏拒绝 |
| 历史同 trace Run + 本 Run + attempt/P1 | 每 runId 一次累计，跨阶段不重加，attempt 金额不消费 |
| unknown/partial/未知价格/Coding Plan | 保留 nullable/估价性质，按确认策略继续，不推断免费/真实账单 |
| 当前写 unknown、在途跨界 | 当前合法 dispatch 不自拦；已花保留，后续请求停止，不承诺退款 |
| SDK/runtime/refusal/validator/coverage/relay/split | 真实底层 transport 数量证明不能绕已生效门，吞错不能提交成功 |
| 取消/deadline/lease loss 与预算同时出现 | C2a reason 与原 fencing 保留；旧 worker 零写，scope/timer 清理 |
| 并发 Task + 同 task 在途 | 隔离累计；受控 barrier 显示检查/发送竞态，承诺仅限上述范围 |
| C3 写前/写后失败 | 零新请求/无已完成请求重发；故障不能转成功，既有 usage 保留 |
| 预算失败后的状态/日志/通知 | Run/trace/dispatch 固定 reason、不可自动重试；已提交事实保留、无成功推送 |
| 既有日/月/手动路径 | 原 UTC 窗口、自动/手动差异和入队策略不变 |

定向测试、双编译器 typecheck、lint、coverage/ops；运行时影响用必要 build/HTTP E2E 与原 D4 smoke 验证。
采用 eval-gate：只有最终 diff/真实路径回归证明正常模型输入/输出接受与评测口径不变，才理由充分 skip。
不以无 Job 的 A1 证明任务门正确，不预先盖章。
方案与最终 diff 用新上下文独立 reviewer，修正后复核；专属收据逐项注明覆盖和未覆盖。
独立 followup HTTP、无 Job eval/probe、direct SDK/fetch、source collection、PPT 不自动获得此任务预算；
不会隐式打开全局 DB，服务端内部 retry/套餐扣减不可观测。
最终按仓库流程 Draft PR + 最终候选 CI/证据绑定后停止，不合并、部署、生产迁移、历史修复或清理。
