# 技术架构设计

> IPD 计划阶段产物。系统骨架、数据流、关键技术选型。

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  Web UI (Next.js)                                       │
│  报告阅读 · 今日 Brief · 管理看板 · 设置                │
└─────────────────────────┬───────────────────────────────┘
                          │ HTTPS（反向代理 TLS 终止）
                          ▼
┌─────────────────────────────────────────────────────────┐
│  API 层 (src/app/api/)                                  │
│  路由 + 中间件（鉴权 / 限流 / 审计 / 日志脱敏）         │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Agent 编排层 (src/lib/agents/)                         │
│  collector ─▶ analyzer ─▶ validator ─▶ report-gen       │
└─────────────────────────┬───────────────────────────────┘
                          │ 使用
                          ▼
┌─────────────────────────────────────────────────────────┐
│  共用运行时 (src/lib/runtime/)                          │
│  LLM Client · Job Runner · Observability · Cost Meter   │
└─────┬───────────────┬────────────────┬──────────────────┘
      │               │                │
      ▼               ▼                ▼
┌──────────┐    ┌──────────┐    ┌──────────────────────┐
│ 数据源   │    │ 外部 LLM │    │ 存储                 │
│ 适配层   │    │ (分析 /  │    │ FS (报告正文)        │
│ sources/ │    │  校验)   │    │ + SQLite WAL + FTS5  │
└────┬─────┘    └──────────┘    │ (业务实体 / Run /    │
     │                          │  审计 / 成本 / 配额) │
     ▼                          └──────────┬───────────┘
┌────────────────┐                         ▲
│ 外部数据源     │                         │
│ RSS/arXiv/API  │              ┌──────────┴────────────┐
└────────────────┘              │ 系统 cron (容器内进程)│
                                │ 定时采集 / 定时 brief │
                                └───────────────────────┘
```

**主要组件**：

- **Web UI** —— 用户阅读报告与配置主题 / 数据源的入口，详见 `product-definition.md`「UI / UX 设计」。
- **API 层** —— Next.js API Routes + 中间件：鉴权（NextAuth）、限流（`rate-limit-flexible`）、审计日志、logger 强制脱敏。
- **Agent 编排层** —— 四个核心 agent 串成端到端管线：`Source → ContentItem → AnalysisBatch → ValidationResult → Report`（实体见「数据模型」，行为见各 spec）。Agent 之间通过共用运行时调用 LLM 与持久化。
- **共用运行时** —— `src/lib/runtime/`，所有 agent 共享的基础设施：
  - **LLM Client** —— 统一适配多提供商、重试 / 超时 / 限流 / token 计量 / Zod schema 校验；启动校验强制「分析模型 ID ≠ 校验模型 ID」（同源偏差约束）。
  - **Job Runner** —— `Run` 实体落 SQLite，承载状态流转 / 失败重试 / 看板下钻（呼应 product-definition「管理看板·失败任务下钻+重试」）。
  - **Observability** —— `metrics_event` 表 + 结构化 JSON 日志 + `alerts` 统一接口。
  - **Cost Meter** —— 调用成本聚合 / 配额校验 / 熔断（charter A5 落点）。
- **数据源适配层** —— `src/lib/sources/`，把外部源（RSS / arXiv / 官方 API）统一为 `ContentItem`；新增源仅改配置 + 加适配器，不散落外部调用；robots.txt 解析在此层。
- **存储层** —— 文件系统承载报告正文（Markdown + 自包含 HTML），SQLite WAL 模式承载业务实体（含 `event_id` 池）+ 全文索引（FTS5）+ `Run` / 审计 / 成本 / 配额。SQLite 文件与归档目录均挂在 Docker 持久卷上。
- **调度器** —— 系统 cron 触发容器内进程（**不用 Vercel Cron** —— timeout 与分钟级长任务不匹配），触发后走 Job Runner。

**跨切面关注**：

- **配置管理** —— 三层分离：
  - **静态配置**（YAML，构建时打包）：默认源清单 / 默认模型对子 / 系统参数 / rate-limit 默认。
  - **动态配置**（SQLite，运行时可写）：用户增删的 `Source` / `Topic` / 推送渠道 / 模型偏好。
  - **环境变量**：密钥的唯一来源；配置文件以 `${VAR_NAME}` 引用，不落明文。

- **密钥与凭据** —— 唯一来源 = 环境变量（local: `.env.local`；staging / prod: SOPS / Vault / KMS 注入容器）。应用启动校验缺失即拒；logger 中间件强制脱敏字段清单（`api_key` / `token` / `cookie` / `authorization`）；前端不直连外部 API，所有出网走后端。

- **可观测性** —— `metrics_event` 事件表 + 看板 SQL 查询（MVP 不引外部 OTel）；结构化日志带 `run_id` / `agent` / `stage` 标签；`alerts` 接口（邮件 / Slack 任选一渠道）。

- **告警** —— 统一走 `alerts` 接口：数据源健康 / 分析批次失败 / 校验不可放行 / 推送失败 / 成本超阈值 / 异常请求。

## 模块拆分

| 模块 | 职责 | 位置 |
|---|---|---|
| collector | 数据采集 | `src/lib/agents/collector.ts` |
| analyzer | 洞察分析 | `src/lib/agents/analyzer.ts` |
| validator | 引用校验 | `src/lib/agents/validator.ts` |
| report-gen | 报告生成 | `src/lib/agents/report-gen.ts` |
| LLM Client | 统一 LLM 调用（多提供商 / 重试 / 限流 / 计量 / schema 校验） | `src/lib/runtime/llm.ts` |
| Job Runner | `Run` 实体编排、状态机、重试 | `src/lib/runtime/jobs.ts` |
| Observability | metrics / logs / alerts | `src/lib/runtime/observability.ts` |
| Cost Meter | 成本统计 / 配额校验 / 熔断 | `src/lib/runtime/cost.ts` |
| 数据源适配 | 外部源 → `ContentItem` | `src/lib/sources/` |
| 配置加载 | 静态 YAML + 动态 SQLite 合并 | `src/lib/config/` |

## 数据流

```
Source ─采集▶ ContentItem ─分析▶ AnalysisBatch(Insight+Citation) ─校验▶ ValidationResult ─生成▶ Report(+索引)
```

1. **采集** —— 按 `Source` 配置抓取、预处理，产出 `ContentItem`（原始 + 结构化双存）。
2. **分析** —— 按 `Topic` 对 `ContentItem` 切片，产出 `AnalysisBatch`（含 `Insight` + `Citation`）。
3. **校验** —— 对 `Insight` 每条 `Citation` 做可达性 + 一致性双层校验，产出 `ValidationResult`。
4. **生成** —— 把校验通过 / 存疑的 `Insight` 组织为 `Report`，归档并建索引。

各阶段对应 spec 见 `docs/plan/specs/`；每次执行落一条 `Run`（见下「运行实体」）。

## 数据模型

> MVP 核心实体与字段。本节是 4 份 spec 输入/输出契约的**单一事实来源** —— spec 引用本节，
> 不各自重定义。实体流转见上「数据流」。类型为示意（string / int / bool / datetime / enum /
> text / object / `T[]`），最终以 develop 阶段 TS 类型为准。
> **必填**列：Y = 字段必须存在且非空；N = 可空 / 可缺省；数组型 Y 表示字段必须存在（可为空数组）。

### 分类字段总览（ADR-0010）

跨实体的「分类相关」字段一览，避免散落各表难以对齐。`facets`/`domain` 是**领域分类的唯一事实源**
（ADR-0010 Step2c 起，旧单值 `industry` 已彻底移除）；词表落代码常量（`lib/topics/facets.ts` /
`archetype.ts`），加值零迁移、app 层校验、无 DB CHECK。

| 维度 | 字段 | 载体实体 | 取值 / 词表 | 角色 |
|---|---|---|---|---|
| **路由** | `topic_id(s)` | Source / ContentItem / Insight / Report / ReportIndex | topic 主键 | 骨架：源配 `topic_ids` → 采集给内容烙 `topic_ids` → 报告按 topic 生成/筛 |
| **领域** | `facets` (`domain:*`) | Topic / ReportIndex | `domain:ai-swe` / `ai-security` / `ai-industry`（多值，`DOMAIN_VALUES`） | 领域分类**唯一维度**；报告库筛选/展示。**源无此字段**，其域由 topic 派生（`sourceDomains`） |
| **行为** | `archetype` | Topic | `deep_vertical` / `horizontal_pulse`（`ARCHETYPE_REGISTRY`） | 行为档（采/筛/选材策略），与领域正交，非内容分类 |
| **内容标签** | `tags` | ContentItem / Insight / ReportIndex | 自由词表（analyzer 抽取） | 报告库「标签」筛选 |
| **实体** | `entity_names` | ReportIndex（聚合自 `Entity`） | `{name, type: organization/person/project/product}` | 报告库「实体」筛选 + 主题页关键实体 |
| **报告类型** | `type` | Report / ReportIndex | `brief` / `deep_dive` / `initial_digest` | 报告类型筛选 |
| **料源形态** | `body_kind` | ContentItem | `article` / `show_notes` / `transcript`（ADR-0007） | 内容形态（影响渲染/分析），非领域分类 |
| **语言** | `language` | Topic / ContentItem | `zh` / `en` / `mixed` | 语言维度 |

> 一句话：「谁的内容」走 `topic_id(s)`；「哪个领域」走 `facets/domain`；「用什么策略处理」走 `archetype`；
> 「报告库怎么筛」靠 `facets / tags / entity_names / type`。源不自存领域分类，由其 topic 的 `facets` 派生。

### 数据源 (Source) · 配置

采集的源配置；由用户 / 管理员配置维护。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | 源唯一 ID |
| `name` | string | Y | 源名称 |
| `type` | enum | Y | `rss` / `arxiv` / `api`（MVP 三类） |
| `endpoint` | string | Y | URL 或 API endpoint |
| `topic_ids` | string[] | Y | 关联主题 —— **也是源的「域」来源**：源的领域由其 topic 的 `facets` 派生（ADR-0010 Step2c：源不自存分类） |
| `fetch_interval` | duration | Y | 增量抓取周期 |
| `backfill` | object | N | 历史回填配置 `{depth, max_cost}`；缺省为不回填 |
| `enabled` | bool | Y | 启停 |

### 主题 (Topic)

用户订阅的追踪主题；MVP 来自用户在设置页配置（非头脑风暴产物）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | 主题 ID |
| `name` | string | Y | 主题名 |
| `keywords` | string[] | Y | 关键词 |
| `facets` | string[] | Y | **领域分类**（多值，受控词表 `domain:ai-swe` / `ai-security` / `ai-industry`）—— 分类唯一维度（ADR-0010；取代旧 `industry`）。输入必填 ≥1 |
| `archetype` | enum | Y | **行为原型**（`deep_vertical` / `horizontal_pulse`）—— 驱动采/筛/选材策略（ADR-0010）；DB 缺省 `deep_vertical` |
| `language` | enum | Y | 输出语言 `zh` / `en` / `mixed` |
| `brief_schedule` | enum | Y | brief 周期 `daily` / `weekly` |
| `enabled` | bool | Y | 启停 |

### 内容条目 (ContentItem)

采集产出的标准化内容。产出：`data-collection` · 消费：`insight-analysis`、`citation-validation`（反查原文）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | 唯一主键 —— 下游引用的锚点 |
| `source_id` | string | Y | → `Source.id` |
| `url` | string | Y | 规范化后的 URL；同时作为去重 / 内容更新的判定键 |
| `title` | string | Y | |
| `author` | string \| null | N | RSS 源常缺 |
| `published_at` | datetime \| null | N | 内容发布时间（原始）；源未提供时为 null |
| `fetched_at` | datetime | Y | 抓取时间 |
| `language` | enum | Y | `zh` / `en` / `mixed` —— 采集层对 `body` 做语言检测得出，检测失败时缺省取所属 `Source` 关联 `Topic` 的语言 |
| `topic_ids` | string[] | Y | 主题归属 —— **采集层赋值，直接继承所属 `Source.topic_ids`**（源级粒度；条目级关键词命中后续迭代）；下游按此切片 |
| `tags` | string[] | N | 标准化标签，可为空数组 |
| `body` | text | Y | 抽取后的结构化正文 |
| `raw_ref` | string | Y | 原始内容存档句柄 —— 校验反查原文用；MVP 阶段原文不清理 |
| `content_hash` | string | Y | 内容指纹 = 对规范化后 `body` 取哈希；用于检测同 URL 内容更新 |
| `fetch_status` | enum | Y | `ok`（完整抽取）/ `partial`（正文不完整 —— 截断 / 部分段落丢失，但 `body` 仍非空、`content_hash` 照常计算）；整源失败不产出条目 |

### 引用 (Citation)

嵌入 `Insight`，是「可溯源」的最小单位。全部字段必填。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content_item_id` | string | Y | → `ContentItem.id` |
| `quote` | text | Y | 被引原文片段（逐字摘录） |
| `locator` | object | Y | 原文定位 `{paragraph_index, char_start, char_end}` |

### 洞察对象 (Insight)

产出：`insight-analysis`（包在 `AnalysisBatch` 内）· 消费：`citation-validation`、`report-generation`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | |
| `topic_id` | string | Y | → `Topic.id` |
| `type` | enum | Y | `aggregation`（主题聚合）/ `trend`（趋势识别）—— MVP 仅此两类 |
| `event_id` | string \| null | N | 关联事件聚类键；`aggregation` 类挂事件，纯 `trend` 可为 null |
| `statement` | text | Y | 结论文本 |
| `importance` | int (1–5) | Y | 重要性评分 |
| `importance_basis` | text | Y | 评分依据 —— 满足「可解释」原则 |
| `citations` | Citation[] | Y | 引用列表（≥ 1，无引用不输出） |
| `source_count` | int | Y | 印证来源数 |
| `multi_source` | bool | Y | 派生：`source_count ≥ 2` |
| `time_window` | object | Y | `{start, end}` 时间切片 |
| `confidence` | enum \| null | N | `trend` 类必填、`aggregation` 类为 null：`high` / `medium` / `low` |
| `language` | enum | Y | 输出语言 |

### 分析批次 (AnalysisBatch)

`insight-analysis` 的输出单元 —— 一次「某主题 × 某时间窗」的分析结果。
产出：`insight-analysis` · 消费：`citation-validation`、`report-generation`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | 批次 ID |
| `topic_id` | string | Y | → `Topic.id` |
| `time_window` | object | Y | `{start, end}` |
| `status` | enum | Y | `done` / `failed`（LLM 调用重试耗尽等） |
| `no_significant_event` | bool | Y | 该窗口无重要事件（诚实兜底）；为 true 时 `insights` 为空、`status` 必为 `done`。`status=failed` 时本字段必为 `false`（失败 ≠ 诚实无事件） |
| `insights` | Insight[] | Y | 洞察列表（可为空数组） |

### 校验结果 (ValidationResult)

产出：`citation-validation` · 消费：`report-generation`、管理看板。分逐引用与整体两级。

**逐引用校验项 (CitationCheck)**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `insight_id` | string | Y | → `Insight.id` |
| `citation_index` | int | Y | 引用在 `Insight.citations` 的下标 |
| `reachability` | enum | Y | `pass` / `fail`（`retryable` 为重试中间态，不落最终值） |
| `reachability_reason` | enum | Y | `ok` / `source_not_found` / `source_unreachable` / `quote_not_in_source` |
| `consistency` | enum | Y | `support` / `not_support` / `uncertain` / `not_evaluated`（可达性 fail 时短路） |
| `consistency_reason` | enum | Y | `ok` / `out_of_context` / `exaggeration` / `misattribution` / `uncertain` / `not_evaluated` |
| `verdict` | enum | Y | `pass` / `blocked` / `flagged` |

**整体校验报告 (ValidationReport)**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `total` / `pass` / `blocked` / `flagged` | int | Y | 各 `verdict` 计数 |
| `consistency_failure_rate` | float | Y | 护栏指标 = `not_support` 数 ÷ `total` |
| `flagged_rate` | float | Y | 第二护栏 = `flagged`（一致性 `uncertain`）数 ÷ `total`；防「负例藏进 uncertain」 |
| `releasable` | bool | Y | 「有效洞察」= 经「洞察级纳入判定」剩余引用 ≥ 1 的洞察。剔除全部 `blocked` 后仍有 ≥ 1 条有效洞察 → true；`total = 0`（空批次 / 上游 `no_significant_event = true`）→ true（让 brief 走「无重要事件」路径，**不置 failed**）；其余 → false 且报告置 `failed` |

**校验判定流程**（消解「拦截 vs 存疑」二态；判定有序、结果唯一）

1. **可达性校验**先行。网络类失败（超时 / 限流）置 `reachability=retryable`，按重试上限重试；重试耗尽归为 `fail`。
2. 可达性落 `fail` → **短路**，不做一致性校验，`consistency = not_evaluated`、`consistency_reason = not_evaluated`。
3. 可达性 `pass` → 做一致性校验，`consistency ∈ {support, not_support, uncertain}`。
4. 由下表（全函数，覆盖全部终态组合）定 `verdict`：

| `reachability` | `consistency` | `verdict` | 报告处置 |
|---|---|---|---|
| `fail` | `not_evaluated` | `blocked` | 不进报告 |
| `pass` | `support` | `pass` | 正常纳入 |
| `pass` | `not_support` | `blocked` | 不进报告 |
| `pass` | `uncertain` | `flagged` | 进报告,标「待核实」 |

**`consistency_reason` 取值约束**（与 `consistency` 绑定，与 `verdict` 表共同形成全函数）：

- `consistency = support` → `consistency_reason = ok`
- `consistency = not_support` → `consistency_reason ∈ {out_of_context, exaggeration, misattribution}`
- `consistency = uncertain` → `consistency_reason = uncertain`
- `consistency = not_evaluated`（短路） → `consistency_reason = not_evaluated`

**洞察级纳入判定**（一条 `Insight` 含多条 `Citation` 时）

- 剔除该洞察中 `verdict=blocked` 的引用。
- 剩余引用 ≥ 1 → 洞察纳入报告；洞察级标记取剩余引用中最差等级：含 `flagged` 则洞察标「待核实」，全 `pass` 则正常。
- 剩余引用 = 0（引用全 `blocked`）→ 整条洞察不纳入报告。

### 报告对象 (Report)

产出：`report-generation`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | |
| `type` | enum | Y | `brief` / `deep_dive` / `initial_digest` |
| `topic_id` | string | Y | → `Topic.id` |
| `status` | enum | Y | 见下「状态流转」 |
| `generated_at` | datetime | Y | |
| `title` | string | Y | |
| `body_md` | text | Y | Markdown 正文 |
| `body_html` | text | Y | 自包含 HTML |
| `insight_ids` | string[] | Y | 纳入的洞察 |
| `event_ids` | string[] | Y | 涉及事件 —— 「不复报」基线 |
| `prev_report_id` | string \| null | N | 「前情」指向的历史报告（同事件更新时填） |
| `citation_count` | int | Y | |
| `cost` | object | Y | `{tokens, amount}` 生成成本 |

**`status` 状态流转**（对齐管理看板）：
`generating` →（`done` | `failed`）；`failed` 可重跑回 `generating`（看板「失败任务重试」）；
`done` → `archived`；任意态 → `deleted`（撤回 / 删除）。
`draft` 为预留态 —— MVP 报告由系统自动生成，不经 `draft`。

### 报告索引项 (ReportIndexEntry)

支撑报告库的搜索 / 筛选 / 排序，落 SQLite 行 + FTS5 虚拟表（`title` / `body` / `summary`）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `report_id` | string | Y | → `Report.id` |
| `type` / `topic_id` / `date` | — | Y | 筛选维度 |
| `facets` | string[] | Y | 领域筛选维度（`domain:*`，写入端取 `Topic.facets`）—— 取代旧 `industry`（ADR-0010 Step2b/2c） |
| `source_ids` | string[] | Y | 报告涉及的源 —— 支撑「按来源筛选」 |
| `title` / `summary` | string | Y | 搜索字段（正文进 FTS5） |
| `tags` / `entity_names` | string[] | N | 筛选维度，可为空数组 |
| `importance` | int | Y | 排序维度 |
| `event_ids` | string[] | Y | |

**派生规则**（由 `report-generation` 归档时计算）：

- `source_ids` = 报告纳入洞察的引用经 `Citation.content_item_id` → `ContentItem.source_id` 去重后的集合
- `importance` = 报告纳入洞察 `importance` 的最大值
- `entity_names` = MVP 阶段恒为空数组（实体追踪后续迭代）
- `tags` = 报告纳入洞察对应 `ContentItem.tags` 去重后的集合

### 运行实体 (Run)

agent 执行单元的状态追踪；由 Job Runner 写入 SQLite，支撑管理看板「流水线追踪 / 失败下钻 / 重试」。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | Y | 运行 ID |
| `kind` | enum | Y | `ingest` / `analyze` / `validate` / `report-gen` |
| `target` | object | Y | 关联对象 `{topic_id?, source_id?, batch_id?, report_id?}` |
| `status` | enum | Y | `running` / `done` / `failed` |
| `started_at` | datetime | Y | |
| `ended_at` | datetime \| null | N | |
| `duration_ms` | int \| null | N | 派生 |
| `cost` | object \| null | N | `{tokens, amount}` |
| `error` | object \| null | N | 失败时的错误信息 `{type, message, stack?}` |
| `retry_of` | string \| null | N | 重试时指向被重试的 `Run.id` |

## 技术选型

> 重大选型变更走 ADR（`docs/develop/decisions.md`）。

| 维度 | 选型 | 理由 |
|---|---|---|
| 运行时 | Next.js 15 (App Router) + TypeScript + Node.js 20 LTS | UI + API 同仓全栈一体；TS 类型与「数据模型」schema 强对齐；MVP 单仓低复杂度 |
| 前端 | React + Tailwind CSS（Next.js 内置） | 与运行时统一；满足 UI/UX 设计原则（高可读性排版、深色模式） |
| 鉴权 | NextAuth（email magic link / credential），管理员独立 role | 与 Next.js 集成；session 落 SQLite；管理员路径 `/admin/*` 独立中间件鉴权（呼应安全设计「身份与隔离」） |
| **Agent 运行时** | `src/lib/runtime/`：LLM Client + Job Runner + Observability + Cost Meter（自建） | Agent 共用基础设施；统一重试 / 限流 / 计量 / 状态追踪 / 告警 / 熔断；启动校验「分析模型 ID ≠ 校验模型 ID」 |
| LLM | Anthropic Claude（**默认对子：分析 = Sonnet 4.6 / 校验 = Opus 4.7**）+ 适配层支持多提供商（OpenAI / 等） | 「模型可配」原则；默认对子满足「校验模型 ≠ 分析模型」（同源偏差）；适配层在 `src/lib/runtime/llm.ts` |
| 存储（报告正文） | 文件系统（Markdown + 自包含 HTML），挂载 Docker 持久卷 | 与 product-definition「先用文件系统」一致；归档可读、易备份 |
| 存储（元数据 / 索引） | SQLite WAL 模式（单文件嵌入式），挂载 Docker 持久卷 | 承载业务实体（`ContentItem` / `Insight` / `AnalysisBatch` / `ValidationResult` / `Report` / `event_id` 池 / `ReportIndexEntry`）+ `Run` + 审计 + 成本 + 配额 + session；MVP 零运维；规模升级再迁移 PostgreSQL |
| 全文搜索 | SQLite FTS5（虚拟表索引 `title` / `body` / `summary`） | 与存储一致，零运维；支撑报告库搜索；后续按需升级 |
| 调度 | **系统 cron + 容器内进程**（不用 Vercel Cron） | Vercel Cron 单次 timeout ≤ 60s 与 MVP「P50 ≤ 10 分钟」长任务不匹配；系统 cron 触发后走 Job Runner，长任务在容器进程内跑 |
| 配置 | 三层分离：静态 YAML（构建时打包）+ 动态 SQLite（运行时可写）+ 环境变量（密钥唯一来源） | 静态 vs 动态边界清晰；密钥不进配置文件，配置以 `${VAR_NAME}` 引用 |
| **部署** | **自托管 Docker 容器（默认）**：Fly.io / Railway / 自托管 VPS 单实例 + 持久卷；反向代理（Caddy / Nginx）做 TLS 终止 | 与 product-definition「Web 站点 + 后端 API」对齐；SQLite + FS 需要持久 FS（serverless 不适用）；MVP 单实例无并发写锁问题。Vercel preview 仅用于 UI 开发预览，不承担持久化 |
| CI/CD | GitHub Actions：lint → typecheck → vitest → playwright → eval 抽样 → Docker build → 部署 | 与 `skills/L3-quality.md` 测试要求对齐；安全扫描同步跑 |
| 安全扫描 | Dependabot + `npm audit`（CI）；Docker image tag 锁定（不用 `latest`）；lockfile 必 commit；模型 SDK 来源限定官方 | 「供应链」要求落地 |
| 评测 | Vitest（单测）+ Playwright（e2e）+ 自建 eval 脚本（在 `evals/`） | 与 L3 测试要求对齐 |
| 日志 | `pino`（结构化 JSON，带 `run_id` / `agent` / `stage` 标签）；本地 / staging 滚动文件；production 经 Docker log driver 出到外部聚合（如 Better Stack） | 结构化便于看板查询与告警 |

## 部署与环境

| 环境 | 用途 | 部署目标 | 数据存储 | 凭据来源 |
|---|---|---|---|---|
| local | 开发 + 单测 / 集成测试 | `docker compose up` 或 `npm run dev` | SQLite + FS 在 `.data/`（不入仓） | `.env.local`（不入仓）；**禁止用 production LLM key** |
| staging | e2e / dogfood 内测 | Docker 容器（Fly.io preview / Railway 独立环境）+ 持久卷 | 独立持久卷 / 独立 SQLite 文件 | Docker `--env-file` 或 SOPS 注入；独立 LLM key；**禁止读写 production 数据卷 / 触发 production 推送渠道** |
| production | 正式运行 | Docker 容器（Fly.io / Railway / 自托管 VPS）单实例 + 持久卷 + Caddy / Nginx 反向代理 | 持久卷（每日快照备份） | SOPS / Vault / KMS 注入容器；不入仓、不入日志、不在前端 |

### 关键技术风险与缓解

| 风险 | 缓解 |
|---|---|
| SQLite 单实例写并发瓶颈 | MVP 单容器单实例无并发；触发阈值（用户 > 5 / DB > 5 GB / P95 写延迟 > 50 ms）任一达成 → 迁移 PostgreSQL（升级路径） |
| 长任务（深挖 ≤ 10 分钟）超时 | 容器内进程直接跑、非 serverless；Job Runner 写 `Run` 实体跟踪 |
| 容器重启数据丢失 | 持久卷挂载（云提供商 volume）；每日快照备份 |
| LLM 提供商故障 / 限流 | LLM Client 内置重试 + 多提供商热切换；Cost Meter 触发熔断 |
| 备份与「彻底清除」冲突 | 删除请求即时屏蔽业务可见性 + 备份保留窗口（30 天）后从备份介质彻底清除 |

### 安全设计 9 项落点

逐项与 `product-definition.md`「安全设计」对齐。

| 安全维度 | 实现路径 |
|---|---|
| 身份与隔离 | NextAuth（email magic link / credential）；session 落 SQLite；管理员路径 `/admin/*` 独立中间件鉴权 |
| 密钥管理 | 唯一来源 = 环境变量；配置文件以 `${VAR_NAME}` 引用；启动校验缺失即拒；logger 中间件强制脱敏（`api_key` / `token` / `cookie` / `authorization`）；前端不直连外部 API |
| 传输与存储 | 反向代理（Caddy / Nginx）终止 TLS（自动续证）；敏感字段经 `node:crypto` 字段级加密；持久卷加密（云提供商）；账号删除 → 级联删除 + 备份滞后窗口 30 天后清除 |
| 输入防护（prompt injection） | 在 `runtime/llm.ts` 包装：外部内容包裹 `<untrusted-source url="…">` 标签 + 指令式文本剥离；用户输入 XSS 防护走 React 默认 + CSP |
| 输出防护 | LLM 输出走 Zod schema 校验；引用 URL 检查（黑名单 + SSRF 防护：禁止内网段 / 私有 IP / `file://`）；模型输出过滤敏感信息 |
| 合规与版权 | `robots.txt` 解析在 `lib/sources/` 适配层；遵守各源 ToS；引用必标来源（schema 强制 `Citation.content_item_id`）；账号注销走级联删除 |
| 供应链 | GitHub Actions 跑 Dependabot + `npm audit`；lockfile 必 commit；Docker image tag 锁定；模型 SDK 限定官方 |
| 审计与日志 | SQLite `audit_log` 表（append-only），记录登录 / 配置变更 / 源接入 / 报告生成 / 推送 / 删除；保留 90 天；敏感字段脱敏 |
| 防滥用 | API 中间件 `rate-limit-flexible`（按账号 / IP / 主题）；超阈值告警 + 临时封禁；与 Cost Meter 联动 |

### 成本控制实现路径（charter A5 落点）

| 项 | 实现 |
|---|---|
| 每次 LLM 调用计量 | `LLM Client` 强制写入 `Run.cost`（tokens + amount） |
| 成本聚合 | SQLite 视图 `cost_daily`（per day × task_type × user × topic × model） |
| 配额校验 | 调用前查 `quota` 表（按账号 / 主题 / 模型上限）；超额拒绝 |
| 熔断 | Cost Meter 检测日 / 月预算 ≥ 80% → 告警；≥ 100% → 停调度器 + 停 cron job |
| 看板可视化 | `cost_daily` 表 → 时序图（管理看板） |

### 数据备份与删除

- 持久卷每日快照（保留 30 天）；月度全量备份（保留 12 个月）。
- 备份介质加密（云提供商或 GPG）。
- 账号删除请求 → 即时屏蔽 + 30 天后从备份介质彻底清除（滞后窗口与主流隐私法规对齐）。
- 备份恢复演练每季度一次。

### 可观测性实现

- **metrics** —— SQLite `metrics_event` 表（事件流）+ 看板 SQL 查询；MVP 不引外部 OTel / Prometheus。
- **logs** —— `pino` 结构化 JSON，带 `run_id` / `agent` / `stage` 标签；本地 / staging 落滚动文件；production 经 Docker log driver 出到外部聚合（如 Better Stack）。
- **alerts** —— `runtime/alerts.ts` 统一接口；MVP 接邮件 + Slack 任选一渠道，与推送复用底层。

### 配置分离

- **静态配置**（YAML，构建时打包）：默认源清单 / 默认模型对子 / 系统参数 / rate-limit 默认。
- **动态配置**（SQLite，运行时可写）：用户增删的 `Source` / `Topic` / 推送渠道 / 模型偏好。
- **环境变量**：密钥的唯一来源；配置中以 `${VAR_NAME}` 引用，不落明文。

### 升级路径（非 MVP 范围，留作 ADR 候选）

| 升级 | 触发阈值（任一达成即评估） | 备选 |
|---|---|---|
| SQLite → PostgreSQL | 用户 > 5 / DB > 5 GB / P95 写延迟 > 50 ms | Supabase / Neon / 自托管 |
| 系统 cron → 任务队列 | 并发跑 > 5 / 时延抖动大 / 复杂 DAG 需求 | Inngest / Trigger.dev / BullMQ |
| SQLite FTS5 → 专门检索 | 报告 > 10 万 / 高级搜索（语义 / 同义）需求 | Meilisearch / Typesense |
| 单实例 → 多实例 | 用户 > 50 / 单实例 CPU 长期 > 70% | 配合 PostgreSQL 迁移 |
