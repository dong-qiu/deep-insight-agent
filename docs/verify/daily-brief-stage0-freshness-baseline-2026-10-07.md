# Daily Brief 阶段 0：F 分段时效诊断与前瞻观测契约

2026-10-07；实现基点 `473e2ee`。F 当前为 **诊断工具已实现、生产策略关闭、前瞻基线尚未完成**。
依据 [rich-insight-freshness](../plan/specs/daily-brief-rich-insight-freshness.md)、[阶段前置 closeout](pre-rich-brief-final-closeout-2026-10-07.md)、[eval-gate](../../.agents/skills/eval-gate/SKILL.md)。
本切片不改 schema、collector、scheduler、analyzer、validator、report-gen 或生产开关；不调用模型/原站，不打开任何 SQLite。

## 已交付与输入边界

`evals/rich-brief-stage0/freshness.ts` 提供三个可执行入口：

- `from-export`：只读已封存 S0 的 manifest 与 candidate-pool；先核 pool SHA，再提取时钟、ID、失败与候选终态元数据。输出没有正文、标题、URL、quote 或配置。
- `summarize`：严格校验 `rich-brief-freshness-v1` JSON 后汇总；不从缺失字段推定时间、证据资格、事件新颖性。
- `template`：产生 **零观测** 的前瞻账本模板。该文件不是实测，不是生产基线。

输出目录必须尚不存在；worktree 内必须 gitignored。目录 0700、文件 0600；全部实测产物留在私有 `.data/rich-brief-stage0/`，不提交。
历史输入只读使用旧密度工作树的已封存 JSON 导出，未访问该树的 live DB、WAL、配置或私有全文归档。
旧探索与 10/3—10/5 已曝光输入均不进入新留出。

冻结诊断接口 `rich-brief-freshness-v1`：

| 实体 | 单位与必填关系 |
| --- | --- |
| `attempts` | 全部已观测分析尝试；包括 failed、unknown、无输入、无 batch。每臂独立存模型、input/output tokens、USD、失败码；无法恢复的 cost 为 null，不称 0 成本 |
| `observations` | 每个分析尝试的输入来源 revision；必须属于该尝试的冻结输入。topic、issue、source form、first/followup、来源家族、11 个独立钟与已观测终态分别存储 |
| `publications` | report × 已刊 insight 的消息；绑定唯一主来源 revision。首报/深读续报/分析回访只能沿用人工事件与已刊命题金标；没有标签为 unknown |
| `provenance` | 输入 manifest SHA、资源版本、窗口、as-of、已知缺口；历史 scope 不是完整采集来源池 |
| `comparison` | 完整来源池 hash/完整性、独立臂名、模型、总 token/USD 预算、配对 run ID；元数据完整也不代表 F 通过 |

每个钟只允许 `value + basis + evidence_ref` 或 `null + unknown_reason`，UTC 必须含可核验小时/时区；date-only 不补午夜。
只读导出中的 `statement_citation_index` 为 1-based，而 DB `citation.citation_index` 为 0-based；工具按真实生产契约减一解析主来源。
不任选一条 secondary citation，也不以当前网页替代历史 revision；主来源绑定冲突保留 unknown。
历史 `body_kind=article` 无法可靠区分网页全文、摘要或论文摘要，因此来源形态暂列 unknown；不可由这种 unknown 声称某来源形态已通过时效门。

## 时钟语义与恢复结果

| 钟 | 含义/未来采集责任 | 此次历史可恢复性 |
| --- | --- | --- |
| `event_at` / `recorded_at` | 真实事件发生/节目录制；来源可验证时间，不由抓取或转载推定 | unknown |
| `source_published` | 原始发布日期，保留来源元数据与对应 revision；它不证明真实事件的新鲜度 | 来源 revision snapshot 可恢复 |
| `source_version_updated` | 对应证据版本的来源更新时间；需官方版本记录/版本化元数据 | unknown；不能用 source/DB `updated_at` 或 `fetched_at` |
| `first_available` | 该证据版本可获取的可核验时刻；必须有独立、版本化的观测/来源凭据 | unknown；普通首次成功轮询只给上界，不证明此前不可获取，不能直接填作精确首次可获取 |
| `first_collected` | 该来源版本首次在隔离管线中成功持久化并可归档核验的时刻；append-only receipt | unknown；`content_item.fetched_at` 在 URL 正文更新时覆盖，不能冒充首次采集 |
| `selected` | scheduler 冻结本期输入名额的时刻，绑定完整来源池与 selection receipt | unknown；analyze started 不是选择时刻 |
| `extracted` | 模型提取完成，并绑定该输入 revision 与输出 batch | generation_event completed 可恢复；缓存命中是复用完成，不是首次提取 |
| `evidence_pass` | 命题/引用独立证据门最后一次成功的时刻，绑定验证记录版本 | unknown；validation_result 没有时间字段，review 中 event ID 没有发生时间 |
| `published` | artifact 提交并通过发布门的时刻，不等于正文生成开始 | 阶段钟 unknown；消息年龄另明确采用 report.generated_at 探索代理 |
| `reader_open` | 已有合法可靠遥测中的打开时刻 | unknown；本次没有阅读情景估算，更没有实测阅读年龄 |

另单列 `analyze_execution_delay = analyze completed - started`，不能代替 selected → extracted 或来源可获取 → 出刊。
前瞻若只有轮询上下界，当前单点钟维持 unknown；下一切片须扩展区间证据契约并报告范围，不能偷偷把上界当精确起点。
时间晚于 as-of 阻断；负时序保留 `invalid_negative` 独立计数，不折零、不进分位数。

## 本次重新运行的探索结果

下表是主来源原始发布时间到 **report.generated_at** 的代理年龄；不是认证生产出刊基线，也不能解释全部延迟。
消息分母是本次完整导出内已观察到发布的 report × insight，未刻意复用旧文档的“73 条/16 条超 48 小时”。
旧文档统计口径与本工具主来源消息口径不同，不能把差额解释为产品变化。

| 冻结历史输入 | 观察分析尝试（完成/失败） | 消息（年龄 known/unknown） | P50 h | P90 h | ≤24h | ≤48h |
| --- | --- | --- | --- | --- | --- | --- |
| 原窗口 9/23—9/26，三主题 | 12（11/1） | 64（64/0） | 25.22 | 130.68 | 31/64 = 48.44% | 47/64 = 73.44% |
| 上述软件工程 | 同一三主题窗口的子集 | 39（39/0） | 23.72 | 130.68 | 22/39 = 56.41% | 33/39 = 84.62% |
| 上述安全 | 同一三主题窗口的子集 | 15（15/0） | 47.36 | 130.13 | 6/15 = 40% | 10/15 = 66.67% |
| 上述产业 | 同一三主题窗口的子集 | 10（10/0） | 52.66 | 146.61 | 3/10 = 30% | 4/10 = 40% |
| 10/3 软件工程 | 1（1/0） | 4（4/0） | 8.30 | 47.28 | 3/4 | 4/4 |
| 10/4 软件工程 | 1（0/1） | 0 | unknown | unknown | 无刊样本 | 无刊样本 |
| 10/5 软件工程 | 1（1/0） | 4（4/0） | 41.48 | 131.28 | 1/4 | 2/4 |

原窗口输入 revision occurrence 分母为 **180 = 12 × 15**，其中提取完成钟 165 known/15 unknown。
版本更新时间、首次可获取、首次采集、入选、证据通过、publication commit 及 reader open 均为 **0 known/180 unknown**；不能据此找出“最大延迟段”。
64 条消息的版本更新年龄均为 unknown。所有已刊消息的首报/续报类别均 unknown。
分析执行时长 11 个已完成尝试 P50 136.55 秒、P90 379.23 秒；1 个失败尝试时长 unknown。
10/3 执行 127.42 秒，10/4 失败，10/5 执行 433.22 秒。
全部 15 个跨上述窗口的尝试成本未由导出保留，为 unknown；模型字段可恢复的不代表 token/总成本可恢复。

原窗口持久化候选终态：display audit rejected 321、selection budget filtered 36、published 64、history/freshness filtered 13、projection/citation gate 8。
这些是已存候选路径的终态，不是未提取重要维度数，也不是采集阶段完整失败分母。10/4 保留无 batch 失败尝试及 3 个已观测候选下限；未留存总候选数继续 unknown。
输出分别报告阶段 entered/progressed/known terminal loss/pending-or-unobserved/entry-unknown；缺少前段钟时不制造损失比例。

输入 manifest SHA（完成 manifest → pool hash 核验；不等于重核备份全部原文或生命周期状态）：

| 输入 | SHA-256 |
| --- | --- |
| original-exploration | `ba0926addd5e3a01239bf8778bbf9f5786520899068cb2b71978c4a96e952b86` |
| software-20261003 | `59b7ac1bccf6aac9fd030cc29c055f84f931c65913c4bf2bff43d6da61fbf9ce` |
| software-20261004 | `ca8b5a1de725b71d8f3a70a1592c76830ec26eef6e2ee72dd091c8b90e990df4` |
| software-20261005 | `aeec396e0027f148c4793c7a231608b457a7fc1e5a171e7a62296d7320dcfd64` |

私有 v2 产物采用修正后的主引用索引；最初诊断产物保留用于追溯，不作为上述数字来源。
后续新增 `stage_delays_by_stratum` 不改上述数字；重新 summarize 输出到新目录并核新 implementation hash。

## 前瞻 F 完成门与下一波

下一波以软件工程为试点，读者为工具链/开发流程决策者；完整来源池和重要事件/维度标签与 T03/T04 共用被冻结资源版本，旧曝光材料仅用于调试。
在查看新留出前预登记连续期数、时间窗、每来源形态最小分母、失败/unknown 处理、成本上限、P90/超龄期数上限和相对改善门。
数值协议由集成负责人纳入 T04 冻结；本工具没有编造采纳/上线阈值。

1. 冻结完整来源清单、全部可获取候选及采集失败 ledger；新 evidence revision append-only，旧 URL 的 fetched_at 不回填首次钟。源 acquisition 与分析 attempts 分表记账，当前工具的尝试分母只覆盖分析阶段。
2. 补入选 receipt、解析/提取覆盖、逐命题 evidence-pass 与 publication commit receipts；缺口显式 unknown。分析缓存命中、失败与重试各有独立尝试。
3. 用 `assertComparableFInputs(F0, F1)` 检查同来源池 hash、同窗口/as-of、同模型/总 token/USD 预算和完整失败成本 ledger；它只检查协议，不替代真实池 hash核验、事件金标、独立评测或 F 发布门。
4. 按 topic/issue/source form/first-vs-followup 单独报告双钟年龄、24/48h（含界）、各阶段延迟与损失；percentile 使用 nearest rank。unknown/负时序从 known 分位数中排除，但保留总分母及比例下界，不靠删失败改善数字。
5. 独立证据门 + 人工重要事件/维度召回非劣 + 重报/空刊不恶化 + F 时效/成本门通过，才能提出独立策略切片；当前 `comparison_ready=false`，B1/#360 不代证。

可执行命令（先使用 Node 24.19；新输出目录，不覆盖私有产物）：

```bash
npx tsx evals/rich-brief-stage0/freshness.ts \
  from-export /absolute/sealed-export /absolute/gitignored/new-output

npx tsx evals/rich-brief-stage0/freshness.ts \
  summarize /absolute/observations.json /absolute/gitignored/new-summary

npx tsx evals/rich-brief-stage0/freshness.ts \
  template 2026-10-09T00:00:00.000Z /absolute/gitignored/new-template \
  2026-10-08T00:00:00.000Z 2026-10-09T00:00:00.000Z
```

## 检查与 eval-gate

使用 Node 24.19.0；`npm ci` 在独立 worktree 完成。
`npx vitest run evals/rich-brief-stage0/freshness.test.ts`：10 项通过，包括 unknown/负时序/失败/no-input/独立成本/主引用 1→0/私有输出/hash 错配/固定预算协议。
`npm run typecheck`：TS7、TS6 及 tools 均通过；eslint max-warnings=0 通过。
调用 eval-gate 后判定：新增确定性离线诊断，没有修改生产 prompt/model/source/validator 或评测金标。
未运行 A1：A1 不执行本工具路径，不能证明 F 改善、人工标签或阅读效果；本切片仅申请工具和观测契约审查。

独立审查修正：attempt 的 analyzer_started/completed 也逐项校验 ≤ as-of；新增无 observation/publication 的未来尝试反例，阻断未来执行时长进入 known 分布。输入 API 不变。

独立审查修正：阶段损失仅按明确失败段映射（not-selected→入选、extraction-failed→提取、evidence-rejected→证据、history-filtered→出刊）；缺更早时间戳而存在更晚成功钟归 pending-or-unobserved。budget-filtered 无法区分输入/报告预算阶段，保持未知归因。新增历史过滤+漏首次采集钟与冲突后续成功钟的回归。
