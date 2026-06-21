# Spec: 源健康自愈（ADR-0008 决定② / 切片3）

> 设计文档（实施前对齐）。落 ADR-0008 决定②：从「被动展示」到「软熔断 + 半开自愈 + 按源告警」。
> 第二轮评审要求「先出半开调度设计、接上 crontab 调度形态再开工」——本文回答之。

## 背景与目标

`aggregateSourceHealth`（`runtime/run-stats.ts`）**已算**每源 `consecutiveFails` / 成功率 / 最近成功，且已被 admin 看板消费展示（`app/admin/page.tsx:68`）。缺的是**自动处置**：坏源持续每轮刷 failed（体检里 freebuf 12×、bleeping 9× 一直挂着没人摘），静默失败（产出 0 条）只在看板排前、无主动告警。目标：把已算好的信号接上**自动熔断 + 半开自愈 + 按源告警**，并保证不误杀抖动好源。

## 用户故事

- As 运维, 坏源连续失败到阈值后**自动停采**且**告警通知我**，不再每轮浪费抓取/污染看板。
- As 运维, 曾经挂掉、现已恢复的源（如 bleeping）**自动复活**，不必我手动盯着 re-enable。
- As 运维, 抖动源（FeedBurner 偶发，thehackernews/google_research）**不被误停**。
- As 运维, 某源悄悄不产出内容了（feed 变标题党 / 解析返 []），**主动收到按源告警**，而非埋在看板里。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `run` 表 ingest 历史（已有）；`aggregateSourceHealth` 的 `consecutiveFails`/`lastSuccessAt`（已有）；每轮 `collectSource` 的 `inserted`（已有，CollectResult） |
| 输出 | `source.enabled` 自动置 0（系统熔断）/ 1（半开复活）；`source.disabled_reason` 标记来源；按源告警（飞书+邮件，复用 `runtime/alert.ts`）；audit 记录（`audit_log.actor='system'`） |
| 触发 | 搭**日跑管线**（`runScheduledPipeline`，crontab `0 17 * * *`）——不引新 cron（与决定①降级口径一致） |

## 行为规约

### 1. 失败退避（**先做，防误杀**）

- 现状：只有 arXiv 有 429 退避（`sources/arxiv.ts:44`），rss/article 无 in-fetch 重试 → 单次抖动即记一条 failed run，放大 `consecutiveFails`。
- 规约：`fetchRss`/`fetchArticleBody` 的 `safeFetch` 失败（网络/5xx/超时）**就地重试 1–2 次、指数退避**（如 1s/3s），全失败才让 run failed。吸收瞬时抖动 → 抖动源不再轻易累积 failed。
- 范围：仅网络层瞬时错误重试；robots 禁止 / 4xx / 解析空**不重试**（非瞬时）。

### 2. 系统熔断（软停用，**退避之上**）

- 判据（**双条件、缺一不熔断**）：`consecutiveFails >= SOURCE_CIRCUIT_FAILS`（默认 12）**且** `now - lastSuccessAt > SOURCE_CIRCUIT_DAYS` 天（默认 3）。
  - 双条件理由（评审）：纯计数 `>=8` 会误杀抖动好源（thehackernews 9×/google_research 9× 实测可达）；叠加「久未成功」只摘**真死**源（freebuf/bleeping 那种连挂多日）。
- 动作：`enabled=0` + `disabled_reason='circuit_open'` + `disabled_at=now`；**按源告警** + `audit_log(actor='system', action='source_circuit_open', target=source_id, detail={consecutiveFails, lastError})`。
- **人工停用永不被系统改**：系统只对 `enabled=1` 的源熔断；`enabled=0` 的源（人工或已熔断）系统不动（半开除外，见 3）。

### 3. 半开自愈（**调度落点：日跑管线旁路，不引新 cron**）

- 落点：`runScheduledPipeline` step1 采集循环**之前**，新增一段「半开探测」：
  - 选取 `enabled=0 AND disabled_reason='circuit_open' AND (last_probe_at IS NULL OR now-last_probe_at > 1 天)` 的源。
  - 对每个：跑一次 `collectSource`（探测）。成功（run done）→ `enabled=1`、清 `disabled_reason`/`disabled_at`、告警「源已自动复活」+ audit；失败 → 更新 `last_probe_at`、保持熔断。
- 频率：日跑管线每天一次 → 半开每天最多探一次/源（`last_probe_at` 节流）。**不新增独立 cron**——熔断源不进正常采集循环（已 enabled=0），半开是旁路分支。
- 与决定①一致：不为此引入新调度形态。

### 4. 按源零产出看门狗（治静默失败）

- 判据：某 `enabled=1` 源**连续 `SOURCE_ZERO_YIELD_ROUNDS`（默认 5）次 ingest run `done` 但 `inserted=0`**（成功但没产出 = feed 变标题党/解析返[]/WAF 软封——体检里 guid bug、相对 URL 丢条目都属此类被掩盖）。
- 需持久 `inserted` 历史：`run.cost` 旁可加，或新表/在 run 记 inserted（见「依赖与影响」）。
- 动作：**按源告警**（不自动停用——0 产出≠源坏，可能确实没新内容；交人工判断）。

## 验收标准 (AC)

- [ ] AC1: 抖动源（mock：连续 failed 但 `lastSuccessAt` 在 3 天内）**不被熔断**。
- [ ] AC2: 真死源（连续 ≥12 failed 且 >3 天无成功）→ 自动 `enabled=0`+`disabled_reason='circuit_open'`+告警+audit。
- [ ] AC3: 熔断源被半开探测命中、`collectSource` 成功 → 自动 `enabled=1`、清 reason、告警复活；探测节流（每源每天最多一次）。
- [ ] AC4: **人工停用**（`enabled=0` 且 `disabled_reason` 非 circuit）的源**永不**被系统半开/改动。
- [ ] AC5: 连续 5 次 done 但 inserted=0 → 按源零产出告警；有产出即重置计数。
- [ ] AC6: rss 网络瞬时失败重试后成功 → 不记 failed run（退避生效）。

## 非功能要求

- 性能：半开探测仅对已熔断源（少量）、每天一次；退避重试上限 2 次，不显著拉长采集。
- 成本：纯采集层，零 LLM。
- 可观测性：熔断/复活/零产出均按源告警 + audit_log，admin 看板已有 `consecutiveFails` 展示可加「熔断中」标。

## 依赖与影响范围

- **schema**：`source` 加 `disabled_reason TEXT`、`disabled_at TEXT`、`last_probe_at TEXT`（`ensureColumn` 幂等，存量 NULL）。零产出看门狗需 ingest run 的 `inserted` 可回溯——`run` 表无此列，方案：① run 记 `inserted`（加列）② 或单独 `source_yield` 累计表。倾向①（run 已是每源每轮一条）。
- **改**：`agents/scheduler.ts`（step1 前半开探测 + 熔断判定/置位）、`runtime/run-stats.ts`（暴露熔断判定纯函数：入 health → 出「该不该熔断/告警」，可单测）、`sources/rss.ts`+`sources/article.ts`（退避重试）、`runtime/alert.ts`（按源告警文案）、`db/repos.ts`（source 新列读写 + setCircuit/clearCircuit）、admin 看板（熔断标，可选）。
- **不破**：决定①（不引新 cron）、人工 enabled 管理（系统只动 circuit 源）。

## 开放问题

1. **退避放哪层**：`safeFetch` 内置重试（影响所有调用方，含 transcript/article）还是 `fetchRss` 包一层？倾向 `safeFetch` 选项化（`retries?`），调用方按需开。
2. **熔断阈值**单位：`consecutiveFails` 是「失败 run 数」，日跑下 12 次≈12 天——是否过久？或改「失败 run 数 ≥ N **或** 距上次成功 > D 天」二选一更快摘死源？需按真实抖动分布定标（体检数据：thehackernews 9×仍可达 → 阈值须 >9）。
3. 零产出看门狗的 `inserted` 持久化：加 `run.inserted` 列 vs 复用现有（run.cost JSON 里塞？）——倾向独立列、清晰。
4. 半开复活后若**立刻又失败**（假性恢复）→ 是否退避半开频率（指数：1天→2天→4天）避免反复探测 hammer？
