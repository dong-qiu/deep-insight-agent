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
  → Deliver             → Push outcome
                     ↘ Human review / direction edit / opportunity decision
```

每条实线是 `generation_activity`，每个方框是既有业务实体引用；人工动作也作为活动写入，且不能与系统派生
混淆。技术机会读取事实时仍必须回到 `TechLeadEvidence → CitationCheck(verdict=pass)`，本能力不得创建
绕过引用白名单的旁路。

## 4. 数据契约

既有 `Run`、`audit_log`、业务表仍为其各自事实源；新增表只存可查询的溯源元数据和实体引用。

### 4.1 `generation_trace`

一次根触发的汇总记录；通常与根 `Run` 一一对应。

| 字段 | 说明 |
|---|---|
| `id` | 全局唯一 `trace_id` |
| `root_run_id` | → `Run.id`，人工纯决策可为空 |
| `trigger_kind` | `cron` / `api` / `manual` / `retry` / `backfill` / `reproject` |
| `topic_id?` / `report_id?` | 根作用域，允许跨主题采集 trace 为空 |
| `started_at` / `ended_at` / `status` | `running` / `done` / `failed` / `partial` / `cancelled` |
| `parent_trace_id?` / `retry_of_trace_id?` | 深挖、重试和派生运行的关联 |
| `runtime_version` | Git SHA、镜像 digest、schema 版本 |
| `summary` | 各阶段数量、耗时、成本、错误摘要；不含正文 |

`Run` 仍是单个 agent 执行的状态事实源，且其枚举保持 `running` / `done` / `failed`；`generation_trace.status`
只是跨 Run 的只读聚合，不能反向更新 Run。聚合规则如下：

- `running`：根 Run 或任何必需子 Run 仍在运行；
- `done`：根 Run 与所有必需子 Run 均为 `done`；`skipped`、无重要事件和空刊是 event reason，不使 trace 失败；
- `failed`：根 Run 为 `failed`，或任一必需阶段失败而未产生可发布的终态；
- `partial`：根 Run / 报告已 `done`，但明确标为非阻断的派生步骤（例如 Lead / Opportunity 投影或投递）失败；相应
  Run 仍为 `failed`，失败原因必须出现在 trace summary；
- `cancelled`：仅用于未来支持取消的触发。在现有 Job Runner 未新增 `cancelled` 前，取消一律以
  `Run.status=failed` + `error.type=cancelled` 记录，并将 trace 聚合为 `cancelled`。

同一 trace 只能有一个 `root_run_id`；无 Run 的纯人工决策 trace 不使用上述 Run 映射，而以最后一个
`manual_decided` / `config_changed` 事件决定终态。

### 4.2 `generation_event`

追加式事件表，按 `trace_id, occurred_at, id` 排序。应用层不得 `UPDATE` / `DELETE` 已写事件。

| 字段 | 说明 |
|---|---|
| `id` / `trace_id` / `parent_event_id?` | 事件身份与树形父子关系 |
| `run_id?` | → `Run.id`，复用现有重试、成本和状态追踪 |
| `stage` | 见下方受控阶段表 |
| `event_type` | `started` / `completed` / `failed` / `skipped` / `retried` / `manual_decided` / `config_changed` / `published` |
| `occurred_at` / `duration_ms?` | 时序与阶段耗时 |
| `actor_type` / `actor_id?` | `system` / `user` / `scheduler`；人工需保留账号审计关联 |
| `reason_code?` | 机器可聚合的失败、跳过或人工决定原因 |
| `input_refs` / `output_refs` | 结构化实体引用数组，见 4.3 |
| `metrics` | 数量、token、金额、freshness、重试次数等小型 JSON |
| `version_context` | 模型、prompt/config、方向规则、Git/镜像的版本引用 |
| `error` | 脱敏后的错误类别、消息摘要、retryable；不存 stack / 凭据 |
| `previous_hash?` / `event_hash` | 事件序列完整性锚点；V1 先计算，P1 再做外部锚定 |

`stage` 受控为：`collect`、`normalize`、`select`、`analyze`、`validate`、`derive_lead`、
`map_direction`、`derive_opportunity`、`generate_report`、`deliver`、`human_review`、`direction_change`。

### 4.3 `EntityRef`

所有输入输出均使用统一引用，不复制实体正文：

```ts
type EntityRef = {
  type: "source" | "content_item" | "analysis_batch" | "insight" |
        "citation_check" | "tech_lead" | "direction" | "direction_map" |
        "opportunity" | "report" | "delivery" | "config";
  id: string;
  revision?: string;       // content_hash、方向 version、配置/规则版本等
  hash?: string;           // 对可公开元数据的 hash，非原文副本
  role: "input" | "output" | "evidence" | "filtered" | "superseded";
};
```

为避免每次下钻扫描 JSON，新增只读派生索引 `generation_edge(trace_id, event_id, from_type, from_id,
to_type, to_id, relation)`；它可从事件重建，不是业务事实源。

### 4.4 关键版本上下文

每个会影响结果的活动应最少记录：

- 运行 Git SHA、OCI image digest、数据库 schema 版本；
- 分析/校验/追问的模型 ID 和 prompt 版本 hash；
- 选择窗口、来源配置版本、方向档案 version、映射规则版本；
- 输入内容的 `content_hash`、引用校验 verdict 与报告发布白名单结果。

不得记录 API key、Authorization header、完整 prompt、未发布原文、用户会话内容或个人资料。

## 5. 行为规约

1. 根 Job 创建 `Run` 时同步创建 `generation_trace`；所有子 Run、重试和 cron 任务显式继承 `trace_id`。
2. 每个阶段至少写 `started` 和一个终态事件；失败、跳过、空结果和“无重要事件”必须有不同 `reason_code`。
3. 分析选择应同时写入候选数、选中数、过滤数及分类原因；validator 写 `pass` / `blocked` / `flagged` 数和原因分布。
4. 技术线索与机会投影失败不得阻断已校验报告发布，但必须记录失败事件和受影响实体。
5. 人工更新 Lead 状态、机会状态、方向词项或重投影时，复用 `audit_log`，并新增带前后版本的 `generation_event`；重投影不得改写既有人工状态。
6. 报告发布事件必须列出实际纳入的 Insight / CitationCheck，以及被拒绝或过滤的洞察计数；Brief 的 freshness 指标必须写入。
7. 重试新建事件和 Run，不覆盖原失败记录；以 `retry_of_trace_id` / `retry_of` 建边。
8. V1 不做事件采样；生产生成链路事件必须完整。高频调试日志可采样，但不等于溯源事件。

## 6. 产品界面

### 6.1 产物级“生成链路”

在 Brief、报告、技术线索、机会和方向编辑历史中提供“查看生成链路”：

- 默认时间线：阶段、时间、耗时、输入/输出数、状态、成本、操作者；
- 可展开的因果图：仅展示当前产物的祖先、证据和人工决策，避免全库大图；
- “事实 / 系统派生 / 人工决定”三种视觉标签；
- 每个 `pass` 引用可继续跳转原文与 CitationCheck；`blocked` / `flagged` 仅向管理员展示原因；
- 版本差异：方向词项、模型/规则、输入窗口变化及重投影差异。

### 6.2 管理驾驶舱

提供按时间、主题、来源、模型、版本和 trace 筛选的四类视图：

| 视图 | 核心问题 |
|---|---|
| 阶段漏斗 | 内容为何没有成为报告、线索或机会？ |
| 质量与新鲜度 | 引用拦截、有效 yield、Brief 时滞是否恶化？ |
| 成本与性能 | 哪个模型/来源/阶段带来 token、金额或耗时异常？ |
| 规划反馈 | 映射准确率、各 lane 人工采纳率和错分原因是什么？ |

首批指标：采集成功率/重复率、正文 partial 率、分析 yield、Citation `pass` 率、阻断原因分布、
报告 freshness、`Lead → Opportunity → research_candidate` 转化率、人工采纳/忽略率、每阶段 P50/P95
耗时和每有效产物成本。

## 7. 审计、权限与保留

- 普通用户只能读取已发布产物及其 `pass` 证据链；管理员才能查看失败原因、成本、模型/规则版本与人工审计。
- 事件 payload 先经统一脱敏器处理；错误仅保留安全摘要和稳定 reason code。
- 运行期完整事件保留至少 90 天；已发布报告、已采纳机会和方向决策保留可下钻的“溯源摘要”直至其业务实体删除。
- SQLite 的 append-only 只是应用约束，不是防篡改存储。P1 将每日事件 hash manifest 随现有异地备份写入 S3，形成可校验锚点；不引入区块链。
- 查询 UI 只访问索引和已授权实体；原文继续按当前引用/鉴权规则读取。

## 8. 实施切片

### P0：可追溯链路（建议先做）

1. 新增 trace / event / edge schema、写入 API、脱敏与 hash；为 `Run` 增加 `trace_id`。
2. 接入 collect、analyze、validate、report、derive lead、map opportunity，以及方向编辑/人工状态变更。
3. 在报告、线索、机会页实现只读时间线和证据下钻；管理页按 trace 查询。
4. 为每个阶段写单元/集成测试，验证无悬空实体、Run/trace 状态聚合一致、重试不覆盖、引用白名单不退化、敏感字段不落库。

### P1：优化驾驶舱与完整性锚定

1. 漏斗、版本 diff、阶段成本/时延和失败归因看板。
2. 方向重投影影响对比，人工标签与映射质量的关联分析。
3. 每日 hash manifest 外部备份与完整性校验工具。

### P2：隔离重放与外部互操作

1. 基于历史 `input_refs + version_context` 生成只读重放计划，并在独立 SQLite/容器运行。
2. 可选导出兼容 OpenLineage 的 Run / Job / Dataset 事件；内部契约不依赖外部后端。

## 9. 验收标准

- [ ] 任一生产 Brief 可在一个页面内回溯到输入批次、纳入洞察、所有 `pass` 引用、模型/规则版本与运行镜像。
- [ ] 任一技术机会可回溯 Lead、方向版本、mapping lane、优先级明细和全部人工决定。
- [ ] 每个 Run 的所有阶段都具有终态或可解释的进行中状态；失败、跳过、空刊不可混淆。
- [ ] 根 Run、子 Run 与 trace 的 `done` / `failed` / `partial` / `cancelled` 聚合符合 §4.1，且不反向改写既有 Run 状态。
- [ ] 可按来源/主题/版本比较 `collect → report` 漏斗、freshness、耗时、成本与 validator 拦截原因。
- [ ] 重试、重投影与人工决策都保留历史，不覆盖原记录；事件不含密钥、完整 prompt、原文副本或未授权信息。
- [ ] 在当前生产数据规模下，单产物链路页面 P95 < 2 秒，单 trace 查询 P95 < 1 秒。
- [ ] 任意完整性校验失败可定位到 event 范围，并告警；不影响已发布报告的读取。

## 10. 质量门与发布策略

P0 只新增确定性元数据、索引和 UI，不改变 analyzer、validator、模型、prompt、数据源或报告纳入语义；
按 `Eval-Gate: skip (deterministic provenance only)` 处理，但必须运行受影响的生产路径回归、typecheck、
全量测试和 build。若后续加入自动归因、LLM 解释、语义聚类或重放改变 AI 输入/输出，则必须先补专用数据集并
执行完整 Eval-Gate。

## 11. 设计依据

- W3C PROV 的 Entity / Activity / Agent 用于区分产物、处理和执行者。
- OpenTelemetry 的 trace、log、metric 关联用于统一 `trace_id` 和运行观测。
- OpenLineage 的 Run / Job / Dataset 及可扩展 facet 模型用于事件契约和未来导出边界。
