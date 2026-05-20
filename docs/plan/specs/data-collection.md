# Spec: 数据采集 (Data Collection)

> M1 计划阶段产物 · MVP 范围 · 状态：🟠 评审中 · 2026-05-20

## 背景与目标

MVP 端到端管线的第一段。把「确定可达的源」（RSS / arXiv / 官方 API）的内容稳定采进系统，
作为洞察分析的输入。对应核心能力「采集」与用户场景「持续追踪」的数据基础。
本 spec 承载关键假设 **A3**（数据源可达性）的落地。

## 用户故事

- As a 用户, I want 系统按配置自动、增量地抓取订阅主题相关的源, so that 我不必手动刷信息源。
- As a 用户 / 管理员, I want 新增 / 启停数据源只改配置不改代码, so that 源清单可灵活演进。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `Source` 配置（字段见 `architecture.md`「数据模型」）；触发信号 |
| 输出 | `ContentItem`（字段见 `architecture.md`「数据模型」，必填集以该表「必填」列为准）；原始 + 结构化双存归档 |
| 触发 | 定时增量（按 `Source.fetch_interval`）/ 按需 / 新源接入时按 `Source.backfill` 一次性历史回填 |

## 行为规约

1. MVP 仅接 RSS、arXiv API、官方 API 三类源（其余源类型后续迭代）。
2. 按 `Source.fetch_interval` 定时增量抓取；增量水位按源类型确定（RSS：etag / last-modified 或已见条目 ID 集；arXiv / API：发布时间戳 + 已见 ID），水位边界条目不漏不重。
3. 新源 / 新主题接入时按 `Source.backfill` 执行一次性历史回填；回填可中断续传、重复接入幂等，并与首次增量抓取的水位无缝衔接（不留缺漏、不重叠）。
4. 预处理：URL 规范化 → 正文抽取 → **语言检测**（对 `body` 检测得出 `ContentItem.language`；检测失败缺省取所属 `Source` 关联 `Topic.language`）→ 去重 / 更新判定 → 标准化元数据，产出 `ContentItem`。`ContentItem.topic_ids` 直接继承所属 `Source.topic_ids`（源级粒度；条目级关键词命中后续迭代）。
5. 去重 / 更新判定（以规范化 `url` 为键）：① url 已存在且 `content_hash` 相同 → 完全重复，跳过；② url 已存在但 `content_hash` 不同 → 内容更新，**原地更新**该 `ContentItem`（刷新 `body` / `content_hash` / `fetched_at`，保留 `id`），不新增；③ url 不存在 → 新建条目。跨源近似去重（同文转载）不在 MVP 范围。
6. `fetch_status`：正文完整抽取 → `ok`；正文不完整（截断 / 部分段落丢失，`body` 仍非空、`content_hash` 照常计算）→ `partial`；整源失败不产出条目（源级失败见第 8 项）。
7. 原始内容与结构化内容双存，结构化条目经 `raw_ref` 可回溯原始内容；MVP 阶段 `raw_ref` 原文不清理。
8. 容错：单源失败不阻塞流水线 —— 记录错误、指数退避重试（默认上限 3 次），耗尽则标记该源本轮失败并在数据源健康告警。
9. 合规：遵守各源 robots.txt / ToS；API 源遵守速率限制并加礼貌延迟。
10. 安全：抓取正文一律按**不可信内容**处理；采集层不在 `ContentItem` 落隔离字段，下游在喂 LLM 前各自做指令隔离（纵深防御，见 `product-definition.md`「安全设计 · 输入防护」）。
11. 源清单与接入方式全部配置化，增删 / 启停 / 调周期无需改代码。

## 验收标准 (AC)

- [ ] AC1: 给定含 ≥3 个 RSS/arXiv 源、窗口内确有新内容的受控配置，定时触发后新条目 100% 入库，且 `architecture.md` 标「必填 = Y」的字段齐全。
- [ ] AC2: 同一 url 内容未变（`content_hash` 相同）重复抓取 → 新增条目 = 0；同一 url 内容变化（`content_hash` 不同）→ 原地更新、条目数不增、`id` 不变。
- [ ] AC3: 配置停用某源 → 下一轮该源抓取次数 = 0；仅改配置新增一源 → 下一轮该源被抓取。
- [ ] AC4: 注入一个必失败的源，其余源 100% 正常完成；失败源被记录、按重试策略重试，重试耗尽后在数据源健康显示为失败。
- [ ] AC5: 新源接入触发回填，入库条目数与 `Source.backfill` 配置一致；回填中途中断后重跑最终条目数不变（幂等）；回填区间与紧随的首轮增量无缺漏、无重叠。
- [ ] AC6: 每个 `ContentItem` 必填字段齐全，经 `raw_ref` 能取回原始内容，`topic_ids` 等于其 `Source.topic_ids`。
- [ ] AC7: 源在两轮抓取间新增条目（含与水位边界**同时间戳**的多条）时，增量抓取覆盖全部新条目、不漏且不重。
- [ ] AC8: 对指定源发起按需触发，能立即执行一次抓取，不等定时周期。
- [ ] AC9: 正文不完整抽取时条目仍入库且 `fetch_status=partial`、`body` 非空；完整抽取为 `ok`。
- [ ] AC10: 对中文 / 英文 / 中英混合 `body` 内容，`ContentItem.language` 分别检测为 `zh` / `en` / `mixed`；检测失败时缺省取所属 `Topic.language`。

## 非功能要求

- 性能：单轮增量抓取阈值 M1 末标定；采集运行于调度，**不在「主题深挖」端到端关键路径内**，不占用 P50 ≤ 10 分钟预算。
- 成本：抓取与预处理不耗模型 token；回填范围受 `Source.backfill` 的成本上限约束。
- 可观测性：per-source 成功率 / 最近抓取时间 / 内容量级 / 错误模式 → 数据源健康看板；连续失败 / 限流自动告警。

## 依赖与影响范围

- 依赖：`Source` 配置（A3 核实产出的可达源清单）；数据模型见 `architecture.md`；安全要求见 `product-definition.md`「安全设计」。
- 影响：`src/lib/sources/` 适配层、`src/lib/agents/collector.ts`、`src/app/api/ingest/`、`src/app/api/cron/`。
- 下游：`insight-analysis` 消费 `ContentItem`。

## 开放问题

- 回填深度默认值与成本上限阈值；`Source.backfill.depth` 单位（时间跨度 vs 条目数）—— 待 A3 核实后定。
- 归档存储的目录结构与索引格式（与 `architecture.md`、`report-generation` 的归档约定统一）。
