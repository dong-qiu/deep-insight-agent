# TD-10：独立采集任务控制的有界首片

调查基线：fetch 后 `origin/main=41def9a7c75fff488cde206a5a2bfddebb6a9fe8`
（#444 followup 已合入）。承接 [C2a](c2a-task-cancellation.md)、
[C2b](c2b-task-budget.md)、[采集契约](data-collection.md)。协调者与独立 Reviewer
已冻结下述首片范围；实现/测试及最终审查绑定 [专属收据](../../verify/c2d-collector-task-control-2026-10-08.md)。

## 源码事实与入口边界

| 实际链路 | 当前控制/写入 | 缺口 |
| --- | --- | --- |
| scheduler collect/probe、admin source collect、Run retry → collectSource | caller 提供 traceClaim，collector 30s heartbeat 与 assertSourceCollectClaim | collectSource opts 无 signal/deadlineAt/taskBudgetUsd；本片不改 caller |
| collectSource → runJob | 原 Run running/done/failed、用量与失败通知；runJob 已支持 C2a/C2b | collector 未传可选控制；非法 deadline 在 Run 创建前拒绝，已取消/0 cap 可用原 failed Run 收尾 |
| fetchFromSource → RSS / arXiv | robots/SSRF/每请求 timeout/解析/重试 | registry、RSS/arXiv 无 task signal；arXiv 全进程队列及退避不支持取消 |
| fetchArticle → robots → fetchWithRetry → readTextCapped | 全文失败返回 null、feed/full_text 回退语义 | 无 task signal；best-effort catch 可吞任务错误，不能直接靠返回 null 继续提交 |
| Content upsert + raw intent + revision | 同一 SQLite transaction，现有 lease guard | 缺取消/预算 checkpoint |
| writePlannedRawArchive → staging/rename → reader eligibility | 同步文件/SQL，planned/attempted/committed/unknown 契约 | helper 无任务/ownership guard；collector 前置检查不等于内部跨进程完整 fencing |
| metadata facts / telemetry | append-only diagnostics 与可选 P1 committed observer | metadata best-effort catch；控制错误不能被吞后继续采集 |
| observe shadow → transcript/program page → sink | 独立 shadow.db + archive；source item/bytes/time/QPS 约束 | 无 task signal；sink 及 fetcher/sleep 可注入；await 后还有写入、catch 后还有 terminal fact |
| collectSource failure/finish | 原已提交/unknown refs、失败 event、trace lease release；失 lease 禁旧 owner 收尾 | cancellation 不得阻止合法失败载体收尾，失 lease 仍优先禁止全部失败写入 |

`safeFetch` 只传 `AbortSignal.timeout`；`readTextCapped` 无任务 signal。
robots 网络错误会 fail-open；article catch 返回 null；podcast fetch catch 返回结构化
transient/timeout。仅在这些入口外加 Promise race，不能证明取消已透传、子请求
已停止或 shadow DB 可关闭。source 自己的诊断/内存状态也不受 collector guard 控制。

## 已冻结首片：准入与 collector 提交抑制

仅修改 `collector.ts`、新专属测试、spec/verify；sources、podcast-shadow/store、
runtime/jobs/cancellation/budget、scheduler/dispatch/HTTP/schema/主台账全部只读。
端口 3118，独立 DB/DATA；不调用真实 fetch/模型/通知/生产。

1. `collectSource` opts 增加可选 `signal/deadlineAt/taskBudgetUsd`，原 caller 零改动、
   无 env 默认 deadline。不新建任务框架/成本表，直接传入现有 runJob。
   collector 用原 createTaskCancellation 持有外层 scope，覆盖 runJob 返回、
   finishSourceCollectTrace 与最终 return，最后 finally dispose；runJob 继承该
   signal/deadline，不以它已 dispose 的 ctx 冒称覆盖外层。外层 withTaskBudget
   延续父 scope 与原失败 Run 载体，足额/未配置正常路径不增加成本事实。
2. 分离 ownership guard 与业务 checkpoint：业务每次先核 lease，再检查
   `ctx.checkCancellation`（含原 sticky budget/usage）；runJob 的 `assertWrite`
   只检查 ownership，不能用取消 guard 阻止合法 failed Run 记账。
   fetch/article await 成功或失败后均检查，进入下一 raw/诊断事实、transaction、
   raw archive/telemetry、成功 event/setRunInserted/trace finish 前再次检查。
3. metadata helper 的可选 checkpoint 要在每个事实写入之前且在 best-effort catch
   外生效；普通诊断错误仍 best-effort。普通 article/shadow 错误原语义不变，
   catch 边界重新检查任务状态，不能吞取消/预算/ownership 然后转成功。
4. shadow 已启动时仍完整 await，**不 race 提前关 DB**。用传给原 sampler 的
   guarded sink 对 append/nextAttempt/archive 做 ownership + control 准入；
   包装原 fetcher/program-page-fetcher 在调用前后检查，并组合既有 beforeRequest
   policy hook：check → await 原 QPS/policy hook → check，再进入 transport；
   fetcher 的成功与异常 settle 后都 check，保留 QPS/bytes/time/筛选/策略。
   未传控制且无 trace/父 budget 的路径用原 sink/fetcher；有 trace 的路径也加
   ownership guard，正常有效 owner 的 source/policy 参数不变。不能禁用已启用 shadow。
5. raw intent 已提交而归档启动前 checkpoint 失败：保留 intent 与非读者资格，
   失败 summary 纳入该 exact unknown ref；只有仍持 lease 才可用原 unknown 标记。
   helper 成功后立即登记 exact committed output ref，先于 telemetry 或任何可能
   失败的 checkpoint；已成功归档的输出仍 committed。失 lease 时不标 unknown、
   不写 failed event。
   不修改或伪造 raw helper 既有状态机，不将失败统称整事务回滚。
6. heartbeat false 或 SQL throw 均只置 lostLease，最小 collector-local catch 防止
   interval uncaught；下一 ownership 检查优先拒绝旧 owner 提交/失败收尾。

此首片明确不具备：及时停止在途源请求、arXiv 排队/退避可取消、整个子树静默、
强制 deadline 返回时限，以及 raw helper 内部每次写入的跨进程 fencing。
取消被观察后 collector 新提交/guarded shadow sink 新写入可被拒绝，但已发出的
网络与请求内部重试仍可能继续。必须等待原 await 真实结束再收尾/关 shadow DB；
未知终止保持维护 blocked，不以接口接收、mock signal 或 no-op health 当静默证据。
如果本轮验收要求同时证明这些完整能力，**首片不能签通过**，应先冻结下面依赖。

## 完整源请求取消所需的最小依赖（未授权写入）

- sources registry/types/RSS/arXiv/article 传递可选 signal，safe-fetch/robots/stream
  reader/实际 redirect/retry/backoff 与 arXiv queue 跨门；检查 source catch 不吞控制。
- podcast-shadow 的每个 await/sink/下一候选/host sleep 控制，且 catch 无迟到 terminal
  写入；真实关闭时机、在途 reader cleanup 需要原始反例，不能只包装最外 promise。
- 若要求 raw archive 内部跨进程所有权拒写，需要 db/raw-archive 的最小 guard
  接口与调用方责任交接；错误路径 markUnknown/finalize 一样检查 owner。

这些是独立工程依赖，不是模型预算或生产授权阻塞。来源语义正常路径与 AI 口径
不得变；确需改变来源/策略/错误口径，先停止并申请对应范围批准与 eval-gate。

## 首片验收与退出

先保护测试，再实现。专属协议测试走真实 collector/runJob/SQLite/raw archive、
controlled source/article barrier 与真实 shadow sampler/store；另用 fake fetch/DNS
走 RSS/article/robots/safeFetch 的原真实路径，不用简单 stub 冒充源取消完成。

| 反例 | 首片必须证明/必须诚实记录 |
| --- | --- |
| 入场已取消、过期/非法 deadline、0/非法 cap | 零 source/article/shadow 新调用；原有 Run 失败载体与精确 reason，非法输入不回显 |
| source/article await 中取消/超时，迟到 resolve/reject | 返回后无 Content/raw/revision/成功 event/telemetry；迟到拒绝无 unhandled；原裸 source 子工作可能继续是保留限制 |
| 已提交第一条，第二条取消 | 第一条 raw/ref/committed 保留，第二条零提交；Run/trace 不伪造全部回滚 |
| raw intent/归档边界取消，归档普通失败 | planned/committed/unknown、reader eligibility、精确 refs/count 保留；失 lease 零失败收尾 |
| 旧 owner/fence、heartbeat 丢失与 cancel/budget 同时发生 | ownership 拒写优先；首取消原因固定；终态收尾不得绕 fence |
| shadow 在 transcript/program-page/sink/sleep await 时取消 | guarded sink 无新写，不提前关 DB；原 await settle 后只 close 一次；普通 shadow 错误仍不影响正常 RSS |
| runJob done 与 outer trace finish 间取消/失 lease | 外层 scope 仍有效，无迟到成功 trace，committed refs 不改记回滚；不重写已经 done 的 Run |
| 原默认与足额、父 scope | 原输出/参数/去重/全文/播客 metadata/shadow/通知等价；子 cap 不放宽父门；无 LLM 收集路径不宣称费用上界 |

实现需运行原 collector/shadow/store/C2a/C2b/raw archive 回归、双 typecheck、lint、
相称 build/ops；最终 collector diff 触发 eval-gate，按原真实路径证据决定正确门，
不预签 skip、不用未执行入口的 A1 补签。高风险内部 fencing 若纳入，需两位独立
Reviewer 和原材料验收；第一片只能以已冻结的有限承诺交付，TD-10 整体仍部分完成。
Blocking/未明确接口/正常语义差异出现即停止实现，回协调者缩片或先交依赖；
不擅改 sources、runtime/dispatch，不修改生产安全边界，不部署或清理工作区/证据。
