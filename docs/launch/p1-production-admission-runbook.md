# P1 生产准入：审计、legal hold 与值班运行手册（INSI-25）

> 状态：准入运行手册；**不是** P1 启用批准，也不授权创建或修改 AWS 资源。
>
> 适用范围：`docs/plan/specs/provenance-dashboard-integrity.md` 所定义的 P1a/P1c 发布完整性能力。完成本手册的记录并经独立只读审查签认前，不得部署、启用或宣称 P1 已生产就绪。

## 0. 不可绕过的边界

- 本手册只在已收到两项明确、可追溯的授权后执行：CloudTrail/相关云资源变更授权，以及备负责人准确的 AWS IAM Identity Center（SSO）principal 标识。不要猜测或从昵称推断 `dolphinqd` 的 AWS 身份。
- 不创建 IAM user、access key、CloudTrail、bucket、KMS key、role 或任何生产资源；本文件中的操作步骤是给获授权的云安全执行者的核对清单。
- `INTEGRITY_ANCHOR_ENABLED` 在 INSI-25 完成且有不可变证据前必须保持 `false`。不得以主机环境变量、容器重启或“临时测试”绕过该限制。
- 记录、告警、工单、PR、截图及本仓库不得写入报告正文、完整 object URI/ARN、账号全号、身份会话、cookie、密钥、私钥、access key、加密上下文或 CloudTrail 原始事件。用受控证据编号、短 hash、脱敏 resource label 和受限证据库引用替代。

## 1. 已批准治理事实与责任

| 事项 | 已批准事实 / 责任 |
| --- | --- |
| 报告可读期 | 自发布时刻起 2 年。 |
| 报告归档期 | 自发布时刻起 7 年。 |
| legal hold | 仅项目负责人可创建或解除；绝不自动解除；每 90 天复核；创建、持续和解除均保留完整审计。 |
| 云安全与 P1 值班主负责人 | `dongqiu`。 |
| 备负责人 | `dolphinqd`；仅在准确 SSO principal 获授权并完成最小权限接入后生效。 |
| critical 告警 | 5 分钟内通知主负责人和已接入的备负责人；15 分钟未确认时升级至 `dongqiu`。 |

项目负责人是 legal hold 的唯一业务授权者；云安全执行者可以在已批准请求下执行底层受控操作，但不能自行判定、创建或解除 hold。备负责人不能取代此授权边界。

## 2. 准入输入、停止条件与证据记录

每次执行均从 `docs/verify/p1-production-admission-evidence-template.md` 复制一份新记录。先分配不可重用的记录编号（例如 `INSI-25-ADMISSION-YYYY-MM-DD-NN`）和证据编号；证据内容保存于受限、不可变的审计存储，文档中仅记录编号、采集时间、采集者和 SHA-256。

开始前必须同时具备：

1. 项目负责人对本次准入范围与 CloudTrail/云变更的书面授权编号。
2. 已核验的 AWS account/Region 清单，以及 P1 anchor、验证材料、CloudTrail 日志和审计证据的**脱敏资源标签**。
3. `dolphinqd` 的准确 Identity Center principal ID、Identity Center instance 和获批 permission set；任一项未知即停止，不以邮箱、显示名或假定 IAM role 替代。
4. 已批准的告警渠道、事件去重策略和受限证据存储位置；这些是本手册的未决输入，不可由执行者临时选择。
5. P0c 性能基线、SQLite 迁移/备份状态和 orphan-anchor 恢复演练计划的可追溯证据。缺一项，P1 仍不可启用。

停止并记录 `needs_decision` 的情况包括：Object Lock 无法在 bucket 创建时启用、任何操作要求删除/覆盖/缩短保留期、KMS 或 IAM 最小权限无法证明、CloudTrail 不覆盖所列事件、日志可写但不可验证、告警未在时限内到达/确认，或 legal hold 责任边界与本手册不一致。

## 3. 保留期与 Object Lock 计算

对每个发布版本记录 `published_at`（UTC）以及下列绝对时刻：

| 字段 | 规则 |
| --- | --- |
| `report_readable_until` | `published_at + 2 years`。 |
| `report_archive_until` | `published_at + 7 years`。 |
| `artifact_retain_until` | 不早于 `report_archive_until`；若批准了更长 artifact 期限，记录其理由和批准。 |
| `verification_material_retain_until` | `max(report_readable_until, report_archive_until, artifact_retain_until, anchor_issued_at + 100 days)`。 |
| Object Lock Compliance retain-until | 不早于 `verification_material_retain_until`，覆盖 anchor、daily root、历史公钥/撤销材料及校验材料所需的不可变对象。 |

Object Lock 必须使用 Compliance mode；保留期只能在合法、获批的情况下延长，不能缩短或绕过。报告/归档期限到期也不自动解除 legal hold。active hold 优先于所有生命周期动作，且将该报告的 manifest、anchor、历史签名材料和 integrity check 快照保留至项目负责人解除 hold 后，才恢复既有受控清理流程。

## 4. CloudTrail 最小覆盖与不可变日志方案

### 4.1 覆盖要求

CloudTrail 配置必须是 multi-Region、记录 management read/write events，并包含 global service events；不得通过 event selector 排除 `kms.amazonaws.com`。S3 object-level data events 只可按下表列出的 P1 bucket/prefix 精确选择，避免无关业务内容扩散到安全日志。

| 范围 | 最小事件 / 核验点 | 准入证据 |
| --- | --- | --- |
| S3 Object Lock 与保留 | `PutObjectRetention`、`GetObjectRetention`、`PutBucketObjectLockConfiguration`、`GetObjectLockConfiguration`、`BypassGovernanceRetention` 的成功与拒绝尝试；同时记录对象写入、删除尝试和 lifecycle/bucket-policy 变更。 | selector 快照、事件样本编号、拒绝 bypass 证据。 |
| legal hold | `PutObjectLegalHold`、`GetObjectLegalHold` 的成功与拒绝尝试；每一 create/release 都须能关联至治理 hold ID。 | 双向审计记录及 CloudTrail event ID/hash。 |
| KMS | 不排除 KMS 事件；至少核验 key policy、grant、key disable/enable、rotation、deletion schedule/cancel，以及 `GenerateDataKey`/`Decrypt` 的可追溯性。 | key-policy 审阅 hash、最小权限结论、KMS CloudTrail 样本编号。 |
| IAM / STS / SSO 接入 | IAM policy/role/trust-policy、permission set/assignment、`AssumeRole` 与拒绝事件；global service events 必须被保存。 | principal/permission-set 的受限证据、policy simulator 或等效最小权限结果、CloudTrail 样本编号。 |
| CloudTrail 自身 | trail 创建/更新/停止/删除、event selector、日志验证、log bucket policy、KMS 和生命周期变更。 | trail 配置快照 hash、delivery/status/validation 结果。 |

AWS 将 IAM/STS 归为全局服务；multi-Region trail 加 global service events 避免该覆盖依赖单一区域。AWS KMS 的 CloudTrail 集成记录 key 管理和加密操作；因此“未排除 KMS”是可验证的准入条件，而不是只记录部分 KMS 操作。详见 [AWS CloudTrail global service events](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-concepts.html) 和 [AWS KMS CloudTrail logging](https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html)。

### 4.2 不可变日志存储与验证

1. 使用与 P1 业务 artifact 隔离的受限日志存储；日志写入者、审阅者和 P1 publisher 权限分离。
2. 日志与 digest 启用 CloudTrail log-file integrity validation；日志、digest、配置快照和验证结果以 Object Lock Compliance 保存至不早于 7 年的已批准期限。CloudTrail digest 可检测已交付日志或 digest 被修改/删除，但不替代 S3 Object Lock。
3. 对日志存储启用 SSE-KMS；key policy 仅允许 CloudTrail 写入所需的 `GenerateDataKey`/`DescribeKey`，受控审阅角色才有读取/解密权限。保留历史 key、key policy 版本和撤销历史，直至相关日志与证据到期。
4. 每次准入及每 90 天复核都执行一个受控时间窗的 log validation，并记录命令版本、起止 UTC、返回状态、摘要 hash 和执行身份标签；不要把输出中可能含 object location 的原文粘贴到记录。
5. 原始 CloudTrail 日志仅留在受限日志存储。告警与此仓库只写 event 类别、时间、受控证据编号、短 hash 和稳定 reason code。

CloudTrail 的 digest 链和 CLI validation 可检测日志/摘要被改动或删除；验证依赖原始交付位置和受限读取权限。参见 [CloudTrail log-file validation](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html) 与 [CLI validation prerequisites](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-cli.html)。

## 5. 最小权限与备负责人 SSO 接入

### 5.1 身份与权限审查

在资源创建/更新的明确授权生效后，云安全执行者按以下顺序收集只读证据并交由独立审查：

1. 确认 P1 publisher 仅有条件写 anchor、签名与所需 KMS encrypt/data-key 权限；它没有读取不必要报告内容、删除、覆盖、Object Lock bypass 或缩短 retention 的权限。
2. 确认 integrity checker 只读 artifact/anchor/公钥材料，不能签名、写入、删除或绕过 Object Lock。
3. 确认恢复 runner 是独立、临时、受控身份；不能由应用角色自行 assume，且恢复不会新建/覆盖 anchor。
4. 确认日志审阅者与 CloudTrail 写入者分离；任何 break-glass 权限、适用范围、时限和审批均须单独记录。
5. 对每个角色执行 policy simulator 或同等确定性授权测试，记录允许 action 的 scope 与所有显式拒绝的摘要，不记录资源 URI、策略正文或凭据。

### 5.2 `dolphinqd` 的 SSO 接入程序

该程序在准确 SSO principal 作为输入获得项目负责人/云安全授权后才可执行：

1. 将被批准的 principal ID、Identity Center instance、permission-set identifier 与授权编号登记为受限证据；显示名仅作辅助，不是身份依据。
2. 由获授权管理员将该 principal 绑定到现有、已独立审查的备值班 permission set；禁止创建 IAM user、access key、共享凭据或未审查的直接 admin policy。
3. 验证该会话可读取本职责所需的脱敏诊断、确认告警、执行已获批准的恢复步骤；同时验证不能创建/解除 legal hold、不能改变保留期、不能删除/覆盖 anchor、不能签发新 publisher 权限。
4. 记录 assignment 的 CloudTrail/Identity Center 审计证据编号、会话验证时间、policy-test 摘要、授权人和独立审阅人。SSO session 值、完整 ARN/URI 和原始日志不得进入此记录。
5. 若 principal、permission set、验证结果或审计事件任一不完整，备负责人保持“未接入”；critical 路由仍必须在 5 分钟内通知 `dongqiu`。

## 6. 告警路由与 90 天复核

### 6.1 上线前路由测试

在不修改报告、anchor、hold 或 IAM 权限的情况下，由获授权值班系统发出一个脱敏的 `p1_admission_route_test` critical 测试事件。记录单调时间线：触发、`dongqiu` 与已接入备负责人的送达、任一确认、15 分钟升级判定和关闭。

- 触发后 5 分钟内必须通知主负责人和已接入备负责人。
- 若无人确认，15 分钟时必须升级至 `dongqiu`；即使主负责人也是初始接收者，也要记录升级规则实际被评估的证据。
- 测试 payload 只含测试 ID、严重度、时间和受控证据编号；不得含正文、URI、凭据、账号号或资源 locator。
- 失败、延迟、重复或无法关联确认均为阻断项；修正后重新测试，不能以手工“已知晓”替代。

critical 的第一版事件至少包括完整性失败/manifest 缺失、验证材料不可用、anchor conflict、未收敛 orphan-anchor、daily root conflict、Object Lock/hold/retention 的未授权或异常变更、CloudTrail 停止/selector 覆盖缺失，以及 KMS key/policy 的高风险变更。事件规则、去重键和告警平台配置本身须有受控证据编号。

### 6.2 每 90 天治理复核

项目负责人发起，云安全与值班主负责人共同完成，独立审阅者只读复核。每项结果写入新的准入记录或关联复核记录：

1. 枚举 active legal hold，核对项目负责人授权、90 天内上次复核、完整 material snapshot、Object Lock 状态和未发生自动解除。
2. 抽样一个已发布 artifact，重算上节的 retain-until，确认 anchor、daily root、历史公钥/撤销记录、check 与 CloudTrail 审计材料均仍可读、不可修改。
3. 重新审阅 CloudTrail multi-Region/global events/KMS 未排除、S3 data selector、日志验证、delivery status 和日志 Object Lock/KMS 保留证据。
4. 审阅 publisher/checker/recovery/log-reader/SSO backup 的最小权限与拒绝测试；principal 或 permission set 变动需要重新独立审阅。
5. 执行一次脱敏 critical 路由测试，核对 5 分钟通知、15 分钟未确认升级和 ack 审计。
6. 核对 P0c 基线、SQLite 迁移/备份和 orphan-anchor 恢复演练的最新证据；过期、失败或缺失均阻断 P1 继续启用。

## 7. legal hold 的创建、解除与双向审计

只有项目负责人可批准 hold 的创建或解除；解除没有自动计划任务、TTL 或静默到期。每次操作必须生成同一个 `hold_id` 的双向证据：受控治理记录与不可变的底层审计证据，二者以证据编号和 hash 相互引用。

### 创建

1. 项目负责人记录范围、法务/业务依据、开始 UTC、预定的 90 天复核日和授权编号；不得记录正文或 locator。
2. 在 P1 hold 写模型追加 hold 及被保护 material snapshot（manifest、anchor、历史 signing material、最新 integrity check）；随后验证关联对象已有/取得正确 Object Lock legal hold 状态。
3. 收集 `PutObjectLegalHold`/读取核验的 CloudTrail 证据，并把 event hash/证据编号写回治理记录；不将原始事件复制到仓库。
4. 独立审阅者确认范围、actor、时间、双向关联和 lifecycle purge 的 fail-closed 状态。任一侧缺失即 hold 未完成，且禁止 purge。

### 解除

1. 项目负责人再次明确批准同一 `hold_id` 的解除，说明解除依据、UTC 时间和授权编号；没有“自动到期”路径。
2. 先追加不可变 release 审计记录，保留创建记录和完整历史；然后按批准范围执行受控底层解除，并采集对应 `PutObjectLegalHold` 及读取核验的 CloudTrail 证据。
3. 独立审阅者确认 release 的治理记录与底层审计记录均关联同一 `hold_id`，且保留期限/retention tombstone 规则仍满足后，才恢复既有受控 lifecycle 流程。
4. 若取消、超时、部分成功或证据缺失，保持 hold 和 purge fail-closed，记录 `legal_hold_release_incomplete` 并升级为 critical。

## 8. 准入结论、独立审阅与回退

执行者不得自签。独立只读审阅者必须逐项确认本手册的治理事实、2 年可读/7 年归档、Object Lock/KMS/IAM 最小权限、CloudTrail 覆盖、日志不可变性、legal hold 无自动解除与 90 天复核、SSO backup 证据和告警时限均与已批准规则一致。

准入记录只能给出以下结论之一：

- **通过，等待人类批准启用**：所有证据完整、无未决决策、独立审阅已签认；仍不自动开启 P1。
- **未通过**：一个或多个阻断项存在；保持 `INTEGRITY_ANCHOR_ENABLED=false`。
- **needs_decision**：需要新的保留、身份、授权、告警或资源设计决定；保持禁用。

回退不是删除证据、停用 CloudTrail、缩短 Object Lock 或解除 hold。若启用后的 P1 需要暂停，只能停止新的 P1 发布/启用动作并保留现有 anchor、日志、hold、验证材料和审计；由项目负责人按事件流程决定后续处置。
