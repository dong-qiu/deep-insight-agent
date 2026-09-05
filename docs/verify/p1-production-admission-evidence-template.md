# INSI-25 P1 生产准入证据记录 — 模板

> 复制为 `docs/verify/p1-production-admission-YYYY-MM-DD.md` 后填写。此记录只放受控证据编号、摘要 hash、时间和角色标签；不得放报告正文、完整 URI/ARN、账号全号、CloudTrail 原文、策略正文、会话信息或任何凭据。

## 结论

**通过，等待人类批准启用 / 未通过 / needs_decision**

`INTEGRITY_ANCHOR_ENABLED`：`false / （仅在批准后记录实际状态）`

## 记录与授权

| 字段 | 值 |
| --- | --- |
| 准入记录 ID | `INSI-25-ADMISSION-…` |
| 评审 UTC 窗口 | `<start> — <end>` |
| 目标 account/Region 集合 | `<脱敏标签>` |
| CloudTrail/云变更授权编号 | `<approval reference>` |
| P1 启用批准 | `<未获批 / reference>` |
| 项目负责人 | `dongqiu` |
| 云安全与 P1 值班主负责人 | `dongqiu` |
| 备负责人 | `dolphinqd`；`<未接入 / 已接入>` |
| 独立只读审阅者 | `<name/role>` |

## 治理事实核对

| 规则 | 预期 | 证据编号 | 结果 |
| --- | --- | --- | --- |
| 报告可读期 | 发布后 2 年 | `<E-…>` | `pass/fail` |
| 报告归档期 | 发布后 7 年 | `<E-…>` | `pass/fail` |
| legal hold 权限 | 仅项目负责人创建/解除；无自动解除 | `<E-…>` | `pass/fail` |
| legal hold 复核 | 每 90 天，完整审计 | `<E-…>` | `pass/fail` |
| critical 通知 | 5 分钟内通知 | `<E-…>` | `pass/fail` |
| 未确认升级 | 15 分钟升级至 `dongqiu` | `<E-…>` | `pass/fail` |

## 证据索引

| 证据 ID | 类别 | 采集 UTC | 采集角色 | 受控存储引用 | SHA-256 / 短 hash | 脱敏摘要 | 独立审阅 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E-001` | `<CloudTrail / IAM / KMS / hold / alert / recovery>` | `<…>` | `<…>` | `<vault reference>` | `<…>` | `<无正文/URI/凭据>` | `<pass/fail>` |

## 保留期计算抽样

| 样本 ID | `published_at` | readable until (+2y) | archive until (+7y) | artifact retain until | verification material retain until | Object Lock mode / retain-until | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<脱敏 artifact label>` | `<UTC>` | `<UTC>` | `<UTC>` | `<UTC>` | `<UTC>` | `Compliance / <UTC>` | `pass/fail` |

## CloudTrail、不可变日志与 KMS

| 控制项 | 最小要求 | 证据 ID | 结果 / 例外 |
| --- | --- | --- | --- |
| Trail 范围 | multi-Region + global service events + management read/write | `<E-…>` | `<…>` |
| S3 Object Lock | retention、legal hold、lock config、delete/bypass 尝试及相关 bucket/lifecycle 变更 | `<E-…>` | `<…>` |
| KMS | 未排除 KMS；policy/grant/disable/rotation/deletion 及 cryptographic operation 可审计 | `<E-…>` | `<…>` |
| IAM / STS / SSO | policy/role/trust/assignment/assume 与拒绝可追溯 | `<E-…>` | `<…>` |
| CloudTrail 自身 | selector/trail/log validation/log-storage policy 与变更可审计 | `<E-…>` | `<…>` |
| 日志不可变性 | 独立受限存储、Object Lock Compliance、SSE-KMS、digest/validation | `<E-…>` | `<…>` |
| 日志验证抽样 | UTC 时间窗、工具版本、摘要 hash、执行角色、成功状态 | `<E-…>` | `<…>` |

## 最小权限与 SSO 备负责人

| 身份/职责 | 所需能力 | 明确拒绝能力 | 证据 ID | 结果 |
| --- | --- | --- | --- | --- |
| publisher | 条件写、签名、必要 KMS encrypt/data-key | delete、overwrite、bypass、缩短 retention | `<E-…>` | `<…>` |
| checker | 受控只读验证 | sign、write、delete、bypass | `<E-…>` | `<…>` |
| recovery runner | 独立临时恢复 | 新 anchor、overwrite、应用角色自行 assume | `<E-…>` | `<…>` |
| log reader | 受控审阅/验证 | 写日志或改 selector | `<E-…>` | `<…>` |
| `dolphinqd` SSO | 仅已批准备值班职责 | 创建/解除 hold、改变 retention、删除/覆盖 anchor、授予 publisher 权限 | `<E-…>` | `<未接入/pass/fail>` |

SSO principal 资料（principal ID、instance、permission set、assignment event、会话验证）位于受限证据 `E-…`；本记录不复写这些值。若任何字段未获批准或无法验证，备负责人状态必须为“未接入”。

## 告警路由测试

| 字段 | 值 |
| --- | --- |
| 测试 ID | `p1_admission_route_test-…` |
| 触发 UTC | `<…>` |
| 初始接收者通知 UTC | `<dongqiu / 已接入备负责人；时间>` |
| 5 分钟判定 | `pass/fail` |
| 首次确认 UTC / 角色 | `<…>` |
| 15 分钟未确认升级评估 | `<执行/不适用（因已确认）；证据>` |
| 升级至 `dongqiu` 结果 | `pass/fail/not applicable` |
| payload 脱敏检查 | `pass/fail` |
| 告警规则/去重配置证据 | `<E-…>` |

## legal hold 审计与 90 天复核

| hold ID | 动作 | 项目负责人授权 | 治理审计证据 | CloudTrail/底层证据 | material snapshot | 下次复核 UTC | 独立审阅 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<hold-…>` | `create/review/release` | `<reference>` | `<E-…>` | `<E-…>` | `<E-…>` | `<UTC>` | `<name/role>` | `pass/fail` |

- 自动解除检查：`pass/fail`；证据 `<E-…>`。
- active hold 的 lifecycle purge fail-closed 检查：`pass/fail`；证据 `<E-…>`。
- 下一次 90 天复核负责人/计划：`<项目负责人；UTC>`。

## P1 其他生产前置与恢复

| 前置 | 证据 ID | 结果 / 到期日 |
| --- | --- | --- |
| P0c 性能基线 | `<E-…>` | `<…>` |
| SQLite 迁移与备份核对 | `<E-…>` | `<…>` |
| orphan-anchor 恢复演练（不新锚、不覆盖、告警/对账） | `<E-…>` | `<…>` |
| artifact/anchor/验证材料不可用的 critical 路由 | `<E-…>` | `<…>` |

## 阻断项、未决决策与例外

| ID | 类型 | 描述（脱敏） | 风险 | 所需决定/授权 | 责任人 | 截止 UTC | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `D-001` | `blocker/needs_decision/exception` | `<…>` | `<…>` | `<…>` | `<…>` | `<…>` | `open/closed` |

## 独立只读审阅声明

我已只读核对本记录所引用的受限证据，并确认其与 INSI-25 已批准治理事实一致：发布后 2 年可读、7 年归档；legal hold 仅项目负责人创建/解除且无自动解除、每 90 天复核；`dongqiu` 为云安全/P1 值班主负责人；备负责人仅在准确 SSO principal 和最小权限证据完整时接入；critical 5 分钟通知、15 分钟未确认升级至 `dongqiu`。我未执行生产变更。

| 角色 | 姓名 | UTC | 结论 | 签认引用 |
| --- | --- | --- | --- | --- |
| 执行记录者 | `<…>` | `<…>` | `<…>` | `<…>` |
| 独立只读审阅者 | `<…>` | `<…>` | `<pass/fail/needs_decision>` | `<…>` |
| 项目负责人（是否批准启用另记） | `dongqiu` | `<…>` | `<…>` | `<…>` |
