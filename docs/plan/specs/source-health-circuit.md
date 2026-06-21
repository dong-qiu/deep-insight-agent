# Spec: 源健康自愈（ADR-0008 决定② / 切片3）

> 设计文档 v2（多 Agent 评审后修订）。落 ADR-0008 决定②：从「被动展示」到「软熔断 + 半开自愈 + 按源告警」。
> v2 修正评审发现的状态机自我增强环 + 半开探测污染 + 阈值单位；裁决了全部开放问题。

## 背景与目标

`aggregateSourceHealth`（`runtime/run-stats.ts:146`）**已算**每源 `consecutiveFails`/成功率/最近成功，且已被 admin 看板消费展示（`app/admin/page.tsx:68`）。缺的是**自动处置**：坏源持续每轮刷 failed（体检 freebuf 12×、bleeping 9× 一直挂着没人摘），静默失败（产出 0 条）只在看板排前、无主动告警。目标：把已算好的信号接上**自动熔断 + 半开自愈 + 按源告警**，且不误杀抖动好源、不与人工运维打架。

## 用户故事

- As 运维, 坏源连续失败到阈值后自动停采 + 告警，不再每轮浪费抓取/污染看板。
- As 运维, 曾挂掉、现已恢复的源（bleeping）自动复活，不必我盯着 re-enable。
- As 运维, 抖动源（thehackernews/google_research，实测可达却 failed×9）**不被误停**。
- As 运维, 某源悄悄不产出了（feed 变标题党/解析返 []）→ 主动按源告警，而非埋在看板。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `run` 表 ingest 历史（已有）；`consecutiveFails`/`lastSuccessAt`（已有）；每轮 `collectSource` 的 `inserted`（CollectResult 已有，`collector.ts:117`） |
| 输出 | `source.enabled` 自动 0（系统熔断）/1（半开复活）；`source.disabled_reason`/`disabled_at`/`last_probe_at`/`circuit_reset_at`；按源告警（飞书+邮件，复用 `runtime/alert.ts`）；`audit_log(actor='system')` |
| 触发 | 搭**日跑管线**（`runScheduledPipeline`，crontab `0 17 * * *`）——不引新 cron |

## 行为规约

### 1. 失败退避（**先做、单独先上、防误杀**）

- 现状：只 arXiv 有 429 重试（`sources/arxiv.ts:42`），rss/article 无 in-fetch 重试 → 单次抖动即记一条 failed run。
- **放适配器层**（`fetchRss`/`fetchArticleBody`），**不放 `safeFetch`**（评审裁决）：与 arxiv 已有重试架构一致；不污染 safeFetch 的 redirect 跟跳循环、不改 transcript/robots 的 catch→null 语义；避免两层重试语义纠缠。
- 规约：仅对 `!res.ok` 的 5xx/超时 与 fetch reject 重试 1–2 次、指数退避（1s/3s）；4xx/robots 禁止/解析空**不重试**（非瞬时）。arxiv 不动（已有自己的重试，勿双重）。

### 2. 系统熔断（软停用）

- 判据（**时间为主、计数防抖**，评审改）：`now - lastSuccessAt > SOURCE_CIRCUIT_DAYS`（默认 3–4 天）**且** `consecutiveFails >= SOURCE_CIRCUIT_FAILS`（默认 4–5，**不是 12**）。
  - 理由：日跑形态下连失≥12≈12 天才摘、太慢；时间条件已隐含多次连失，计数只需 > 抖动源单日抖动量（取 4–5）即可区分「单次抖动」vs「持续失败」。真死源 ~4 天摘、当天恢复的抖动源永不触发时间条件。
  - **前置定标任务**（不是悬空开放问题）：先上退避（1）跑 1–2 周，核 run 时间戳确认体检里 thehackernews 9× 是跨多日还是单日累积，据此最终定 N。
- **`consecutiveFails` 须按 `circuit_reset_at` 锚定**（评审🔴 必修1）：该值由 run 历史实时算，源熔断 enabled=0 后不再产 run → 计数冻结在 ~阈值；人工 re-enable 后第一次失败即 ≥阈值 + 仍久未成功 → **立刻再熔断、与人工意图打架**。修：熔断与复活都写 `circuit_reset_at=now`，熔断判定只统计 `started_at > circuit_reset_at` 的 run。
- 动作：`enabled=0` + `disabled_reason='circuit_open'` + `disabled_at=now` + `circuit_reset_at=now`；按源告警 + `audit_log(actor='system', action='source_circuit_open', target=source_id, detail={consecutiveFails,lastError})`。
- 系统只对 `enabled=1 AND (disabled_reason IS NULL)` 的源熔断。

### 3. 人工 re-enable 必须清熔断态（评审🔴 必修2）

- 现状：`updateSource`（`repos.ts:43`）整行覆写但不碰新列 → 人工把熔断源拉回 `enabled=1` 会留 `enabled=1 ∧ disabled_reason='circuit_open'` 脏态。
- 规约：**repo 层 `clearCircuit`**——保存 `enabled=1` 时一并清 `disabled_reason`/`disabled_at`/`last_probe_at` + 写 `circuit_reset_at=now`（干净重数 consecutiveFails）。设置页保存 / API PUT 路径钉死调用。
- AC4 修正：「人工管理优先」既覆盖**人工停用不被系统复活**，也覆盖**人工拉回启用时清掉系统熔断态**（评审指出原 AC4 只覆盖了前一半）。

### 4. 半开自愈（**日跑管线旁路、不引新 cron**，评审🔴 必修3 加固）

- 落点：`runScheduledPipeline` 采集循环（`scheduler.ts:144` 串行 for）**之后**（不在之前，避免拖慢当天 brief 主链）。
- 选取：`enabled=0 AND disabled_reason='circuit_open' AND (last_probe_at IS NULL OR now-last_probe_at > 1 天)`。
- 探测：**不复用裸 collectSource 的告警路径**——collectSource 失败走 `runJob` 无条件 `notifyFailure`（`jobs.ts:59`）→ 每死源每天一条噪音（与降噪相反）。修：
  - 探测失败**只更 `last_probe_at`、不告警**；探测 run 的 target 打 `probe:true` 标记 → `run-stats`/看门狗排除，不污染 consecutiveFails/健康统计。
  - **单源超时**（~10s）+ **每轮探测数上限**（默认 5）：多个死源串行探测各挂到超时会卡当天 brief。
  - 成功（run done）→ `clearCircuit`（enabled=1 + 清态 + circuit_reset_at）+ 告警「源已自动复活」+ audit。
- 频率：`last_probe_at` 固定 1 天节流（MVP）。指数退避（freebuf 这种永远探不通的海外死源）后置——探测失败不告警已消除主要噪音痛点，hammer 窗口本就有限。

### 5. 按源零产出看门狗（治静默失败）

- 需 ingest run 的 `inserted` 可回溯：**加 `run.inserted INTEGER` 独立列**（评审裁决，否决塞 run.cost JSON——污染成本语义）。CollectResult.inserted 已有，让 ingest 的 runJob 把它透传进 `finishRun`。旧行 NULL = 未知、不计入。
- 判据（评审改，降假阳）：**「历史有过稳定产出的源，突然连续 N 次（默认 5）done 但 inserted=0」**才告警——纯「连续 0」对生来稀疏源（owasp_llm 3 条属正常）高假阳。需先建立「该源有过产出」基线。
- 动作：**按源告警，不自动停用**（0 产出≠源坏）。**与切片4 去重**：零产出只管「采集层成功但 inserted=0」；切片4 的「被采纳=0」是分析价值层、不重复告警。
- 保守起步：先只上**看板标记**，自动告警待基线判据验证后再开。

## 验收标准 (AC)

- [ ] AC1: 抖动源（连续 failed 但 `lastSuccessAt` 在阈值天内）**不被熔断**。
- [ ] AC2: 真死源（>阈值天无成功 且 连失≥N）→ 自动熔断 + 告警 + audit + 写 circuit_reset_at。
- [ ] AC3: 熔断源被半开探测命中、collectSource 成功 → 自动复活（clearCircuit）+ 告警；探测失败**不告警**、只更 last_probe_at；探测节流（每源每天≤1）+ 每轮探测数上限。
- [ ] AC4: **人工管理优先**：① 人工停用（enabled=0 且 reason 非 circuit）永不被系统复活；② 人工把熔断源拉回 enabled=1 → 自动 clearCircuit、不留脏态、consecutiveFails 干净重数。
- [ ] AC5: 复活后再失败**不会因旧 consecutiveFails 立即再熔断**（circuit_reset_at 锚定生效）。
- [ ] AC6: 有产出基线的源连续 5 次 done+inserted=0 → 看板标记/告警；有产出即重置。
- [ ] AC7: rss 网络瞬时失败重试后成功 → 不记 failed run（退避生效）。

## 非功能要求

- 性能：半开仅对已熔断源（少量）、每天一次、单源超时 + 数量上限；退避重试上限 2 次。
- 成本：纯采集层、零 LLM。
- 可观测性：熔断/复活/零产出按源告警 + audit_log；admin 看板加「熔断中」标。

## 依赖与影响范围

- **schema**：`source` 加 `disabled_reason TEXT`/`disabled_at TEXT`/`last_probe_at TEXT`/`circuit_reset_at TEXT`；`run` 加 `inserted INTEGER`（均 `ensureColumn` 幂等、旧行 NULL）。
- **改**：`agents/scheduler.ts`（采集后半开旁路 + 熔断判定/置位）、`runtime/run-stats.ts`（熔断判定纯函数 + circuit_reset_at 锚定 consecutiveFails + 排除 probe run）、`sources/rss.ts`+`sources/article.ts`（退避重试）、`runtime/alert.ts`（按源告警文案）、`db/repos.ts`（source 新列 + setCircuit/clearCircuit；run.inserted 透传 finishRun）、`runtime/jobs.ts`（probe 模式跳过 notifyFailure）、admin 看板（熔断标）。
- **不破**：决定①（不引新 cron）；人工 enabled 管理（系统只动 circuit 源 + 人工拉回时清态）。

## 实施顺序（评审）

1. **先单独上退避（1）** → 观察 1–2 周抖动源 consecutiveFails 真实分布。
2. 据分布定标熔断阈值（2）+ 落 schema 新列。
3. setCircuit/clearCircuit + circuit_reset_at 锚定（必修1/2）。
4. 半开探测旁路（必修3：绕 notifyFailure + 超时 + 数量上限 + probe 标记）。
5. 零产出看门狗（基线判据，先只看板）。

## 开放问题（已裁决，留痕）

- 退避层级 → **适配器层**（非 safeFetch）。
- 熔断阈值 → **时间为主**（>3–4天 且 连失≥4–5），上退避后实测定标。
- inserted 持久化 → **run.inserted 独立列**。
- 半开复活又失败 → **MVP 固定 1 天节流**；指数退避后置。
