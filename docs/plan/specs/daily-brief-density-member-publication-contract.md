# Daily Brief 单主题首发：成员发布契约（S0 设计）

> 2026-10-03 · 适用于[新刊优先切片](daily-brief-density-fast-release.md)。这是 S0 的实现输入，不表示 S1 收益、生产 schema 或上线已获准。S2 才提交迁移和发布代码。

## 范围与发布单位

只为开启试点的**新生成** `brief` 引入 Story。一个 Story 是同一冻结 `ContentItem` 版本下、同一真实新事件的 1–3 个有序事实成员；单事实照常短讯。成员仍是各自的 Insight、唯一主 Citation、展示审计和 validator 检查。并列成员不生成新断言，标题只能复用已审计主事实或无事实含义的序号。

旧报告的正文、artifact、review snapshot 和发布历史不迁移。关闭开关时仍走现有选择与展示；开启后如无法确认归组、历史新颖性或成员证据，全组退回旧代表项，**但在已开启的新格式报告内仍作为单成员 Story 经过同一发布 guard**，不得借回退绕过证据包。新格式的发布历史在之后关回旧模式时仍须被历史查询识别。

## 最小不可变包

S2 在 `src/lib/db/schema.ts` 定义新表，并以不可变迁移落地。建议一个按 `report_id` 唯一的版本化、规范编码 Story manifest，加一个由 manifest 派生的轻量成员历史索引；两者在发布 intent 事务中写入，随后只允许 redaction/retention 按现有生命周期移除。具体表名在 S2 定稿，但下列字段和关系不得省略。

| 层 | 必须固化的内容 | 不能只依赖的现有记录 |
|---|---|---|
| 报告/Story | `report_id`、topic、manifest/选择/renderer 版本、Story 顺序、归组依据（主体、行动、版本）、各 Story 的成员顺序、规范包 hash、Markdown/HTML artifact hash 和成员渲染锚点 | `report.insight_ids` 是扁平集合；`report.event_ids` 和当前 `event_id` 不证明真实同事件 |
| 成员文本 | `insight_id`、原 `event_id`、展示模式（已审中文结论或 quote-only）、最终读者文本及 hash、成员类型/重要性、唯一主 `citation_index`、选择/排除理由 | 可变 Insight 行、headline、只存 ID 的 report revision |
| 原文证据 | `content_item_id`、`content-v4` revision、正文内容 hash、受控 raw archive 的路径和文件 hash、逐字 quote、UTF-16 locator/有界 span、来源 URL/发布日期快照 | URL 可达、可变 `content_item.body`、仅有 raw 文件而未验证 envelope 与版本 |
| 通过依据 | 完整 `kept` 或 `kept_degraded` 展示审计及相应的结论/原文投影 hash、逐主引用 `pass/support` 的 validator 检查、模型/prompt/策略版本、检查时间；必要限定由成员文本与证据共同覆盖 | `report_selection_decision` 仅记结果、revision 的计数摘要、另一成员的通过记录 |
| 展示绑定 | 成员到 Markdown/HTML 中唯一锚点、受界定的渲染文本 span/hash 和引用编号的确定性映射；`citation_count` 等于实际展示成员引用数，单源多成员仍标单源 | 在读取时重新从可变 batch 选取、只查正文含有 quote 子串 |

Manifest 保存成员所需的 quote/span 和来源版本绑定，不另存整篇原文；发布及恢复时验证受控归档的 hash、envelope、规范化正文与 `content-v4` 一致。成员历史索引至少可按 report/topic、事实指纹、来源版本和原事件线索检索，但必须与规范包逐项一致。历史检索不能把来源 ID 变化当成事实新增，也不能把旧报告缺少新格式身份当作“从未发布”。

当前 v6 白名单允许 `kept` 与 `kept_degraded`。后者若没有经哈希精确绑定的 `reader_statement`，最终展示文本必须是经审计的 source-quote 投影，**不能恢复被降级的中文草稿**；Story 包保存实际展示模式、最终文本/hash、quote 和 locator，guard 对两种模式分别核对。quote-only 可用于单成员回退或成组，但仍须逐成员 `pass/support`，不能因只有原文而省略审计/限定检查。

## 意图、提交和恢复共用的 guard

1. 在同一 SQLite intent 事务内写入 `generating` Report、完整 review/selection decisions、Story manifest/成员索引、`generation_effect` 的 artifact manifest 与引用绑定；effect payload 固化 Story manifest 版本和 hash。非空新格式缺任何一项即不产生可发布 intent。空 Brief 继续使用现有空刊契约。
   **仅在 intent 前**，候选组中有成员不合格时可重新选择一个独立合格的单成员 Story，并据此一次性生成新 manifest；intent 写入后不得移除失败成员来补救原报告。
2. 从**固化 Story 投影**一次性生成 Markdown、HTML、索引与通知所需的派生文本；为每个成员记录可复核的正文锚点。阶段内不再次调用选择器，也不从 live batch 构造第二份成员顺序。写 staged artifact 后核对字节数及 SHA-256。
3. 正常提交、无锚恢复和已锚恢复共用版本化 `assertBriefStoryPublication`：核对 effect、review decisions、规范包 hash、成员顺序与 `report.insight_ids`、引用编号/数量、两份 artifact hash 及成员锚点；逐成员重查 `kept`/`kept_degraded` 展示审计及实际展示模式、`pass/support`、quote locator、冻结内容 revision 与 raw 归档。任一成员不通过则整份新格式 fail closed，不能借另一成员的引用过关。现有 `assertReportPublicationEvidence` 可作为旧格式守卫及新守卫的子检查，不能单独作为新格式的完整证明。
4. 上述 guard 在把 Report 改为 `done`、写 index/FTS、发布 review snapshot 或锚定提交的**同一事务**中运行。重试只能恢复原 intent、原 manifest 和原 artifact 版本；不得重选成员、重渲染另一正文或铸造不同的锚。终态失败保留诊断，不创建读者可见的新刊。
5. 已发布读取只消费固化投影与 artifact。之后更改 live Insight、Citation、validator 行或选择规则，不改变已刊正文、卡片、索引、通知及导出。redaction/retention 必须覆盖新增包和索引，并保证删除后任何读者/管理端都不能借其恢复原文；旧格式仍按原生命周期处理。

`report_selection_decision` 保留**每个原 Insight 的互斥终态**。已刊成员的 published rank 按成员顺序连续，未纳入成员分别记历史重复、同义重复、分组不确定、预算或证据门原因；Story 数与事实成员数单独计量。不能将三条事实合为一个 decision，从而让成员级审计失去分母。

## S2 前必须落地的反例测试

| 反例 | 预期 |
|---|---|
| 同 URL 不同产品/版本、同实体不同交易、不同 `event_id` 同研究、同 `event_id` 不同事件 | 只按主体/行动/版本证据归组；不确定则退回旧代表项 |
| 第二成员缺 kept 审计、`flagged`/`blocked`、quote locator 错位或 raw envelope/版本不一致 | intent 前可选独立合格单成员；intent 后整份拒绝，不能借首成员通过补救原组 |
| intent 后、文件落地后、锚写入后、提交后调用方失联；并发或重复 reconcile | 只发布原版本一次，或安全留在非可见终态；三个提交入口共用 guard |
| intent 与 artifact 绑定被改、live 行在 intent 后被改、MD/HTML 成员顺序或引用编号不一致 | 拒绝提交；已发布 artifact 读取不重新生成 |
| on→off→on、近 14 天重复、旧报告缺成员身份、redaction 与 retention | 不重报已刊成员；历史疑义退回旧选择；删除后包和索引不可读 |

这些测试要走 `runReportGen → SQLite → effect/artifact → reconcile/reader` 的生产函数，而非只测一个新纯函数。当前 `report-gen`、pipeline 集成、review 与 reports 的 189 项测试是 before 基线；它们不覆盖上述新格式反例。若后续采用模型做归组或改 validator/prompt/数据集，再按仓库 eval-gate 执行相应语义评测。
