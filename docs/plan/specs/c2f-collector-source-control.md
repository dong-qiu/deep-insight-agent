# C2f：collector 消费 RSS/article signal（仅待冻结方案）

2026-10-08 复 fetch：`origin/main=0ca3ec9bfa9d1e7ad7134f027bf1dc7b53b5f813`（#445）。
本轮仅调查/方案，未实现、未运行接线验收、未盖 Eval/创建 PR。原事实绑定已提交
C2d `74053b6292f06c1499c071e6db5936e87ff6d399` / metadata
`ede88343916a1bd1f99b03123f8d1a610395c408`（collector 字节同等），及 C2e
`398ab959eeedffb72ee90776e12efb68a86f494f`；不复制其他 Session 未提交实现。
**实施前置**：C2d/C2e 均已正常合入，精确 main CI success，重新 fetch 对齐，
独立 Reviewer/协调者冻结下述方案及 collector/旧专属测试归属；当前未获实施授权。

## 真实消费路径与缺口

| 原调用/作用域 | 已提交源码事实 | 首片责任 |
| --- | --- | --- |
| collectSource → createTaskCancellation | 每次调用都产生 signal，默认无 deadline；外层最后 dispose | 不能因 signal 对象存在就自动开启来源控制 |
| runJob → ctx.signal | 从外层 signal 创建局部 scope，结束时 dispose；预算另有 ALS 父 scope | 使用仍活着的 collector 外层 signal，不用 raw opts.signal/Job 局部 scope 改首因 |
| collector:219 → joinSource(fetchFromSource(source)) | await 成功/异常后 checkpoint，但未传 options | 仅 RSS 且显式取消/deadline 请求时传 C2e signal |
| collector 全文分支 → joinSource(fetchArticle(url, container)) | 既有 full_text/legacy/kill/去重/条数上限；未传第三参数 | 同一显式请求时传第三 options；不改是否抓全文或 container |
| heartbeat / assertWrite / checkpoint | heartbeat false/SQL throw 只置 lostLease；ownership 优先，然后 cancellation、budget/usage | 原拒写/收尾优先级保持；失 lease 本身不会 abort 网络 |
| scheduler collect/probe、admin collect、Run retry | 当前只传 traceClaim/telemetry/probe/retryOf，没有 signal/deadline | 不修改这些调用方，也不隐式消费 HTTP disconnect/drain |

C2e v1：SourceFetchOptions 只有 signal；RSS registry 支持它，article 的第三参数支持它。
registry 非 async：already-aborted 先同步抛原 reason，live arXiv signal 同步 unsupported；
undefined 为原 queue Promise。直接把每次生成的 signal 都送 registry 会误拒绝默认 arXiv。
C2d 旧集成测试明确保留 requestSignal 不受 task abort、article robots fail-open 后继续
payload 的首片限制；C2f 正是显式控制调用下这些限制的有界消费接线，历史证据不改签。

## 建议冻结接口消费 v1

1. **启用选择**：`opts.signal !== undefined || opts.deadlineAt !== undefined` 才是明确
   来源控制请求。traceClaim、probe、retryOf、telemetry、仅 taskBudgetUsd/父预算，以及
   runJob/collector 默认生成的 signal 都不触发。无新 env/default deadline/全局开关。
2. **RSS registry**：启用且 source.type===rss 时，仅新增
   `fetchFromSource(source, { signal: cancellation.signal })`；否则保留原单参调用。
   arXiv 即使显式控制 collectSource 也不传 signal 到 registry，继续原 queue/retry，
   仍由原 joinSource/checkpoint 抑制迟到提交；能力缺口在专属验收记录，不能标来源已停止。
   API/未知类型原失败不变；不新增能力字段或诊断 writer。
3. **article**：启用时只在原 wantFullText 分支已有调用加第三
   `{ signal: cancellation.signal }`；未启用仍原 `(url, container)` 调用。
   article 能力独立于 feed 类型（包括可能来自 arXiv 的原全文分支），不改变来源选型。
   不把原 feed-only/full_text、ARTICLE_FETCH 动态 getter、去重/预算条数或正文回退改写。
4. **首因**：传 collector 外层 canonical task signal，继承 C2d 的 cancelled /
   task_deadline_exceeded / generation_fence_lost reasonCode。C2d 既有 createTaskCancellation
   会将 raw null/opaque 外部原因规范为 cancelled；不绕过该契约把 raw opts.signal
   直接送 sources。C2e 保留的是收到的 signal.reason；不宣称 collector 新增任意原始
   reason 透传。首个 task 原因仍 sticky，子请求 timeout/cleanup 不覆盖它。
5. **join 与提交**：保留 joinSource 成功/异常两路 checkpoint、ownership-first、原
   ctx.checkCancellation、outer trace-finalization 与 dispose；不新增 race/abort controller。
   C2e 真 DNS/hook/fetch/body cleanup 结束后 collector 才收尾。期间不提前 finishRun/
   finishTrace/关 DB；之后无 Content/raw/provenance/metadata/telemetry/成功 event。
   失 lease/旧 owner 优先拒绝失败载体写入，不新增 lease-loss 触发网络 abort。
6. **预算与失败语义**：父 ALS scope/Run 兼容估价、预算优先级/usage 收尾保持。
   budget fault 不转 signal、不新增金额门，不称网络/实际账单上界。普通 source/article
   错误、full_text partial 回退、source 失败及恢复/重试口径保持；普通 conflict 的
   top reason=provenance_revision_conflict、nested error.reason_code=collect_failed（原 collect
   阶段）、retryable=true 继续保护，只有控制错误为标准 reason/retryable=false。
   当前源码没有名为 source_failure_reason 的新字段；保护现有 Run.error 与阶段 failure
   event，不为该描述引入 schema/诊断字段或重分类。

## 文件归属与验收交接

本轮只写本新 spec，WT `insight-agent-c2f-collector-source-plan-20261008`、PORT3122、
独立 DB/DATA；主台账 root-only。实施建议仅 collector.ts 两处参数选择、一个局部
启用条件及新 collector.source-control.integration.test.ts/receipt；source 六文件、
runtime/Job/dispatch、raw helper/DB、shadow、arXiv、model/prompt/来源配置均不写。
C2d/C2e 原 owner 仍持冻结归属，需明确交接 collector 与必要旧专属集成测试再实施。

旧 C2d integration 中两项 RSS requestSignal=false 断言及一项取消后 article payload
继续断言会在新能力下失效。交接后只更新这些**显式控制首片限制**的版本断言/名称，
永久保存原 head/日志/收据；不删除/skip 旧测试或把旧红改记旧质量通过。原正常 source
输出/partial/error、shadow 等价与所有普通失败保护断言不得改；未获测试归属则暂停。

先保护反例再接线，fake DNS/global fetch/真实 Response/ReadableStream + 真实
collector/runJob/SQLite/provenance/raw helper，不能 mock wrapper 冒充 transport 已消费。

| 反例 | 必须证明 |
| --- | --- |
| 默认、trace-only、预算-only/父预算、显式 live signal、deadline-only | 只有后二者 RSS/article 实际 fetch 收到外层控制；默认旧调用参数/输出/HTTP 次数/重试/QPS 不变 |
| 入场已取消/过期、非法 deadline、0 cap | 原 C2d failed Run/非法入场与零新 source 工作保持；不新增 source unsupported 误分类 |
| RSS feed/robots、article robots/payload、redirect/retry/read 时取消 | 实际组合 signal 被 abort，零新 hop/retry；取消不成为 allow-all/null/成功；真正 await 后零业务/归档提交 |
| DNS/hook/HTTP 迟到 resolve/reject；已拥有 Response 的上层 await gap | 不提前结束；pending cleanup 时 Run 仍未收尾，read/cancel join、cleanup reject 不遮首因/无 unhandled；其后零 Content/raw/ref/成功 trace |
| 第一条 committed 后第二条取消 | 首条原 committed/ref/raw 保留；第二条零新提交，planned/unknown 契约不重写 |
| 外部 cancel 与 deadline、lease/heartbeat loss、预算竞争 | 原第一个 task reason；ownership 优先且旧 owner 零失败写，父预算未转 source signal；不把网络未知当已终止 |
| arXiv 默认及显式 collect 控制 | 零 signal-bearing registry 调用，原 queue/429/cooldown不变；显式取消 await 原工作后拒写，诚实保留源子工作未知/不支持 |
| 普通 source 错误/恢复、full_text 失败/kill/container、golden/metadata/shadow | 原正常输出/raw_html/partial/恢复/错误类型与历史 nested reason 保留；影子策略/关闭时机不变 |

定向新增及原 C2d/C2e/source/shadow/C2a/b 回归、双 TS/lint；相称 build/所需 CI 绑定最终
受审 head/tested merge/main。最终 diff 仍按 eval-gate 判断真实路径，真实模型预算 0，
不预签 skip、不以 A1 补签未执行路径。本方案未运行这些测试、不作接线验收通过声明。
前置 merge/精确 CI、文件交接、独审或正常语义等价缺口出现即退出回协调者。
arXiv/source 子树未知、shadow 深层取消、raw 内部 fence 为独立工程待办；不称全 writer
静默、严格 deadline-return 或 TD-10 整体关闭。safe_rollback=null、部署 hold/#435 硬阻断
保持，无模型/通知/真实来源/生产访问、PR/盖章/清理动作。
