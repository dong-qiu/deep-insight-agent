# Spec: 溯源驾驶舱与完整性能力（P1a）

> 状态：🟡 Draft，须经人工设计评审后才能拆分 P1 实现任务。
> 依赖：[生成溯源与全链路可观测性](generation-provenance.md) P0a–P0c 已启用。

## 1. 目的与边界

为管理员提供跨 trace 的漏斗、成本、时延和 validator 失败归因；为已发布报告及其文件提供可验证、可告警的完整性证据。它扩展 P0 的单 trace 管理查询，**不**替代业务事实表、发布白名单或 P0 的 effect/reconciliation 协议。

本期不保存完整 prompt、模型原始响应或原文副本到指标索引；不自动修复数据、不重写历史报告、不构建跨租户共享查询，也不让驾驶舱或校验任务进入已发布报告的读取关键路径。

当前产品是单部署的 `admin` / `viewer` 模型。为使契约可迁移，所有新增事实表均有不可空 `tenant_id`，当前固定为服务端写入的 `default`；客户端不得提交该字段。真正多租户之前，所有查询仍必须由服务端注入该等值谓词，不能以“当前只有一个 tenant”为由省略。

## 2. 漏斗、成本、时延与 validator 指标

### 2.1 事件与状态机

驾驶舱仅消费追加写入的 `generation_event` 和 P1a 事实表；不得从现态 `Run` 或 `Report` 倒推历史。每个事件至少包含：`tenant_id`、`trace_id`、`run_id?`、`report_id?`、`event_id`、`stage`、`attempt`、`producer_version`、`schema_version`、`occurred_at`、`ingested_at`。`event_id` 为全局 UUID；重复 event_id 必须返回原结果。相同 `(trace_id, stage, attempt, event_type)` 的不同 `semantic_payload_hash` 必须拒绝写入并产生 `event_conflict` 告警，不能静默覆盖。

状态机版本 `funnel-v1`：

```text
received → accepted → processed → validated → published
               ├── failed | cancelled | timed_out
               └── rejected
```

- 每个阶段都记录进入与终止事件；`failed`、`cancelled`、`timed_out`、`rejected` 是终态，之后只能开始一个更高 `attempt`。
- 合法正向跳转可跳过业务上不适用的阶段，但事件必须带 `skip_reason_code`；逆向跳转、同 attempt 的两个不同终态均为冲突。
- 漏斗默认按 `trace_id` 的最高成功阶段计数；同一 trace 在一阶段最多计一次。尝试视图按 `(trace_id, stage, attempt)` 计数，不能与默认漏斗混用。
- `occurred_at` 是业务 event-time，`ingested_at` 是到库时间。每日汇总在次日 UTC 02:00 冻结；其后 7 个自然日内迟到事件触发对应日期的幂等重算并标记 `revised_at`。超过窗口的事件进入 `late_event` 隔离表并告警，须由管理员显式回填；不允许悄然改变已发布周/月报。

### 2.2 指标口径

| 指标 | 精确定义 | 维度 |
| --- | --- | --- |
| 漏斗 | 时间窗内有 `received` 的去重 trace 数为分母；阶段转化率为到达该阶段的去重 trace / 分母；流失按第一个终态失败原因归因 | tenant、UTC 日/小时、topic/source、pipeline/version、stage |
| 成本 | `cost_ledger.amount_minor` 之和；每笔必须有币种、provider/model、usage、发生时间和归属 trace/stage。无法定价写 `amount_minor=NULL, cost_status=unknown`，单列展示，绝不按 0 计 | tenant、provider/model、pipeline/version、stage、UTC 日 |
| 时延 | 同一 trace/attempt 相邻阶段 `entered_at` 的差值；只统计已终态样本，另报进行中数。展示 P50/P95/P99、样本数和负/缺失时钟数 | tenant、pipeline/version、stage、UTC 日 |
| validator 原因 | 每条终态校验结果的标准化 `reason_code`、`severity`、validator/rule version、去重 trace 数与总次数 | tenant、validator、reason_code、rule_version、UTC 日 |

`reason_code` 初始受控字典为 `source_not_found`、`source_unreachable`、`quote_not_in_source`、`out_of_context`、`exaggeration`、`misattribution`、`uncertain`、`not_evaluated`、`event_conflict`、`authorization_denied`、`internal_error`。新增 code 必须随 schema version、文档和 Eval fixture 一起评审。

## 3. 存储、索引与保留

新增 `funnel_event`、`cost_ledger`、`validator_result_fact`、`artifact_manifest`、`integrity_check` 五类写模型，以及小时/日级物化汇总。明细表只保存结构化元数据、长度、计数、稳定 reason code 与 hash；错误文本须经 P0 脱敏器处理。

所有明细索引以 `(tenant_id, …)` 开头，至少有：

- `funnel_event(tenant_id, occurred_at DESC)`、`(tenant_id, trace_id, stage, attempt)`、`(tenant_id, report_id)`、`(tenant_id, pipeline_version, occurred_at)`；
- `cost_ledger(tenant_id, occurred_at, provider, model)`；
- `validator_result_fact(tenant_id, validator, reason_code, occurred_at)`；
- `artifact_manifest(tenant_id, artifact_id, artifact_version)` 唯一；
- `integrity_check(tenant_id, artifact_id, artifact_version, checked_at DESC)`。

API 明细查询最大 UTC 时间窗 31 天、每页最多 100 条；聚合查询最大 400 天。每一条驾驶舱 query 必须用 `EXPLAIN QUERY PLAN` 在版本化容量 fixture 上证明命中索引，禁止扫描 JSON 或无界递归。

保留期是本 spec 的准入常量：原始明细 90 天在线、每日汇总 400 天、`generation_trace_request` 100 天；已发布报告及其对应 manifest 在报告可读/归档期内保留，删除后只保留 P0 redaction tombstone。每日外部完整性锚与 redaction registry 一样使用 Object Lock Compliance，至少 100 天。法律保全优先于生命周期清理；到期任务只可在保全不存在、备份/registry 义务满足且审计记录成功写入后执行。

## 4. 完整性信任锚与原子发布

每一个已发布的 `.md`、`.html` 与后续受支持 artifact 都有不可变 `(artifact_id, artifact_version)` manifest。内容 hash 是**原始、未解压的字节流**的 SHA-256 小写十六进制；大对象流式分块计算，但 hash 语义与一次读取完全相同。不得对 JSON、文本编码或压缩结果进行隐式规范化。

manifest 本体使用 P0 定义的 UTF-8 canonical JSON，含 artifact/version、length、media type、created_at、上游 trace/revision、`content_hash_algorithm`、`content_hash`、父级或报告级 root、`manifest_schema_version`。其 `manifest_hash` 为该 canonical JSON（排除签名字段）的 SHA-256。每日锚把按 `(tenant_id, report_id, artifact_id, version, manifest_hash)` 排序的叶子做 Merkle root；根与清单一起以 `If-None-Match: *` 写入独立 Object-Lock Compliance bucket。

`manifest_hash` 与每日 root 必须由 KMS/HSM 中的 Ed25519 发布密钥签名；记录 `key_id`、算法、签名、签发时间和撤销状态。运行时只持有签名权限，校验服务只持有公钥/验证权限，二者均没有 Object-Lock 删除、覆盖或保留期绕过权限。密钥轮换新建 key version，旧公钥保留至其所有 anchor 到期；撤销后新发布失败，历史校验仍以记录的公钥验证并标出 `key_revoked`。

发布沿用 P0 `generation_effect`：先写 staging artifact 与待签名 manifest，流式校验所有 content hash，再原子 rename、条件写外部 anchor，最后在**同一 SQLite 事务**将 effect `committed`、报告 `done`、发布索引/FTS 与 `published` 事件置为可见。任一步失败则 report 不进入 reader resolver，reconciliation 只可重试相同 artifact/version 或置 `failed`，绝不可修补已发布版本。

## 5. 授权、审计与读取隔离

| 动作 | viewer | admin | 受控 integrity worker |
| --- | --- | --- | --- |
| 读已发布报告与 `pass` 证据 | 允许 | 允许 | 不适用 |
| 读驾驶舱聚合/明细、成本、失败原因、manifest | 拒绝 | 允许 | 仅执行所需的最小读取 |
| 触发/查看重校验、下载 artifact URI、查看诊断 | 拒绝 | 允许并审计 | 允许执行，不提供用户会话 API |
| 签名/写锚、删除或绕过 Object Lock | 拒绝 | 拒绝 | 签名仅发布身份；对象删除全部拒绝 |

每个 handler 在加载 artifact、trace 或聚合前都做认证、角色和服务端 `tenant_id` 谓词；无权限、跨 tenant 或不存在均返回相同 404，不泄露 artifact 存在性。`authorization_denied` 只写入受限审计/指标，不对调用者输出资源标识。审计事件至少含 actor/service identity、tenant、action、目标类型、允许/拒绝、request/trace ID、时间、reason code；不包含正文、凭据或 artifact URI。

已发布报告读取只经 `published_report` resolver，并且只依赖已提交 report/artifact snapshot。驾驶舱使用独立读模型；校验走队列 worker，最大并发 2、单任务 60 秒、每 artifact 每 24 小时最多一次自动校验。驾驶舱或 worker 的超时、积压、失败都只能降级诊断功能，不能调用 hash 重算、聚合或外部锚服务来阻塞报告读取。

## 6. 校验、告警与处置

重校验按指定且已授权的 artifact version：读取原始字节 → 重算 content hash → 验 manifest hash/签名 → 验 daily Merkle root/外部 anchor → 追加 `integrity_check`。终态为 `pass`、`content_mismatch`、`manifest_mismatch`、`anchor_mismatch`、`missing_artifact`、`unreadable`、`unsupported_algorithm`、`authorization_denied`。失败记录只显示 artifact/version、期望与实际 hash 的前 12 位、失败步骤、checker 版本与时间。

以下规则写为首版告警阈值：任一完整性失败或 manifest 缺失为 critical（5 分钟内通知）；7 天同 reason_code ≥5 次为 high；未知成本占当日 trace ≥1% 为 warning；任一漏斗转化率较最近 28 日同星期基线下降 30% 且样本 ≥20 为 warning；阶段 P95 超基线 50% 且样本 ≥20 为 warning。相同 `(tenant, rule, range, artifact?)` 30 分钟内去重。critical 完整性失败阻止该 artifact 的**新**发布；对已发布报告仅附管理员状态/告警，绝不回写正文、自动下线或影响 reader。

## 7. Eval-Gate 与验收

P1a 的 gate 是确定性、版本化的 `provenance-dashboard-integrity-v1` fixture；每次变更 schema、状态机、聚合、manifest、授权或告警规则都必须运行。fixture 和结果记录 schema/rule/checker/hash-key version、UTC 时钟、数据集 SHA-256、预期输出与允许误差；执行环境与 P0c 容量 fixture 同时记录。它不替代修改 prompt/model/source 时既有 `eval-gate` 的 A1 门。

通过条件：

1. 重放/重复/乱序/迟到事件后，漏斗、成本、P50/P95/P99 与 reason-code 汇总精确匹配 fixture；超过 7 天回填窗的事件不改变冻结汇总。
2. 100% 拒绝跨角色/跨 tenant 的聚合、明细、URI 与重校验访问，且响应无法区分不存在与无权；负向测试证明正文/prompt 不会进入索引、告警或审计。
3. 对正常、篡改 artifact、篡改 manifest、替换二者、缺件、错误签名/撤销 key、并发发布半途失败，100% 得到指定终态；“同时替换 artifact + manifest”必须被外部已签名 anchor 检出。
4. report reader 在聚合库不可用、队列积压、checker/anchor 超时和告警失败时仍只读取已提交快照；端到端读取 P95 不劣于 P0c 基线超过 5%。
5. 关键 dashboard 查询在容量 fixture 上命中规定索引；31 天明细与 400 天聚合均在 P0c 记录硬件上 P95 ≤2 秒；告警去重和阈值边界逐项通过。

人工评审须确认：本 spec 与 `generation-provenance.md` 的术语/权限/发布原子性一致、保留常量符合业务及法务要求、KMS/HSM 与 Object-Lock 权限边界可由运维落地、以及上述 gate 产物可复现。评审签核前不得创建或启动 P1 实现子任务。
