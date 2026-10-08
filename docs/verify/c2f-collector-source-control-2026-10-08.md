# C2f collector 显式消费 RSS/article signal：隔离工程收据

2026-10-08。状态：本机候选，等待双独立最终 review、事后 eval-gate 判定及 PR/精确 CI；
未 push、未合入、未上线、未盖 Eval 章。目标仅为
[冻结 C2f 首片](../plan/specs/c2f-collector-source-control.md)，不关闭 TD-10 整体。

## 身份、授权与实现

复 fetch 基线 `cfca8bc70587a78941cde28487af2d1c1b2d90b1`。协调者已确认父 C2d #449
`5ae17c3` 精确 main CI `37698406412 / attempt 1 / success`，父 C2e #450 上述
SHA 精确 main CI `37699429841 / attempt 1 / success` 并保全专属包；本轮没有把父
证据当作新 consumer 验收。原 spec `6b646a563b5dd7c65ad9fa6d492330ed300e8d58`
正常 cherry-pick 为 `07048c2`；原 93 行保持原时点，本次追加授权绑定。

唯一负责人执行 Agent B：collector.ts、新 collector.source-control.integration.test.ts、
C2f spec/本收据，及获明确交接的旧 collector.task-control.integration.test.ts 三条
限制断言。源码只新增局部启用条件与两处参数选择：

- `opts.signal !== undefined || opts.deadlineAt !== undefined` 才开启 source control。
  默认、trace、probe、retry/telemetry、预算-only/父 ALS 预算仍原 registry 单参和
  article 双参；每次自动生成的 signal 不触发。没有新 env/default deadline。
- 仅 RSS registry 传 collector 外层 canonical cancellation.signal；arXiv 始终单参，
  原 queue/429/cooldown 未修改。原 wantFullText 分支独立传 article 第三 options，
  即使 feed 为 arXiv，仍不改变是否抓全文、kill/getter、container/去重/条数上限。
- 保留外层作用域直到 trace 收尾与 finally；原双路 joinSource/checkpoint、ownership
  首位、父预算/Run 兼容估价、失败/正常输出口径不变。不将 budget/lease-loss 翻 signal。
  raw null/opaque 外部原因继续由 C2a 规范为 cancelled；sources 收到的是 canonical
  TaskCancellationError，首个 cause 不被第二次 abort、deadline 或 cleanup error 替换。

六个 C2e source 与 runtime/Job/dispatch、shadow、raw helper、schema、安全 policy、
模型/prompt/来源配置均未写。新事实不批准回退、不解除 hold/#435 生产硬阻断。

## 真实保护路径

只替换 DNS/global fetch/通知边界；真实 collectSource/runJob/registry/RSS/article、
robots/SSRF/safeFetch/redirect/retry/Response/ReadableStream、SQLite/provenance 与
实际 raw helper/文件保留。合成 .invalid feed/HTML/Atom，不访问真实源/模型/生产。
每条红测也实际释放 deferred 并 join 后关 DB，不 race 关闭资源；不消费未归属 Session 内容。

| 风险 | 永久真实 consumer 保护 |
| --- | --- |
| 默认/trace/预算/父预算/probe/retry/telemetry/live signal/deadline | 参数 arity、请求序列、实际正文/raw_html/container/reader_eligible/effect/Run 保持；仅后二者启用 |
| 首因 null/opaque 与迟到 HTTP | 实际组合 request signal abort，cleanup reject 被 join，reason 等于 canonical transport 原 cause；cleanup pending 时 Run running/trace accepted/source 未 settle |
| DNS resolve/reject、robots/feed/article robots/article payload reader | 真 await 结束前 collector 不收尾；随后无新 HTTP/Content/effect/成功 output，不 allow-all/null 吞控制 |
| 已拥有 Response 的三上层 await gap | cancel 恰一次/bodyUsed=true，cleanup pending 不收尾；reject 不遮 canonical cause |
| redirect/503 retry body cleanup 内取消 | 原真实 transport 接到 signal，结束 cleanup 后不新 hop/retry；无 Content/raw 提交 |
| deadline-only、cancel 先于 deadline | 实际 transport abort；忽略取消的迟到响应仍 join，首个 task reason sticky |
| 首条已 committed、第二条 article 取消 | 第一条 exact Content/ref/effect/raw 原字节保留，失败 committed=1/unknown=0；第二条不提交 |
| lease 或父 budget 单独故障 | network signal 保持 live，实际旧 source join 后拒写；失 owner 无 failed Run/event 更新 |
| sticky 父 budget 与 cancel/deadline/lease 竞争 | canonical cancellation/ownership 原优先级；预算不变网络 signal，不声明费用上界 |
| arXiv 默认/显控及原全文分支 | registry 原单参 queue/网络未知；原 article 分支独立收到显控且真 join；不抛 source_cancellation_unsupported |
| 普通 robots fail-open、full_text null/partial、旧失败与 shadow | 正常 partial/output、collect_failed nested/retryable=true、Run.error/恢复/影子策略原回归保护 |

旧三条版本限制仅改名称/显式能力断言：两例 RSS requestSignal.aborted=false → true；
article 取消后的 payload 存在 → 不存在。原 C2d `74053b6292f06c1499c071e6db5936e87ff6d399`、
C2e `398ab959eeedffb72ee90776e12efb68a86f494f`、父 merged Git 对象及旧收据/raw
保留，不删除/skip、不改签旧历史质量。其余已有保护未改。

## 验证与失败保全

Node 24.19.0/npm 11，独立 WT PORT3124、本地配置 0600、隔离 DB/DATA 0700。

- 初轮 24 条保护：14 failed / 10 passed；其中一处 fixture 错把现有 fetch_status 叫
  completeness，已只修测试字段；一个 deadline-only 名称误提未传入外部 controller，
  已修准确名称。原测试字节/log 保全，不把这轮签给最终测试版本。
- 实现前第二轮 **31 条：14 个真实 source 消费缺口 failed / 17 passed**。collector
  与精确 main 原字节相同；原保护测试字节、绑定、红测日志完整保全。失败包括实际
  transport 未 abort、body cancel=0、DNS 返回后继续 HTTP 及显控参数未消费。
- 最小实现后新 37 条与旧真实 HTTP 9 条通过；后续补 arXiv feed/原 article 独立能力
  和 trace pending 断言，最终新 **38 条通过**。不把旧 31 条红测改签为新增全部测试。
- 最终定向新/原 source、collector、shadow、source entries/health、C2a/C2b、raw 与
  reports cancellation 回归 **29 文件 426 项通过，无 skip/未处理拒绝**。
  原 425 项/中间轮日志亦保全，最终日志单独绑定最终源码/测试字节。
- TS7/TS6 app/tools、affected ESLint、生产 build 与 git diff --check 通过。build 的
  既有 middleware→proxy deprecated warning 保留，不记已消除；必要精确 PR tested
  merge/main CI 和构建由协调者另核。

私有非覆盖 evidence 根：
`/Users/dongqiu/.local/share/insight-agent/evidence/c2f-collector-source-controls-20261008/`。
最终 index/binding 记录精确受审 head、源码原字节、日志、原失败 size/hash，目录 0700、
文件 0600；不将敏感原文/报告或运行日志入 Git。源码未再变化的有效 build 结果保留
源码 hash 绑定，测试追加不移植未执行路径质量。

已亲读 eval-gate 与 pre-pr-ai-review；新消费涉及来源真实路径，最终由协调者亲自读
最终 diff、正常等价证据及双独审后判断。预算 0，未跑 A1/真实模型，不预签 skip，
不把本收据写成真实 AI 质量、人评、历史 S2a 或来源许可通过。

## 保留工程边界

arXiv queue 在显控下仍不消费 task signal，迟到原网络工作必须实际 join；无能力/未知
终态不称 source 子树停止。podcast-shadow 深层 signal/lifecycle、raw helper 内部跨进程
fence、probe timeout race、共享 writer 静默及生产维护是独立待办；本片没有隐式接入
HTTP disconnect/drain、严格 deadline-return 或全系统费用界。safe_rollback=null、
deployment blocked/hold 保持；无生产访问/通知/部署/批准回退/清理授权。
