# D2 / TD-12 首切片：告警 webhook 渠道职责提取

日期：2026-10-05。基线 `origin/main` @ `2bb91519a20cea09fdc387bcab0917728e28cdc4`。
承接 [TD-12](technical-debt-remediation.md)、[架构](../architecture.md)、
[D1](d1-database-lifecycle.md)、[D1 收据](../../verify/d1-database-lifecycle-2026-10-05.md)、
[C3 收据](../../verify/c3-model-usage-persistence-2026-10-04.md) 和
[C2b 收据](../../verify/c2b-task-budget-2026-10-05.md)。本切片完成不关闭 D2。

## 只读盘点与文件归属

D1 #411 已合入 `4e09ec9`，其精确 main CI 37219844193 成功；C2b #412 已合入
`2bb9151`，精确 main CI 37322850784 成功。不把合入/镜像视为生产上线，不访问生产。
参考并行计划分支只读，不整分支合入。所有 linked worktree 的 status 和 branch delta 已检查。
多个 Codex 进程存在，但无法可靠映射到 Session；干净 worktree 不证明交接。

交付前 main 前进到 `64f365682c2a6a4ffa6198f3bb4c57d1e1ab589c`（#413，仅 D1 专属
spec/收据补记），精确 main CI 37324076876 docs/success。D2 worktree 正常 fast-forward
包含它，原实现/fixture 的行为基线仍为 `2bb9151`；两者 src 树相同。D1 补记确认 TD-11
技术交付完成，但 C1/C2b 具体共享文件仍须串行交接，不视为整个目录释放。

| 候选 | 职责与耦合 | 提取边界、收益和风险 | 测试/变更频率与冲突 |
| --- | --- | --- | --- |
| analyzer.ts | 选材、模型输入、语言修复、分批、费用与取消 | 纯输入整形可独立测，但参数加载与模型输入强耦合，需冻结输入 | 自 9/1 起 24 次路径提交（含 merge）；现有 analyzer 测试；C2b 占用，不实施 |
| runtime/llm.ts | provider/retry/schema/usage/budget | 可先拆无 I/O 协议解析；SDK/预算/取消顺序风险高 | 自 9/1 起 12 次路径提交；C3/C2b 刚合入，保留其文件及测试，未确认交接不实施 |
| db/reports.ts | 发布/协调/删除、查询、统计纯投影 | topicEvolution/entityTrends 是纯边界；收益为分析投影独立于发布存储；持久化部分风险高 | 自 9/1 起 10 次路径提交；报告/统计测试；C1 恢复/删除、Brief 历史选择关联，暂避开整个实现文件 |
| agents/report-gen.ts | 白名单选择、历史去重、正文/索引/通知映射、编排 | 可拆渲染/确定性选择，但必须真实 runReportGen 接线保护 | 自 9/1 起 8 次路径提交；Brief 活跃设计与 D7 标识任务潜在冲突，暂不动实现及测试 |
| controller/replay.ts | 状态 reducer、fencing、证据 TTL、ready bundle、审计/通知计划 | 纯 ready bundle 可拆，但互相调用多，状态/哈希冻结成本高 | 自 9/1 起 18 次路径提交（含 merge）；大量 replay/reconciliation 保护，作为以后候选 |
| runtime/alert.ts（推荐） | 业务文案/Brief 判定、去重、env、渠道协议、HTTP 与邮件扇出 | 仅渠道识别、HTTP 请求转换、响应错误解析提取成叶模块，协议可独立测试且不加载邮件/logger | 自 9/1 起 2 次路径提交；alert.test.ts 已覆盖正常五渠道，缺少完整字节基线、类型畸形响应、初始化与失败接线；C2b/C1/Brief 当前变更无此文件 |

频率由 `git log --since=2026-09-01 --format=%h -- <path>` 计数，不是性能或业务收益测量。
主 worktree 保留 ADR/roadmap 修改和 4 份未跟踪 Brief 文档；Brief density worktree
另有 ADR、fast-release、S0 progress 和 2 份未跟踪文档。C2b worktree 当前干净但仍按
用户指定的 repos、runtime jobs/llm/model-usage/relay/diagnostics、agents
analyzer/validator/pipeline/scheduler/generation-dispatch（含测试）保留占用。
C1 的 schema、integrity/recovery/delete/ops，D1 的 connection/startup/migration 和共享
package/lock/CI/architecture/ADR/roadmap 全部不修改。提交前再次现场核对。

只修改 alert.ts、新 alert-channels.ts、D2 专属测试/合成 fixture、本 spec 和专属收据。
旧 alert.test.ts 不移动、不修改。其他会话工作区只读；没有直接 Session 交接回复。
本范围不需要 C2b 文件交接，未来进入其范围须先确认交接。

## 输入输出与职责

`alert-channels.ts` 包含原 `PushHighlight/Notification/ChannelId/AlertRequest` 类型，以及原
`detectChannel/buildAlertRequest/appLevelError` 和其私有 helper/常量。类型随中性消息协议移动，
不新增类型泛化。原 alert.ts 导入并 re-export 所有这些 API，旧调用方不迁移。

依赖图为 `业务调用方 → alert facade → alert-channels → node:crypto`。email.ts 保留对
alert 的 type-only import，叶模块不回引 facade，不引 DB/agents/sources/email/logger/env。
alert 保留 notify/sendAlert、文案、Brief 判定/Set、邮件扇出和原环境变量读取时机。

实际调用方核对：jobs/followup/scheduler/source-health/pipeline 分别产生失败、预算、源健康
及报告通知；staleness/integrity-alert/metric-alert/generation-dispatch-health 复用 notify；
admin page 读 Brief 阈值，email 仅 type import。全部保留 facade，无调用方迁移或遗漏。
reports 的调用方横跨 startup/pipeline/API/报告库/主题统计；replay 被 controller store/
reconciler 使用，说明暂缓这些边界的理由。ops/probe-alert.mjs 自带独立协议镜像，
不导入真实 TS 实现；本切片不运行或修改它，不用它证明等价，后续另行消除镜像漂移。

| API | 输入 | 输出/不变量 |
| --- | --- | --- |
| detectChannel | URL 字符串，可选 override | 原五渠道；override trim/lowercase 优先；host 精确/真子域；飞书 path 条件；非法 URL 回 generic |
| buildAlertRequest | URL、Notification、channel、可选 secret/now | 原 URL/method/headers/body/channel，包括 JSON 属性顺序、缺省字段丢弃、重复 tags 和换行；ntfy origin + 第一段 topic，不解码；所有原异常继续同步抛出 |
| appLevelError | channel、响应字符串 | 非飞书/空体 null；code 优先于 StatusCode、缺省 0、严格数字 0；解析/属性访问异常原非 JSON 描述与 120 UTF-16 截断 |

签名函数在 secret truthy 且 now 缺省时仍调用 Date.now，不宣称其无条件纯。
提供显式 now 时确定性；未签名不读时钟。没有新随机数、缓存或顶层 env 读取。
非法 runtime 值保留原 fallback/错误，不顺手加强验证。

固定输入的输出、排序/重复保留、默认值、错误分类和传播不变。没有 SQL/事务/写顺序/
幂等/fencing/数据库连接/迁移改动；D1/C1/C3/C2a/C2b 通过既有回归保持。
引用白名单/一致性/证据可见性/报告发布/模型/provider/thinking/prompt/判断/阈值均不改。
不加框架、依赖、schema、迁移、分页、查询优化、ID 改造或历史回填。

## 先保护、再提取的验收矩阵

预期取自以上既有契约或在原实现上冻结的合成 JSON fixture（记录基线与 SHA256）。
同一套测试先从 alert facade 跑原实现，再不改输入/预期跑提取实现；新叶模块只追加
入口身份与零依赖副作用验证，不让新实现生成预期值。

| 场景 | 验收证据 |
| --- | --- |
| 五渠道、非法/空 URL、host 大小写/伪子域、override | 表驱动固定结果，保留 fallback |
| 中英文/空消息、缺失字段、重复 tags、highlights、额外元数据 | 全请求字节 fixture；不排序、去重或渲染邮件字段；输入不改动 |
| ntfy 多段/编码/根路径/非法 URL | 固定 origin/第一段；同步错误类别与原自定义文本 |
| 签名 now=0/负值/秒边界、空 secret、缺省 now | 固定签名 fixture、受控时钟；未签名时零时钟访问 |
| 响应新旧字段、冲突、null、数组、标量、字符串 0、坏 JSON、长 body | 固定原返回值与截断；保留现状分类，不修复 |
| JSON 序列化/输入 getter 抛错 | 原同步异常传播与身份；notify 构造错误捕获，零 fetch |
| notify → 渠道转换 → sendAlert | mock fetch 真入口；env 在调用时读；签名/timeout 参数；HTTP 失败/应用拒绝/read-body failure/同步和异步 transport 失败都 resolve，固定脱敏日志分类 |
| 模块初始化 | 基线 facade 不读通知配置、不发送；原 logger 的 LOG_LEVEL 初始化保留；叶模块无 email/logger/diagnostics runtime import、零 I/O/clock/env |
| 兼容性/依赖 | facade re-export 引用身份、旧 alert/email/job/provider 测试；TS7+TS6 类型检查、lint，AST/文本逐字对照提取段，无 runtime 回环 |

只使用合成数据、临时库和 mock transport；不发送真实通知、不调用付费模型。
至少受影响测试、完整 coverage/ops、双 TS typecheck、lint。alert 经 Job/报告入口共用，
保守补 build:e2e、HTTP E2E 和 D4 browser smoke；CI 原应用、容器和覆盖率门保留。
按 eval-gate 在逐字提取与真实兼容路径回归确认后 skip；A1 不执行渠道职责拆分，不作为证明。

## 评审、回退与停止

独立新上下文 reviewer 先审方案，再审最终完整 base→working diff，修正后复查受影响路径。
按 [交付证据流程](pr-delivery-evidence-workflow.md) 提交前写专属收据，正常 hooks 提交/
推送/Draft PR，独立核对远端完整 diff 与冻结文件，核验最终候选 full CI 原始身份产物。
CI 链接/结果只追加 PR 摘要，不为补 URL 变更候选。停止等待合并授权。

回退为代码正常 revert，不接数据库或生产。没有合并、生产部署、迁移、恢复、历史修复或
分支/worktree 清理授权。已知旧 appLevelError 对 `null` 归非 JSON、字符串 `"0"` 归拒绝、
notify 对非法/空配置沿用原处理；记录为现状，不在纯重构中修复。

未完成：alert 业务文案/发送/状态、全部其他热点模块和持久化/编排拆分。
下一切片优先仍选纯边界；进入 C1/Brief/C2b 文件必须现场确认交接，DB 入口继续沿用 D1，
每个 PR 仅一个模块一组内聚职责，D2/TD-12 保持部分完成。
