# TD-10：独立 followup 的可选任务控制

基线 `81dac77cd27f82d7b554694bf0a12cd82cd0920b`。承接 [C2a](c2a-task-cancellation.md)、
[C2b](c2b-task-budget.md) 与 [followup](followup-qa.md)。本片仅接线既有控制协议，
不修改模型、prompt、引用池、缓存版本、语义判定或正常请求的并发、重试策略。

协调者独占 `src/lib/agents/followup.ts`、新增专属 task-control 测试、本 spec 和收据；
不改 A3 的 dispatch、runtime 公共门、schema 或 HTTP route。旧 Session 的未提交内容不复制。

真实入口 `answerFollowup` 增加可选 `signal/deadlineAt/taskBudgetUsd/assertWrite`；
缺省调用与现有 HTTP route 保持原参数和行为，不把 HTTP 断开隐式取消或添加默认 deadline。
同一函数作用域的生成和并行 judge 共用取消信号与可选既有预算。若已有父级
`withTaskBudget`，沿既有协议继承父额度，传入子额度不覆盖或放宽父门；反例验证这一边界。
本片面向没有 UsageJob 的独立调用，不将嵌套 Job 记账纳入覆盖。独立函数没有 Run，
额度仅在该次调用内以唯一临时身份累计既有兼容估价，不创建/伪造 Run 或用量行、
不改日/月 manual advisory、不从 attempt/套餐余额推费用、不能称真实或全局金额上界。
预算关闭时不新增金额检查；足额正常路径的请求和输出与旧代码相同。

取消先于首次外部调用检查；生成与 judge 接收同一 signal；每次 await 后及 cache.set 前
检查取消与可选 caller fencing，失去所有权优先拒写。budget sticky 不得被 judge 的降级 catch
吞掉；仍保留普通 judge 失败降级。首个取消原因不由预算改写，有限 deadline 不重置。
已经发送的 provider 工作、既有缓存/费用不会回滚；迟到 resolve/reject 不复活结果或缓存。
本入口只返回结果，HTTP 保存 followup/audit 在调用者控制之外，不能冒称该 route 已具备
维护准入或迟到提交 fencing。未知子工作和生产维护继续阻断。

验收先补真实函数/内存 SQLite 反例：调用前取消/非法 deadline/0预算零模型请求；
在途生成或 judge 取消/超时后零新 judge/cache；首原因及 fence 优先；普通 judge 失败仍降级；
并行费用达到 cap 后拒绝新调用及结果，足额和缺省参数/输出等价；迟到错误无未处理拒绝。
控制反例整mock callStructured，仅证明真实followup/validator控制调用；另补真实
followup→callStructured→SDK→fake fetch的取消、预算、足额及未知估价反例，零网络。
两类均不证明真实模型质量。执行原 followup/validator/
C2a/C2b 回归、双 typecheck/lint/build。最终 diff 经 eval-gate 判断，独立 pre-pr-ai-review；
发现正常 AI 语义变化则停，不以不执行本入口的 A1 代签。

退出：本片完成仅代表独立函数的显式控制能力；source collection、HTTP composition、
全 writer、全局预算/默认 deadline 仍是工程待办，不整体关闭 TD-10。
回退仅撤回新增显式控制，无历史数据修改；已经提交事实及证据保留。
