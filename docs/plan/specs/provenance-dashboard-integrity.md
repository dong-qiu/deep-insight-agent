# Spec: 溯源驾驶舱与完整性能力（P1a）

> 状态：🟢 设计已签核；生产前置待确认。
> 设计签核记录：2026-08-22；签核人：项目负责人 dongqiu；[签核证据](https://github.com/dong-qiu/deep-insight-agent/pull/265#issuecomment-5381671917)。规格 PR [#264](https://github.com/dong-qiu/deep-insight-agent/pull/264) 已合入，INSI-12 已完成，独立评审记录为 INSI-24。
> 实现准入：在 INSI-27「P1-0a：实现准入与本地安全核对」完成前，不得启动 P1 实现任务。
> 生产准入：在 INSI-25「P1-0b：生产治理与发布前置确认」完成前，不得将 P1 能力部署、启用或宣称为生产就绪。
> 依赖：[生成溯源与全链路可观测性](generation-provenance.md) P0a–P0c 已启用。

## 签核、实施与生产准入

本规格的设计取舍已经完成签核；这不等同于生产就绪。实施与生产使用两道不同的门，不能互相替代：

- **INSI-27 实现准入门**只允许在隔离开发环境中开始 P1 代码。它确认所有实现使用 task-local SQLite 与合成/许可 fixture、不得访问生产数据或凭据、不得部署或启用 P1 能力，并继续受 feature branch、PR、CI、引用白名单和本规格的数据最小化约束。此门完成后，只有 INSI-15 可以从 `blocked` 解除；它不是 Object Lock、KMS、IAM、值班或恢复演练已经完成的证明。
- **INSI-25 生产准入门**必须形成可审计证据，确认数据与法务保留规则、Object-Lock/KMS/IAM 最小权限、告警值班、P0c 性能基线、SQLite 迁移/备份及 orphan-anchor 恢复演练。它是任何 P1 部署、功能启用、生产验收或“生产就绪”声明的阻断门；在 INSI-18 和 INSI-21 前必须完成。

测试替身、mock anchor 或本地演练只能证明代码行为，不能被记作生产配置或生产恢复证据。任何实现若需要读取生产凭据、写入生产 bucket、变更生产 IAM 或部署，仍必须先完成 INSI-25。

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

保留期是本 spec 的准入常量：原始明细 90 天在线、每日汇总 400 天、`generation_trace_request` 100 天；已发布报告及其对应 manifest 在报告可读/归档期内保留，删除后只保留 P0 redaction tombstone。

每个 manifest/version 的**验证材料集合**为：不可变 anchor 的 canonical payload/签名/完整 object key 与 provider version（如有）、`manifest_hash` 与 manifest 签名、对应 content hash、签名 `key_id` 的公钥/证书/撤销历史、canonicalization 版本，以及 `integrity_check` 审计记录。集合的 `retain_until` 必须为 `max(报告可读期结束, 报告归档期结束, 该 artifact 的保留期结束, anchor 创建后 100 天)`；anchor 和每日 Merkle 汇总锚使用 Object Lock Compliance 至该时刻，验证材料的其余部分不得先于该时刻清理。法律保全优先于所有到期时间，并延长整套集合直到 hold 解除。

报告删除请求的行为固定如下：有 legal hold 时拒绝物理删除并写 `deletion_blocked_legal_hold` 审计；无 hold 但仍在可读/归档期时仅可按授权将报告从 reader 下线为 `delete_pending`，不得删除 artifact、manifest、anchor 或验证材料；全部报告/归档保留期结束后才可销毁 artifact/manifest。销毁前必须追加含 locator、manifest/anchor payload hash、最后一次校验结果与销毁时间的签名 `retention_tombstone`；viewer 此后得到与不存在相同的 404，admin 只能读脱敏 tombstone，结论为“内容保留期已结束，原始内容不再可验证”，不得再显示 `pass`。anchor 与其他验证材料仍保留至其计算出的 `retain_until`，之后只保留 P0 redaction tombstone。到期任务只可在无 hold、备份/registry 义务满足、tombstone 和审计记录成功写入后执行。

在报告仍可读/归档期间，anchor、历史公钥或任何验证材料不可用时，校验记录为 `verification_material_unavailable`，5 分钟内触发 critical 告警；reader 继续只读取已提交快照，viewer 的证据状态显示“暂不可验证”而不暴露对象键或存储细节，admin 可见受控诊断和恢复进度。恢复只能重新取得同一不可变 object version、原始 canonical bytes 和记录的公钥材料；不能恢复即持续告警并禁止为该 artifact 新发布版本，绝不能以新锚或新 key 把历史版本重新标为 `pass`。

## 4. 完整性信任锚与原子发布

每一个已发布的 `.md`、`.html` 与后续受支持 artifact 都有不可变 `(artifact_id, artifact_version)` manifest。内容 hash 是**原始、未解压的字节流**的 SHA-256 小写十六进制；大对象流式分块计算，但 hash 语义与一次读取完全相同。不得对 JSON、文本编码或压缩结果进行隐式规范化。

manifest 本体使用 P0 定义的 UTF-8 canonical JSON，含 artifact/version、length、media type、created_at、上游 trace/revision、`content_hash_algorithm`、`content_hash`、父级或报告级 root、`manifest_schema_version`，以及下述固定的 `external_anchor` locator。其 `manifest_hash` 为该 canonical JSON（排除签名字段）的 SHA-256。

### 4.1 每个 manifest/version 的外部锚

方案 1 是本 spec 的唯一发布信任边界：**每一个** `(tenant_id, report_id, artifact_id, artifact_version, manifest_hash)` 都必须有一个独立、签名、不可变的外部锚；每日 Merkle root 只做事后汇总，绝不作为发布成功或单个已发布版本校验的前提。

在计算 `manifest_hash` 前，publisher 必须在 manifest 的 `external_anchor` 中写入以下固定 locator；manifest 中**没有** `binding`、`binding_kind`、anchor payload hash 或 anchor signature 字段：

```text
anchor_schema_version = anchor-v1
object_key = integrity-anchors/v1/{tenant_id}/{report_id}/{artifact_id}/{artifact_version}/anchor-v1.json
```

`artifact_version` 是发布版本的不可变逻辑版本；`anchor-v1` 和完整 object key 是锚对象的不可变逻辑版本与定位符。ID 中的每一段必须符合 P0 的不可变 ID grammar（不得含 `/`、NUL 或路径规范化片段），所以此模板给出唯一 key。`manifest-v1` 规范化为 RFC 8785 JCS 产出的 UTF-8 bytes；字符串必须是 Unicode scalar value（拒绝孤立 surrogate）、不得做 NFC/NFD 转换，hash 使用这些 bytes 的 SHA-256。

`manifest_hash` 的唯一 preimage 为 `M = JCS-UTF8(manifest_without_derived_fields)`：它包含上述 `external_anchor` locator；排除 `manifest_hash`、`manifest_signature`、`anchor_provider_version_id`、`anchor_payload_hash` 与所有 anchor 签名。字段名使用 ASCII，数值按 JCS 表示；schema 禁止未声明字段。`manifest_hash = SHA-256(M)`。因此 manifest 身份与 anchor locator 先被固定，再产生 digest；任何 `binding` 字节都不属于 `M`。

完成 manifest hash 后才构造 `binding`。它是 anchor payload 的必填对象，严格等于下列 schema（不得遗漏或增加字段，所有值均为字符串）：

```json
{
  "binding_schema_version": "binding-v1",
  "binding_kind": "manifest-v1-sha256",
  "tenant_id": "<manifest.tenant_id>",
  "report_id": "<manifest.report_id>",
  "artifact_id": "<manifest.artifact_id>",
  "artifact_version": "<manifest.artifact_version>",
  "manifest_schema_version": "<manifest.manifest_schema_version>",
  "manifest_canonicalization": "rfc8785-jcs-utf8",
  "manifest_hash_algorithm": "sha-256",
  "manifest_hash": "<lowercase SHA-256(M)>"
}
```

尖括号值只能逐字复制自已验证的 manifest 或由 `M` 计算；不得接受第二套调用方传入的 identity/hash。`binding` 本身不单独 hash、签名或携带 `object_key`、`anchor_payload_hash`、provider version、签名或 “latest” 指针：它的字节边界就是下述 anchor payload preimage 中的一个 JCS member。anchor 的 `object_key` 必须与 manifest 的 `external_anchor.object_key` 字节相等，且由 verifier 单独比较；这样 locator 被 `M` 承诺、又被 anchor payload 承诺，但没有把尚未生成的 anchor 或 binding 反写到 manifest。

写锚幂等键为 `SHA-256("anchor-v1\\0{tenant_id}\\0{report_id}\\0{artifact_id}\\0{artifact_version}\\0{manifest_hash}")`；它记录在 `generation_effect`，而非 manifest。anchor payload preimage 的唯一边界为 `A = JCS-UTF8({anchor_schema_version, object_key, content_hash_algorithm, content_hash, issued_at, binding})`，其中 `binding` 为上述完整对象，且 `issued_at` 是 publisher 写入的 UTC RFC 3339 instant。`anchor_payload_hash = SHA-256(A)`；不可变对象存储的 envelope 是 `{payload: A-as-JSON, anchor_payload_hash, signature}`，其中后两项都**不**属于 `A`，Ed25519 签名覆盖 domain-separated bytes `"anchor-v1\\0" || A`。这建立了单向顺序 `manifest locator → M → binding → A → anchor hash/signature`，故 manifest 与 binding 不可能循环依赖。支持 provider object version 时，条件写成功返回的 `provider_version_id` 也必须保存到 `artifact_manifest.anchor_provider_version_id`；不支持时该字段为 `NULL`，校验以不可覆盖的完整 key、Object-Lock retention 和锚 payload hash 定位唯一对象。任何版本字段都不得以可变的 “latest” 指针表示。

`manifest_hash` 与每日 root 的签名同样覆盖各自 domain-separated canonical preimage；所有签名记录 `key_id`、算法、签名、签发时间和撤销状态。校验器必须依次重建 `M`、比较 `binding` 的十个字段、比较 locator、重建 `A`、比较 `anchor_payload_hash` 并验签；任一不等即为 `manifest_mismatch` 或 `anchor_mismatch`。运行时只持有签名权限，校验服务只持有公钥/验证权限，二者均没有 Object-Lock 删除、覆盖或保留期绕过权限。密钥轮换新建 key version，旧公钥保留至其所有 anchor 到期；撤销后新发布失败，历史校验仍以记录的公钥验证并标出 `key_revoked`。

#### 4.1.1 固定测试向量与可复现验证

`provenance-dashboard-integrity-v1` 必须把以下 ASCII-only JCS bytes 作为固定测试向量（无 BOM、无尾随换行）。对原始 artifact bytes `abc`，`content_hash` 是 `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`。下列 `M` 的 SHA-256 必须为 `85b88d5667e4e5e36dc461ff25b6f2b225354623774baddd9b3fddb6dae04907`：

```json
{"artifact_id":"artifact-0001","artifact_version":"v1","content_hash":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","content_hash_algorithm":"sha-256","created_at":"2026-08-21T00:00:00Z","external_anchor":{"anchor_schema_version":"anchor-v1","object_key":"integrity-anchors/v1/default/report-0001/artifact-0001/v1/anchor-v1.json"},"length":3,"manifest_schema_version":"manifest-v1","media_type":"text/plain","report_id":"report-0001","tenant_id":"default","upstream_trace_id":"trace-0001"}
```

将该 hash 写入 `binding.manifest_hash` 并加入固定 `issued_at` 后，下列 `A` 的 SHA-256 必须为 `e9c15e12b101ae5d11b7f778e1ea27e6722569f813e324026d305260157a7bb0`：

```json
{"anchor_schema_version":"anchor-v1","binding":{"artifact_id":"artifact-0001","artifact_version":"v1","binding_kind":"manifest-v1-sha256","binding_schema_version":"binding-v1","manifest_canonicalization":"rfc8785-jcs-utf8","manifest_hash":"85b88d5667e4e5e36dc461ff25b6f2b225354623774baddd9b3fddb6dae04907","manifest_hash_algorithm":"sha-256","manifest_schema_version":"manifest-v1","report_id":"report-0001","tenant_id":"default"},"content_hash":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","content_hash_algorithm":"sha-256","issued_at":"2026-08-21T00:00:01Z","object_key":"integrity-anchors/v1/default/report-0001/artifact-0001/v1/anchor-v1.json"}
```

可复现验证不依赖实现代码：将以上两个代码块各保存为无换行的 UTF-8 文件 `M.json`、`A.json`，执行 `shasum -a 256 M.json A.json`，输出必须依次为上述 `M`、`A` digest；随后以记录的 `key_id` 验证对 `"anchor-v1\\0" || A.json` 的 Ed25519 签名。负例只把 `A.json` 的 `binding.manifest_hash` 改为 64 个 `0`，重算 `A` 后必须仍能证明原签名/原 `anchor_payload_hash` 不匹配，并产生 `anchor_mismatch`。该过程既是可复现验证步骤，也是跨语言 canonicalization 的 gate fixture。

写锚只能使用该 object key 的 `If-None-Match: *`。网络失败或未知结果必须以相同 idempotency key 重试：若对象已存在，publisher 仅可读取并验证其 canonical bytes、payload hash、签名和所有绑定字段都与当前候选完全相同，才把它视为成功；任何不一致均为 `anchor_conflict` critical，禁止发布且不得覆盖对象。不得为同一 manifest/version 生成第二个 key 或“修正”已有锚。

### 4.2 发布、补偿与对账

发布沿用 P0 `generation_effect`：先写 staging artifact 与带固定 locator 的待签名 manifest，流式校验所有 content hash，再原子 rename、条件写该 manifest 自身 anchor，最后在**同一 SQLite 事务**将 effect `committed`、报告 `done`、发布索引/FTS、`published` 事件，以及 manifest 的 anchor key/provider version/payload hash/签名置为可见。只有这一 SQLite 提交点后，reader resolver 才可看到报告；外部锚已存在本身不构成发布。

外部锚写成功而 SQLite 发布事务失败时，report 仍不可读。reconciliation 必须以 effect 的 artifact/version、manifest hash 和锚 idempotency key 扫描，记录 `anchor_written_sqlite_uncommitted` 指标与 critical 告警（含 effect ID、locator、重试次数和年龄，但不含内容或 URI 凭据）。它只可：(a) 再次验证同一不可变 anchor 后重试原 SQLite 事务；或 (b) 在发现 artifact/manifest/effect 的不可恢复冲突时将 effect 标为 `unknown`/`failed` 并保留不可删除的 orphan-anchor 审计记录。不得新建 anchor、覆盖已存在对象、暴露报告，或把另一版本接到该锚。恢复后写 `anchor_reconciled` 审计事件并关闭同一告警；超过 15 分钟未收敛升级为 high。所有路径必须可由 effect ID 与 idempotency key 定位。

### 4.3 每日 Merkle 汇总（补充证据）

每日 UTC 02:00 后，汇总 job 为前一 UTC 日内已完成 SQLite 提交的 per-manifest anchors，按 `(tenant_id, report_id, artifact_id, artifact_version, manifest_hash)` 排序生成一个 root。其 immutable key 为 `integrity-daily-roots/v1/{tenant_id}/{YYYY-MM-DD}/root.json`，同样条件写、签名并记录 leaf-count、cutoff、排序规则和 root。该 root 不覆盖也不延迟任何单个 anchor 的发布/校验保证。

若 UTC 02:15 未见前一日 root，写 `daily_anchor_missing` high 告警，并在管理员诊断视图展示 `daily_summary=missing`；已发布报告读取与其自身 anchor 的 `pass` 证据照常可用，reader 不会同步检查此汇总。恢复 worker 只能按已冻结 cutoff 使用相同排序重建相同 root 并条件写入；已有对象时必须逐字段验证相同 root/leaf-count/signature 后才算幂等恢复。不一致写 `daily_anchor_conflict` critical，保留诊断并人工处置。恢复成功写审计事件、将状态展示为 `recovered` 并关闭缺失告警；在 cutoff 后才完成发布的 anchor 明确不补写既有 daily root，其自身 anchor 仍是完整信任证明。

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

重校验按指定且已授权的 artifact version：读取原始字节 → 重算 content hash → 验 manifest hash/签名 → 以 manifest 的固定 locator 读取并验证**该版本自身** external anchor（key、provider version 如有、payload hash、签名与 `binding.manifest_hash`）→ 追加 `integrity_check`。每日 Merkle root 只在存在时作为补充交叉检查，缺失不能把单版本校验降级为失败。终态为 `pass`、`content_mismatch`、`manifest_mismatch`、`anchor_mismatch`、`verification_material_unavailable`、`missing_artifact`、`unreadable`、`unsupported_algorithm`、`authorization_denied`。失败记录只显示 artifact/version、期望与实际 hash 的前 12 位、失败步骤、checker 版本与时间。

以下规则写为首版告警阈值：任一完整性失败或 manifest 缺失为 critical（5 分钟内通知）；7 天同 reason_code ≥5 次为 high；未知成本占当日 trace ≥1% 为 warning；任一漏斗转化率较最近 28 日同星期基线下降 30% 且样本 ≥20 为 warning；阶段 P95 超基线 50% 且样本 ≥20 为 warning。相同 `(tenant, rule, range, artifact?)` 30 分钟内去重。critical 完整性失败阻止该 artifact 的**新**发布；对已发布报告仅附管理员状态/告警，绝不回写正文、自动下线或影响 reader。

## 7. Eval-Gate 与验收

P1a 的 gate 是确定性、版本化的 `provenance-dashboard-integrity-v1` fixture；每次变更 schema、状态机、聚合、manifest、授权或告警规则都必须运行。fixture 和结果记录 schema/rule/checker/hash-key version、UTC 时钟、数据集 SHA-256、预期输出与允许误差；执行环境与 P0c 容量 fixture 同时记录。它不替代修改 prompt/model/source 时既有 `eval-gate` 的 A1 门。

通过条件：

1. 重放/重复/乱序/迟到事件后，漏斗、成本、P50/P95/P99 与 reason-code 汇总精确匹配 fixture；超过 7 天回填窗的事件不改变冻结汇总。
2. 100% 拒绝跨角色/跨 tenant 的聚合、明细、URI 与重校验访问，且响应无法区分不存在与无权；负向测试证明正文/prompt 不会进入索引、告警或审计。
3. 对正常、篡改 artifact、篡改 manifest、替换二者、缺件、错误签名/撤销 key、并发发布半途失败，100% 得到指定终态；“同时替换 artifact + manifest”必须被该版本自身外部已签名 anchor 检出。fixture 还须覆盖 anchor 条件写的重放/冲突、anchor 写成但 SQLite 提交失败后的精确重试/孤儿告警，以及 daily root 缺失、幂等恢复和不影响 reader 的展示。
4. 对报告可读/归档期长于 100 天的 fixture，生命周期任务在 `retain_until` 前删除 anchor、历史公钥或其他验证材料必须失败并留下审计；legal hold 期间删除同样失败。归档期结束后的销毁必须生成可验签 `retention_tombstone`，viewer 返回 404，admin 只得到“内容保留期已结束，原始内容不再可验证”的脱敏结论；验证材料不可用时必须产生 `verification_material_unavailable` 与 critical 告警而不阻断 reader。
5. 固定测试向量的 manifest 与 anchor JCS UTF-8 bytes、SHA-256 值和 Ed25519 signatures 必须精确匹配；对 identity、locator、`binding_kind` 或 `binding.manifest_hash` 的任一单点篡改必须失败。该向量证明 digest 仅在 anchor binding 出现、不会参与自身 manifest preimage。
6. report reader 在聚合库不可用、队列积压、checker/anchor 超时和告警失败时仍只读取已提交快照；端到端读取 P95 不劣于 P0c 基线超过 5%。
7. 关键 dashboard 查询在容量 fixture 上命中规定索引；31 天明细与 400 天聚合均在 P0c 记录硬件上 P95 ≤2 秒；告警去重和阈值边界逐项通过。

人工评审须确认：本 spec 与 `generation-provenance.md` 的术语/权限/发布原子性一致、保留常量符合业务及法务要求、KMS/HSM 与 Object-Lock 权限边界可由运维落地、以及上述 gate 产物可复现。INSI-27 实现准入签核前不得启动 P1 实现子任务；INSI-25 生产准入签核前不得部署、启用或完成 P1 的生产验收。
