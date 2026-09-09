# Spec: 原子洞察与证据关系图

> 状态：已达成方案共识，待分阶段实施。
> 日期：2026-09-09

## 背景与目标

Insight Agent 的发布红线是“报告中的引用必须可回溯到原文”。现有链路已经能拦截大量无效、不可达或语义不一致的引用，但一条洞察仍可能把多个事实、比较和结论写在同一句中，再由多个引用共同支撑。这样会带来三个问题：

- 读者无法判断一个具体数字、范围或因果词到底由哪段原文支持；
- 校验器容易退化为“整段文字大致可由若干链接覆盖”，而不是逐项验证；
- 为了避免误报而放宽校验，会增加“看似有引用、实际结论越界”的风险；反过来，过严的整句校验又会误拒真实证据。

本方案把**可核验的事实**和**面向读者的报告表达**分层：分析层产出原子事实，证据层显式保存事实与原文片段的关系，报告层只组合已经验证的事实。目标不是把日报写得碎，而是让每一句可读结论都能展开为可审计的事实图。

## 用户故事

- As a 情报读者, I want 每个关键结论能定位到对应原文和事实, so that 我能快速判断其可信范围。
- As a 编辑或审核者, I want 看到报告句子由哪些已验证事实组成, so that 我能审查归纳是否越过证据边界。
- As a 系统维护者, I want 把“直接事实”和“跨事实归纳”区分校验, so that 提升引用精度而不牺牲可读性。

## 核心决策

### 1. 原子事实是分析层的最小发布单元

原子事实（Atomic Fact）是一个独立、最小、可由外部原文验证的**完整命题**。长期目标为：**一个原子事实有一个主证据来源**；若需要多个来源支持同一主题，应保存为多个事实，而不是把来源拼成一个不可拆分的句子。

原子不等于短句，也不等于每天只能使用一个来源。它要求一个事实只表达一个可验证断言，例如一个结果、一个指标、一个适用范围、一个限制条件或一个来源直接陈述的关系。

原子不等于短句。命题成立所必需的主体、指标、比较基线、范围、条件、模态和限制必须留在同一个事实中，并由同一主证据来源完整覆盖；不能先把条件剥离，再发布一个失真的“裸结果”。只有可独立判真/假的附带命题才应拆开。

以下内容必须拆分为不同事实：

- 两个独立的数字或实验结果；
- “A 优于 B”的独立比较结果，和无法由同一主证据来源完整支持的附带主张；
- 事实与由系统自行推出的因果、趋势、优先级或普遍性结论；
- 可独立判真的结果与限制/范围事实（必要限定除外）。

### 2. 证据关系必须显式保存

目标关系图为：

```text
已发布 artifact 的展示锚点 --binds--> ReportClaim --derived_from--> AtomicFact --supported_by--> FactEvidence --points_to--> 原文 quote/span 快照 --belongs_to--> ContentItem 版本
```

`FactEvidence` 是不可变证据边：它保存 `CitationRef`、原文内容哈希/版本、逐字 quote、locator、一个或多个有界 evidence span、展示覆盖审计 ID、校验 verdict、validator/prompt/policy 版本和时间。仅有 URL 可达性不足以构成证据。一个主证据来源可由同一 `ContentItem` 内有限多个、可定位的 span 组成（例如正文与图注）；跨 `ContentItem` 拼接才能成立的命题不得标为单一原子事实，必须拆分或阻断。

事实、证据、报告声明和 artifact 均使用稳定版本 ID。`primaryCitationRef` 必须唯一指向该事实的 `contentItemId`；已发布报告不能因内容重抓、重渲染或后续校验策略变化而丢失“当时为何通过”的证据快照。

### 3. 报告可以综合，但不得自由推断

报告层不直接生成没有来源的“新事实”，只能使用已验证原子事实，并保存 `derived_from_fact_ids` 和表达关系类型：

| 关系类型 | 含义 | 允许条件 |
|---|---|---|
| `direct_fact` | 直接复述一个原子事实 | 恰好绑定一个事实；数字、对象、范围、条件、极性和模态不变 |
| `verified_parallel_summary` | 并列多个事实 | 至少绑定两个事实；由确定性白名单模板生成，逐项保留事实的主体、条件、极性和模态，不引入实体/时间对齐、因果、优劣、总量、比例、普遍性或新比较 |

`source_stated_relationship` 是 `AtomicFact.claimKind`，不是报告层的自由关系类型：报告只能用 `direct_fact` 展示它。除原始研究直接报告的结果外，渲染必须保留来源主体、证据动词和语气（如“该论文报告”），不得把来源观点写成已被系统独立证实的事实。

关系类型由确定性编排器根据绑定事实的数量和白名单模板授权；模型只能提出候选，不能以自报 `relationType` 获得发布资格。不允许未被来源明确支持的 `inference`、因果归因、最佳方案判断、跨场景泛化或“因此/证明/领先”等强化措辞进入发布报告。

### 4. 读者看到的报告保持连贯

原子事实用于保存和验证，不要求逐条原样展示。报告生成器可按主题、事件或实体将已验证事实组织成段落；每个读者可见的断言片段必须有 `FactBinding`，绑定事实 ID、渲染文本范围和对应证据引用。读者界面展示原文引用，而不是内部 F1 ID。这样既避免“短、碎的数据库条目”直接成为日报，也避免流畅叙述掩盖证据边界。

示例：

```text
事实 F1：论文在其 CPU 基线上报告最高 8.4x 加速。 [C1]
事实 F2：论文在其 GPU 基线上报告最高 1.4x 加速。 [C2]

报告句：该方法在论文所列 CPU 与 GPU 基线下均报告加速：
最高分别为 8.4x 和 1.4x。 [F1, F2]
关系：verified_parallel_summary
```

该报告句不能进一步写成“该方法因此是更优的通用方案”，除非有来源直接支持该结论并形成独立事实。

### 5. 独立评审一致意见（2026-09-09）

数据/架构、证据语义、迁移/评测三个独立评审视角一致认可本方案的方向：原子事实、显式证据边和受限报告编排是正确的目标架构。三方也一致认为它**只能先作为 P0/P1 实施基线，不能据此直接开始 P2 的 schema/API 迁移**。

进入 P2 前的共同前置条件为：

1. 完整原子命题与同一主证据来源的有界 span 集；
2. artifact 版本和断言级 `FactBinding`，而非仅句级事实列表；
3. 不可变证据/校验快照与发布事务完整性；
4. 由确定性模板授权的报告综合，不能相信模型自报关系类型；
5. legacy 投影、影子路径、feature flag 回退和可比较的分层 Go/No-Go 基线。

后续章节把这些共同前置条件写为数据契约、行为规约、阶段门和验收标准；任何一项未满足时均为 P2 No-Go。

## 输入 / 输出契约

### 目标数据契约

以下是目标契约，不要求本次文档落地时立即迁移数据库。

```ts
type FactEvidence = {
  id: string;
  factId: string;
  citationRef: string;
  contentItemId: string;
  contentHash: string;
  quote: string;
  evidenceSpans: { startUtf16: number; endUtf16: number; excerpt: string }[];
  displayCoverageAuditId: string;
  validationCheckId: string;
  verdict: "pass" | "fail";
  validatorPolicyVersion: string;
  verifiedAt: string;
};

type AtomicFact = {
  id: string;
  text: string;
  claimKind: "result" | "mechanism" | "comparison" | "scope" | "limitation" | "source_stated_relationship";
  topicId: string;
  analysisBatchId: string;
  runId: string;
  eventId?: string;
  primaryCitationRef: string;
  contentItemId: string;
  verificationStatus: "verified" | "blocked" | "legacy";
};

type FactBinding = {
  factId: string;
  textStartUtf16: number;
  textEndUtf16: number;
  citationRefs: string[];
};

type ReportClaim = {
  id: string;
  reportId: string;
  artifactId: string;
  artifactVersion: string;
  renderedAnchor: string;
  renderedTextHash: string;
  text: string;
  relationType: "direct_fact" | "verified_parallel_summary";
  derivedFromFactIds: string[];
  factBindings: FactBinding[];
  provenanceStatus: "verified";
};
```

`primaryCitationRef` 指向主证据来源；实现中可以保留补充引用和独立交叉验证信息，但补充证据不得掩盖主断言缺少直接支持的问题。`verificationStatus` 由已通过的不可变 `FactEvidence` 推导或与其在同一事务中约束，不能作为可任意改写的标签。

历史洞察在迁移完成前标记为 `legacy`。仅当原始内容快照可用、最终展示命题与 `Citation.claim` 规范化等值、对应 CitationCheck 通过且存在展示覆盖审计时，才可投影为新的 `verified AtomicFact`；其余历史记录只能为 `legacy` 或 `blocked`。`legacy` 可保留在历史报告中并显示旧保证等级，但不得作为新 `ReportClaim` 的输入。

### 报告生成输入与输出

| 项 | 说明 |
|---|---|
| 输入 | 仅 `verificationStatus=verified` 的原子事实、证据引用和允许的主题/事件分组 |
| 输出 | 含 artifact 版本、渲染锚点、`ReportClaim` 与断言级 `FactBinding` 的报告文本；每个读者可见事实展示面都能返回原文引用 |
| 触发 | 日报/周报生成、人工预览、审核重跑 |

## 行为规约

1. 抓取内容统一进入 `ContentItem`，引用必须包含可展示、可定位的原文摘录或位置。
2. 分析器先识别候选断言；复合断言按可独立判真的结果、对象、指标、范围、条件和限制拆分为候选原子事实，但命题成立的必要限定保留在同一事实中。
3. 每个候选事实必须选择一个直接主证据来源，并通过可达性、摘录一致性和语义覆盖校验；失败即标记 `blocked`，不得进入发布白名单。
4. 报告生成器只选择已验证事实。它可按同一主题/事件分组，但分组不是新的证据实体。
5. 确定性渲染器按关系类型生成文本：`direct_fact` 逐项复述；`verified_parallel_summary` 仅使用可反解析为 `FactBinding` 的白名单模板。模板外 token、谓词或关系出现时阻断或降级为内部草稿。
6. 发布前校验每个读者可见断言片段中的关键谓词、数值、比较对象、范围和限制条件是否全部由其 `FactBinding` 映射；任何未绑定部分均阻断发布或降级为内部草稿。该约束覆盖正文、标题、摘要、卡片、重要性说明、图表、通知、导出和追问，不允许旁路。
7. 审核界面和审计产物必须支持从已发布 artifact 的展示锚点跳转到事实、引用、原文摘录，反向也能查询某个事实被哪些 artifact 版本和展示面使用。
8. 发布事务必须同时固化 ReportClaim、FactBinding、FactEvidence、验证审计、render citations 和 artifact manifest/version；任一边缺失时报告只能为 draft/failed，不能为 done。新图不得成为绕过既有 validator 白名单的第二条路径。

## 分阶段实施

### P0：契约与审计先行

- 固化本规格、关系类型和禁止的自由推断边界。
- 在现有 `Insight`/引用数据上生成只读的事实—报告映射审计，不改变生产 schema。
- 记录复合断言率、未绑定谓词、引用覆盖缺口和报告可发布率，作为迁移基线。
- P0 只度量基线，不作为质量通过证明；指标按 topic、来源/body kind、模型和报告展示面分层，并固定数据集、源码、配置和输入哈希。

### P1：兼容投影与双轨验证

- 仅按本规格的 legacy 投影判据从现有洞察投影候选原子事实；无法安全拆分、没有内容快照、CitationCheck、展示审计或等值 `Citation.claim` 的记录保持 `legacy` 或 `blocked`，绝不静默升级。
- 报告路径并行输出旧格式和证据图审计结果，比较信息产量、引用准确性、误拒率与人工审核成本。影子产物不得写入读者报告、触发通知、影响重复检测或生产统计。
- `verified_parallel_summary` 必须由确定性白名单模板表达，不能由模型自由补全关系。
- 预登记与现有 `eval-criteria.md` 对齐的过渡基线和每个分层的 Go/No-Go 口径；若 Insight 与 Fact 的单位不同，必须在同一语料上保留旧洞察和原子事实的双标注，不能把不可比指标当作回归绿灯。

### P2：持久化证据图与报告编排

- 在 schema、迁移和 API 中正式保存 `AtomicFact`、`ReportClaim` 及其关系。
- 报告渲染改为从事实白名单和关系模板生成；加入读者侧的句级溯源展示。
- 对历史数据明确迁移状态，不混淆新旧保证等级。
- 迁移必须读写兼容，并用 feature flag 在旧/新读取与渲染路径之间回退；禁止把 SQLite schema 回滚当作日常回退机制。已发布 artifact 必须保留当时的事实图、证据快照和渲染版本。
- P2 前必须以 ADR 固化不可变性/版本、外键与索引、artifact anchor、发布事务、内容更新、redaction 和 replay 的保留策略。

### P3：收紧生成与发布门

- 分阶段把“一个原子事实一个主引用”升级为分析器的默认生成契约。
- 将未绑定报告谓词、关系类型越界和无主引用事实接入发布阻断。
- 只有同时满足下列预登记门槛，才能停止旧路径作为默认发布依据：发布输出可达性 100%；display `unsafe_accept=0`；适用的一致性、幻觉、flagged 与人工复审指标均达到 `eval-criteria.md` 的发布阈值；相同配置下任一硬质量指标相对过渡基线不得下降超过 3 个百分点；达到预登记的产量下限、最大误拒率、人工抽检比例与连续完整运行次数。任何缺失口径、不可比基线或失败分层均为 No-Go。

## 验收标准 (AC)

- [ ] AC1：每个新发布的原子事实都有一个可定位、已通过语义覆盖校验的主证据来源；同一 `ContentItem` 内的有界 span 集完整覆盖命题的必要限定。无主证据、校验失败或跨内容拼接事实不能进入发布报告。
- [ ] AC2：每个已发布 artifact 版本的所有事实展示面都有 `ReportClaim`、渲染锚点、文本哈希和断言级 `FactBinding`；其所有绑定事实均为 `verified`。
- [ ] AC3：`direct_fact` 恰好绑定一个事实；对象、数值、比较、范围、条件、限制、极性和模态均能映射到该事实及其不可变证据边。
- [ ] AC4：`verified_parallel_summary` 至少绑定两个事实，并且可确定性反解析到每个绑定；出现模板外 token、谓词、实体/时间对齐、因果、优劣、总量、比例、普遍性或新比较时阻断发布。
- [ ] AC5：任何来源关系结论均以 `source_stated_relationship` 原子事实表示，并以 `direct_fact` 且保留来源归因/语气的方式渲染；报告层不得自行推出关系。
- [ ] AC6：审核者可从已发布 artifact 的任一事实展示锚点回溯至原文摘录、内容哈希、验证审计和策略版本，并可从事实查询所有下游 artifact 版本与展示位置。
- [ ] AC7：迁移期间，旧数据明确标为 `legacy`；不会被新的发布门误认为完全符合原子事实契约。
- [ ] AC8：`legacy` 仅在历史展示中保留旧保证等级，不能成为新 `ReportClaim` 输入；只有通过完整重验和证据快照校验的历史记录才可升级为 `verified`。
- [ ] AC9：报告发布事务缺少 FactEvidence、验证审计、FactBinding、render citation 或 artifact manifest/version 中任一项时，报告不得进入 `done`。
- [ ] AC10：涉及 prompt、模型、校验逻辑、数据源或评测集的实现 PR 必须通过 Eval-Gate，并相对过渡基线按分层报告引用一致性、显示覆盖、误接受、误拒绝、人工复审和报告产量变化。

## 非功能要求

- 准确性：发布报告中 `blocked`、`legacy`、无验证记录或无主证据的事实数必须为 0；`multi_source/source_count` 只是覆盖元数据，不可被表述为同一原子事实的独立印证。
- 可观测性：按 topic、来源/body kind、模型、报告展示面和评测/生产批次记录事实候选数、可发布率、复合断言率、主证据覆盖率、未绑定率、误接受/误拒绝和人工复审结论；每项指标必须定义分母。
- 成本：事实拆分会增加模型调用和校验次数；优先采用一次分析、多次确定性编排，以及批量失败时的安全逐项降级。
- 性能：报告渲染以已验证事实图为输入，不能在页面层重新抓取第三方内容或绕过 validator 白名单。
- 兼容性：迁移以双轨审计和可回滚开关推进，不与 live SQLite 数据库或历史生产数据共享试验环境。

## 依赖与影响范围

- `src/lib/agents/analyzer`：候选断言拆分、主引用选择、受控重要性理由。
- `src/lib/agents/validator`：主引用语义覆盖、关系类型校验、显示覆盖审计。
- `src/lib/agents/report-gen`：事实选择、模板化综合、句级溯源渲染。
- `src/lib/db/schema.ts` 与分析持久化：原子事实、报告声明和关系边的持久化设计。
- `evals/`：增加复合断言、跨来源并列、范围/限制、关系越界和历史兼容样例；按照 `eval-gate` 比较基线。
- `docs/plan/architecture.md`、`docs/develop/decisions.md`：P2 前补充正式数据模型与架构决策。

## 非目标

- 不把模型的自由解释或常识推理伪装为来源支持的事实。
- 不要求报告把每个原子事实机械地单独显示为一行。
- 不以 URL 可达、标题匹配或多个弱引用的合并替代直接语义证据。
- 不在未完成双轨验证前一次性重写历史报告或删除历史溯源数据。

## 开放问题

1. 主证据来源之外的独立交叉验证关系是否需要单独建模，以及何时可向读者显示“交叉验证”标签。
2. 主题/事件分组的实体解析质量门及人工纠错路径。
3. 哪些受限汇总模板可在中文报告中保持自然、又能可靠识别越界措辞；其词表与反解析测试集由谁维护。
4. P1 前在 ADR 中预登记的产量下限、最大误拒率、人工审核抽样比例及连续稳定运行次数的具体数值。
