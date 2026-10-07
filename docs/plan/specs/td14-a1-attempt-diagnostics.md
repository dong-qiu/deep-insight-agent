# TD-14：A1 attempt 诊断与零付费测量准备

日期：2026-10-07；启动 origin/main `473e2eeae119b600b63abd78ce886301bd882235`。
本轮真实模型预算 0；独立 worktree，TD-14 继续部分完成。模型/provider/prompt/评分/数据集/baseline/并发默认值不变。

## 最小设施与计数规则

显式 opt-in A1 诊断作用域，必须同时提供非负整数 transport 上限和正整数总窗口。
缺任一或非法值在请求前拒绝；没有 opt-in 时既有 runner 行为不变。不建立金额预算、DB 或新恢复系统。
复用 C2a cancellation/awaitWithSignal、C3 原始 usage parser 与真实 fetch 边界；不将无 Job A1 伪装为受 C2b 保护。

- logical call = 一次 callStructured，完整 UUID；operation 为代码标识。拆批、repair、countercheck、backfill、validator 外层 retry 是新 logical call。
- attempt = 一次底层 fetch invocation，完整 UUID，同 logical call 单调 attempt_number。SDK 内部 retry、runtime transient/refusal retry 均重新计数。
- 上限检查及计数同步在真实 fetch 前；拒绝请求不算 dispatch。允许恰好 N 次，包括并发；第 N+1 次拒绝时 sticky incomplete 并 abort 同作用域。
- 作用域总窗口使用 C2a 绝对 deadline；取消或过期后拒绝新 dispatch/结果/业务 checkpoint，迟到成功不能清除 failure。
- 已发送请求可能继续计费；本地 abort、SDK 包装或停止等待不证明撤回 provider 工作/费用。
- 用量从 C3 原始 nullable 数值与 final 标志投影 unknown/partial/reported；未知金额为 null，不消费 legacy fallback 作为账单。
- attempt wall 从 dispatch 到 body EOF/error/cancel（HTTP 非成功到 headers），另外记录 headers wall；不能称纯 provider latency。未结束保留 running/null，不补零或 P95。
- C3 Job DB writer/fencing/金额消费及优先级保持；诊断仅在无 Job runner 显式启用。

## runner 与产物

诊断 check 接在 progress、chunk/completed checkpoint 和成功终态提交边界。吞掉错误也不能完成执行。
失败收尾保留诊断快照，失败观察不得重新阻止失败产物发布。SIGINT/SIGTERM先取消作用域再发布；不自动恢复/付费重跑，不修改源 checkpoint。
诊断作为加性 manifest/progress 字段，不进入 EvalConfig；显式限制写入恢复身份的额外条件，禁止不同限制之间混用 checkpoint。
C4a阶段时钟仍保持边界；末尾发布另取真实起止差。独立父进程 spawn→close 覆盖模块加载/发布/退出，残差不冒称精确 module-load time。
性能/评测原产物只在隔离私有目录。版本化仅工具/合成fixture/测试/脱敏摘要。

## 验收

真实 runner/agents/SDK + 拒绝外网的 mock transport，子进程不继承凭据、不加载 env 文件：
上限0/恰好N/并发、SDK retry、EOF retry、split、repair、countercheck、backfill；deadline/取消/迟到成功、sticky failure。
缺失/截断/基础设施失败不得创建不完整 completed checkpoint；合法 uncertain/not_support不改判。
完整恢复/partial恢复仍走C4b身份拒绝，源字节不改，没有自动恢复或重跑。
用量unknown/partial/reported与明确0，logical/attempt身份和各角色operation计数；并行phase取墙钟，非latency之和。
受影响测试、双编译器typecheck、lint、风险相称coverage；必要build由最终full CI核验。
独立review先审限制/测量方案，再审最终实现与反例、结论证据；使用eval-gate及pre-pr-ai-review。

## 最小真实测量申请（未授权）

问题：当前冻结版本的主要墙钟阶段及调用放大来自何处？没有可比before时只建诊断基线。
候选：一次冷进程、无resume、保留当前cache条件，固定1 topic / 12 consistency pair / 14 display / 8 quote。
最多80 transport attempts，45分钟总窗口；retry使用当前实现有效值，冻结后再写精确上限，禁止临时增加。
单运行仅原始样本/各角色operation分布，不报告P95、吞吐或整体质量通过。若需要估计尾延迟另申请足量样本。
模型/provider/协议/thinking与输入选择在真实运行前核当前配置并冻结，不自动切换或扩大样本。
Coding Plan费用/额度未知，请求上限不是金额上限；停止条件：cap/deadline/取消/身份漂移/基础设施不完整/产物发布失败。
产物：私有输入hash/源码dirty与lockfile/config/prompt身份、outer/phase/publish wall、logical/attempt raw samples、用量状态、终态/质量/争议与baseline可比性。
D7 S2前后基线不得混用；真实测量前择一源码/输入身份并冻结，不能绕C4b拒绝规则。
完成零付费验证/独立review后向用户提交精确专项申请，等待明确授权；本轮停在候选CI核验，不合并/部署/恢复/清理。

## 独立评审后的实现补充

- opt-in 使用 `A1_DIAGNOSTIC_MAX_ATTEMPTS`（0–10000）与 `A1_DIAGNOSTIC_WINDOW_MS`（1–2700000ms），必须成对设置。未启用不安装observer，也不打开DB。
- `measure-a1-process.ts --prepare` 经同一runner setup采样真实配置/文件字节hash/实际选中数组hash/分块计划；fetch拒绝哨兵保证零请求。准备收据标为failed/not_evaluated、execution_complete=false，退出0仅表示准备完成，绝不冒称评测完成。
- 真实测量必须显式 `--execute`（此flag不代替用户授权），父进程冻结cold-only、force-smoke，并拒绝配置重新注入resume。父进程从spawn前至close取墙钟，窗口覆盖模块加载；到期SIGTERM，最多1s本地退出grace后SIGKILL。OS调度/不合作I/O不能给严格物理毫秒保证，亦不能撤回provider费用。
- 子进程末尾采样publish墙钟，经IPC确认后退出；父进程close后独占写私有 `diagnostic-lifecycle.json` / `process-observation.json`。sidecar是独立观测，不伪造manifest自身hash。缺IPC/非正常退出/超窗口时 measurement_complete=false；质量状态仍逐字段保留。
- 冻结调用样本不提前解除deadline；manifest写后、目录rename后pointer提交前同步检查。失败可从封闭的成功候选单向降为不完整；rename后失败直接回写自己的final目录，不重建tmp或更新latest-complete。
- P0 analyzer当前不调用repairCoverage/backfill；专属导出入口的合成SDK测试另证它也跨硬门，不将其算成实际A1放大。
- SDK retry序号读取SDK自己发出的 `x-stainless-retry-count`；Responses无此值为null。同call剩余attempt可包含runtime transient/refusal，不仅凭attempt_number猜原因。validator外层retry与split是新call；不能把所有新call自动叫retry。
- 单attempt协议终态归因仍主要在既有role/by_operation聚合中；当前attempt状态描述本地transport EOF/error/cancel，不等于业务成功或账单终态。
