# Spec: 信息源可靠性与覆盖复审（2026-09）

## 目的

以生产侧“采集 → 入选 → 已发布报告引用”的真实证据，而不是配置项数量，维护三个主题的信息源覆盖。
本切片只修复已经验证的失效入口和主题错配源；不因短窗口零产出自动下线低频权威源。

## 生产证据（2026-09-06，只读）

近 60 天的 `source-contribution.sh` 审计覆盖 58 份已发布报告：

| 主题 | 结论 |
| --- | --- |
| `t_code_agents` | GitHub Engineering 在 60 天有 32 次引用，虽近 14 天为 0，必须保留。GitHub Next 的少量内容高度相关（agentic workflow、verified migration、PR maintenance），保留。Google Research Blog 采 18 条、0 引用，且内容主要为医学、气候与生命科学，和软件工程主题错配。Lex Fridman 虽稀疏，但最新 DHH 节目直接讨论 agentic engineering，保留。Aider feed 最新内容停在 2025-05，属于发布停滞，不是抓取故障。 |
| `t_prompt_injection` | Embrace The Red、Trail of Bits 在长窗均有被引，应保留。MITRE ATLAS、OWASP LLM、Project Zero 属低频权威基线，不能仅凭零新条目下线。`src_simonwillison_promptinj` 的零增量并非低频：通用 Simon feed 更早抓到同 URL，被全局 URL 唯一索引去重，专题源没有机会为安全主题写入路由。 |
| `t_ai_industry` | TechCrunch 引用占比过高；SemiAnalysis 应提供研究/基础设施视角，但旧 `https://www.semianalysis.com/feed` 最新条目停在 2025-09，已失效。站方当前 newsletter feed 在生产出口验证为 robots 允许、20 条内容、最新 2026-09-01、首条约 19k 字。 |

## 本 PR 范围

1. 将 `src_semianalysis` 的默认 endpoint 改为 `https://newsletter.semianalysis.com/feed`。
2. 提供仅接受审计过的旧值→新值的生产迁移脚本；不插入新源、不删除历史内容、不覆盖人工配置。
3. 默认停用主题错配的 `src_google_research`，并提供只接受精确当前配置的生产停用脚本；历史内容保留。
4. 在生产 probe 中纳入 SemiAnalysis 现用入口，作为运行前复核。

## 明确不在本 PR 中解决的问题

`src_simonwillison` 与 `src_simonwillison_promptinj` 的 URL 重叠暴露了数据模型约束：`content_item.url` 全局唯一，内容的 `topic_ids` 仅继承首次写入的 Source。直接把专题源改为共享通用源会把大量无关文章送进安全分析；直接覆盖原条目的 `source_id` 又会损坏既有引用归因。

后续必须先立项并验收以下能力，再修改该逻辑：

- 同 URL 被多个来源路由时，保留全部 topic 路由与来源归属；
- 历史 citation、`source_id` 归因与 `raw_ref` 仍稳定可追溯；
- 不将同文重复送入同一主题的 analyzer，且多主题路由可独立选择；
- 贡献看板能正确表达“原始来源”和“路由来源”，不把专题源继续误报为零贡献；
- 对重叠 URL、内容更新、旧引用可达性运行回归和多源 Eval-Gate。

## 生产执行顺序

1. 合并后先确认 CI 通过，再核验生产运行版本是否已包含本配置字面量。若未包含，按 code-only 的安全重部署流程更新运行版本（不得运行会覆盖 `.env.local` 的全量部署）；仅在运行版本确认后进入以下数据库配置迁移。
2. 在生产出口运行 `./ops/aws/probe-sources.sh`，确认 SemiAnalysis feed 与 robots 仍通过。
3. 显式执行 `./ops/aws/seed-semianalysis-source.sh --apply`；确认只迁移 endpoint。
4. 显式执行 `./ops/aws/disable-google-research-source.sh --apply`；确认只停用源，不删除历史内容。
5. 连续观察 14 天：`TOPIC=t_ai_industry NEW_DAYS=14 ./ops/aws/source-contribution.sh 14`，并检查日报选择漏斗。若候选增加但入选/发布不增加，先查选择或校验，不继续加源。

## 验收标准

- 默认配置能通过 Zod 加载；新空库的 SemiAnalysis endpoint 是 newsletter feed，Google Research 默认停用。
- 两个生产脚本都要求唯一的 `--apply`；字段、启用状态或人工停用原因不符合预期时失败。
- SemiAnalysis 脚本仅更新 endpoint；Google Research 脚本仅停用源并记录人工复审原因；两者均不删除 `content_item`。
- 受影响测试、`npm run typecheck`、`npm run build` 通过。
- Eval-Gate：已实际启动 A1，但首个模型请求等待超过 5 分钟仍未产生结果文件，记录为评测基础设施阻断，**不是通过结论**。本变更未修改 prompt、模型、分析器或 validator，A1 也不覆盖 RSS endpoint/生产 SQLite 配置迁移；本 PR 以配置解析、类型检查、测试、构建和生产出口 probe 为范围内证据，并要求后续恢复评测基础设施后补跑多源评测。
