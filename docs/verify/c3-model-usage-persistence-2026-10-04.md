# C3 / TD-13 最小模型调用用量持久化验证收据

日期：2026-10-04。范围：已确认契约、additive v48、Job 内真实请求接线与只读 reader。
交付状态：本地实现/回归完成；候选 PR CI 在首次提交前尚未运行。最终候选 SHA、独立远端 diff 复核、CI run/attempt/实际 tested SHA 和产物身份在同一 PR 摘要追加，不为补 CI URL 改动候选 head。
本收据不是合并、上线或生产账单完整性的证明。遵循 [交付证据流程](../plan/specs/pr-delivery-evidence-workflow.md)。

## 授权、基线与隔离

用户明确确认第 1 步后，按原顺序完成 schema/migration 串行交接和独立表方案；不重复 C5/D5/C4a/C2a。
初始盘点与设计评审见 [启动收据](c3-model-usage-preflight-2026-10-04.md)，验收契约见 [C3 spec](../plan/specs/c3-model-usage-persistence.md)。
最新核验基线 `origin/main` @ `142b1e38c0f07d0ff67d80611c2681a5ef11ffc8`，
[main CI 37192597531](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37192597531) success。
分支已正常合入认证 #409 与 D4 #404 的主干提交；C3 没有修改其认证/退出/browser/package/lock/CI 文件或减弱测试。

worktree `/Users/dongqiu/Dev/code/insight-agent-c3`，branch `feat/c3-model-usage-persistence`。
沿用权限 0600、独立 DATA_DIR/DB_PATH 的本地配置；测试只使用 in-memory、临时 seed 与合成归档。
没有复制 live DB、历史原文/报告，也没有输出密钥、访问生产/云、运行历史修复或清理分支。
本地运行 Node `24.19.0` / npm `11.17.0`，依赖来自当前 lockfile 的正常 npm ci。
主工作区的 ADR/roadmap 未提交改动保留；architecture 仅补 C3 已确认实体契约。

## 完成的最小范围

1. `model_usage_attempt` 单表保存应用 UUID logical call / attempt、Run/trace/role/provider/model、时间、nullable token、观测状态与编号/hash、本地价格快照/来源和 nullable USD 估价。身份不可变、完成事实不可覆盖，不存正文/端点/request id/凭据。
2. 每个可观察 fetch dispatch 先提交 unknown，收到原始 usage 在 SDK/业务接受相应事件前同步提交。SDK 内部 retry、runtime/refusal retry 有独立 attempt；同一 attempt 重放幂等、冲突/stale 拒绝。SSE token 是累计快照，缺失字段继承已知值而非相加或归零。
3. Anthropic 在安装的 SDK 0.127.0 自定义 fetch 边界观测，原字节、背压、取消与 retry 参数保留。最终 output delta 与 message_stop 都可证明且没有观测丢帧，才提升 reported。CR/LF/CRLF 与跨 chunk 支持；262144 字符 frame 上限超出会固定诊断并保持不完整，不影响原业务 framing 接受。
4. Responses 在原 parser 的 completed/incomplete/failed/error usage 边界接线，先于 legacy normalizeUsage；Coding Plan 金额始终 unknown。unknown/partial 不当零，local estimate 不当账单，不获取或推断套餐余额。
5. Job 内 callStructured 的 analyzer/validator/coverage、语言修复与 judge 共享隔离归属；实际 runAnalysis、judgeWithRetry、coverage 外层 retry 的真实 SDK/mock fetch 路径已测试。独立 followup HTTP、无 Job 的 eval/probe/direct SDK/fetch 不记录，也不隐式打开全局 DB；语言修复等全部子路径未逐个做完整端到端演练。
6. 每次写事务执行原 assertWrite：仍持 lease 的显式取消仅记录实际已到达的用量，拒绝迟到业务结果；真实 lease 接管后拒绝用量写及业务写，不新增 writer 权限。取消后不另建追读消费者，不承诺取得尚未到达的用量。
7. 持久化错误 sticky 于 Job，每次新 dispatch、logical call 与业务 checkpoint 检查。写前故障零请求；写后故障不自动重发已完成请求，即使 SDK 包装或 validator/coverage 吞错重试也不继续真实 transport。固定 usage_persistence_failed，迟到 DB closed/fence loss 有脱敏诊断，不重开 DB、不复活 Run。
8. Run.cost/预算与 P1 投影保留原消费源；attempt 独立作为观测事实源，三者禁止相加。完整记录重放不会按新版 PRICING 重估已保存价格。
9. 仅 explicit migration `20261004_48_model_usage_attempt` 新建表/index/guards；schema.ts 与 frozen DDL 相等，历史 47 条 ledger checksum 与独立基线 fixture 一致，无回填。只读当前/旧库 reader 无 DDL/修复，未迁移 writer 在 dispatch 前拒绝。reader 每页 1000、nextOffset 显式标明后续页；静止 Run 可完整翻页，进行中分页不提供快照隔离保证。

## 反例与本地验证

先编写反例，最初因 repository/runtime 模块尚不存在而失败，再实施。所有模型请求均为 synthetic fetch；真实付费请求为 0。

| 风险 | 证据 |
| --- | --- |
| SDK retry、refusal/schema failure、并发归属 | `runtime/model-usage.integration.test.ts` 真实 SDK 两次 transport/独立 attempt、共享 logical call；失败后 usage 保留；并发 Job 不串 Run |
| replay/conflict/stale、局部缺失不覆盖、价目版本变化 | `db/model-usage.test.ts` 相同身份/观测 replay、不同事实拒绝、final immutable、累计快照与原价格快照保留 |
| usage 后失败/取消/EOF 未到 | 集成测试在 Run running 时已读到 reported；取消业务失败但已提交 usage 保留；Responses terminal 后非法协议仍可读 |
| 崩溃/重启 | 子进程先提交 WAL 后 SIGKILL，重开 readonly 得到 reported 与另一个 unknown；不从未知 attempt 推算账单 |
| 缺失/非法/零/未知价格 | raw 字段安全整数检查、cache unsupported nullable；零与 null 不同；未知模型/Coding Plan 无估价0；丢帧/缺 final output 保持 partial |
| 取消、fencing、迟到故障 | 有 guard 的迟到记录；真实 generation_dispatch 接管后旧 guard 拒写且 Run 不改；取消收尾后 closed/write-failed 固定诊断 |
| 新库/v47/readonly/原子性 | 历史 checksum fixture，显式 v48 重复执行；文件库 v47 升级阻断 DDL 注入后 ledger 回滚；旧/新 readonly 文件字节不变 |
| 原成本/预算/P1 | 真实 runAnalysis → analyze → SDK → batch/Run；P1 off/on 均单次 Run 成本，on 时仅原有1条 cost_ledger 投影；attempt 不参与原汇总 |
| 持久化失败与重试 | SQL trigger 合成写故障、缺 schema、readonly、conflict；sticky gate 阻止 SDK 与真实 validator/coverage 外层 retry 再次 transport；不静默成功 |
| framing/正常接受规则 | CR/LF/CRLF、逐字符分块、超限 frame、多 delta、缺最终 delta；现有 provider/LLM/agent/引用/取消回归全部通过 |

命令及结果（最终文件集合，提交前工作 HEAD `ee1f87c1d70acf94d854e4015bf338993f95976c`）：

- `npm run test:coverage`：242 文件 / 2453 项 Vitest + 150 项 ops 全部通过；statements 78.97%、branches 71.51%、functions 79.00%、lines 82.92%，原门槛保留。
- C3 专属 3 文件合计 46 项，纳入上述全套；C2a 与现有 pipeline/SDK/provider/预算回归保留。
- `npm run typecheck`：TS7 + TS6、app/tools 全部通过。`npm run lint` 与 `git diff --check` 通过。
- `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e`：成功，18.662 秒；同环境/HEAD/输入绑定构建复用。
- `npm run test:e2e:built`：6 文件 / 7 项通过；`npm run test:browser:built`：D4 原有 5 项通过，未修改测试。

早期全套出现真实文件迁移默认 5 秒超时（同场景单独复跑 2.31 秒通过，无迁移断言失败）；仅该涉及 durable fsync 的新 integration case 设置 30 秒，未放宽全局超时/门禁。修正后完整 coverage 重跑通过。新增 test 的 ProcessEnv/generic 类型问题也已修正并通过双编译器；这些早期失败不冒充最终通过。
本地 build 验证的是上述 HEAD 的冻结 working tree；提交后的最终候选由 PR full CI 的新构建与证据绑定，不复用本地 receipt 冒充最终 SHA。

## Eval-Gate 与独立审查

应用仓库 [eval-gate](../../.agents/skills/eval-gate/SKILL.md) 与 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。
llm.ts 命中路径门，但最终 diff 不改变模型/provider/thinking、prompt、请求参数、正常 retry、terminal/Zod/引用判断或评测口径。新增的是观测及已确认的本地持久化故障停止策略。
因此使用 `Eval-Gate: skip (C3 usage observability; unchanged AI parameters/acceptance; real SDK/pipeline and cancellation regressions pass)`。
A1 无 Job 不接新观测 DB，不证明 C3；不调用真实模型或使用无关 A1 代替持久化证据。

独立方案 reviewer 的 4 项 Warning 在 spec 阶段处理；用户随后确认设计/交接。
新的独立实现 reviewer 按完整 merge-base diff 审查，发现 3 项 Warning：初始 output0 假完整、partial null 覆盖已知、CR-only framing 缺口。均修正并补专属回归，独立最终复跑 C3 三文件 46/46，通过；其建议的显式 reader 分页也已处理。专属收据的范围、数字、链接与证据来源独立复核通过，Blocking=0、未解决 Warning=0。最终提交 SHA 的审查绑定与 PR 远端 diff 复核追加到 PR 摘要，未完成的 CI 不在本收据预签 success。

## 风险、回退与后续

- 同步 SQLite 写入增加每个 usage 边界的 I/O；本切片不调整 timeout/deadline/预算阈值，不做写重试。不可观测的服务端转发/retry、响应丢失、lease 丢失后 usage、未提交窗口与历史调用仍可能未知，不能宣称财务完整。
- 新观测表无 retention/删除任务，数据增长需要后续独立容量方案；reader 不提供业务 UI/API 或新的账单消费源。
- 正常回退代码保留 v48 表及已提交事实，禁止 drop/downgrade ledger；生产迁移仍须按既有 pause/drain、显式 runner 和版本交接流程另获授权。本任务未执行生产迁移/部署。
- C2b 可以基于冻结 C3 契约启动只读调查/spec 设计；实现前仍需 C3 合入及对应 main CI，schema/runtime 串行交接，明确 unknown/partial/估价与 legacy 成本防重复的预算消费契约。C3 PR 通过不等于 C2b 可直接切换预算，更不证明实际账单或套餐额度可恢复。
- 停止于 PR/最终候选 CI 就绪，合并和部署等待用户授权；共享 ADR/roadmap 不覆盖，分支/worktree 不清理。
