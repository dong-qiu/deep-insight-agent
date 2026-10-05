# C2a：任务取消与 deadline 传递

日期：2026-10-04。基线 origin/main `065dd0cf7a8f06d4becd093da2f133fc552ce201`。
承接 [TD-10](technical-debt-remediation.md) 与 [generation provenance](generation-provenance.md)，遵循 [架构 Run 契约](../architecture.md#运行实体-run)。仅 C2a；不实施 C2b/C3/C4b，不新增 schema、预算或用量持久化。

## 最小契约与所有权

- JobSpec / generation execution options 增加可选 `signal?: AbortSignal` 和 `deadlineAt?: number`（绝对 Unix 毫秒）。不新增 env 或生产默认 deadline；旧调用不传入时无限任务期限，原 `LLM_TIMEOUT_MS` 保持不变。非法 deadline 在执行前拒绝，不能静默换值。
- scheduler 的单主题执行入口拥有整任务取消作用域；其同一 signal 经 pipeline → JobCtx → analyze / validateBatch → coverage、语言修复、judge → callStructured → SDK/fetch 与重试等待。独立 runAnalysis/runValidation/runReportGen 仍支持相同可选契约，由 runJob 拥有局部作用域。父作用域负责释放 timer/listener，子作用域只释放自己资源；同一个 absolute deadline 可用于子阶段同步提交 checkpoint，不重置任务期限。
- dispatch 拥有租约 controller，续租 CAS 返回 false、抛错或 assertWrite 检测失去所有权时立刻 abort；任务 signal 同时承接显式外部取消与 deadline。调用前检查 ownership；每次实际写入仍执行原 fencing/assertWrite，不以 signal 替代。
- deadline 是整个任务的共同结束边界，跨请求/重试/阶段不重置；单请求 timeout 是现有每次请求的独立墙钟限制，仍可按原策略重试。外部取消与 deadline 按第一个被观察到的原因固定，取消后不改原因、不继续派生/下一批/重试。
- drain 继续停止领取并等待当前任务完成或租约到期，SIGTERM 不直接映射为任务 abort；不修改 worker drain 的宽限时间或生产配置。HTTP 接受的 durable 请求不因原请求断开而取消；不把 HTTP signal 隐式接入。

## 终态、提交和清理

- 持有所有权时，取消的现有 Run 写 `failed`；外部取消使用稳定 `cancelled` 分类，deadline 使用稳定 `task_deadline_exceeded` 分类。trace 使用已有 cancelled 映射/event；不新增 Run status。dispatch 的已有 failed 容器状态保留，可解释的取消 reason 不作自动可重试失败。
- 调用前已取消：不调用 agent/外部服务；独立 pipeline 在尚无 Run 时不新造 Run，runJob 已创建或 dispatch 已领取的 Run 仍按现有失败载体收尾。调用中：真实 SDK/fetch 收到 signal，Anthropic stream 同时 abort；等待层提前返回时必须给后台 Promise 附 rejection handler。
- 返回时再次检查 signal，丢弃 provider 忽略取消的迟到结果；模型响应不是数据库提交授权。任务取消后不写分析/校验/cache/规划/报告/通知业务结果；取消之前已提交的阶段保留，不声称可回滚既有提交。
- 租约丢失：不写失败 Run、trace、report 或业务状态；仅返回本执行器 failed 结果。旧 claim 的状态留给已有接管/恢复流程，原 fencing 即使未触发 abort 仍独立拒绝。
- 失败收尾可写脱敏取消诊断，但仍须 ownership guard。报告异步锚定发布跨 await 后必须重新执行 ownership + cancellation 守卫；失去所有权时错误清理也不得落库。锚 signer/store 的既有接口没有 AbortSignal；以 await 前后守卫停止后续调用和本地提交，不宣称可中止其已发出的 I/O。可能已提交的远端锚/费用不能撤回，保留已有 reconciliation 边界。
- relay 恢复使用 leader 的业务输入；leader 取消后停止它的探测并清理退避 timer，follower 仅取消自身等待或用自身操作继续恢复。未取消时共享 gate、退避/探测次数与并发策略不变。
- finally 释放 deadline、请求 timeout、heartbeat、retry timer/listener；后台 Promise 的迟到 fulfil/reject 不能启动后续阶段或产生未处理拒绝。成本口径维持既有记录，不声称获知未返回用量或撤回 provider 已完成的工作/费用。

## 兼容与回退

未取消的正常路径模型/provider/thinking/prompt、引用白名单、判定规则、调用参数、重试次数/退避值/并发/cache 保持原样。取消只缩短失败路径，不建立任务平台。现有调用方无需新增参数；未来 C2b 可主动 abort，C3 可复用上下文但另行定义调用/attempt 与持久化契约。代码回退无 schema 迁移；回退后取消保护缺失，不把它作为运行保障。

## 验收

真实生产接线 + 内存/临时隔离 DB + fake clock + 受控 SDK/fetch，不调用真实模型/生产：调用前零请求、调用中底层 signal、LLM/agent/relay 退避取消、deadline 后无后续阶段、租约丢失取消且 guard 拒写、忽略取消迟到结果不落库/发布、同时取消固定一致终态、正常输出/调用参数保持原样、既有 drain/fencing 回归、timer/listener 清理、日志/SQL 诊断脱敏。独立最终 diff review、双编译器 typecheck、lint、受影响测试和 ops 测试；eval-gate 按实际 diff 判断并记录证据，未取消语义改变须停止并交接。

## 接线边界与并行交接

本切片任务指 durable generation worker 的单主题生成，以及可单独调用的 pipeline 阶段/Job。`runScheduledPipeline` 是采集后接受多个 durable 请求的入口，并非这些请求的共同在途任务；不把它的 HTTP 生命周期或 drain 信号传入已接受任务。Source collection 与独立 followup HTTP 工作流不在本切片新任务入口中，不宣称已支持端到端任务 deadline；其既有 timeout 行为保留。底层 callStructured 接受 signal 的能力可供后续显式调用方复用，不能假称现有未接线的调用方会自动取消。

本 Session 独占 runtime/jobs/cancellation/llm/relay-recovery、生成 pipeline/scheduler/dispatch、Analyzer/Validator 取消失败路径及专属测试；用户已确认 reports.ts 和 integrity-publication.ts 的最小 guard 接线交接。D4 仍负责浏览器 smoke，不修改其工作区、package/lock、CI、Docker 或浏览器基础设施。共享 roadmap/ADR 不改。
