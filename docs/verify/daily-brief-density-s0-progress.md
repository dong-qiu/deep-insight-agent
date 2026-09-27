# Daily Brief 信息完整性：S0 执行记录

> 2026-09-27 · S0 进行中，未达到合并门。原始材料仅保存在 gitignored 私有目录。

## 阶段状态

| 任务 | 当前结果 | 尚缺完成条件 |
|---|---|---|
| T01 隔离环境 | 已完成：独立 worktree/分支、owner-only 配置、绝对隔离 DB/DATA 路径、通知关闭 | 无 |
| T02 全候选诊断 | 已实现只读 exporter，完成一次三主题全队列导出；定向测试及独立 review 后修正 | 合格互补事件数量仍依赖 T03 人工归组及合格池重放，不能只凭同文章计数 |
| T03 来源标注 | 用户负责；首批三份来源证据核验通过，改为对话中逐项确认 | 事件边界、重要信息、必要限定和题目裁定；至少 30 个事件及家族分区 |
| T04 协议冻结 | 已列字段缺口/身份决策草表，协议未冻结 | 探索集初测后确定数值、预算、留出封存 |

仅创建 S0 草稿 PR 留存代码及 CI；完成 T03/T04 和独立复核前保持 draft，不提前合并或启动 S2。
这遵循执行清单 PR-1 的阶段完成条件，不将工具通过测试等同于实验通过。

## T01 环境与取样

- 基线 `21414ab702282a5fc3645cea15afe26f1e042c07`；分支 `feat/brief-density-s0`。
- Node 24.19.0、npm 11.17.0；依赖按 lockfile 安装。原 worktree 的未提交改动保留。
- 从既有 S3 定时在线备份只读取回 2026-09-26 18:00 UTC 一致性快照，再用 SQLite backup API
  在新 worktree 私有目录建立 DELETE-journal 实验副本。输入未迁移、未 bootstrap，quick_check=ok。
- 私有环境 manifest 保留来源/派生快照 SHA、捕获时间、配置隔离证明；输入副本 0400、目录 0700。
- 2026-09-27 14:28 UTC 只读核对生产撤回记录和待处理撤回请求均为 0；人评材料不从旧备份恢复已撤回内容。
- 87 份所选原文归档只读取回，传输完整性通过；归档文件 0600。未复制原 worktree 的 `.data/`。

## T02 初步诊断（不是质量收益）

输入窗口为 `[2026-09-23 00:00, 2026-09-26 18:00) UTC`，`asOf=2026-09-26 18:00 UTC`。
该窗口覆盖 11 个 batch、442 个候选审计/保留记录，另有 1 次没有窗口内 batch 的分析尝试；
后者没有可恢复候选文本或有效候选诊断，候选总数仍为 unknown，不记为零。

| 主题 | 候选记录 | 展示审计拒绝 | 曾在 Brief 发布 | 选择预算排除 | 历史/新鲜度排除 | 展示/引用门排除 |
|---|---:|---:|---:|---:|---:|---:|
| 软件工程 | 253 | 171 | 39 | 29 | 10 | 4 |
| AI 安全 | 79 | 57 | 15 | 3 | 2 | 2 |
| AI 产业 | 110 | 93 | 10 | 4 | 1 | 2 |
| 合计 | 442 | 321 | 64 | 36 | 13 | 8 |

表中“曾发布”是窗口内 batch 的候选截至 asOf 的 Brief 发布观察，不是某一天的报告条数，
也不代表每条都能重新取得完整不可变证据。候选未通过展示审计不能直接恢复成多句摘要。
“源文信息本来就少”与“提取遗漏”仍须人工来源标注后区分。

归档缺口按输入 revision occurrence 计，包含无 batch 的分析尝试；同一篇文章重复进入不同批次会重复计数。
已有 raw 文件但不具备 envelope 的旧记录保留为 `archive_envelope_unavailable`，与真正版本错配分开报告；
只有当前行无法复原所选历史正文的样本保持 null，不补造旧版本，也不重新抓取当前网页替代。
具体 hash、来源明细及 quote/locator 核验结果见私有 manifest/pool，禁止提交原文。

## 独立检视与测试

第一次独立 review 提出四项 Warning：失败 diagnostics 漏导出、跨报告尝试/时间混算、
归档自校验被当作版本绑定、无 batch 输入缺口未计入统计；均已修复并加入反例。
第二轮发现窗口结束后、asOf 前完成的 batch 可能重复计为无 batch 尝试；已修复并加入边界测试。
另修正测试夹具的 quote 字符长度，保留严格 locator 断言。
最终自查将被拒候选进一步区分为“审计仍有草案片段”与“无文本”，保留对应 claim 文本但不提升为可发布成员。

- `npx vitest run evals/brief-density/export.test.ts`：11/11 通过。
- `npm run typecheck`：TS7 与 TS6 均通过。
- `npx eslint evals/brief-density --max-warnings=0`：通过。
- 未运行 A1：本次没有修改 prompt、模型、数据源、评测集或发布语义，A1 不执行该只读导出路径。
- 实际模型调用 0、通知 0、生产业务写入 0；阶段收益及人评状态 pending。

## T04 字段缺口草表（待冻结）

| 字段/关系 | 当前来源 | 当前保证与缺口 | 新路径需要的最小契约 |
|---|---|---|---|
| 最终事实文本 | Insight statement/reader_statement | live 行可变；revision 不保存完整文本 | 固化最终展示文本及其 hash、展示策略 |
| 主引用/quote/locator | Citation + statement_citation_index | live 引用绑定；旧 locator 或原文版本可能缺失 | 每成员绑定完整引用及同版本 quote/span |
| 所选原文版本 | analyze input refs + content-v4 | 固化元数据/hash/长度，不含正文/raw handle | 可恢复的受控正文或对应不可变归档，访问边界一致 |
| raw 归档 | raw_archive effect + manifest | 新 envelope 可绑定结构化正文；旧 raw 文件不能自动提升保证 | 文件完整性与内容版本分别验证，缺口 fail closed |
| 展示审计/独立复核 | 两种 display audit、decision | 完整 kept 审计与拒绝诊断保证不同；失败诊断是有损摘要 | 成员对应的完整审计及模型/prompt/policy/version |
| validator | citation_check/validation_result | live 检查；revision 仅摘要字段 | 固化逐引用 check 和策略/运行版本，不只核可达性 |
| 发布选择及成员顺序 | report_review_snapshot/selection_decision | 可追踪尝试和 rank，不能替代最终文本快照 | 一个投影服务正常保存、恢复、历史及全部展示面 |

## T04 身份与历史决策草表（待人工样本检验）

| 场景 | 命题身份 | 证据 occurrence | 发布决定原则 |
|---|---|---|---|
| 同义改写、仅更换 quote | 不自动视为新命题 | 可有新 occurrence | 保守去重；不能凭新 hash 重报 |
| 仅重抓/更新时间变化 | 不自动改变 | 记录版本变化 | fetched_at 不等于新增事实 |
| 同文出现另一项独立事实 | 需要独立命题身份 | 可共享 content revision | 分别验证、历史判定；不被同文章去重整体删除 |
| 同主体不同产品/版本/交易 | 不仅按实体归组 | 各自保留来源 | 按事件及必要限定判断，不因同 URL/实体合并 |
| legacy 与新成员混合 | legacy 没有完整事实身份 | 兼容旧 occurrence | 疑义保守，不把缺身份当未发布 |
| off→on→off | 保留命题发布历史 | 保留全部成员 | 关闭新生成仍能识别已发布成员，避免重报 |

本表没有决定生产 schema 或语义阈值。先根据实际标注和探索读测填写协议，再封存留出集并进入 S1。
