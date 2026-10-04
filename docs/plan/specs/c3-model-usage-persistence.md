# C3 / TD-13：最小模型调用用量持久化

日期：2026-10-04。基线 `origin/main` @ `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`。
状态：用户已确认关键设计及 C1/D1 schema/migration 文件交接；最小持久化及运行接线已实现，交付证据见 [C3 收据](../../verify/c3-model-usage-persistence-2026-10-04.md)。最终验证基线为 `origin/main` @ `142b1e3`，包含其他工作流已合入的认证 #409 与 D4 #404。
承接 [技术债 TD-13](technical-debt-remediation.md)、[C2a 取消契约](c2a-task-cancellation.md)、
[C2a 收据](../../verify/c2a-task-cancellation-2026-10-04.md)、[架构](../architecture.md)、
[provider spec](volcengine-responses-provider.md) 与 ADR-0031。

## 现场与现有能力

- #406 已合入，main CI `37167709112` 成功。C5/D5/C4a/C2a 不重复实施。
- `callStructured` 有进程内 meter 和每次已返回 usage 的 `onCost`；Job 仅在 done/failed 时保存 Run.cost。
  Volcengine 的 formal terminal 失败已有 usage 保留能力，但流中断/取消可能发生在最终返回之前。
- 现有预算 `getBudgetStatus → sumRunCostSince` 仅累计 Run.cost.amount；未知模型使用既有保守 fallback，
  标 `estimated`。C3 不改变这个数值、限额、调度策略或 C2b。
- P1 `cost_ledger` 是阶段提交后由 `costs[]` 生成的 append-only 观测投影；有幂等 hash 与冲突审计。
  其 token 字段 NOT NULL/default 0，stage/trace 是 metric 身份，部分调用合并 input/output，coverage 归属也不精确。
  它没有真实 logical-call/run/attempt 身份、usage 完整性、cache token 明细或价格快照。
  覆盖这些语义需要破坏其现有不可变事实契约，或新增同请求多条事件并重写各聚合消费者。
- 已安装 Anthropic SDK `0.127.0` 的 client 在 retryRequest 后重新调用底层自定义 fetch；故 SDK 内部 retry
  可在实际 fetch 边界观测。一次 messages.stream/finalMessage 不能冒充一次 HTTP attempt。
  仓库旧注释的 SDK 0.98 不是当前依赖事实。

## 已确认的最小设计

采用一个独立 `model_usage_attempt` 表，保存调用观测而不建立第二套财务账本；复用 SQLite DB、
provenance migration runner、canonical hash、现有价格纯函数与原 ownership guard。
此表不写入 cost_ledger/rollup，不向 Run.cost 再加一次费用，也不保存 provider 账单、套餐余额或 request id。
新表理由是现有 P1 不可变投影不能表达从未知到观测完成的请求状态；不是默认另造 cost ledger。

用户已确认这一关键设计及 schema/migration 交接。另一方案是在 cost_ledger 上追加 nullable 观测字段，
但仍要解决初始未知记录与 append-only 禁更新的矛盾，并改变 P1 reader/retention/rollup；不推荐本切片扩大至此。
若这构成架构变更，按 L2 将已确认实体契约补进 architecture；ADR 的共享工作区内容不覆盖，必要时另行交接。

### 身份、幂等和状态

- logical call = 一次 callStructured，应用生成完整 UUID；validator 外层重试是新的 logical call。
- attempt = 底层实际 fetch 的一次应用可观察 dispatch，完整 UUID，唯一 `(logical_call_id, attempt_number)`；
  SDK 内部重试、runtime transient retry、refusal retry 都产生新的 attempt，不能复用失败 attempt 的 ID。
- 记录最小 metadata：attempt/logical-call/run/可选 trace ID、角色、provider/model、开始/观测时间、
  usage 状态、input/output/cache-write/cache-read 的 nullable token 字段、估价状态/来源/价格快照/nullable USD。
  身份字段只来自应用上下文和已验证配置，不存 prompt、原文、响应正文、密钥、敏感 endpoint 或 provider request id。
- 发请求之前保存 started/unknown。它表示已计划 dispatch，不能保证 provider 收到请求；本地网络失败也可能有费用未知。
  收到 provider usage 后在该事件边界同步提交，不等待 Run、Zod 或 SSE EOF。既有成功响应接受规则保持不变。
- usage 状态区分 unknown（无可信字段）、partial（只获得部分或无最终 usage envelope）、reported（完整 provider 字段）。
  unknown/partial 不能当零消耗；明确报告字段缺失。provider 明确返回 0 与缺失不同。
  reported 仅代表 provider 报告完整，不能证明实际账单完整或金额已对账。
- 同一 attempt 相同观测语义重放返回 replayed，不再次累计。started → partial → reported 为显式单调转换；
  已有完整观测不可覆盖。相同终态不同 token/价格/归属或相同 attempt 不同身份拒绝，原记录保留，
  输出固定冲突 reason；不自动造新 attempt 或重发请求。局部 usage 更新须保留已知字段，不能以缺失字段归零。
- 进一步固定局部更新：unknown → partial、partial → partial、partial → reported 均允许，但 reported 不降级。
  单个 parser 给观测编号 observation_number；同编号同 hash replay，同编号不同 hash conflict，旧编号 stale 拒绝。
  token 是 provider 的累计快照，不把每个 SSE delta 相加；更高编号只替换明确提供的字段，不把缺失字段归零。
  已收到完整 envelope 的同语义重放可幂等，完整 envelope 的不同 token/价格/归属拒绝。
  表保留当前观测与 hash，不宣称保留每一个 SSE 片段的历史；进程重启不能复活原请求或重建其未收到观测。
- Volcengine 现 normalizeUsage 会将缺失/非法字段归 0，不能用其结果证明 usage 完整。
  C3 观测在归一化之前检查原 terminal event 字段：缺失、非安全整数、负数或小数均为缺失/partial，
  明确数值 0 才是真零。原业务 normalizer、终态接受和 Zod 规则保持原样；观测接口不持久化原事件正文。
  Anthropic message_start 的 output=0 是初始快照，不代表最终 output 为零；message_delta 提交 partial 快照，
  message_stop 时还须有有效 message_delta.output_tokens，且没有超限丢帧或尚未被有效值替换的非法字段，才可提升 reported；不能用初始 output=0 代替最终用量。cache 字段缺失保留 null；无法证明完整估价输入时金额 unknown。
- 进程重启后 started/partial 原样可读，查询显示未完整；不得把 orphan 清扫当作 usage 修复。
  已提交 reported 重启后可读，重放仍幂等。中断前未取得/未提交的使用量无法从数据库推断。

### Provider 字段合并与完整性

| Provider/事件 | 计数字段语义 | 状态与缺失规则 |
| --- | --- | --- |
| Anthropic message_start | input/output/cache 为该消息初始累计快照 | 已报告字段可存 partial；output 初始0不作完整事实；任何缺失计数字段保持 null |
| Anthropic message_delta | output 及明确提供的 input/cache 为当前累计快照，非增量 | 新观测刷新明确字段，其他继承；仍 partial，不对 delta 相加 |
| Anthropic message_stop | 最后累计快照 | 有有效最终 output delta、input/output、无丢帧/尚未修复的非法观测才 reported；cache 缺失保留 null；完整金额另检所有 cache 输入 |
| Responses completed/incomplete/failed/error terminal | raw usage 为该 attempt 的最终累计 envelope | input/output 均有效才能 reported，否则 unknown/partial；不因业务 terminal 失败而丢已报告用量 |
| Responses input_tokens_details.cached_tokens | 该 envelope 的 cached-input 累计快照 | 缺失为未报告，null；明确0才零；不把它与 input_tokens 相加推断总输入 |
| Responses cache creation | 当前协议未提供此计数字段 | null/不支持，不能借 Anthropic cache-write=0 假造 provider 返回值；Coding Plan 金额一直 unknown |

新表 token 字段以 nullable 形式表达未报告/不支持；provider/version 给出支持范围，reader 不能把二者解释为真零。
reported 的“完整”仅限 provider 最终 input/output envelope，不要求 provider 支持全部 Anthropic cache 字段；
估价完整性另检所有计算输入。实际观察不到 envelope 就保持 unknown/partial。

### 估价与预算消费者

- token 是 provider 观测，estimate 是本地价格计算，actual billing 和 Coding Plan 额度均未取得。
- 已知本地价目：estimate_status=estimated，记录 price_source/定价版本/实际计算所用输入输出价与 cache 乘数，
  使用现有 costUSD，不重新抓价格，不宣称当前官方价或实际账单。
- 未知模型或 Volcengine Coding Plan：estimate_status=unknown、estimate_usd=NULL；不能使用 $0。
  部分 usage 不产生完整金额；可保留 token 观测，但金额 unknown。既有 Run 保守估价不复制成可信报价。
- C3 attempt reader 是新调用的细粒度 token/完整性事实源；Run.cost 仍是现有预算/运行展示的兼容来源；
  P1 ledger/rollup 仍消费自身既有阶段投影。三者禁止相加；不能用 attempt 表去回填无法证明的旧 Run。
- 已知价格与既有 Run 无 estimated 标记并不等于实际账单。文档明确 legacy amount 的估价性质，
  不本切片重写旧 JSON 或改变 UI/预算数值。
- 因预算暂不切换到 attempt 事实源，C3 不承诺取消/崩溃/租约丢失后的在途成本会进入既有预算。
  C2b 需要另行确认未知/partial/估价口径和迁移防重复规则。

### 取消、fencing 和持久化失败

- Job 建立隔离 usage 上下文；logical call 获取当前 Run 和 guard，并发 Job 不串归属。
- 用量写入仅调用原 assertWrite，不能调用接受业务结果所需的 cancellation checkpoint。
  显式取消且仍持有租约：仅实际已到达本地观测边界的迟到 usage 可补记录，业务结果仍被 C2a 拒绝；不启动后续调用/阶段。
- 租约丢失：每次 SQL 写事务内仍调用 assertWrite；拒绝 usage 写和业务写。保留已提交 started/partial/reported，
  租约丢失后的未知额度不补推断。此方案不新增独立费用 writer 权限，不绕 fencing。
- 底层观测不能延长 drain、修改取消 reason、释放后复活 Job，或制造未处理 rejection；迟到 observer 的错误
  使用固定脱敏诊断。reader 需将 started/partial 显示为未完整，即使终止业务结果已丢弃。
  不建立取消后的追读消费者；保留 SDK stream.abort/body cancel，不能保证未到达本地的迟到用量还能获取。
- 新请求前记录失败：不发 provider 请求，固定 usage_persistence_failed，拒绝在当前 Job 继续调用。
- usage 到达后写入失败：不自动重发 provider 请求；当前 usage 上下文记 sticky failure，停止新 dispatch，
  在业务提交 checkpoint/Job 收尾显式失败。已有记录保持 unknown/partial；日志只写固定类别与应用 ID，
  不输出 SQL/provider error 正文，也不能声称记录完整。lease loss 仍按原错误边界处理，不写失败 Run。
  迟到 observer 区分 usage_persistence_failed、usage_fence_lost、usage_store_closed 三种固定诊断；
  全部 Promise 有 rejection handler，DB 已关闭时禁止自动重开数据库或运行迁移。
- SDK 0.127.0 会把自定义 fetch 抛错作为连接失败进行内部 retry 并包装 APIConnectionError。
  因此不能只依靠“持久化错误 nontransient”：sticky failure 必须在**每次实际底层 fetch 前**检查，
  也在新 callStructured/validator/recovery 与业务提交 checkpoint 检查；SDK 自己的下一次 wrapper 调用
  可以发生，但不得触发第二次 provider transport。最终用受控 usage_persistence_failed 覆盖 SDK 包装，
  不改变未故障场景的 SDK maxRetries/backoff。
- 正常成功路径的 observer 必须同步完成提交后才把相关原字节/事件交给 SDK/业务解析，保证业务成功不抢先。
  Job 因 C2a 已取消收尾后仍存活的 observer 用同一 guard，写失败仅记录固定脱敏类别和应用 attempt ID，
  不能再改 failed/done Run；reader 的 started/partial 明确不完整，不声称后续未提交 usage 已完整。
  如该 observer 可能在成功 Run 收尾后首次看到 usage，则接线设计不满足本契约，不能以日志兜底通过。
- 默认不重试本地写入、不新增全任务 deadline。后续若需写入重试须另证幂等与停止新 transport。

### 观测接线及未覆盖范围

已接线：runJob 内调用 callStructured 的 analyzer、validator、coverage、语言修复与 judge。
使用仅含 metadata 的 async context，避免给 agent/prompt 重写接口。Anthropic SDK 的自定义 fetch
观测真实 dispatch；SSE usage observer 必须保留原 body 字节、背压、取消、错误和 SDK retry 参数，
不得 clone/tee 后无界缓存，也不得把 SDK 隐藏请求伪计为可见 attempt。
Volcengine 在原 SSE parser 提取 usage 的事件处接同一观测接口；不改变 provider 参数、terminal/Zod/引用规则。

独立 followup HTTP、脱离 Job 的直接 LLM/eval/probe 调用、任意独立 new Anthropic/fetch 入口不自动持久化；
默认不打开 DB、不从 getDb 隐式取得全局库。provider 内部转发/计费、未进入本地 fetch 的服务端 retry 不可观测。
真实 SDK transport、runAnalysis、judgeWithRetry 与 coverage 的接线由合成集成测试核验；语言修复/judge 复用同一 callStructured 上下文，但本切片没有逐个端到端演练全部子路径。不宣称全系统持久化覆盖。
observer 若需 SSE framing buffer，必须有固定容量上限；超过上限仅记录观测不完整/受控故障，
不能无界保留模型正文或改变合法业务 framing。容量边界与超大合成 chunk 需反例证明。
C3 不启动新的 retention/删除任务；调用观测暂保留，容量与后续 retention 是明确运维风险，不借用 P1 删除 guard。

### Migration、reader 和回退

仅新增 v48 additive DDL：schema.ts 定义，runner 冻结初版 DDL/hash。旧 v1–v47 SQL/checksum 不改。
不放进启动 SCHEMA_SQL 偷迁移；通过现有 explicit runner 新建/升级，验证事务原子性和重复执行。
未迁移库的 reader 只读返回 unavailable；不能建表、补列或读取时修复。writer 需在请求前明确拒绝
未迁移库，不能静默禁用并宣称完整。合成测试迁移后再接线；getDb 的 ledger gate 保留。
reader 每页最多 1000 条，以 nextOffset 显式指示后续页；只读连接不迁移、不修复。分页查询按开始时间、logical call、attempt 序号排序；进行中的 Run 翻页不是数据库快照，审计完整集应在 Run 静止后读取。
现有测试使用未跑 provenance migration 的 openDb(:memory:) 需确认是否要在受影响 fixture 显式迁移，
不能为了兼容测试把生产 writer 的 missing-schema 失败改成静默丢弃。

代码回退保留新增表和历史已提交事实；不授权 drop 表/降级 ledger。新版本显式迁移前旧 writer 须按原
运维 pause/drain 流程交接，此任务不实际执行生产迁移。历史旧 Run/P1 不回填。

## 反例与验收矩阵

| 反例 | 必须证明的结果 |
| --- | --- |
| SDK 500 后内部 retry；runtime transient/refusal retry | 每次实际 fetch 独立 attempt，同 logical call 归属准确，失败无 usage 为 unknown，成功 usage 只一次 |
| 相同 attempt 相同/冲突报告；多个 Job 并发 | replay 幂等；冲突拒绝且原记录不变；不能跨 Run 或 call 串计 |
| usage 事件后 SSE 卡住/invalid schema/任务失败 | usage 已提交，无需等 EOF、Zod 或 Run 收尾 |
| 显式取消后 provider 忽略取消迟到 usage | 有租约时可记录观测，迟到业务结果不接受；无后续调用 |
| 真实 lease 接管后迟到 usage | SQL guard 拒写，旧 started/partial 可读；旧 Run/trace/report 不落库 |
| 暂停在写入完成后终止子进程并重开 DB | reported 持久；重复提交幂等；未完成请求保持 unknown/partial，不恢复未知账单 |
| provider missing usage、缺失字段、明确 0、partial usage | null/partial 和真零不同；不伪造完整 usage 或 $0 |
| 未知模型价目及 Coding Plan | 金额 NULL/unknown，来源状态可追溯；Run fallback 与原预算行为一致 |
| 新库、真实 v47 升级、重复迁移、中途失败 | v1–v47 checksum 不变；新增 DDL/ledger 同事务；无历史用量回填 |
| readonly 当前/旧版本 DB reader | 无 schema/ledger/user_version/文件写入；writer 拒绝只读或未迁移库 |
| Run + P1 ledger + attempt 同一次请求 | 原预算及 P1 汇总不重复累计；精确 token 不借 legacy 合并字段推断 |
| 写入前/usage 后 SQLITE_BUSY/只读/冲突；SDK 自定义 fetch 错误包装 | 零请求或仅已完成请求；sticky failure 在内部/外层 retry 逐 dispatch 拒绝真实新请求，最终固定故障与不完整状态 |
| 多 message_delta、重复/乱序 partial、缺失原始 usage 字段 | 累计快照不相加；同观测 replay/冲突与 stale 明确；业务 normalizer 归零不能伪造 reported |
| Job 已取消收尾后迟到 observer 写失败 | 无未处理 rejection，不再改 Run；固定日志和原 unknown/partial reader，不宣称完整 |
| 正常 SDK/fetch 请求、取消、drain | 请求参数/输出/重试次数不变；C2a guard 与现有 drain 回归通过 |

默认合成数据与 mock fetch/SDK，不调用付费模型。实现前固化上述生产路径测试，再按风险运行
定向单元/集成、完整 coverage/ops、TS7+TS6 typecheck、lint、必要 build/迁移集成；保留 CI/Eval 门。
Eval-Gate 不能预先盖 skip；最终证明模型/provider/thinking/prompt/引用及合法请求语义不变后才决定，
持久化正确性由真实路径回归证明，不用无关 A1 充证。

独立 reviewer 先审候选设计、再审最终 diff 与反例并复查修正。专属收据记录 HEAD/测试/CI/未覆盖入口。
最终 PR/CI 就绪停止；没有合并、部署、生产 DB/云访问、历史修复或分支清理授权。
