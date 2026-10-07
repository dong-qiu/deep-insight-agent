# Daily Brief I：有界工作启示 shadow 样本与评测准备

> 2026-10-07 · 实查 base `b3c92771f292cf7521b3768ba6ffe69a4ef2dbbf`，分支 `docs/daily-brief-implications-shadow-prep-20261007`。只提交本文，候选正文和来源材料只在owner-only私有资源中。本波未调用业务模型API、原站、生产DB或正式留出，不修改来源、prompt、dataset、schema、analyzer、validator、report-gen或V1 TechLead；没有I人评/发布准入。

依据：[ADR-0043](../develop/decisions.md#adr-0043-daily-brief-分离来源观点与有界工作启示)、[共同v0](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)、[新版I方案](../plan/specs/daily-brief-rich-insight-freshness.md)、[试点读者与实验门](../plan/specs/daily-brief-stage0-pilot-and-experiments.md)。软件工程技术负责人/资深开发者的工具链采用、开发流程和验证试验目标沿用；不重问已确认产品边界。

## 实际前提 inventory

读取data树最新v3已曝光worklist，SHA-256为 `bc44d0f3319a0c1877f180fd962be0b3d74f3fbb1fa4d2468d5128a621636810`，14/14资源hash一致。仅打开其绑定的旧raw-verified JSON导出和对应archive-copy，不打开DB、不采新资料。这是3 runs / 3 attempts / 45输入occurrences / 23 exact revisions的旧探索池；188曝光registry其他条目不参与本波样本。

| 盘点项目 | 真实数量 | 保证边界 |
| --- | --- | --- |
| 观察到的候选记录 | 149 | 包括失败尝试的可观察候选；失败尝试总候选仍unknown，不将149当完整模型产出分母 |
| 有持久化Insight | 59 | 不是本波重新提取，也不是重要性金标 |
| 有kept/kept_degraded审计 | 41 | 标签本身不足；继续逐主引用核精确绑定 |
| 本波历史前提绑定核验通过 | 38，来自7个exact source revisions | 只证明旧快照pass/support与v6展示/归档绑定；未重跑当前语义校验或完成v0图迁移 |
| 选入I准备样本 | 3个不同source revisions的3个前提 | 按导出固定顺序取首个合格不同source revision，最多3个；不依据候选假设效果或AI评分挑选 |
| 没有持久化Insight | 90 | 不能以旧拒绝文字补前提；保留原观察缺口 |
| 没有kept审计 | 18 | 原有pass/support不能代替展示通过 |
| validator claim与精确展示claim不一致 | 1 | 本波保守拒绝，不用相同quote/主题相关推断两个claim等价，也不声称现行报告因此有bug |
| 非article、本波形态排除 | 2 | 不记语义失败；未在I准备里处理show-notes/transcript归属门 |

38合格与111互斥排除合计149，排除/unknown都留在private failure ledger。38不是38个新重要维度、独立事件或可刊启示；它们也未经人审重要性判断。

选中3项逐条核验使用真实[display-coverage-audit.ts](../../src/lib/utils/display-coverage-audit.ts)的 `auditSupportsReaderProjection`、`auditSupportsReaderStatement`、`requiredAuditCitationIndexes`，以及[白名单helper](../../src/lib/utils/citation-verdict.ts)。必须同时具备：

- audited/source_quote_v1批次、display-coverage-v6、kept或kept_degraded终态、明确主引用及primary/独立quote-only countercheck；实际reader text与通过draft hash一致。
- 所有审计required引用及主引用的旧check为 `reachability=pass / consistency=support / verdict=pass`；主 `Citation.claim`、audit内statement claim与实际reader text逐字相同。本波没有把已定位quote当作新的语义support。
- 对应完整输入ref唯一；content-v4 snapshot、规范正文hash/长度、归档effect/envelope/hash/size与真实 `normalizeBody/contentHash/canonicalHash`一致；quote在原body的UTF-16 `[start,end)` locator逐字复核。

引用索引显式区分statement/display的1-based与check/citation的0-based。现有helper通过不意味着永久不可变 `ValidationBinding` 已存在：私有premise bundle保存旧check和完整audit/hash、content-v4/source/quote/归档绑定；`current_validation_status=unknown_not_rerun`、`v0_graph_status=not_materialized`。不补当前事实、人工gold、长期历史或来源观点保证。

## 三份typed shadow候选已落地

基于上述3个历史前提，实际写出3份 `claim_type=analysis_judgment` 候选，作者标 `agent_assisted_draft`，显式标签为“我们的假设／待验证”。每项保存独立ID/version、不可变private premise-bundle ref/hash、content/citation/check/display/归档版本绑定，以及目标场景、条件、失效点和下一步验证动作。具体来源与假设正文不进入本文或非作者reviewer材料；后续需要人工判断时由owner逐项提供私有审阅包。

| 字段 | 3份当前状态 |
| --- | --- |
| factual premise refs / 条件 / 失效点 / 验证动作 | 全部已填，refs精确回到上述历史证据bundle |
| source-stated impact | 全部 `unknown_not_established_from_bound_premise`；确认数0，没有将自有判断填成来源影响 |
| human事件/重要性、独立证据review、读者review及理解效果 | 全部pending，reviewer未签，score为null |
| current事实状态、immutable published claim history及lineage | unknown/pending；不以旧榜单、费用或论文快照宣称当前事实 |
| 新事实/近期新闻增量计数 | 每项0，仅是自有判断候选；不能借新措辞算新闻收益 |
| `publish_eligible` / 验证动作执行许可 | 全部false；不承诺效果、采购、切换或自动立项 |
| analysis_revisit资格 / 频次 / 阅读预算 | 独立I门与history未过，blocked；频次和阅读预算null，未冻结 |

前提包含的对象、比较、时间和条件保持在bundle中；候选动作只是有条件的试验建议，不能把前提“适用于来源所列情境”扩大为“必适用于团队”。已有引用只支持事实前提，没有给自有判断伪造 `Citation.claim` 或source support。V1 TechLead事实入口与现行读者报告没有写入候选分析理由。

## 已生成资源与可执行命令

私有目录 `.data/rich-brief-stage0/implications-prep/`及输出子目录0700，文件0600。纯JSON/归档准备器只做binding核对，候选由本Agent组织为待审草稿，**不是人工金标或人工审核**；没有新增业务模型API调用或AI自评分。只在owned gitignored位置写新目录，不覆写原输入/已生成包，未复制DB/WAL、整篇原文或报告。

| artifact | SHA-256 |
| --- | --- |
| `premise-inventory.json` | `3955e843ce9c09bd99022adc0871e97e3b32a6b371b48cf51420a883408f036c` |
| `selected-premises.json` | `57e0a5f46c26f038f2b8987edc0c394687223bbdad1036fc9654b169368ce659` |
| `preparation-failure-ledger.json` | `f7ea6022fb597f274cdfd6ddd263413d905e8e1eda7eaf02fdc670a08e6556a1` |
| `analysis-judgment-candidates.json` | `1841f2cf613fe01f8d8cf74f6e4391906f27b713fbd33ee68dcdb26a9ff93601` |
| `I-evaluator-protocol-draft.json` | `c6bcb901279f11ca1778a73bc9b614ed98d30da05afd07e003a9177f16465118` |
| `I-human-review-worklist.json` | `c14b46325a004e48d89e3ee800fac46b461695f3870eb368f92862ae184f8751` |

准备器SHA-256为 `b51781dfb4cd323ec3f7c24ef49ee3807d9bc2f49e7b6cd8328aa51e9c9e1d3a`，private selector/shadow receipt另绑定资源hash。它是本波私有盘点，不是已实现的I evaluator、产品type或共享validation binding。

使用满足仓库engine的Node 24.19工具链，从该worktree执行；命令不固化本机用户安装路径。config已固定旧v3绝对输入路径及hash；重新盘点须换新输出目录，不能覆写已有run-v1/v2。

```sh
node --version
node --import tsx .data/rich-brief-stage0/implications-prep/select-premises.mjs \
  .data/rich-brief-stage0/implications-prep/selector-config.json \
  .data/rich-brief-stage0/implications-prep/run-v2
```

上述命令重建前提inventory/bundle和失败账本，不自动生成或评价启示；3份候选与待人工worklist在独立shadow receipt封存。各臂/各判断之后的业务模型调用、token、费用、失败、人工时间、阅读与放弃也必须分别记账，本波实际新增业务模型/原站调用0、相应费用0；准备耗时未仪器化为unknown。当前pending不记作错误0或人评通过。

## I专用evaluator资源草案与下一门

协议资源已经列出前提真假与历史时间范围、逻辑越界、目标不适用、反例/失效、动作可行性、读者错误归因、误认新闻增量和阅读负担8类审阅维度。3行human worklist的答案/结果全为null；sample目标、盲读人数/分配、score门、频次、阅读/token/成本/时间预算及evaluator/model/prompt版本均为null/pending，`status=not_frozen`。已准备3sample不是足量通过门。

独立证据审阅先核前提/必要限定/出处版本及当前适用范围；人工领域审阅判断推理、条件和验证动作；人工盲读分别辨认来源事实与我们的假设、是否新增新闻、适用及失效情境、下一步动作。未来拒绝/不适用/证据不足/部分读测/放弃均留在固定分母。合成错误变体若用于工程反例须另stratum，不能冒充真实反例、人工结果或原来源观点。

有无正确前提、推论是否有界、是否适用于读者、动作是否可执行及理解效果分别验收，不能以前提机器通过代签逻辑/阅读。捏造前提、限定缺失、source quote直接给推论背书、无界泛化或效果承诺、没有I门的公开推论、把分析回访计新事实/近期新闻均拒绝。数值收益/误拒与预算待有依据的探索和人工确认，不能凭本波AI草稿自设阈值。

当前可独立前进的是：对3个有限候选逐项核对前提/逻辑/适用性，补来源影响与判断的标识反例，准备独立人工工作表及阅读盲测规则。新产品方向已确认；只在具体假设或事件重要性确需裁决时向用户交逐项材料，不重复询问方向。正式阅读卡依然依赖C1足量新增可刊重要维度和独立证据门，I准备不代签它。

`analysis_revisit`只能在事实未变、已验证前提/history/lineage与独立I门、人评、全展示面绑定及频次/阅读预算全部过门后发布；本轮没有证实永久事实历史，也未申请该类别。P全文、C说话人、F时效或C1成功不自动开放I。生产类型、审核主体、gate、全展示面与回退由集成负责人串行冻结后再实现，缺省off。

## 工程核对与交付限制

依仓库eval-gate覆盖判断，本diff只提交文档，私有准备不改生产prompt/模型/来源/校验或评测标签。A1不执行本波盘点/I逻辑或阅读题，未跑、不盖eval pass章；未来typed claim/model/validator及公开展示实现分别走有效语义门与真实发布/恢复路径，人评不由AI代替。

实际已核验3candidate必填结构/唯一premise refs及hash、publish false、人评null、资源receipt/hash和owner-only权限。v2增加显式reachability=pass重核，38/7/3计数及inventory、selected bundle、failure ledger和候选hash保持一致；v1原件保留，未覆盖旧包。

- Node `24.19.0`下锁定依赖安装完成，`npm run typecheck`的TS7/TS6各app/tools通过；它只核对现有树，不包括gitignored private mjs，也不认证I发布实现。
- `ops/ci-docs-check.mjs/checkDocuments`真实检查本文1/1通过，`git diff --check`通过。
- 私有selector `node --check`、最新selector/resource receipt hash及全部0700/0600权限重验通过。这些是准备资源检查，没有运行I evaluator或人评。

非作者审查由集成负责人安排。仅本文commit，不push/merge/生产开关；上线仍须具体版本、核验与回退后用户确认。
