# Spec: 生成溯源与全链路可观测性（Generation Provenance）

> V1 · 状态：🟡 Draft · 2026-08-01

## 1. 背景与问题

Insight Agent 已有 `Run`、`audit_log`、成本记录、引用校验，以及从 `ContentItem` 到 `Report`、`TechLead` 和
`TechnologyOpportunity` 的业务关联。但这些信息分散在不同表、日志和页面中，当前难以回答：

- 一份 Daily Brief 具体使用了哪些内容、批次、校验结果和规则版本？
- 一条技术机会为何被映射到某方向，或者为何没有进入机会池？
- 某天产出变少、变旧、成本变高时，问题发生在哪一个阶段？
- 人工调整方向后，哪些候选受影响，哪些结论仍来自旧规则？

本能力将完整记录“实体（数据/产物）—活动（处理步骤）—执行者（系统/人工）”关系，使生成链路可解释、
可审计、可优化；它不替代业务事实表、日志或引用校验。

## 2. 目标与非目标

### 目标

1. 任一 Brief、报告、技术线索、技术机会和人工方向决策均可从 UI 下钻至完整输入、处理步骤和有效证据。
2. 每次运行拥有统一 `trace_id`，可关联采集、分析、校验、派生、报告、推送、人工复核及重试。
3. 对每一步记录版本、耗时、数量、成本、失败/跳过原因和输入输出引用，支持跨 Run 对比与漏斗分析。
4. 对“已发布事实”“系统派生结果”“人工决策”做明确区分；不把模型输出或建议伪装为事实。
5. 记录默认脱敏、追加写入；不会复制原文、密钥、完整 prompt 或隐私数据。

### 非目标

- 不在 V1 建设通用日志平台、分布式 tracing 后端或替换现有 SQLite。
- 不保存完整 LLM prompt / response；业务实体中已有的洞察、报告和引用仍是唯一正文事实源。
- 不允许通过“重放”直接覆盖生产事实；重放仅能在隔离环境生成候选证据。
- 不自动立项、调整方向或修改人工状态。

## 3. 全链路范围

```text
Source / SourceConfig
  → Collect / Normalize → ContentItem
  → Select / Analyze    → AnalysisBatch → Insight
  → Validate            → CitationCheck(pass | blocked | flagged)
  → Derive Lead         → TechLead → TechLeadEvidence
  → Map Direction       → TechLeadDirectionMap → TechnologyOpportunity
  → Generate Report     → Daily Brief / Deep Dive / Initial Digest
  → Deliver             → delivery attempted（P0）/ channel outcome（P1）
                     ↘ Human review / direction edit / opportunity decision
```

每条实线是一个 `generation_event` 表示的活动，每个方框是既有业务实体引用；人工动作也作为活动写入，且不能与系统派生
混淆。技术机会读取事实时仍必须回到 `TechLeadEvidence → CitationCheck(verdict=pass)`，本能力不得创建
绕过引用白名单的旁路。

## 4. 数据契约

既有 `Run`、`audit_log`、业务表仍为其各自事实源；新增表只存可查询的溯源元数据和实体引用。

### 4.1 `generation_trace`

一次根触发的汇总记录；通常与根 `Run` 一一对应。

| 字段                                      | 说明                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                      | 全局唯一 `trace_id`                                                                         |
| `root_run_id?`                            | → 本 trace 首个编排 Run；创建中、零输入和人工纯决策可为空，绑定后不可变                     |
| `scope_kind`                              | `topic_pipeline` / `source_collect` / `report` / `manual_decision`；决定 trace 的唯一粒度   |
| `trigger_kind`                            | `cron` / `api` / `manual` / `retry` / `backfill` / `reproject`                              |
| `topic_id?` / `source_id?` / `report_id?` | 与 `scope_kind` 对应的根作用域；不得在一个 trace 中混合多个主题                             |
| `started_at` / `ended_at` / `status`      | `running` / `done` / `failed` / `partial` / `cancelled`                                     |
| `parent_trace_id?` / `retry_of_trace_id?` | 深挖、重试和派生运行的关联                                                                  |
| `runtime_version`                         | Git SHA、镜像 digest、schema 版本                                                           |
| `completion_policy`                       | 本次 trace 的执行形态、阻断级别、可接受终态和 skip 规则快照；状态聚合只读取此快照和终态事件 |
| `coverage`                                | `complete` / `partial` / `legacy`；避免把上线前无法证明的历史伪装为完整链路                 |
| `next_sequence`                           | 同 trace 事件序号的事务内计数器；仅 allocator 可更新                                        |
| `request_id`                              | → `generation_trace_request.id`；一次逻辑触发的持久登记                                     |
| `summary`                                 | 各阶段数量、耗时、成本、错误摘要；不含正文                                                  |

`Run` 仍是单个 agent 执行的状态事实源，且其枚举保持 `running` / `done` / `failed`；`generation_trace.status`
是由 Run 与事件重算的**物化只读投影**，只能由 provenance projector 在同一事务更新，不能反向更新 Run，也不能由
API 直接改写。聚合规则如下：

- `running`：尚未具备终态；根 Run、任何必需 Run 或任何必需 event-only 阶段仍在进行；
- `done`：根 Run 与所有必需子 Run 均为 `done`；`skipped`、无重要事件和空刊是 event reason，不使 trace 失败；
- `failed`：根 Run 为 `failed`，或任一必需阶段失败而未产生可发布的终态；
- `partial`：根 Run / 报告已 `done`，但明确标为非阻断的派生步骤（例如 Lead / Opportunity 投影或投递）失败；相应
  Run 仍为 `failed`，失败原因必须出现在 trace summary；
- `cancelled`：仅用于未来支持取消的触发。在现有 Job Runner 未新增 `cancelled` 前，取消一律以
  `Run.status=failed` + `error.type=cancelled` 记录，并将 trace 聚合为 `cancelled`。

同一 trace 最多一个 `root_run_id`。纯人工决策与零输入/预算跳过 trace 可没有 Run，均以最后一个终态事件决定状态；
前者为 `manual_decided` / `config_changed`，后者为 `skipped(reason_code=no_content|budget_exceeded|window_closed)`。

### 4.1.1 Trace 拓扑与重试

P0 的 trace 粒度固定如下，避免“全站一次 cron”形成不可查询的大 trace：

- `topic_pipeline`：一次主题流水线（分析 → 校验 → 报告及其非阻断派生）一条 trace；第一个 `analyze` Run 是
  `root_run_id`，后续 `validate` / `report-gen` Run 必须带同一 `trace_id`。
- `source_collect`：一次来源采集一条独立 trace；其 `ContentItem` 被主题流水线消费时，以实体引用和
  可解析的来源 trace 关联，而不是把跨主题采集 Run 伪装成子 Run。一个主题可消费多个来源 trace，
  因而这些多对多关系只由实体引用/因果边表达；`parent_trace_id` 仅表示单一的直接派生来源。
- `report`：仅对独立报告重生成使用；`manual_decision`：只承载一次人工方向、线索或机会决定。

`Run.trace_id` 是多对一外键，必须由 `JobSpec` / `JobCtx` 显式透传；现有 `retry_of` 继续只描述 Run 级重试。
同一 trace 内重试阶段新建 Run 和事件，保留相同 `trace_id`；一次由用户或调度新发起的完整重跑新建 trace，并以
`retry_of_trace_id` 指向前一次 trace。`completion_policy` 在根 trace 创建时冻结，明确哪些阶段是必需、哪些是
非阻断，禁止根据事后当前配置改变历史聚合结果。

创建顺序按执行模型固定。纯人工或零输入 trace 不创建 Run。对 durable-dispatch trace，接受事务只创建
`generation_trace(root_run_id=NULL,status=running)`、active reservation 与 queued dispatch；worker 成功领取 dispatch 和
lease 后，才在**同一短事务**创建带 `trace_id` 的首个 `running` Run 并一次性回填 `root_run_id`。因此，已接受但尚未领取的
trace 的 `root_run_id=NULL` 是合法状态，不得被 orphan recovery 标为失败。非 dispatch 的同步执行路径也必须先取得 owned lease，
再创建首个 Run；`root_run_id` 已绑定后不可修改。所有没有 Run 的阶段必须在 `completion_policy.execution_kind` 标为
`event_only`，其终态由对应事件参与聚合；不得把吞掉的异常或 fire-and-forget 调用视为已完成。

并发创建必须经过 `trace_factory`，而不是“先查 running 再插入”。`generation_trace_request(id, scope_key UNIQUE,
active_key, idempotency_key_hash?, trace_id UNIQUE, state, retained_until)` 是**持久**触发登记：它在 trace 终态后仍保留至
`retained_until`，lease 的释放不删除它。同一 `scope_key` 或同一有效 `idempotency_key_hash` 必须原样返回已登记的 trace，
不得新建；手动 key 只保存 HMAC，不保存原值。`state` 受控为 `accepted | terminal | archived`：accepted 覆盖 queued/claimed
dispatch 与 running trace，projector 在 trace 终态时同事务转 terminal，归档任务才可转 archived；request state 不是 worker
claim 的替代品。

`trace_factory` 使用两个稳定键：`scope_key` 标识一次逻辑触发，
`active_key` 防止同一产物并发生成。scheduled `topic_pipeline` 的 `scope_key` 为
`topic_pipeline:{topic_id}:{report_type}:{UTC period}`，其中 brief 用 UTC 日期、deep_dive 用 ISO 周、initial_digest 用
`initial`；`active_key` 固定为 `topic_pipeline:{topic_id}:{report_type}`，终态后在同一事务释放。`source_collect` 用
`source_collect:{source_id}:{UTC hour slot}`；手动/API 触发必须提供调用方 `idempotency_key`（24 小时内相同 key 返回同一
trace，缺失即拒绝）。不同 `scope_key` 与相同 `active_key` 冲突时：cron 记录 `skipped(reason_code=active_generation)` 并
返回既有 trace；API 返回 `409 active_trace_id`，不附着、不接管；只有既有 trace 终态并释放 active lease 后才可重试。

Scheduled topic pipeline 的 durable payload 还必须冻结 `window_end`（RFC 3339 UTC）：worker 和完整重跑均按
`[window_end - window_hours, window_end]` 选材，不能因等待、部署或人工重试漂移到当前时间。早期 payload 缺少该字段时，
重跑以原 trace 的 `started_at` 作为兼容回填值，并在新 dispatch 中持久化。

手动请求使用如下固定格式，并把 endpoint、scope 与响应一并冻结：

| 场景                               | `scope_key` / `active_key`                                                                                   | 响应                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Deep Dive / 独立报告               | `report:{topic_id}:{type}:manual:{idempotency_hash}:{request_sequence}` / `topic_pipeline:{topic_id}:{type}` | 同一未过期 key 返回原 trace；active 冲突返回 409 |
| 人工方向、Lead 或 Opportunity 决定 | `manual_decision:{entity_key}:{idempotency_hash}:{request_sequence}` / `manual_decision:{entity_key}`        | 同一未过期 key 返回原 trace；active 冲突返回 409 |
| 全量重跑                           | `retry:{retry_of_trace_id}:{idempotency_hash}:{request_sequence}` / 原 trace 的 active key                   | 仅原 trace 终态后允许创建                        |

`idempotency_key_hash` 的有效期固定为 24 小时。`trace_factory` 在事务内先按未过期 hash 查询；过期后保留旧 request 供审计，
递增 `request_sequence` 创建新 scope，避免 `scope_key UNIQUE` 阻止合法的新请求。清理任务仅在 trace、审计与备份保留期均结束后
归档 request；不以时间相关 partial index 承担唯一性。

`POST /api/topics/{topic_id}/deep-dive` 是 P0a 的规范 API：请求必须携带长度 8–128 的 ASCII `Idempotency-Key` header，
body 可选 `planning: boolean`（默认 `true`）。路由必须在启动异步任务前同步完成 `trace_factory` 与 dispatch 创建事务：首次返回
`202 { trace_id, request_id, status: "accepted", replayed: false }`；同 key 重放返回 `200 { trace_id, request_id, status,
replayed: true }`；active 冲突返回 `409 { code: "active_generation", active_trace_id }`；缺失/非法 key 返回 400。登记成功但
本机唤醒 worker 失败不改变该响应：持久 dispatch 已是可恢复的 handoff。仅当创建 trace、lease、request 与 dispatch 的同一事务
无法提交时返回 503；不得因进程内 Promise、HTTP 连接或一次 signal 失败把已接受请求标记为失败。

`GET /api/generation-traces/{trace_id}` 是 Deep Dive 的唯一状态查询 API，按钮必须保存 POST 返回的 `trace_id` 并以此轮询，
不得使用 `since` 或 Run 时间窗猜测。P0a 仅允许 `requireAdminActor()` 的请求读取；未认证返回 401，认证但无权、不存在或已过审计
保留期均返回 404，避免泄露 trace 存在性。响应只返回 `{ trace_id, request_id, status, root_run_id, started_at, ended_at, coverage,
dispatch: { state, attempt, claimed_at, lease_expires_at, last_error_reason? }, stages }`；不返回 owner token、fencing epoch、
payload、原始错误、实体引用或未授权内容。`last_error_reason` 只在 admin 角色下返回稳定脱敏 reason code。终态
`done|partial|failed|cancelled` 可缓存，非终态须 `Cache-Control: no-store`。

#### 4.1.1.1 Durable dispatch（P0a）

`generation_dispatch(id, request_id UNIQUE REFERENCES generation_trace_request(id), trace_id UNIQUE REFERENCES
generation_trace(id), kind, payload, state, attempt, claim_epoch, owner_token?, claimed_at?, heartbeat_at?, lease_expires_at?,
last_error?, created_at, updated_at)` 是唯一允许把接受的生成请求交给执行器的持久 outbox。`payload` 只含重建执行所需的
`topic_id`、report type、planning、请求 scope 和版本化 schema；不得含 header 原值、凭据、原文或 prompt。`state` 为
`queued | claimed | done | failed | cancelled`，`attempt` 与 `claim_epoch` 单调递增，`last_error` 是脱敏后的稳定 reason code / 摘要。

首次请求必须在同一 `BEGIN IMMEDIATE` 事务创建 `generation_trace_request`、`generation_trace(root_run_id=NULL)`、
`generation_lease(state=reserved, owner_token=NULL, fencing_epoch=0, expires_at=NULL)` 和
`generation_dispatch(state=queued, attempt=0, claim_epoch=0)`，提交成功后才能返回 202。`reserved` 是持久 active reservation：
它不超时、不允许执行，直至同 trace 终态后在同一投影事务释放；所以 queued trace 仍会造成 active conflict，但不会被另一个请求夺走。
任何后续 HTTP 重放只读取同一 request/dispatch，绝不另起进程内任务。路由可在提交后发送本机 wake-up 以降低延迟，但 wake-up
是可丢的优化；不得作为可靠性边界。

部署一个独立于 Web 路由进程的 `generation-dispatch-worker` 服务（与 app 使用同一发布镜像和 SQLite 卷），持续轮询 queued
任务并监测 expired claim。worker 必须在**同一短事务**以 compare-and-swap 同时领取 `queued` 或
`claimed AND lease_expires_at < now` 的 dispatch，并将相同 trace 的 lease 从 `reserved` 或 `owned AND expires_at < now`
变为 `owned`：写入同一个新的随机 `owner_token`、递增且对齐 `claim_epoch` / `fencing_epoch`、设置两个 expiry 为
`now+120s`，创建首个 `running` Run 并绑定 `root_run_id`（若尚未绑定）。领取失败的 worker 不得创建 Run 或执行任何外部调用。
运行中每 30 秒以 owner token + 两个 epoch CAS 同时续期。所有 dispatch 完成、失败、Run/event/业务/effect/projection 写入均
同时校验 dispatch claim 和 owned lease；过期或被接管的旧 worker 不得提交终态。进程崩溃、部署重启或网络中断后，过期 claim
由任一健康 worker 接管，保留此前 attempt 与安全错误摘要。

接管发生在 `root_run_id` 已绑定后时，不得创建第二个 root Run、也不得仅因 owner 改变把现有 `running` Run 标为失败；新 owner
在同一 trace / Run 上从已提交的 event、revision 与 effect 状态恢复。未终态阶段可按既有 Run retry 语义创建子 Run，外部调用
允许至少一次重试，但其所有业务提交仍受新 epoch fencing 和 effect reconciliation 约束。无法安全恢复的 dispatch 才以
`dispatch_failed` 同时结束当前 Run、trace 与 dispatch；用户随后以新的完整重跑 trace 重试，绝不覆盖已接受记录。

worker 仅在 trace 已按 `completion_policy` 进入终态后将 dispatch 标为 `done`（trace `done|partial`）或 `failed`
（trace `failed|cancelled`）；无法安全解释的调度异常也必须以 `dispatch_failed` 结束 trace 和 dispatch，而非遗留 claimed 状态。
健康检查须报告最老 queued/expired-claimed 任务年龄；超过 5 分钟告警，超过 15 分钟使 worker readiness 失败。部署 drain 先停止领取、
等待当前 claim 完成或到期接管，不能终止后把任务遗失。测试必须覆盖“202 后 Web 进程立即退出”“worker 在外部调用中崩溃”“旧 claim
复活写入被拒绝”和“重复 wake-up 只执行一个 dispatch”。

`generation_lease(id, active_key, scope_key, trace_id, state, owner_token?, fencing_epoch, heartbeat_at?, expires_at?)` 的 `state`
为 `reserved | owned | released`，并以静态 partial unique index `UNIQUE(active_key) WHERE state IN ('reserved','owned')`
保证同一 active key 只有一个未终态 trace；released 行保留审计而不阻塞下一次请求。accepted trace 只能是 `reserved`，不得含 owner 或 expiry；
worker 只能在领取 dispatch 的同一短 SQLite 事务转为 `owned`。owned lease 的 TTL 为 120 秒，owner 每 30 秒以
`owner_token + fencing_epoch` compare-and-swap 续租；仅在 `expires_at < now` 时才可由同一 dispatch 的新 claim 接管，
并将 `fencing_epoch` 单调加一。trace 终态后 projector 在同一事务转为 `released`，保留审计行但不再占用 active key。

同时持有 dispatch claim 和 owned lease 后才可开始 LLM 或抓取调用；每个 Run、业务、event、revision、effect 和 trace projection
的写事务都必须带 `owner_token + claim_epoch + fencing_epoch`，并验证其仍是未过期当前 owner，否则整笔事务失败。恢复者接管后旧 owner 的任何后续提交
必须失败，新 trace 只在完整重跑时创建。该 lease 不是跨网络调用的长事务，且所有 Run 创建都只能接收已创建的 `trace_id`。

### 4.1.2 状态机真值表

Projector 是唯一的纯函数 `projectTrace(runs, stageAttempts, completionPolicy)`，每次 event / Run / recovery 写入后在同一
事务重算。`completion_policy` 对每个 stage 分别指定 `execution_kind: run | event_only | omitted`、
`criticality: required | non_blocking`、`allowed_terminal_events` 与 `skip_is_success`；执行形态与阻断级别不得混用。
Projector 先将各 stage 的 allowed terminal event 归一为 `completed | skipped | failed | cancelled` 再套用下表；测试必须
逐行覆盖。

| 条件（按优先级）                                                                     | trace 状态  | 说明                                                                     |
| ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------ |
| 任一根/必需阶段以 `cancelled` 结束                                                   | `cancelled` | 现有 Run 用 `failed + error.type=cancelled` 映射                         |
| 任一根/必需阶段 `failed`，且没有 policy 允许的已发布替代终态                         | `failed`    | 包含 recovery 补写的失败                                                 |
| 任一必需阶段未终态                                                                   | `running`   | 包含 retry 中与 event-only 正在进行                                      |
| 全部必需阶段 `completed`，或以 policy 允许的 `skipped` 结束；任一非阻断阶段 `failed` | `partial`   | P0 delivery `attempted` 不是失败                                         |
| 全部必需阶段 `completed`，或以 policy 允许的 `skipped` 结束                          | `done`      | `no_content` / `budget_exceeded` / `window_closed` 是允许 skip 的 `done` |
| 纯人工 trace 的 `manual_decided` / `config_changed` 已终态                           | `done`      | 无 Run 合法                                                              |

P0a 冻结 policy：`analyze` / `validate` / `generate_report` 均为 `run + required`，其接受终态为
`completed|failed|cancelled`。`ValidationResult.releasable=false`（但非空批次）保持既有质量契约：不调用模型生成，但必须
创建并结束 `report-gen` Run 为 `failed(error.type=no_releasable_insight)`，追加 `generate_report.failed`，且不得发布报告，
使 trace 为 `failed`。同时落一条不可公开 `Report(status=failed)`：它有新 report ID、topic/type/generated_at、失败原因与
输入/校验引用，但 `body_path=NULL`、没有 artifact、`report_index` 或 `report_fts`；重试新建 Report 与 trace，并以
`generation_edge(relation=retry_of)` 连接，绝不覆盖失败记录。P0 migration 必须使 `report.body_path` 可空并为失败原因提供
结构化字段。只有空批次/`no_significant_event` 可走既有“无重要事件”成功路径。`deliver` 为
`event_only + non_blocking`，只接受 `attempted|skipped` 并归一为 completed；`derive_lead` / `map_direction` /
`derive_opportunity` 在 P0a 均为 `event_only + non_blocking`：每个 stage 独立写 started/completed/failed event 与其业务
revision/edge 的同事务边界，opportunity 异常必须向 stage wrapper 抛出后写 failed，禁止吞掉。人工 trace 的
`human_review` / `direction_change` 为
`event_only + required`，分别接受 `manual_decided` / `config_changed` 并归一为 completed。`summary` 由 projector
重建，不作为状态判断输入。

三个规划 stage 的事务边界固定为：`derive_lead` 原子写 `tech_lead`、`tech_lead_evidence`、对应 revision/ref；
`map_direction` 原子写（首次必要时）`topic_direction` 默认播种、`tech_lead_direction_map`、对应 revision/ref；
`derive_opportunity` 原子写 `technology_opportunity`、`opportunity_lead`、对应 revision/ref。默认方向播种只能在
`map_direction` started 后发生。每个 stage 独立拥有 attempt、fencing 校验与失败 event；前一 stage 已提交而后一 stage 失败时
trace 归为 `partial`，不得回滚已提交事实。Deep Dive 与 scheduled pipeline 都必须调用同一规划 stage 编排；只有显式
`planning=false` 的 API 才可在 trace policy 中 `omitted`，并在响应与时间线显示该选择。

### 4.2 `generation_event`

追加式事件表，按 `trace_id, sequence` 排序。`sequence` 是同一 trace 内由写入事务分配的单调整数，且
`UNIQUE(trace_id, sequence)`；`occurred_at` 仅用于展示，不能用于完整性顺序。常规应用路径不得 `UPDATE` /
`DELETE` 已写事件。

| 字段                                                            | 说明                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id` / `trace_id` / `sequence` / `attempt` / `parent_event_id?` | 事件身份、稳定顺序、阶段尝试号与树形父子关系                                                                                             |
| `semantic_payload_hash`                                         | 排除运行时易变字段后的幂等语义 hash；用于安全重放比较                                                                                    |
| `run_id?`                                                       | → `Run.id`，复用现有重试、成本和状态追踪                                                                                                 |
| `stage`                                                         | 见下方受控阶段表                                                                                                                         |
| `event_type`                                                    | `started` / `planned` / `attempted` / `completed` / `failed` / `skipped` / `retried` / `manual_decided` / `config_changed` / `published` |
| `occurred_at` / `duration_ms?`                                  | 时序与阶段耗时                                                                                                                           |
| `actor_type` / `actor_id?` / `audit_log_id?`                    | `system` / `user` / `scheduler`；人工需保留账号与既有审计记录关联                                                                        |
| `reason_code?`                                                  | 机器可聚合的失败、跳过或人工决定原因                                                                                                     |
| `input_refs` / `output_refs`                                    | 结构化实体引用数组，见 4.3                                                                                                               |
| `metrics`                                                       | 数量、token、金额、freshness、重试次数等小型 JSON                                                                                        |
| `version_context` / `context_completeness`                      | 模型、prompt/config、方向规则、Git/镜像的不可变版本快照，以及 `complete` / `partial`                                                     |
| `error`                                                         | 脱敏后的错误类别、消息摘要、retryable；不存 stack / 凭据                                                                                 |
| `payload_schema_version` / `payload_hash`                       | `v1` 规范化、脱敏后 payload 的 SHA-256；P0 用于写入/读取校验，不声称防篡改                                                               |

`metrics` 与 `version_context` 均为写入时 default-deny 的字段契约，不接受任意 JSON。P0 已登记的
metrics 仅为非负整数计数（选择、输入/洞察、citation verdict、发布/freshness、候选/机会及采集/归一化
计数）；`version_context` 仅允许规范化的 `source_config_revision`（`source-v1:<sha256>`）与
`collection_mode`（`feed` / `full_text`）。新增字段必须先登记、说明其脱敏语义并补负向测试；prompt、
raw content、secret、token 或嵌套调试 payload 一律在写入前拒绝。

`stage` 受控为：`collect`、`normalize`、`select`、`analyze`、`validate`、`derive_lead`、
`map_direction`、`derive_opportunity`、`generate_report`、`deliver`、`human_review`、`direction_change`。

`attempt` 为正整数，并与 `stage` 一起定义一次阶段尝试。某 trace 中某 stage 的首次尝试为 1；同一次尝试的
`planned` / `started` / `attempted` / 终态事件共享 attempt。Run 级重试沿 `retry_of` 链取父 attempt + 1；event-only
重试在同一 trace + stage 的最大 attempt 上加 1；完整重跑新建 trace 并从 1 开始。写入约束为
`UNIQUE(trace_id, stage, attempt, event_type)`；命中同一幂等键时比较 `semantic_payload_hash`，相同视为安全重放，不同视为
一致性错误，不得覆盖原事件。

P0 的 `payload_hash` 输入是：移除 `payload_hash` 本身后的脱敏事件字段，以 `payload_schema_version=v1` 编码为
UTF-8 canonical JSON（对象 key 按 Unicode 码点升序递归排序；数组保留业务顺序；时间统一 RFC 3339 UTC；金额与
非整数数值使用十进制字符串；缺失值不写入，`null` 保留），再计算 SHA-256 小写十六进制。P1 不得变更 v1 的
解释；若需扩展，新增 schema version。

P0 不实现跨事件 hash 链。P1 如需实现，必须另行规定每 trace 的 `previous_hash → event_hash` 计算公式、重建工具和
每日外部 manifest；在这些规则齐备前，不得把 `payload_hash` 宣称为防篡改证明。

幂等比较只使用 `semantic_payload_hash`，它由 `payload_hash` 的 v1 输入**排除** `id`、`sequence`、`occurred_at`、
`duration_ms`、实时 token / cost、错误 stack 和其他运行时诊断字段后计算；完整 `payload_hash` 仍保存实际事件。
同一幂等键的重放先读取原事件并返回，不新写 event；只有相同 `semantic_payload_hash` 才是安全重放。P0 必须维护
canonical JSON 的固定测试向量，至少覆盖 Unicode key、数组顺序、整数/金额、`null` 与缺失字段。

### 4.3 `EntityRef`

所有输入输出均使用统一引用，不复制实体正文：

```ts
type EntityRef = {
  type: "source" | "source_config" | "topic" | "run" | "content_item" | "analysis_batch" | "insight" |
        "citation" | "citation_check" | "validation_result" | "tech_lead" |
        "tech_lead_evidence" | "direction" | "direction_map" | "opportunity" |
        "opportunity_lead" | "report" | "delivery" | "config";
  locator: {               // 两种形式均序列化为稳定的 entity_key
    kind: "id"; id: string;
  } | {
    kind: "composite"; key: Record<string, string | number>;
  };
  revision: string;        // content / direction / mapping / config 的不可变 revision；不可版本化实体用 not_versioned
  hash?: string;           // 对可公开元数据的 hash，非原文副本
  role: "input" | "output" | "evidence" | "filtered" | "superseded";
};
```

`entity_key` 是 `type + ":v1:" + base64url(canonical JSON(locator))`，其中 canonical JSON 使用 §4.2 的 v1 规则。
单 ID 实体使用 `kind=id`；复合实体必须使用以下 key，不得拼接含歧义的字符串：`citation_check` 为
`{batch_id, insight_id, citation_index}`，`citation` 为 `{insight_id, citation_index}`，`tech_lead_evidence` 为
`{lead_id, insight_id, citation_index}`，`direction_map` 为 `{lead_id, direction_id}`，`opportunity_lead` 为
`{opportunity_id, lead_id}`。新建可被引用的复合实体如有条件应增加不可变单 ID；在此之前，resolver 只能按该
canonical composite key 查询。每种 `type` 的 locator、revision 含义和 resolver 必须有单元测试。

`revision` 不是“当前行版本”的别名，而是不可变历史快照的键。P0 新增 `provenance_revision(entity_type,
entity_key, revision, captured_at, snapshot, snapshot_hash)`：`snapshot` 只含可解释的脱敏元数据，禁止复制未发布正文。
revision registry 是封闭契约，所有 type 必须有下列 revision generator、snapshot 白名单和 resolver，未列类型不得以
`not_versioned` 绕过原地更新：

| type                                                                                      | revision generator / snapshot 白名单                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source` / `source_config`                                                                | 脱敏来源配置 canonical hash；URL、类型、启停和选择规则，不含凭据                                                                                                                                              |
| `topic` / `direction`                                                                     | version 或结构化规划规则 canonical hash；名称、目标、词项、约束                                                                                                                                               |
| `content_item`                                                                            | `content-v2:${content_hash}`；URL、来源、发布时间、正文长度与正文哈希。`fetched_at` 是可变采集观测时间，不进入不可变 revision snapshot；历史 `content_hash`（v1）引用保留原样，**P0 不写 `raw_revision_ref`** |
| `analysis_batch` / `insight` / `citation` / `citation_check` / `validation_result`        | batch-scoped immutable key；窗口、纳入决定、verdict 和理由代码，不复制 quote / 正文                                                                                                                           |
| `tech_lead` / `tech_lead_evidence` / `direction_map` / `opportunity` / `opportunity_lead` | 每次原地更新前的 canonical snapshot hash；状态、lane、评分输入、规则版本、人工决定                                                                                                                            |
| `report` / `delivery` / `run` / `config`                                                  | 不可变 ID 或 canonical metadata hash；报告纳入清单、effect intent、Run 状态、运行配置版本                                                                                                                     |

业务表原地更新时必须先写对应 revision；历史查询不得以当前正文、方向或映射反向补全。P0 一律返回“历史正文未保留”，
不得暴露可能已指向新正文的 `raw_ref`。P1 如建设 content-hash 命名、不可变且授权可读的 raw archive，才可新增
`raw_revision_ref`，并要求归档 hash 等于本 revision 的 `content_hash`。

为避免每次下钻扫描 JSON，新增两个只读派生索引：

- `generation_entity_ref(trace_id, event_id, entity_type, entity_key, revision, role, visibility_class)`：完整保留
  `EntityRef` 的查询字段；
- `generation_edge(trace_id, event_id, from_type, from_key, from_revision, to_type, to_key, to_revision,
  relation, visibility_class)`：只记录明确的因果边，不以输入/输出的笛卡尔积猜测关系。

`relation` 受控为 `consumed`、`produced`、`validated`、`supports`、`filtered_by`、`derived_from`、
`decided_on`、`delivered_as`、`supersedes`、`retry_of`。`visibility_class` 是写入时不可变的
`public_evidence` / `admin_only` / `redacted_at_write` 分类，不是当前用户权限缓存。两个索引均可从事件重建，不是业务
事实源；实体被删除后，resolver 按当前删除/脱敏登记返回 `deleted` tombstone，保留 `type/entity_key/revision/role`
但不解析或泄露已删除正文。

### 4.4 关键版本上下文

每个会影响结果的活动应最少记录：

- 运行 Git SHA、OCI image digest、数据库 schema 版本；
- 分析/校验/追问的模型 ID 和 prompt 版本 hash；
- 选择窗口、来源配置版本、方向档案 version、映射规则版本；
- 输入内容的 `content_hash`、引用校验 verdict 与报告发布白名单结果。

运行版本必须有可验证事实源：镜像在 build 时注入 `GIT_SHA`；P0 新增
`provenance_meta`，在首次启用时以事务锁定 `provenance_started_at` 和 `provenance_schema_version`。运行时从这两个
来源快照，不得由镜像 tag、当前 Git 工作区或“最新 schema”推测。仅本地开发可把未知版本写为 `unknown` 并标记 trace
`partial`；生产环境任一必填运行版本为未知即拒绝成为 writer，不得继续生成报告。

构建必须把不可变 `GIT_SHA` 写入镜像内 `/app/build-info.json`。OCI manifest digest 只在镜像 push 后产生：部署必须以
`repo@sha256:…` 拉取并解析 RepoDigest，先原子写 `deployment_record(id, image_digest, git_sha, deployed_at, actor)`，再以
Compose environment 注入 `INSIGHT_IMAGE_DIGEST`。应用启动只在 env digest、最新 deployment record 与 build-info Git SHA
三者一致时成为 writer；deployment record 写入或任一校验失败必须中止切换并保留旧健康容器。`provenance_schema_version`
只来自 migration ledger 的最新已应用版本。

生产发布的唯一允许顺序为：push 镜像 → 解析 `repo@sha256` RepoDigest → migration / deployment-record writer 写入并验证
`image_digest + git_sha` → 将 `INSIGHT_IMAGE_DIGEST` 注入新容器 → 启动时三方校验 → health gate 后切换流量。record writer
失败、env 缺失或比对失败均回滚到旧健康镜像；本地 Compose 开发可不写 deployment record，但必须显式 `development` 模式并
使所有 trace 为 `partial`。

`version_context` 是事件发生时写入的不可变快照，查询时不得回查“当前配置”补齐历史。每项不适用字段必须显式为
`not_applicable`，缺失字段则标记 `context_completeness=partial`；发布、校验和方向映射活动不得以 `partial`
版本上下文标记为完整可重放。

不得记录 API key、Authorization header、完整 prompt、未发布原文、用户会话内容或个人资料。

### 4.5 迁移与部署协议

P0 通过单个、版本化的 `provenance-v1` migration 引入 schema；不得继续仅依赖启动期 `ensureColumn` 猜测状态。migration
先创建 `schema_migration(version PRIMARY KEY, checksum, applied_at)` ledger，再在短 `BEGIN EXCLUSIVE` 窗口按顺序创建
`generation_trace`、`generation_event`、`provenance_revision`、`generation_entity_ref`、`generation_edge`、
`generation_effect`、`generation_lease`、`provenance_redaction`、`provenance_meta` 及其索引/immutable trigger，最后增加
`generation_trace_request`、`generation_dispatch`、`deployment_record` 及其索引/immutable trigger，最后增加可空
`run.trace_id REFERENCES generation_trace(id)`；`generation_trace.root_run_id REFERENCES run(id) DEFERRABLE INITIALLY DEFERRED`。

每个 migration 必须记录 DDL checksum 并在同一数据库锁内执行；失败则回滚、记录失败日志并拒绝应用启动，不能半迁移继续提供
写服务。发布由一次性 `migration runner` 执行，固定顺序为：暂停 cron/入口写流量 → drain 或标记在途 Run → 停止旧 writer
→ 备份 SQLite → runner 迁移 → schema/health gate → 启动新版本 → 恢复 cron。任一步失败都保持旧容器停止、从迁移前备份
恢复数据库并重新启动旧镜像，不能让新旧 writer 并发。旧二进制只在 `run.trace_id` 尚可为空时短暂只读兼容，迁移完成后不允许
旧二进制写入。`provenance_started_at` 与 migration 成功标记在同一事务锁定；既有 Run 保持 `trace_id=NULL` 并在查询中显示
`legacy`，绝不回填伪造链路。上述停写、恢复和 mixed-version 拒绝须有部署集成测试。

实现上，应用启动路径不得再执行 provenance DDL：`openDb()` 仅校验 ledger 已含目标版本，否则以明确 health error 拒绝
成为 writer。runner 由同一发布镜像的专用命令运行，并由部署编排在任何 app 容器启动前完成；Compose/生产部署脚本必须
显式执行 pause/drain/backup/runner/schema gate/roll back，不能把 `docker compose up` 当作迁移机制。

## 5. 行为规约

1. 按 §4.1.1 创建根 trace 与首个 Run；同一主题流水线的后续 Run 显式继承 `trace_id`，跨主题采集以输入 trace
   或实体引用关联，不共享根 trace。
2. 每个阶段至少写一个起始/intent 事件和一个终态事件；失败、跳过、空结果和“无重要事件”必须有不同 `reason_code`。
3. 分析选择应同时写入候选数、选中数、过滤数及分类原因；validator 写 `pass` / `blocked` / `flagged` 数和原因分布。
4. 技术线索与机会投影失败不得阻断已校验报告发布，但必须记录失败事件和受影响实体。
5. 人工更新 Lead 状态、机会状态、方向词项或重投影时，复用 `audit_log`，并新增带前后版本及 `audit_log.id` 的
   `generation_event`；`actor_id` 必须是实际操作者身份，无法识别时标记为 `unknown` 和 `coverage=partial`，不得冒充
   `admin`。重投影不得改写既有人工状态。
6. 报告发布事件必须列出实际纳入的 Insight / CitationCheck，以及被拒绝或过滤的洞察计数；Brief 的 freshness 指标必须写入。
7. 重试新建事件和 Run，不覆盖原失败记录；以 `retry_of_trace_id` / `retry_of` 建边。
8. V1 不做事件采样；生产生成链路事件必须完整。高频调试日志可采样，但不等于溯源事件。

9. 事件粒度以“阶段一次尝试”为主，不为调试输出逐行建事件；每个输入/输出实体仍完整写入
   `generation_entity_ref`。脱敏后的 `metrics + error + version_context` 合计最大 16 KiB，超出部分只允许写
   聚合计数、稳定摘要和 `truncated=true`，不得静默丢失实体引用。

10. 同一 SQLite 业务写入中的业务实体、`generation_event`、revision、entity-ref / edge 索引以及 trace 投影必须
    同事务提交；每个阶段使用 `(trace_id, stage, attempt, event_type)` 幂等键。外部副作用不可能与 SQLite 两阶段提交，
    因而 P0 使用 `generation_effect(id, trace_id, event_id, kind, idempotency_key UNIQUE, artifact_manifest,
    status, created_at, updated_at)` 持久记录 intent；`kind` 仅为 `report_file` / `raw_archive`，status 为 `planned` /
    `attempted` / `committed` / `unknown` / `abandoned`。`artifact_manifest` 是受控 JSON：每项仅含相对目标路径、SHA-256、
    size 与 `report_id?`；路径必须位于对应 allowlisted 根目录，拒绝绝对路径、`..` 和符号链接逃逸。
11. 对报告文件和 raw archive，worker 以 effect ID 写 staging 路径，校验 artifact manifest 的 SHA-256 后原子 rename 到最终路径，再写
    `committed` 终态；启动 reconciliation 扫描 `planned` / `attempted` / staging / 最终文件，按 idempotency key、manifest hash 和
    manifest entry 的目标路径重试、提交或标为 `unknown`，绝不静默删除孤儿。报告删除、raw 清理也必须先写 effect / audit，再同步删除文件与
    SQLite 业务引用。P0 不把调用未抛错当作成功。
12. 事件序号由同一事务中的 trace counter 分配：`BEGIN IMMEDIATE` 后递增 counter、插入 event 和派生索引；遇到
    `SQLITE_BUSY` 或唯一冲突按有限指数退避重试，超限后写可解释失败。启动恢复必须返回 orphan Run 明细；对带 trace 的
    Run 在同一事务写 `Run.failed`、追加 `failed(reason_code=process_recovered)` 和重算 projection。legacy/no-trace Run
    只按原有 Run 恢复，并标记不可补写 provenance。
13. P0 的 `deliver` 不进入 `generation_effect` reconciliation，也不保存 webhook、收件人或可重建通知 payload；只记录
    `stage=deliver,event_type=planned|attempted|skipped` 的不可重放审计，其中 `attempted` 是本阶段的合法终态但不代表投递成功。
    UI 固定显示“已记录尝试，渠道结果未知”，不得将其计入成功率或 trace `partial`。只有 P1 引入最小化、脱敏且可能重复的
    持久 delivery outbox 并取得渠道终态后，才允许记录 `completed` / `failed` 并作为非阻断阶段参与聚合。
14. 报告对外发布必须以一个 `report_file` manifest effect 管理其 `.md` 与 `.html` 两个 artifact。报告行先以
    `status=generating` 与 `planned` effect 在同一 SQLite 事务写入；仅在 manifest 中全部 artifact 经 staging、hash 校验和
    原子 rename 后，才在**同一 SQLite 事务**将 effect 标为 `committed`、报告改为 `done`、插入 `report_index` 与
    `report_fts`、写 `generate_report.completed/published` 并重算 trace。所有普通读路径必须经 `published_report` resolver /
    SQL view：`getReport`、按 ID 页面/API、首页、列表/筛选、distinct、主题统计、FTS 搜索、PPT 与 follow-up 均强制
    `report.status='done'`；admin lifecycle resolver 才可读取 `generating/failed`，且不得复用 public DTO。任何 crash 窗口均由 reconciliation 收敛：只有 staging →
    重试，只有完整最终文件 → 校验后提交，hash 不匹配或缺件 → `unknown` / report `failed`；`generating` / `failed` 报告
    不得从 reader API 或发布索引可见。必须覆盖双文件、索引/FTS 最终提交、重复 reconcile、hash 不匹配与 rename 后崩溃的集成测试。

## 6. 产品界面

### 6.1 产物级“生成链路”

在 Brief、报告、技术线索、机会和方向编辑历史中提供“查看生成链路”：

- 默认时间线：阶段、时间、耗时、输入/输出数、状态、成本、操作者；
- 可展开的因果图：仅展示当前产物的祖先、证据和人工决策，避免全库大图；
- “事实 / 系统派生 / 人工决定”三种视觉标签；
- 每个 `pass` 引用可继续跳转原文与 CitationCheck；`blocked` / `flagged` 仅向管理员展示原因；
- 版本差异：方向词项、模型/规则、输入窗口变化及重投影差异。

P0 的图查询采用硬预算：时间线最多 100 条事件一页，因果图最多 4 跳、500 个 ref / edge；超出时返回管理员可见的
`truncated` 与继续分页游标，不作全库或无界递归扫描。P0 仅展示单 trace；跨来源/模型/版本比较属于 P1。

### 6.2 管理驾驶舱（P1）

在 P1 提供按时间、主题、来源、模型、版本和 trace 筛选的四类视图；P0 仅提供单 trace 的 admin 查询。

| 视图         | 核心问题                                         |
| ------------ | ------------------------------------------------ |
| 阶段漏斗     | 内容为何没有成为报告、线索或机会？               |
| 质量与新鲜度 | 引用拦截、有效 yield、Brief 时滞是否恶化？       |
| 成本与性能   | 哪个模型/来源/阶段带来 token、金额或耗时异常？   |
| 规划反馈     | 映射准确率、各 lane 人工采纳率和错分原因是什么？ |

首批指标：采集成功率/重复率、正文 partial 率、分析 yield、Citation `pass` 率、阻断原因分布、
报告 freshness、`Lead → Opportunity → research_candidate` 转化率、人工采纳/忽略率、每阶段 P50/P95
耗时和每有效产物成本。

## 7. 审计、权限与保留

- P0 沿用现有全局 `admin` / `viewer` 模型，不假设尚不存在的实体 ACL。授权矩阵固定为：匿名请求全部拒绝；viewer
  仅可从已发布报告入口读取报告及其 `pass` 证据的标题/URL/quote/locator；admin 可读取所有资源。Graph、Topic 聚合、
  Lead、Opportunity、Direction 及其页面/API/drill 全部 admin-only，不能以其现有可读性绕过发布/引用白名单。生成链路、
  失败原因、成本、模型/规则版本和人工审计同样 admin-only。实体 ACL 成为需求后再扩展本契约。
- 事件 payload 先经统一脱敏器处理；错误仅保留安全摘要和稳定 reason code。
- 事件 API 必须先做实体级授权，再展开引用：对无权读取、未发布、`blocked` / `flagged` 或已删除实体，只返回
  `redacted` / `deleted` 占位和经授权的聚合计数，绝不返回 ID、URL、标题、错误原文或可反推正文的版本字段。
- provenance resolver 采用 default-deny 字段白名单，UI 不得自行根据 `visibility_class` 决定字段。viewer 不返回
  `redacted_count`、隐藏项分页总数、actor、错误、方向词项、source 配置、snapshot hash 或任一 admin-only 元数据，
  防止通过聚合或翻页反推受限对象；admin 的 redaction 也只返回 reason code。
- P0 为 `generation_event` 的更新/删除建立 SQLite 拒绝 trigger，并且仓库不提供更新/删除 API。SQLite 仍不是
  防篡改存储，数据库管理员可绕过这一约束。
- 删除类别必须区分：(a) 运营清理报告/raw，(b) 业务实体删除，(c) 个人数据擦除。P0 不物理清理完整事件；P1 才可通过
  受审计归档任务，将已校验 trace 摘要和 manifest 写入异地存储后清理超过 90 天的完整事件。已发布报告、已采纳机会和
  方向决策保留可下钻的溯源摘要直至其业务实体删除。
- P1 将每日 hash manifest 随现有异地备份写入 S3，形成可校验锚点；不引入区块链。
- 查询 UI 只访问索引和已授权实体；原文继续按当前引用/鉴权规则读取。
- `visibility_class` 只描述写入时敏感性；每次响应仍以当前角色、发布状态和 `provenance_redaction` 重新判定。用户
  删除或实体硬删除时，不改写事件：追加 `provenance_redaction(entity_key, scope, reason, at)`，resolver 返回匿名 actor
  或 `deleted` tombstone。redaction 记录及其最小匿名化映射必须至少保留到所有可恢复备份的最大窗口结束；任何备份恢复后
  必先重放仍有效的 redaction，再允许 API 提供查询。为覆盖“恢复点早于删除”，删除请求必须先写入独立于业务 SQLite
  备份的 append-only `redaction registry`。每条 registry 同时保存 `record_id`、`entity_key_hmac`（去重/索引）、以
  KMS envelope encryption 加密的最小 `entity_key` 定位信息、`kms_key_version`、`hmac_key_version`、scope、reason code、
  effective_at、expiry_at；
  `record_id=base64url(HMAC(REDACTION_HMAC_KEY, canonical(entity_key, scope, deletion_request_id)))`，`entity_key_hmac` 使用相同
  key version 但独立 domain separator。HMAC 不承担恢复定位；不可猜测的 record ID 使 412 只能代表同一删除请求的先前写入，
  不依赖应用角色读取对象。

  P0a 的 registry 固定部署在生产 AWS `ap-southeast-1` 的独立 S3 bucket
  `<AWS_NAME>-redaction-registry-<account-id>`，不可复用 `*-backups-*`。bucket 必须阻断公开访问、启用 versioning、
  Object Lock **Compliance** mode、**创建 bucket 时配置的 default Compliance retention=100 days** 和默认 SSE-KMS；每个对象使用
  prefix `records/YYYY/MM/<record_id>.json`，必须以
  `If-None-Match: *` 条件 `PutObject` 创建，禁止覆盖和删除。稳定 record ID 命中 412 表示先前写入可被安全重试引用，绝不
  写新版本覆盖原对象。`effective_at` 固定为 registry 成功写入时刻；bucket default retention 自动给出 100 天 retain-until
  （现有 S3 DR 最长 90 天加 10 天恢复余量），应用不得传对象级 retention header，也不拥有 `s3:PutObjectRetention`；
  bucket lifecycle 只能在 Object Lock 到期后清理旧版本。实体定位信息还必须用该 bucket 专用 CMK 的 `GenerateDataKey` envelope
  encryption 形成 ciphertext / encrypted data key；`REDACTION_HMAC_KEY` 来自 AWS Secrets Manager 的版本化 secret
  `<AWS_NAME>/redaction-hmac/<version>`，不写入 SQLite、事件、镜像、`.env` 或备份。CMK 轮换后旧 key material 与 HMAC secret
  version 至少保留至所有引用记录的 retain-until 结束。

  应用实例角色只可向 `records/` 新建对象，并可 `kms:GenerateDataKey` / `kms:Encrypt`；明确拒绝 `GetObject`、`DeleteObject`、
  `s3:PutObjectRetention`、`s3:BypassGovernanceRetention` 与 registry CMK 的 `kms:Decrypt`。应用与恢复 runner 仅可读取指定
  `redaction-hmac/*` Secrets Manager secret version，并仅可对该 secret 的 KMS key 以 `kms:ViaService=secretsmanager.ap-southeast-1.amazonaws.com`
  解密；清理角色没有 Secrets Manager 或该 KMS key 权限。受控的灾难恢复角色才可 `ListBucket` / `GetObject` / registry-CMK
  `kms:Decrypt`，且只能在恢复 runner 中使用；到期清理角色与应用角色分离。删除命令先在内存中生成 HMAC、校验 canonical schema 并用稳定 `record_id`
  条件写外部记录，再在
  同一业务 SQLite 事务写 `provenance_redaction` 和删除/tombstone；外部写入、加密或 HMAC 校验失败时 fail-closed，禁止删除业务数据。
  外部成功而 SQLite 事务失败时保留孤立 immutable record，重试必须复用同一 record_id；遇到 412 仅引用既有对象，不能删除、新建第二条
  或覆盖原对象。

  恢复 runner 必须在复制任一 SQLite/报告备份后、启动 app 前，从 registry 读取 `effective_at <= restore_time < expiry_at` 的记录，
  解密、验证 HMAC 并以幂等事务重放到本地 `provenance_redaction`；registry 不可读、KMS 不可用、签名不合法、记录缺失或重放失败时
  必须终止恢复，app/worker 保持停止。恢复日志仅输出 record count、key version 和 reason code，不输出 entity key。所有删除命令、
  backup/restore、S3 DR 和 viewer resolver 必须接入此协议；归档/备份不得保存可还原的个人资料、正文或已清理文件路径。
- 新人工动作必须通过 `requireAdminActor()` 取得可信 `{id, role}`，并在同一事务写 `audit_log` 与 event。
  共享密钥/旧记录无法归属个人时使用 `actor_type=system, actor_id=shared-admin-unattributed` 且 coverage 为 `partial`，
  不得伪造用户身份。

## 8. 实施切片

### P0a：报告可追溯纵切（首个可发布切片）

1. 新增 trace / event / revision / entity-ref / edge / redaction / meta schema、写入 API、统一脱敏和 v1
   `payload_hash`；为 `Run` 增加 `trace_id`。事件必须有 `(trace_id, sequence)` 与阶段幂等唯一约束，查询索引至少
   覆盖 `trace_id + sequence`、`event_id`、`entity_type + entity_key`。
2. 实现 §4.1.1 / §4.1.2 的持久 trace request registry、trace factory、`reserved → owned → released` lease、领取后才绑定的
   root Run、零输入终态和 projector；实现与 request/trace/reservation 同事务创建的 `generation_dispatch`、独立 worker 的原子
   claim/heartbeat/recovery/drain、`GET /api/generation-traces/{trace_id}` 和 queue-age health gate。实现事务内 sequence allocator、
   业务数据与溯源数据的原子写入、幂等、effect reconciliation 与 orphan recovery 补事件。
3. 替换 provenance 相关的启动期 DDL：实现同镜像 migration runner、`openDb()` ledger gate，以及 pause/drain/backup/
   runner/health/rollback 的 Compose 与生产部署编排；禁止 mixed-version writer。
4. 接入 `topic_pipeline` 的 analyze → validate → report，并为其实际输入的 Content / Batch / Insight / Citation /
   ValidationResult 写最小 revision snapshot。现有 `runTechLeadExtraction` 仍在 validate 后运行，P0a 必须将其 Lead /
   DirectionMap / Opportunity 写入、非阻断失败、revision 和 fencing 全部作为同一 trace 的 `non_blocking` 阶段纳入；只将
   这些实体的专属 UI 与人工编辑留给 P0b，禁止在 P0a 静默跳过或以无 trace 的副作用继续写入。
5. 在已发布报告页提供 admin-only 单 trace 时间线、`pass` 引用下钻和 viewer 白名单视图；把角色矩阵、viewer 字段白名单、
   `blocked` / `flagged` 访问控制及 public-reader inventory 全部前移到 P0a。inventory 至少覆盖 `getReport`、按 ID 页面/API、
   首页、列表/筛选、distinct、主题统计、FTS、PPT、follow-up；它们必须经 published-report resolver 且过滤
   `report.status='done'`。Graph、Topic 聚合、Lead、Opportunity、Direction 的页面/API/drill 则必须进入 admin-only route
   inventory。现有报告页的 blocked 检查仅 admin 可查询/渲染。P0a 完成前不开放 viewer provenance。
6. 设定 `provenance_started_at` 切换点并锁定运行版本事实源：切换点前的产物显示“历史产物，溯源覆盖不完整”，不得
   回填或伪造当时的模型、镜像、规则及输入窗口。
7. Docker build 必须生成 `/app/build-info.json`，发布镜像和部署配置必须传递/校验 `INSIGHT_IMAGE_DIGEST`；为缺失、
   不匹配和成功注入分别写部署集成测试，确保 P0a 报告能记录运行镜像而不是系统性 `partial`。
8. 按 §7 固定部署创建时启用 default-100-day Compliance retention 的独立 S3 Object-Lock + SSE-KMS redaction registry、
   应用/恢复/清理三类最小 IAM 角色、Secrets Manager HMAC version read policy 和 key rotation；实现稳定 record-id 的幂等写入、
   恢复 runner 的 decrypt/verify/replay 和 fail-closed gate，并接入 cleanup、用户删除、backup/restore、S3 DR 和 viewer resolver；
   未接入前不得启用 P0a 的删除入口或 viewer provenance 查询。
9. 为上述阶段写单元/集成测试，验证固定 slot/API 幂等与 active 冲突返回、状态机真值表（含 `no_releasable_insight` failed
   Report、无 artifact/index/FTS、重试不覆盖）、lease 续租/接管后旧 owner 拒绝写入、Lead/Map/Opportunity 各 stage 的部分失败、
   无悬空实体、事务/恢复、重复投递安全重放/冲突拒绝、引用白名单、viewer 脱敏、双文件 report effect 的 staging/reconcile、
   按 ID/index/FTS 可见性、redaction fail-closed/恢复重放/权限拒绝，以及 202 后 Web 退出、双 worker claim 竞争、claim 接管、
   未领取不得创建 root Run、旧 worker 拒写、drain、`trace_id` 状态查询与序号并发追加。

### P0b：采集与规划链路

1. 接入 `source_collect`、Content 不可变 revision、Direction / 人工决定及复合 locator；采集失败
   事件必须分别标明已提交、已回滚和未知 output refs。
2. 增加线索、机会、方向页的 admin-only 时间线和证据下钻；人工写路径接入 `requireAdminActor()` 与同事务 audit。
3. P0 不写 `raw_revision_ref`；如需历史正文跳转，移至 P1 不可变 archive。

#### P0b-1：定时采集 Trace 与 Content revision

- 每个启用来源在一个 UTC 小时槽内至多登记一个 `source_collect:{source_id}:{hour}` request；同步执行先取得
  owned lease，再创建首个 `ingest` Run 并绑定 `root_run_id`。同槽重入返回原 trace；活跃来源冲突返回既有 trace，
  不得并行写入同一来源。
- `collect` 与 `normalize` 各有 started / terminal event；Source 配置以脱敏 canonical snapshot 固化，每个新建或
  更新的 ContentItem 在业务 upsert 同一 SQLite 事务内写入 `content-v2:${content_hash}` revision。snapshot 仅含 URL、
  来源、发布时间、正文长度与 hash，禁止 `raw_ref`、原文或 raw archive 指针。
- 失败事件只引用已提交的 Content revision，并分别给出 `committed_output_ref_count`、
  `rolled_back_output_ref_count` 和 `unknown_output_ref_count`。无法证明已提交的输出不得伪造 entity ref；所有三个计数
  均须显式写入，即使为 0。
- 本切片只覆盖定时采集；按需采集与失败 Run 的人工重试在后续 P0b 工作中接入调用方 idempotency / actor 审计，不改变
  现有管理员操作语义。

#### P0b-2：规划人工决定与管理员下钻

- 技术线索、技术机会和方向工作台仅在管理员会话中显示其最近一次 output Trace；时间线继续通过 admin-only
  resolver 读取，普通用户只能看到既有的已校验 `pass` 证据，不返回 Trace ID、actor、版本或失败信息。
- Lead / Opportunity 状态、方向创建 / 状态变更 / 完整编辑 / 显式重投影必须要求 `Idempotency-Key` 与
  `requireAdminActor()`。一次成功决定在同一个 SQLite 事务写业务更新、`audit_log`、`manual_decision` Trace、
  started + `manual_decided|config_changed` 事件、输出 revision 与 request/lease 终态；相同 key 在 24 小时内返回原 Trace，
  不覆盖人工事实。
- 人工 Trace 的 locator 使用实体类型 + 稳定 ID；方向 revision 包含版本和完整规则快照，Lead / Opportunity revision
  包含状态、评分与其确定性输入的最小脱敏快照。分数以稳定十进制字符串存入 snapshot，禁止浮点序列化漂移。
- 本切片不回填 P0b-2 前的人工动作，也不把 `raw_ref`、原文、提示词、密钥或渠道结果写入 event / revision。

#### P0b-2a：管理员单主题 Daily Brief

- 管理员可在主题页和设置页通过 `POST /api/topics/{topic_id}/brief` 对一个启用主题登记一次标准 `brief`；路由只写
  request / trace / lease / dispatch，实际 analyze → validate → report 仍必须由 generation-dispatch worker claim 后执行。
  它不得调用全局 cron、采集其他来源或主题，也不得直接写报告、Run 或业务数据。
- 请求必须携带长度 8–128 的 ASCII `Idempotency-Key`，并由 `requireAdminActor()` 取得可信 actor；只保存 key 的 HMAC。
  canonical 幂等边界是 `topic_pipeline:{topic_id}:brief:{UTC date}`：同一主题同一 UTC 日的重复请求返回既有 trace（200），
  不因更换 key 产生第二份日报；不同日但上一个 brief 尚持有 lease 时返回
  `409 { code: "active_generation", active_trace_id }`。
- 成功受理返回 202，冻结现行 `PIPELINE_WINDOW_HOURS`（默认 168）、`PIPELINE_ITEMS_PER_TOPIC`（默认 15）及
  `window_end`，并在创建 trace / request / lease / dispatch 的同一 SQLite 事务写 `audit_log` 和 `select/planned` event。
  audit 只记录 actor、topic、trace/request ID、报告类型、UTC period、窗口与条数，禁止记录明文 key、正文、提示词或密钥。
- UI 仅管理员可见，触发前必须显示成本/窗口确认提示，并基于 `/api/generation-traces/{trace_id}` 展示受理后的 worker
  状态；普通用户既不可见入口，也会被 middleware 与 handler 的双重鉴权拒绝。

### P0c：容量与受限视图

1. 实现分页/图遍历预算；删除、恢复和 viewer 授权均是 P0a 的前置条件，P0c 只扩展受限图形视图与容量验证。
2. 以只读生产规模测量生成匿名 benchmark fixture，并记录 DB 大小、并发 writers、每 trace event/ref/edge P50/P95、
   page size、图深度、SQLite pragma、磁盘/机器规格及 query plan；关键查询须以 `EXPLAIN QUERY PLAN` 验证索引命中。
3. P0 性能门只对该版本化 fixture、`page_size≤100`、图深度≤4、图元素≤500 和记录的机器规格生效。

### P1：优化驾驶舱与完整性锚定

1. 漏斗、版本 diff、阶段成本/时延和失败归因看板。
2. 方向重投影影响对比，人工标签与映射质量的关联分析。
3. 规范 hash 链与每日 hash manifest 外部备份、归档及完整性校验工具。
4. 持久 delivery outbox 和渠道终态；为来源/主题/模型/版本建立规范化筛选列与索引，不扫描 JSON 完成驾驶舱筛选。
5. content-hash 命名的不可变 raw archive 与历史正文授权跳转。

### P2：隔离重放与外部互操作

1. 基于历史 `input_refs + version_context` 生成只读重放计划，并在独立 SQLite/容器运行。
2. 可选导出兼容 OpenLineage 的 Run / Job / Dataset 事件；内部契约不依赖外部后端。

## 9. 验收标准

- [x] P0a 后，`provenance_started_at` 之后生成的任一生产 Brief 可在一个页面内回溯到输入批次、纳入洞察、所有 `pass`
  引用、模型/规则版本与运行镜像；切换点前的 Brief 明确显示为 `legacy` 或 `partial`。
  - 报告纵切的生产证据已通过：`docs/verify/p0a-production-report-acceptance-2026-08-04.md`。该样本是 Deep Dive，不能替代本 AC 要求的 Brief。
  - 正常日报的验收步骤与证据模板见 `docs/verify/p0a-brief-production-acceptance-runbook.md`；非空生产 Brief 已于 2026-08-08 通过，证据见 `docs/verify/p0a-brief-production-acceptance-2026-08-08.md`。
- [x] P0b 后，切换点后生成或变更的任一技术机会可回溯 Lead、方向 revision、mapping lane、优先级明细和全部人工决定；复合实体
  引用可被唯一解析，历史快照不会被当前业务行覆盖。生产证据见
  `docs/verify/p0b-production-planning-acceptance-2026-08-12.md`。
- [ ] 每个 trace 的 `completion_policy` 中所有阶段都具有终态或可解释的进行中状态；失败、跳过、空刊不可混淆。
- [ ] 根 Run、子 Run 与 trace 的 `done` / `failed` / `partial` / `cancelled` 聚合符合 §4.1，且不反向改写既有 Run 状态。
- [ ] SQLite 业务写入、event、revision、索引和 trace 投影要么一起提交，要么均不可见；文件等外部副作用通过
  `generation_effect` 的 intent、staging、hash 校验和 reconciliation 达到可解释的至少一次处理，P0 不声称渠道成功。
- [ ] 重试、重投影与人工决策都保留历史，不覆盖原记录；事件不含密钥、完整 prompt、原文副本或未授权信息。
- [ ] 在版本化 benchmark fixture、记录的机器/SQLite 配置、`page_size≤100`、图深度≤4 和图元素≤500 下，单产物链路页面
  P95 < 2 秒，单 trace 查询 P95 < 1 秒；关键查询的 query plan 命中规定索引。
- [ ] P1 可按来源/主题/版本比较 `collect → report` 漏斗、freshness、耗时、成本与 validator 拦截原因，且筛选命中索引。
- [ ] P1 的任意完整性校验失败可定位到 event 范围并告警；不影响已发布报告的读取。P0 仅校验 payload 格式、
  哈希重算和顺序完整性，不将其宣称为防篡改保证。

## 10. 质量门与发布策略

P0 不改变 analyzer、validator、模型、prompt 或数据源；但 P0a 会把现有 `releasable=false → Report.failed` 质量契约
落实到当前报告路径，因此不能只以“元数据改动”作为质量证明。使用
`Eval-Gate: scoped (deterministic report lifecycle/effect publishing; report-gen production-path regression)`；必须运行
`releasable=false`、空批次、可发布报告、DB/index/FTS/reader、失败 Report 重试和引用白名单的真实 report-gen 生产路径回归，
以及 typecheck、全量测试和 build。若后续加入自动归因、LLM 解释、语义聚类或重放改变 AI 输入/输出，则必须先补专用数据集并
执行完整 Eval-Gate。

## 11. 设计依据

- W3C PROV 的 Entity / Activity / Agent 用于区分产物、处理和执行者。
- OpenTelemetry 的 trace、log、metric 关联用于统一 `trace_id` 和运行观测。
- OpenLineage 的 Run / Job / Dataset 及可扩展 facet 模型用于事件契约和未来导出边界。
