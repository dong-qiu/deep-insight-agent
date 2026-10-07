# Daily Brief 共同版本化证据与发布契约 v0

> 2026-10-07 · 阶段 0 接口候选，供集成负责人冻结。本文定义后续切片的共同输入与完成门，**不是已实现的 schema、生产功能、S1 或来源许可**。代码审计基于 `473e2eeae119b600b63abd78ce886301bd882235`，见[独立审计](../../verify/daily-brief-stage0-contract-audit-2026-10-07.md)。

依据：[新版方案](daily-brief-rich-insight-freshness.md)、[成员发布包](daily-brief-density-member-publication-contract.md)、[原子证据图](atomic-insight-evidence-graph.md)、[播客规格](podcast-transcript-acquisition.md)、[现行报告规格](report-generation.md)、[架构](../architecture.md)、[ADR-0036/0043](../../develop/decisions.md)。现行 validator 与展示审计是共同底线；本文没有放宽它们。`C1-extraction` 专指首次提取对照；交接中的 `C1-backup` 专指旧备份/恢复验收，两者收据和完成门互不替代。B1 当前 no-go，#360 仅诊断收口。

## 版本与未知值

本契约的 `contract_version=rich-brief-evidence-publication-v0`。每个资源另存其自身版本和 SHA-256，不能仅写“latest”或模型营销名称。规范编码使用已审计的确定性 canonical JSON + UTF-8 SHA-256；语义金额用整数 micros 或稳定十进制字符串，禁止浮点舍入改变身份。数组仅在字段声明为集合时排序；成员、span 和渲染顺序保持不变。每个对象保存规范包 hash，遇同 key 不同 payload 则记录冲突并拒绝覆盖。

不存在的信息写结构化 `unknown(reason)`；明确不适用写 `not_applicable`。不得用空串、零、当前时间、最后抓取时间或模型猜测补齐。事件日期、来源可获取时间等诊断字段可以未知，但须计入未知分母。发布必需的事件身份、归属边界、原文 revision、定位、语义 support、展示绑定、artifact 与历史判断不得未知；缺失时只保留候选/失败记录。无需嘉宾归属的 transcript claim 可明确写 `attribution=none` 并展示“节目转写提到”，不能把 `unknown` 归属尝试改成 `none` 来消除已有的人物断言。

## 五层身份及键

以下字段是逻辑接口，数据库表名、迁移和具体 TypeScript 类型留给经评审的实现切片。当前 tenant 固定 `default`；离线实验必须另有 `dataset_id`/`execution_scope=shadow`，不能以虚构 tenant 绕过现有单 tenant 约束。

| 层 | 键与必填内容 | 未知/不可变边界 |
|---|---|---|
| 来源配置 | `(source_id, source_config_revision)`；规范化、脱敏配置 hash，adapter/parser/policy 版本、source family ID 与家族标注版本 | 家族未知保留 `unknown`，不得当独立源或负例；配置变更产生新 revision，认证参数不进入证据 |
| 原文版本 `SourceRevision` | `(source_work_id, evidence_revision)`；内容形态、来源/ContentItem refs、`content-v4` ref、归档 envelope/ref/hash、下载载荷不可逆 hash、脱敏归档 hash、规范正文 hash、parser/normalizer 版本、覆盖账本 hash | 与 live `content_item` 分离。换抓取时刻不自动换证据版本；正文、表格/图注、speaker map、解析覆盖或版本归属变化均产生新版本 |
| 命题身份 `ClaimIdentity` | `(event_identity_version, event_key, claim_key)`；完整语义元组、命题类型、身份策略/人工裁定 ref | 与措辞、URL、抓取时间、模型 run、证据数量无关；语义不明拒绝“首次新刊/深读更新”资格 |
| 证据出现 `EvidenceOccurrence` | `evidence_occurrence_id`；claim、唯一主 `SourceRevision`、quote/hash、有界 locator/span、归属、提取 run/arm/candidate refs | 同命题不同证据版本是不同 occurrence，不能因此成为新命题；不可跨 ContentItem 拼接支撑单一原子命题 |
| 校验/发布 | `validation_binding_id`、`(artifact_id, artifact_version, member_id)`；下文精确绑定与前刊 lineage | 只追加，不从 live 行重建已刊文本；策略重验产生新记录，不能覆盖当时通过依据 |

`source_work_id` 表示同一文章、论文工作或节目集的版本链身份；不把同 URL 当充分证明。论文采用可信论文 ID 与作者版本映射，节目采用 canonical episode 与 RSS/节目页/转写配对，文章采用已核验 canonical work 映射。映射不确定即 unknown。转载/镜像的 source family 与同一 work 的证据版本分开：两个镜像不等于两个独立来源。

现有 `source-v1` 是配置 revision，`content-v4` 是白名单元数据 snapshot revision，二者都不是全文证据 revision。v0 保留两种现有 ref；新增 `evidence_revision` 覆盖完整证据 envelope 的规范 descriptor（不含秘密或正文副本），并验证 descriptor 指向的归档字节/正文。descriptor 包括上表的形态、hash、parser/normalizer、覆盖、speaker map 与可信工作版本。`observed_at`、抓取 run 和首次/最后时钟作为追加观察事实关联，不进入“正文语义有增量”的判断。原归档不可读或不匹配时失败关闭；有 `content-v4` 行不能替代原文归档。

## 命题、事件、重要维度

`ClaimIdentity` 至少包含以下显式语义字段：

```ts
// 文档接口示意；尚未导出到 src/，不得当运行时代码。
type ClaimIdentityV0 = {
  contract_version: "rich-brief-evidence-publication-v0";
  event_identity_version: string;
  event_key: string;
  claim_key: string;
  claim_kind: "result" | "mechanism" | "comparison" | "scope" |
    "limitation" | "source_stated_relationship" | "source_view";
  semantic_tuple: {
    subject: string; predicate: string; object: string;
    metric_and_unit: string; comparator_and_baseline: string;
    scope: string; conditions: string; polarity: string; modality: string;
    time_or_work_version: string; attributed_source_or_speaker: string;
  };
  identity_policy_version: string;
  adjudication_ref: string;
};
```

无指标/比较/人物归属时，相关字段取明确 `not_applicable`，不能删字段。哈希只证明 canonical tuple 相同；不同措辞是否同一命题、两篇来源是否同一事件不能由哈希证明。候选映射由确定性规则提出，歧义留待人工，追加带理由的 alias/adjudication 版本；历史裁定不原地修改。`event_id` 只作现有 occurrence 线索，须通过主体/行动/对象/研究版本证据映射到 `event_key`，不能把相同 `event_id` 当真实同事件证明。

`GoldDimension` 单独绑定 `(dataset_id, event_key, dimension_id, gold_version)`，保存重要性、完整命题、必要限定、输入 ref 集、人工确认/待审状态。维度不能由实验臂的候选数量定义。T03 的全部输入、所有重要事件/维度、排除原因、未知和无模型输出均留在固定分母；旧 188 版本只作探索。家族留出、前瞻窗口、T04 数值/资源指纹和盲评题由数据/协议切片冻结，本文不凭证据契约代签人评或数值门。

`ClaimIdentityV0` 是未来产品结构契约。实验评分侧可用人工事件/维度gold对照候选；**人工gold不得注入C1/B1执行器、prompt、归组器、选段或排序来充当系统自动能力**。执行器只能消费冻结来源与其自身版本化规则/模型；gold、留出标签和评分identity映射置于独立评分资源，在各臂输出固化后关联。工程用合成fixture也不得混入真实收益/安全cohort。

## 证据出现与校验绑定

每个 `EvidenceOccurrence` 必填：`claim_key`、`evidence_revision`、实际主 `content_item_id` 与 `citation_ref`、逐字 `quote`/hash、正文 UTF-16 `[start,end)` span 及 excerpt、原载荷 locator（HTML 段落/PDF 页与块/转写 segment）、bounded span 顺序、必要上下文/限定、source/speaker 归属、提取模型/prompt/output/预算版本、run/arm/candidate ID、失败终态与时间。quote 对正文规范版本的 UTF-16 定位必须重算一致，PDF 等原载荷 locator 与正文坐标同时留存，不能把页码字符串当逐字定位证明。

同主 ContentItem 的有界正文、表格/图注 span 集可以作为未来原子证据图的候选，但现行 display-coverage-v6 要求唯一 citation 的 displayed quote 自洽、覆盖整项断言并通过独立 quote-only countercheck。**v0 不使多个不连续 span 自动获得现行发布资格**；需改变展示/validator 时另立版本、反例及 eval-gate。跨条目才成立的复合命题必须拆分/阻断，不能把各段拼成伪引语。多个 occurrence 的 `source_count` 是覆盖元数据，未经专用独立性规则不得写“多源证实”。

`ValidationBinding` 必填：

| 字段组 | 精确绑定 |
|---|---|
| 输入 | claim key/完整 claim hash、evidence occurrence ID/hash、source/evidence/content revisions、quote/span hash、实际 `Citation.claim`、最终展示文本 hash、展示模式 |
| 展示审计 | 完整 `kept`/`kept_degraded` decision、gate/prompt/input hash、主引用索引/refs、逐断言 coverage spans、primary 与独立 countercheck、reader statement/draft/source quote hashes |
| validator | batch/check ref、完整 reachability/consistency/reason/verdict、模型/provider resolved ID、prompt hash、policy/cache/thinking 配置、checked_at、运行状态 |
| 结论 | 只有 `reachability=pass && consistency=support && verdict=pass` 且实际展示绑定通过才可作为发布输入；缺记录、`flagged`、`blocked`、异常、未知均拒绝 |

展示绑定不可只按 insight ID 或“同一来源另一成员通过”成立。`kept_degraded` 的最终正文只能使用已精确审计的 `reader_statement`，否则用已通过的 source-quote 投影，禁止恢复被降级草稿。全篇 body 的 validator support 不能代替读者所见 quote 的覆盖；quote 存在不能代替语义 support。引用编号转换在接口处显式声明：现有 `statement_citation_index`/display audit 为 1-based，validator/check 和 report binding 为 0-based；新稳定 occurrence ID 是身份，索引只是投影，不允许暗中统一后错配。

## PublishedArtifact、Member、ClaimLedger 与 lineage

新格式 intent 的规范不可变包至少保存：`report_id/topic_id`、选择/renderer/contract 版本、Story/event 与成员顺序、每个成员 claim key 和 occurrence/binding ID/hash、实际最终文本/hash/mode、重要维度和选择终态、MD/HTML artifact ID/version/字节 hash、唯一展示锚点、正文 UTF-16 span 与引用编号映射、source family/形态/时间快照、历史决策与 lineage。同源多成员标单源；Story 数、独立事件数、新重要命题数、前情数、分析判断数分别计量。

`PublishedClaimLedger` 从该规范包逐项派生，键为 `(topic_id, claim_key, artifact_id, artifact_version, member_id)`；保存发布类别、event key、首次刊期、前刊 member、history/asOf/policy 版本及原保证等级。判断历史是否存在须查 immutable published artifact 的命题集合，而非 live Insight/当前检查或新 URL。ledger 必须跨开关 `off→on→off→on` 一致；最近 14 天现行 occurrence 查询可保留为旧模式保护，不能冒充永久语义命题历史。新增命题历史范围及保留/删除规则须在生产实现 ADR 明定，未证明历史完整时不授予“此前未刊”。legacy 不静默升级为 verified；未知历史映射拒绝新版首次/续报资格，现行旧模式按自身契约独立运行。

| 发布类别 | 必要条件及计量 | 不合格情况 |
|---|---|---|
| `first_publication` 首次新刊 | 事件归属确定、重要命题未刊、证据与展示独立通过；近期首报另须 F 时间证据 | 新 URL、镜像、重抓、换句式、同旧命题另一来源不足以新刊；首次见到旧事件不自动算近期新闻 |
| `deep_read_update` 深读更新 | 已刊同事件，新重要方法/依据/反例/范围/局限/嘉宾观点改变结论理解；逐命题未刊与通过，链接前刊 artifact/member | 旧结论仅作带绑定的前情，不计新事实、独立事件或近期首报；只有新增篇幅无资格 |
| `analysis_revisit` 分析回访 | 事实未变，仅新增 typed analysis judgment；I 专用发布门、人评、频次/阅读预算通过，链接已验证前提 | 未过 I 门只留 shadow；不计事实增量、近期新闻或新事件 |
| `reading_page_revision` 阅读页新版本 | 只补充解释/导航，无可刊重要新命题；版本化关联原 artifact | 不创建日报新刊，不更改原 artifact 或重写原刊期 |

`lineage` 是明确的 `(from_artifact/version/member, to_artifact/version/member, relation, policy_version, decision_ref)` 追加边；`relation` 取 `same_event_deep_read_update|analysis_revisit|reading_page_revision|correction`。`correction` 只能走独立纠错/撤回与生命周期流程，不因新 evidence 自动涂改旧刊；旧绑定保留或按既有 redaction/retention 权限删除。新关系边本身不授予发布许可。

## 来源与分析边界

| 切片 | 专用必填证据 | 回退/禁止 |
|---|---|---|
| P 论文 | work/version ID、HTML/PDF/摘要形态、完整性/章节/表格与图注覆盖账本、解析错误/截断、作者 claim/实测结果/范围与限制 | 摘要级回退显式“仅据摘要”，不记 full-text cohort 或深读通过；缺全文/关键章节不能宣称论文全文证明 |
| C 播客 | canonical episode/RSS/节目页/下载载荷配对、发布者公开 transcript、segment/timestamp、speaker map/hash/version、主持/嘉宾角色和来源段 | show notes 只刊已验证简介；未知 map 不归人，verified 还须段/map相互匹配；不跨段拼引语。不新增 ASR或旧 URL 原地升级许可 |
| I 启示 | 独立 `AnalysisJudgment` ID/version、已验证前提 claim/binding 列表、目标读者/场景、条件、失效点、验证动作、审核主体与专用门证据、明确展示“我们的判断/待验证” | 不能用 `Citation.claim` 的 source support 假装推论被原文直接支持；来源明确影响仍为 source claim；V1 TechLead 不容纳自由分析理由 |
| F 时效 | event/work original/version time、source available、first collected、selected、extracted、validated、published 的追加观察与时间来源/精度/unknown 原因 | 不把 `fetched_at` 当首次发现/来源可用；无打开遥测仅固定阅读时点情景估算；首次/续报/形态分别计量 |

I 的逻辑类型与事实命题分开：`AnalysisJudgment` 没有伪造的直接原文 support，也不能进入现行 AtomicFact 白名单。其前提仍逐条需要 ValidationBinding；公开 judgment 的 reviewer/approval record、全展示面绑定和专用 evaluator 由 I 切片冻结，在此之前关闭。前提正确不等于推论、读者收益或可执行性通过。

## 共用接口与发布事务

以下函数名是未来实现责任接口，**当前均未因本文而实现**：

```text
freezeSourceRevision(input archive + descriptor) -> SourceRevision | rejection
resolveClaimIdentity(candidate + deployed event/identity policy versions) -> identity | unknown
bindEvidenceOccurrence(identity + revision + bounded spans) -> occurrence | rejection
bindValidation(occurrence + exact final display + checks/audit) -> binding | rejection
classifyPublication(identity + immutable published claim ledger at asOf) -> category | unknown
buildPublicationPackage(ordered qualified members + lineage + renderer versions) -> package
assertRichBriefPublication(intent + package + exact staged artifacts + archives) -> pass | rejection
```

发布 guard 必须在 normal commit、无锚 reconcile、已锚 reconcile 同一路径执行，并在变更 `Report.status=done`、index/FTS/review 可见性及锚提交的同一事务核对。保留现有 `assertReportPublicationEvidence` 作为旧模式 guard/新模式子检查；新版还要检查完整版本包、每成员审计、span/归属、历史/lineage 与两份 artifact hash/锚点。空 Brief 沿用现行空刊契约，不创建虚构 member。

intent 前不合格组可降为独立合格单成员，并重新一次性生成包；**intent 后不能删失败成员、重选、换正文或换 artifact 来救原刊**。任一成员不合格整份失败关闭，重试只恢复原 intent/version。一个成功原始 run 不能给另一个实验臂或失败 retry 盖章。对所有事实展示面（正文/HTML/标题/摘要/卡片/index/通知/导出/追问）消费同一固化投影，衍生面新增事实时也须绑定；页面不能在读取时抓外部内容或从 live batch重新生成。

发布后的事实与旧通过依据不因新策略改变而改写。撤回、redaction、retention 同时覆盖新包、member ledger、lineage 与派生读模型，删除后不能由新表恢复原文；实现前需补正式 ADR、schema/architecture 与新对象生命周期测试。日常回退切换读取/选择路径，不回滚 SQLite schema，不删历史 artifact。

## 依赖和共享模块合入顺序

每步须经非作者审查再合入；本顺序是协调计划，不是已获准生产写入。前三支线独立准备并不授权共享文件并行编辑。

阶段0只能定义阅读卡未来契约/完成门；**C1足量新增的可刊重要维度与独立证据门未通过前，不启动阅读卡正式评测或实现**。旧B1或#360诊断不能代替这两个前置门。

| 次序/所有权 | 可交付物 | 依赖和完成门 |
|---|---|---|
| 0 集成负责人 + 数据/契约/F 独立作者 | 当前 v0、T03完整输入/人审包、T04冻结资源、F观察协议 | 不看新留出结果；人审未完明确 pending，不伪造 gold；只读/隔离 shadow |
| 1 共同 identity/archive 作者 | source/evidence revisions、clock观察、claim/event候选接口和影子持久化 | 先正式 ADR/架构；严格 namespace、不可变/hash/conflict/lifecycle测试；不得改变 production选择 |
| 2 analyzer 作者（串行） | C1-extraction候选与 provenance/失败成本账，P/C/I shadow typed输出 | T04/数据接口冻结；同输入模型预算分别记账；prompt/来源/数据集走 eval-gate；不发布 |
| 3 validator 作者（串行） | occurrence/展示精确绑定、P/C归属门，独立语义收据 | 独立安全与人工重要维度门；保持 support + display countercheck；I另有专用门 |
| 4 history/schema 作者（串行） | immutable published claim/member lineage与兼容迁移 | C1足量新增可刊重要维度通过后才启动正式阅读卡路径；独立历史、alias与删除门 |
| 5 report-gen/DB发布作者（串行） | 单主题新格式 package、guard、三入口恢复、全展示面 | 正式阅读卡人工盲评/预算与T04门；生产路径反例；新开关缺省关闭 |
| 6 F/P/C/I独立切片作者 | 已过各自评测的单主题shadow/灰度申请 | 共用接口版本一致，各专用门独立；失败分支保持关闭不阻碍别支线；三主题另验 |

F可独立完成前瞻观察与最大延迟段归因；若其首个实现只改采集调度/入选且不启用新格式，可基于现行证据发布路径独立过门。P/C可准备新事件深读 shadow；旧事件深读生产启用始终依赖命题历史/续报发布。I的影子判断可独立准备，公开展示须通过自己的门及共用发布绑定，不能因阅读卡先通过自动上线。

## 生产路径回归与完成门

实现测试必须调用真实 `runReportGen → pipeline → SQLite intent/effect → artifacts → normal/reconcile/reader`。选择纯函数和只读 exporter 的绿灯不能替代完整发布路径。门槛由 T04/专用协议预登记数值，以下安全反例必须全部通过：

1. 缺主证据、`blocked/flagged`/无check、展示 hash错位、缺countercheck、`kept_degraded`恢复草稿、0/1-based错配：不得 intent/发布；不能借其他成员 pass。
2. 同URL正文更新、解析版本变更、archive/envelope/hash损坏、旧quote locator漂移、缺全文章节：历史artifact不改写，新包失败关闭或明确摘要回退。
3. 同实体不同事件、同event_id不同研究版本、不同ID同命题、转载/镜像/换句式：不能错误归组或重复新刊；疑义保持unknown待人工。
4. 同事件确有重要新限定/方法：深读更新只计新增命题并链接准确前刊；前情不计事实增量；只新增I判断不得走新闻路径。
5. transcript未知归属、verified缺map/segment或不匹配、主持问题归嘉宾、跨段伪quote、show-notes伪全文：阻断错误归属/全文标签；明确非归属claim仍可单独过门。
6. intent前/后、落文件后、锚写后、提交后失联；重复/并发reconcile：只发布原版本一次或留不可见失败态，三个提交入口同guard。
7. intent/member顺序/引用号/MD-HTML-索引通知不一致或live行后改：提交拒绝或读取固化原投影，不能静默重渲染。
8. on/off/on、旧保证等级、redaction/retention、前刊删除/不可读：去重不中断，不能由ledger/lineage恢复被删原文；历史未知不充未刊。
9. F缺首次时钟/部分运行/空刊/预算耗尽：全部留固定分母与unknown；不得用低覆盖/漏重要事件换新鲜度，首报/续报统计分开。

每个涉及prompt/模型/来源/validator/评测集的PR用 `eval-gate`；确定性编排/历史/渲染/索引/通知走相应生产路径回归，不拿不执行代码的A1当证明。准备PR用 `pre-pr-ai-review`，受影响测试、`npm run typecheck` 与完整CI通过，影响build/routes才增build。人工重要性/事件归属/阅读盲评不由AI自评代替。

新增模式开关均为**拟议**，缺省off，不在本阶段设置环境变量或生产配置。现有 `TRANSCRIPT_FETCH/TRANSCRIPT_SHADOW_FETCH` 和每源off策略继续有效；生产打开/部署须另备精确commit/镜像/迁移/开关白名单、验证样本、停止指标、on→off回退及历史读取方案后向用户确认。文档完成只证明接口与缺口可审查，不签生产门。
