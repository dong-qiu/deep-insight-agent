# Spec: Controller 可靠性交付闭环

> 状态：阶段 1 规范，供阶段 2 实现使用。本文定义交付 Controller 的持久状态、证据和恢复契约；不改变现有 Controller、CI、部署、权限、凭据或 AWS 资源。

## 背景与目标

Controller 负责把一个已授权的交付请求推进到“可供人工审阅”的状态。它必须在运行时暂时离线、事件至少一次投递、任务中断，以及 PR base 变化时保持安全而可恢复。

本规范特别阻止两类已发生故障：

1. **运行时离线耗尽任务**：没有有效 heartbeat 和已确认 lease 的等待或重连，绝不消耗一次执行/修复预算。
2. **旧 base 的 Reviewer 被采纳**：Reviewer 与 CI 证据必须绑定当前 PR freshness 三元组；任一成员变化即失效，不能再用于采纳。

完成态是 `ready_for_human_review`，而不是合入、发布或部署。所有不可自动解决的决定交由人类。

## 术语、权威来源与不变量

| 术语 | 定义 / 权威来源 |
|---|---|
| delivery | 一次由人工授权的交付请求，以不可变 `delivery_id` 标识。 |
| Controller record | Controller 的持久聚合；保存当前状态、`generation`、最新证据引用和审计尾指针。 |
| runtime | 执行任务的本地运行时；heartbeat、lease 确认和任务结果是其权威事实。 |
| PR | GitHub PR；`head_sha`、`base_sha`、`merge_state_status`、CI run 和 review 来自 GitHub webhook/API 快照。 |
| freshness tuple | `F = (head_sha, base_sha, mergeStateStatus=CLEAN)`；`CLEAN` 为大小写规范化后的 clean 状态。 |
| evidence | 带来源、采集时间、不可变 ID/URL、payload hash 和 `F`（若与 PR 有关）的可复查事实。 |
| logical attempt | 一个 matching lease 的**已接受终态**（completed 或 failed）执行/修复结果；排队、offline 等待、重复事件和没有终态结果的中断均不是 attempt。`started_count` 仅作诊断指标，不参与预算。 |

不变量：

- 每次写入都必须携带 `delivery_id`、预期 `generation`/前置状态、幂等键、证据引用、writer 和恢复语义；条件写失败时读取最新 record 后按本规范重新判定，禁止盲写覆盖。
- `generation` 在任何会使既有 PR/CI/review 证据失效的事件上单调递增。历史 evidence 不删除，只标为 `superseded` 并记录失效原因。
- Controller 只接受带相同 `delivery_id` 与当前 generation 的因果相关事件；未知、冲突或缺失证据进入人工决策，不做猜测性推进。
- 任何状态都可由审计事件和证据重放恢复；恢复不能重复发送外部副作用。

## 持久记录与写入信封

阶段 2 至少持久化以下字段（字段可分表，但语义不可分散）：

```text
ControllerRecord {
  delivery_id, state, generation, updated_at,
  task_id?, runtime_id?, active_lease_id?, lease_fencing_token?,
  leased_at?, lease_expires_at?, last_heartbeat_at?, started_at?,
  start_receipt_id?, result_receipt_id?, attempt_count, started_count, repair_round,
  current_freshness?, evidence_set_id, notification_cursor,
  offline_incident_id?, offline_started_at?, last_notification_at?,
  last_transition_event_id, escalation_reason?
}

TransitionEvent {
  event_id, delivery_id, generation_before, generation_after,
  from_state, to_state, writer, occurred_at,
  idempotency_key, precondition, evidence_refs[],
  recovery_action, rollback_marker?
}
```

`event_id` 是审计主键；状态写入的幂等键为 `delivery_id:generation:transition:causal_event_id`。需要创建/重新投递子任务时，额外使用 `delivery_id:generation:operation:ordinal`；同键必须返回原效果或语义冲突，绝不创建第二个活跃任务。

lease 的条件写和 runtime 结果必须同时围栏 `delivery_id`、generation、`runtime_id`、`lease_id`、`lease_fencing_token`、未过期 `lease_expires_at` 和预期状态。旧 runtime、旧 lease 或重启前的 result 只能形成 stale 审计事件，绝不能写入当前 record。

## 状态机

除下表所列迁移外一律拒绝并写审计 `invalid_transition`。`cancelled` 仅表示自动处理停止；仍允许人工以新 generation 显式 reopen。下表是唯一的**逐边写入契约**；每一行都是一个独立条件写，不能把同一源状态的条件借给另一条边。

| From → To（触发） | 前置条件 | 幂等键 | 最小证据 | 写入副作用与恢复 |
|---|---|---|---|---|
| `intake → admitted`（授权通过） | 授权完整、范围允许、禁止项策略已加载 | `:admit:<request_hash>` | 授权请求、范围校验 | 写 admitted；冲突重读，不建任务。 |
| `intake → awaiting_human_decision`（授权/范围冲突） | 验证失败或授权互相矛盾 | `:escalate:<validation_hash>` | 验证错误、请求 | 冻结；人工提供新决定才恢复。 |
| `admitted → waiting_for_runtime`（工作已入队） | 工作计划可执行且范围仍允许 | `:queue:<work_hash>` | 工作计划、策略版本 | 幂等创建 queued 子任务；创建失败保留 admitted、同键重试。 |
| `admitted → awaiting_human_decision`（不可执行范围） | 缺 runtime、授权不覆盖或目标禁止 | `:escalate:<cause_hash>` | 计划、策略拒绝原因 | 不建任务；人工决定。 |
| `waiting_for_runtime → leased`（lease 已确认） | heartbeat ≤90 秒、唯一任务 queued、runtime 确认新 lease | `:lease:<runtime_id>:<lease_id>` | heartbeat、ack、lease expiry/fence | 原子写 runtime/lease/fence/expiry；失败不扣 attempt。 |
| `waiting_for_runtime → awaiting_human_decision`（offline 阈值/孤儿） | offline ≥30 分钟、≥3 次丢 lease、或有多个活跃子任务 | `:escalate:<incident_or_conflict_id>` | heartbeat 历史、lease/task 清单 | 撤销可撤 lease、冻结；attempt 不变。 |
| `waiting_for_runtime → cancelled`（人工取消） | 人类取消决定有效 | `:cancel:<decision_id>` | 决定记录 | 撤销 queued work；迟到事件只审计。 |
| `leased → executing`（started） | matching、未过期 fenced lease 的 start receipt | `:start:<lease_id>:<receipt_id>` | start receipt、heartbeat | 写 started 时间/计数；不扣 attempt。 |
| `leased → waiting_for_runtime`（未开始 lease 到期） | lease 过期且无 matching start receipt | `:lease_expired:<lease_id>` | expiry、缺失 start 证明 | 原子撤 lease；attempt 不变，可重派。 |
| `executing → evidence_collecting`（成功结果） | matching fenced lease 的 completed result，产物完整 | `:result:<lease_id>:<result_hash>` | result、日志/产物 hash | 接受 result 并使 attempt +1；后续收集证据。 |
| `executing → repairing`（可机械修复失败） | matching fenced failed result、失败分类允许且轮次 <2 | `:result:<lease_id>:<result_hash>` | result、失败分类、修复计划 | 接受结果并使 attempt +1；创建该轮 repair。 |
| `executing → waiting_for_runtime`（中断） | lease 到期且没有 matching terminal result | `:interrupted:<lease_id>` | expiry、最后 heartbeat/checkpoint | 撤 lease、保留 checkpoint；attempt 不变。 |
| `executing → awaiting_human_decision`（不可分类/越界） | matching result 不能安全分类，或请求禁止操作 | `:escalate:<result_hash>` | result、策略拒绝 | 接受终态 result 并使 attempt +1，随后冻结。 |
| `evidence_collecting → ready_for_human_review`（证据完整） | 当前 F、通过 CI、approved review 均未过期且严格相同 | `:ready:<F_hash>:<bundle_hash>` | PR snapshot、CI/review bundle、验收结果 | 原子 pin bundle 与 ready；失败重读 F。 |
| `evidence_collecting → freshness_invalidated`（F 变化/快照不可信） | 观察到 head/base/merge-state 改变，或 snapshot >10 分钟/未知 | `:invalidate:<old_F_hash>:<cause>` | 旧/新 snapshot 或 stale 证明 | 执行下述原子 invalidation；不得采纳旧 evidence。 |
| `evidence_collecting → repairing`（证据失败可修） | CI/review 不通过的可机械原因且轮次 <2 | `:repair:<round>:<cause_hash>` | 失败 evidence、修复计划 | 记录失败 evidence 后入 repairing。 |
| `evidence_collecting → awaiting_human_decision`（缺失/冲突） | 证据冲突、不可获取或修复耗尽 | `:escalate:<cause_hash>` | 缺失/冲突清单 | 冻结，不以猜测替代 evidence。 |
| `freshness_invalidated → evidence_collecting`（新 F 已取得） | 新一代已有权威 PR snapshot | `:refresh:<new_F_hash>` | 新 snapshot、generation | 只创建新 F 的 CI/review 取证；旧 evidence 仍 superseded。 |
| `freshness_invalidated → repairing`（新 F 暴露可修失败） | 新 CI/review failure 可机械修复且轮次 <2 | `:repair:<round>:<cause_hash>` | 新 F、失败 evidence、计划 | 创建 fenced repair；否则不自动改动。 |
| `freshness_invalidated → awaiting_human_decision`（F 不可确定） | 无法取得权威新 snapshot 或出现冲突 | `:escalate:<cause_hash>` | 查询失败/冲突 evidence | fail closed，等待人工。 |
| `repairing → waiting_for_runtime`（派发修复） | 未有活跃 repair，策略允许，轮次 <2 | `:repair_dispatch:<round>` | 修复计划、前轮结果 | 幂等创建唯一 repair task；执行后按 executing 边结算。 |
| `repairing → evidence_collecting`（无需执行的修复完成） | 仅取证/重查修复已提供新 evidence | `:repair_evidence:<round>:<hash>` | 新 evidence | 不扣执行 attempt；进入完整性检查。 |
| `repairing → awaiting_human_decision`（耗尽/冲突/越界） | 轮次已达 2 或出现人工边界 | `:escalate:<cause_hash>` | repair history、原因 | 停止自动修复，冻结。 |
| `ready_for_human_review → freshness_invalidated`（F 变化/TTL 到期） | 有 F 变化、过期或 snapshot 不可信事件 | `:invalidate:<old_F_hash>:<cause>` | 触发 snapshot/TTL 证明 | 原子 invalidation；撤销 ready bundle。 |
| `ready_for_human_review → awaiting_human_decision`（人工拒绝/范围变化） | 有效人工决定或授权失效 | `:escalate:<decision_or_cause>` | 决定/授权变化 | 冻结；无自动合入。 |
| `ready_for_human_review → cancelled`（人工取消） | 有效取消决定 | `:cancel:<decision_id>` | 决定记录 | 停止后续自动动作。 |
| `awaiting_human_decision → admitted` / `waiting_for_runtime` / `cancelled` | 明确、可审计的人类 reopen/resume/cancel 决定 | `:human:<decision_id>` | 决定人、理由、目标状态 | 保留冻结事实；仅按决定的目标迁移。 |
| 任一持有 `current_freshness` 的非终态 → `freshness_invalidated`（reconciler 观察到 F 变化） | 权威 snapshot 证明 head/base/merge state 改变、未知或 stale；适用于 `waiting_for_runtime`、`leased`、`executing`、`evidence_collecting`、`repairing`、`ready_for_human_review` | `:invalidate:<old_F_hash>:<cause>` | 旧/新 snapshot 或 stale 证明 | 执行下述原子 invalidation；若有 lease，原子 fence/revoke 并使迟到 result stale，之后才可重派。 |

invalidation 必须使用**单个原子事务/条件写**：验证旧 generation 与观察到的 `old_F`，将 `generation += 1`、状态写为 `freshness_invalidated`、把旧 F 的 CI/review/ready evidence 统一标为 `superseded`，并写 `TransitionEvent`。事务提交前，任何 reader 的 acceptance predicate 必须 fail closed；提交后旧 approval 永远不可见为可采纳。若存储不支持跨记录原子性，必须先持久化 `pending_invalidation` fence 并使 acceptance fail closed，再由同一幂等键完成全部步骤；不得保留旧 ready/evidence 状态继续可采纳。

## PR freshness、CI 与 Reviewer 绑定

接受证据的唯一条件为：

```text
candidate.F == currentPR.F
&& candidate.F.mergeStateStatus == CLEAN
&& ci.conclusion == passed
&& ci.F == candidate.F
&& reviewer.decision == approved
&& reviewer.F == candidate.F
&& !ci.expired && !reviewer.expired
```

- 采用 GitHub PR 的最新原子快照产生 `currentPR.F`。`CLEAN` 是必要条件，不是持久承诺；GitHub 尚未计算或值不明时，状态为 `evidence_collecting`，不是 clean。
- `head_sha`、`base_sha` 或 `merge_state_status` 改变，或 webhook 顺序/快照 freshness 无法证明时，均按 `freshness_invalidated` 处理。旧 CI、review 和 ready 证据不得继承到新 generation。
- CI 绑定其 `workflow_run_id`、结论、完成时间、head/base SHA 和 `F_hash`。review 绑定 `review_id`、reviewer identity、结论、提交时的 head/base SHA 和 `F_hash`；“批准最新提交”但缺少 base SHA 的 API 结果不满足此规范，须补取快照。
- evidence TTL 默认 24 小时；TTL 到期、PR snapshot 超过 10 分钟未确认，或 recheck 失败时进入 `freshness_invalidated`/`evidence_collecting`，并重新获取需要的证据。不得以旧 review 续期。

## 任务 / 子任务生命周期映射

| Controller 状态 | 父交付任务 | 子任务 | 预算 / 恢复 |
|---|---|---|---|
| `intake` / `admitted` | 已记录，未执行 | 不存在或仅幂等创建请求 | 0 attempts。 |
| `waiting_for_runtime` | 可恢复、未占用 runtime | 一个 `queued` 任务，或无任务等待调度 | offline、lease 到期和重复投递均不扣预算。 |
| `leased` / `executing` | 活跃 | 最多一个 `leased`/`running` 子任务，必须携带 `delivery_id`、generation、lease ID | 只有接受 completed/failed result 后才消耗 attempt。 |
| `evidence_collecting` / `freshness_invalidated` | 活跃 | 无代码执行子任务；仅可幂等创建 CI/review 查询/请求 | 证据任务不消耗修复预算。 |
| `repairing` | 活跃且轮次可见 | 一个当前 repair 子任务；旧 task 必须 terminal 或 lease revoked | 最多 2 轮；每轮有独立 evidence bundle。 |
| `ready_for_human_review` | 等待人工 | 所有子任务 terminal；不得再派发自动修复 | 只允许 freshness recheck。 |
| `awaiting_human_decision` / `cancelled` | 冻结 / 终止 | 无活跃子任务；先撤 lease 再确认状态 | 人类决定才可重新开始。 |

Reconciler 每次扫描时修正孤儿关系：同 generation 两个活跃子任务、task 与 lease 不一致、或 result 属于旧 generation 时，先停止自动推进并转 `awaiting_human_decision`；不得任选一个“看起来最新”的结果。

## 故障恢复、重复触发与人工边界

| 情形 | 规则 |
|---|---|
| runtime 离线 | heartbeat 超过 90 秒视为 offline；撤销/等待 lease，转 `waiting_for_runtime`。连续离线本身不消耗 attempt。首次 offline **立即通知**，之后每 30 分钟提醒；只有持续 30 分钟或超过 3 次 lease 丢失才升级人工。 |
| runtime 重连 | 以新 heartbeat 和新的 lease 重新进入 `leased`；旧 lease/result 因 lease ID 不匹配被记录为 stale，不改变状态。 |
| 任务中断 | 没有 matching completed/failed result 的 running task 到 lease expiry 即中断；回 `waiting_for_runtime`，保留 checkpoint/产物引用，attempt 不增。 |
| 重复触发 / 乱序事件 | 用 event ID、generation 与状态写幂等键去重；已应用返回先前效果，旧 generation/无因果关系事件只审计。 |
| 过期复审 | PR snapshot、CI 或 review 达 TTL 时标为 expired；重新取得同 F 的证据可回 `evidence_collecting`，F 变化必须先 invalidation。 |
| 自动修复 | 仅允许已分类的机械性重试/重新查询/重新请求，`AUTO_REPAIR_MAX=2`，指数退避 5、15 分钟；每轮都必须产生新 evidence。禁止自动改需求、改代码范围、批准 PR 或忽略失败。 |
| 人工决定 | 以下任一情形立即 `awaiting_human_decision`：修复耗尽、授权/范围冲突、多个活跃任务、证据冲突、无法取得 PR 权威快照、需要权限/凭据、任何 merge/deploy/生产/权限操作。 |

## 通知、去重与审计

| 信号 | 接收者 | 频率与去重 | 必填审计字段 |
|---|---|---|---|
| runtime offline / reconnect | 交付所有者 | offline 首次立即，之后每 30 分钟；reconnect 每次 state change 一次 | `delivery_id`、generation、runtime ID、heartbeat age、lease ID、offline incident ID、dedupe key。 |
| freshness invalidated | PR 所有者 / reviewer | 每个 `F_hash` 一次；同一 invalidation 不重发 | 旧/新 F、触发字段、superseded evidence IDs、snapshot ID。 |
| CI/review pending 或 expired | 交付所有者 | 每 24 小时最多一次，恢复时一次 | F、缺失/过期 kind、deadline、request ID。 |
| repair attempt / exhausted | 交付所有者；耗尽时人工决策者 | 每轮一次；exhausted 永久一次 | round、cause、attempt count、evidence refs、next action。 |
| ready for review / human escalation | 人工审阅者 | 每个 generation 一次 | F、evidence bundle ID、验收结果、escalation reason。 |

通知使用按信号定义的幂等键，而非一把通用键：offline 为 `delivery_id:generation:offline:<incident_id>:<30m_bucket>`（首桶立即）；reconnect 为 `delivery_id:generation:reconnect:<transition_event_id>`；invalidation 为 `delivery_id:generation:invalidation:<old_F_hash>:<cause>`；其余信号为 `delivery_id:generation:<signal>:<causal_event_id>`。`offline_incident_id`、`offline_started_at`、最后一个已发送 bucket、发送/确认结果与 retry receipt 都要持久化。发送结果、channel、模板版本、recipient、timestamp 和 `TransitionEvent.event_id` 必须审计；失败可重试，但不得产生额外逻辑状态变化。

## Dry-run、回放与验收矩阵

dry-run 只运行同一 reducer、幂等、invalidation 和通知去重逻辑，禁止创建/修改 PR、CI、task、runtime、部署或任何生产资源。回放输入为脱敏 JSONL 事件及固定时钟；输出包括状态序列、审计 event hash、通知计划和 invariants 报告。至少提供下列 fixture：

- `runtime-offline-before-lease.jsonl`：无 heartbeat 时多次调度；断言 attempt 永远为 0。
- `runtime-interrupted-after-start.jsonl`：started 后无 result 且 lease 到期；断言回等待、checkpoint 保留、attempt 不增。
- `duplicate-and-out-of-order.jsonl`：同一 result/通知重投和旧 generation result；断言一次状态效果、一次通知计划。
- `base-changes-after-approval.jsonl`：`base_sha` 改变后旧 CI/review；断言 generation 递增、evidence 全部 superseded、不能到 ready，且只发一次 invalidation 通知。
- `head-changes-after-approval.jsonl`：`head_sha` 改变后旧 CI/review；断言与 base 变化相同的 fail-closed 行为。
- `merge-state-changes-after-approval.jsonl`：`CLEAN → DIRTY` 与 `CLEAN → unknown/stale snapshot`；断言旧 reviewer 不可采纳，直到新的完整 `F`、CI 和 review 到齐。
- `repair-exhaustion.jsonl`：两轮机械修复失败；断言升级人工而非第三轮自动修复。

| AC | 场景 | 可观察断言 |
|---|---|---|
| AC1 | 每个合法状态迁移 | 只有表列迁移被 reducer 接受；每条 `TransitionEvent` 有前置条件、幂等键、evidence 与恢复语义。 |
| AC2 | runtime 离线、重连和中断 | 离线/未确认 lease/中断不耗尽 attempts；重连使用新 lease；超过阈值通知并升级。 |
| AC3 | 重复和乱序投递 | 状态、子任务和通知都恰好一次；旧 generation 不可覆盖当前 record。 |
| AC4 | base/head/merge state 改变 | 以 base、head、`CLEAN→non-CLEAN` 和 unknown/stale snapshot 四个回放分别证明：任一 `F` 成员变化原子失效 CI/review/ready、发一次通知；旧 Reviewer 绝不能被采纳。 |
| AC5 | CI/Reviewer 采纳 | 仅完整且相同 `F=(head, base, CLEAN)` 的 passed CI + approved review 可进入 `ready_for_human_review`。 |
| AC6 | TTL 与复审 | 过期 evidence 不可采纳；recheck/重放保持可审计且无重复副作用。 |
| AC7 | 修复与人工边界 | 最多 2 轮机械修复；耗尽、冲突、权限/生产相关操作都进入人工决策。 |
| AC8 | 通知与审计 | 频率、dedupe key、审计字段符合表；dry-run 不发送实际通知。 |
| AC9 | 禁止操作 | 集成测试证明 Controller 不调用自动合入、部署、生产访问、权限或凭据变更路径。 |

## 明确禁止项与阶段 2 交付边界

Controller 及其自动修复**不得**：自动合入 PR、修改分支保护、触发或执行部署、访问生产系统/数据、创建或修改 AWS 资源、修改 IAM/权限、读取或写入凭据，或以任何方式绕过 CI、Reviewer 或人工授权。

阶段 2 的实现应以本规范为验收来源，先实现持久 reducer、事件/证据模型、dry-run replay fixtures 与上述 AC；不得把此 Stage 1 文档本身解释为实施这些功能的授权。
