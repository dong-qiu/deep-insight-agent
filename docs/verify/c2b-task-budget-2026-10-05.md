# C2b / TD-10 任务预算检查验证收据

日期：2026-10-05（Asia/Shanghai）。验收见 [C2b spec](../plan/specs/c2b-task-budget.md)，
启动事实见 [前置收据](c2b-task-budget-preflight-2026-10-04.md)。本收据记录提交前本地验证；
本地验证与独立复审完成。候选 PR/CI 尚未运行，不预签 success。
最终候选 SHA、远端 diff 复核、CI run/attempt/实际 tested SHA 与产物身份按
[交付流程](../plan/specs/pr-delivery-evidence-workflow.md) 追加到同一 PR 摘要，不为补 CI URL 改 head。

## 授权、基线与隔离

初始 main 为 `c7648986d96e040dcad8c7e6dd01e75759c2bbee`，C2a #406、C3 #410、D4 #404 已合入。
用户确认可选任务额度、Run 兼容估价唯一消费、未知继续且不预留、保留原日/月粒度与手动策略，
以及 repos.ts 的一个按 trace 查询 Run id/cost 只读接口。没有新增默认额度或 deadline。
独立评审提出共享 relay 跨任务污染后，用户“请按照建议的顺序继续”确认最小 relay 文件交接。

现已 fast-forward 至 D1 #411 合入后的 main `4e09ec93923a0d7bece2b282045a18c98eb3a1c8`，
[精确 main CI 37219844193](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37219844193) success。
D1 当前 spec/收据/实际 diff 与 C2b 的 repos/runtime/agents 不重叠；C2b 不改其连接、迁移、启动模块。
没有整分支合入过期 refactor-plan，也没有操作其他 Session 的 worktree。

worktree `/Users/dongqiu/Dev/code/insight-agent-c2b`，branch `feat/c2b-task-budget`。
只复制 gitignored .env.local，权限 0600，DATA_DIR/DB_PATH 指向本 worktree 独立路径；
不复制数据库、sidecar、原文/报告或 .env.development.local，不输出密钥。
主 worktree 的 ADR/roadmap 未提交内容保留。全部测试为合成数据、内存/临时隔离库与 mock provider；
付费模型调用、生产访问、历史修复均为 0。Node 24.19.0 / npm 11.17.0，正常 npm ci，package/lock 未改。

## 实现与保证

1. `taskBudgetUsd` 为显式可选有限非负 USD 数值；worker 才解析 opt-in `COST_LIMIT_TASK`，
   显式值优先，缺失不限额，0 禁止新 dispatch。非法配置固定 `invalid_task_budget`，不回显原值。
2. AsyncLocalStorage 隔离任务，以 runId Map 累计已落盘 Run.cost 和当前 recordCost 增量。
   同 trace 恢复只读加载历史一次，复用 Run 保存累计值；attempt 估价和 P1 投影不加入总额。
   未配置时不读预算 DB，不增加预算失败/结算等待，保留原 onCost 行为。
3. 金额达到上限时 sticky `task_budget_exceeded`；错误金额为 `task_budget_cost_invalid`。
   非法历史成本在 Job 执行前拒绝，保留原始 JSON 与状态，不顺带修复历史。
4. logical call、实际 fetch dispatch（含 Anthropic SDK retry）、runtime retry/refusal、validator、
   coverage、Analyzer split 与阶段 checkpoint 接线。实际 dispatch 检查在 C3 初始 unknown 写入之前。
   缺省/观察型 onCost 也计入本 Job，转发及重复调用 ctx.recordCost 不双计。
5. 返回的已 dispatch 响应先记兼容费用，再拒绝未提交业务结果；预算-only 收尾等待已启动的
   timeout 控制 callStructured Promise，保存并发 sibling 费用。取消/deadline/C3 writer failure
   中断等待；失去 lease 时旧 worker 无权写终态或观测，不等待 SDK 忽略 signal 的裸 Promise。
6. 固定错误沿原 Run.failed、阶段 failed event、dispatch 非重试失败传播；trace 保持原 partial
   投影规则。已提交批次/用量保留，无成功 report 就不发成功通知，沿用 notifyFailure/silent。
   原因优先为 fencing 拒写、C2a 已观察首个取消、C3 sticky writer fault、预算 sticky。
7. Relay 共享恢复中的 leader TaskBudgetError 只中断 leader；健康 follower 用自身 operation
   重新进预算门。同任务 follower 仍被同一 sticky 门阻止。原退避、重试次数和冷却阈值不变。
8. 自动日/月入队拦截、手动 advisory、UTC Run.started_at 累计和既有阈值不变。

只保证同一作用域已经观察并生效的预算错误后，不再发生新的底层 transport。
unknown/partial、价格未知及 Coding Plan 继续保留不确定事实，不当零、实际账单或可信套餐余额；
Provider 部分字段使旧估价为 NaN 时不交付可消费金额，显式非法 recordCost 仍拒绝。
旧 fallback/estimated 数值只是兼容预算值。Run、attempt 与 P1 三类金额不能相加。

已发送/在途请求仍可跨界或继续计费；取消不保证退款或停止计费。没有 reservation、跨 worker
全局锁或可信单请求费用上界，故不提供真实账单、日/月或多任务全局绝不超额承诺，也无固定 USD
残余超额上界。不同任务各自额度不互相抵扣，日/月“检查后入队”的竞态明确保留。

## 反例与覆盖入口

| 风险/入口 | 证据与实际范围 |
| --- | --- |
| 未配置/足够/临界/0/非法 | 真实 Job→callStructured→SDK/mock fetch；正常结果/Run/attempt 保留，0 零请求且无 unknown 行 |
| Run 与 attempt/P1 防重复 | 同 trace 历史+增量、跨 Job 阶段 Map；真实 worker P1 off/on 仅原投影，巨额 attempt 不参与消费 |
| 恢复/非法历史 | trace 继承与其他 trace 排除；变更/移除 cap；无 trace existingRunId 负金额及坏 JSON 原字节/状态保留 |
| SDK/runtime/refusal 重试 | SDK 503、Responses EOF、paid refusal；生效后 transport 计数不增加，不重发已完成请求 |
| validator/coverage/split/relay | 真实 judge/coverage/analyze + SDK；吞错不成功；共享 relay leader 失败/follower 成功共2次 transport |
| unknown/partial/未知价格 | Responses Coding Plan unknown、Anthropic partial 缺最终 output、未知模型 NULL 价格与原非零 fallback |
| 在途与并发 | 暂停第二个真实 mock fetch，首分支触顶后收齐2笔；独立任务各自额度；检查/发送竞态只证明本地停止范围 |
| 取消/deadline/fencing | 三类原因与预算同时触发；真实 claim/CAS 接管旧 Run 不改；不合作 sibling 不阻塞取消、不复活结果 |
| C3 writer fault | SQL trigger 注入 usage 写故障，固定原因优先，已提交成本保留；原 C3 写前/写后、missing schema 回归继续运行 |
| 业务状态/通知/日月 | 真 scheduler/pipeline/dispatch/Job/DB，阶段使用合成 agent；已提交 analysis 保留、validation 拒绝、无成功通知、原手动 advisory |

三个专属文件合计 52 项（runtime/task-budget.test.ts 18、integration 28、pipeline 6）。
pipeline 集成模拟 agent 输出/recordCost；真实模型 dispatch、SDK 和 agent 外层 retry 由 runtime
集成测试覆盖，两类证据不能混称整条端到端真实模型管线。
语言修复/techlead 等通过共用 runtime 与 checkpoint 接入，但没有逐一做每个子路径完整预算 E2E。
独立 followup HTTP、无 Job 的 eval/probe/direct SDK/fetch、source collection、PPT 独立上限不自动纳入。
Provider 服务端内部重试/转发、未返回费用与套餐扣减不可观察。

初始14项反例在实现前为11失败/3通过。评审新增的两项历史反例先2失败/16通过、修后18通过；
共享 relay 反例先明确 follower 被预算错误污染，修后成功。整套首次运行 relay 新例超时，原因是
SDK 单例保留先前测试的 retry 配置；仅 mock429 加 x-should-retry:false 后整套通过，生产参数未改。
没有用 skip/xfail/放宽全局超时或削弱断言覆盖失败。

## 本地验证与 Eval-Gate

| 命令 | 最终结果 |
| --- | --- |
| 三个 C2b 专属 Vitest 文件 | 52/52 通过 |
| npm run test:coverage | 248 文件 / 2575 项 Vitest，ops 150/150 全通过 |
| coverage statements / branches / functions / lines | 79.25% / 71.79% / 79.34% / 83.08%，原门限保留 |
| npm run typecheck | TS7+TS6 app/tools 全部通过 |
| npm run lint | 通过，max-warnings=0 |
| NEXT_TELEMETRY_DISABLED=1 npm run build:e2e | 成功，一次构建 15,252ms |
| npm run test:e2e:built | HTTP 6 文件 / 7项通过，同构建 additional_builds=0 |
| npm run test:browser:built | 原 D4 Chromium 5/5 通过，零重试，同一构建收据 |
| diff / 专属文档链接 | diff --check、3份专属文档的本地链接通过 |

本地 build 绑定 main `4e09ec9` 上的冻结 working tree、输入和环境，同构建用于 HTTP/browser。
提交后最终候选由 PR full CI 新构建验证，不拿本地 build 冒充最终候选 SHA。

应用仓库 [eval-gate](../../.agents/skills/eval-gate/SKILL.md) 和
[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。最终 diff 保留模型/provider/thinking、
prompt、引用白名单、请求参数、正常 retry/接受判断与评测口径，仅加已授权 opt-in 控制失败路径。
正常 SDK/agent/Job 回归全通过，使用 `Eval-Gate: skip (C2b opt-in task budget control; unchanged AI parameters and acceptance; real SDK/pipeline/cancellation regressions pass)`。
无 Job A1 不执行任务预算门，完整 A1 不作为预算正确性证据；没有调用付费模型或修改 baseline。

## 独立审查与交付边界

独立方案 reviewer 三项 Warning（并发收尾、cap 重配置、原因优先）已在确认前处理并复核。
新上下文实现 reviewer 初审 Blocking 0 / Warning 2：历史成本覆盖和共享 relay 跨任务传播。
两项均补红→绿反例并修订，独立局部复核通过：Blocking 0 / Warning 0。
reviewer 在 Node24 独立运行专属52/52、原历史/relay probes、同任务 follower 与无限额 follower
两个变体；历史原字节/状态保留，跨任务共2请求、同任务仅1请求，均符合契约。
完整18文件差异、工作树/暂存一致性、三份文档本地链接、收据与 PR 草稿范围/数字及 Eval skip
理由均独立核对。源文件冻结后仅更新本收据的审查结论；最终提交与远端摘要绑定仍须实际核对。
主 agent 的全量/typecheck/build/E2E/browser 结果不冒称 reviewer 独立重跑。

PR/候选 CI/main/生产四层证据分别记录。此时仅主干前置与本地结果，不是 C2b 已合入或上线。
按正常 hooks 提交/推送、Draft PR、远端最终 diff 独立核对和 full CI 后停止；
不合并、部署、生产迁移、历史修复或清理分支/worktree。只读 repos 接口之外未改 schema/迁移/
共享测试、认证、D4、package/lock、CI、ADR/roadmap；relay 文件仅上述已授权修复。
回退为正常 revert C2b 代码，保留已提交 Run/usage/业务事实，无 schema 回退或预算退款。
