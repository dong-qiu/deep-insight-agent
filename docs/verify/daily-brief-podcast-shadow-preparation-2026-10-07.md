# C 播客 shadow：实际输入清点与专用评测准备

2026-10-07；基点 `49a00b0`。**离线准备已落盘，真实 transcript 配对和 C 专用评测尚未开始；生产保持关闭。**
依据 [播客采集规格](../plan/specs/podcast-transcript-acquisition.md)、[共同证据/发布 v0](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)、[shadow 输入规格](../plan/specs/podcast-shadow-eval-input.md)。
本切片独占 `evals/rich-brief-podcast/` 与本文，不改生产 schema、collector、analyzer、validator、report-gen、模型、来源策略或 dataset；未打开正式留出、未请求原站/API/模型。

## 实际清点结果

实际使用阶段 0 已曝光的软件工程 `rich-brief-stage0-input-v1` 冻结输入：
SHA-256 `b2b927a40dfd5ef70e18c1297e72978cb33b29a1b8280feb71329c00c5c7b56d`。
准备器对全部 occurrence 校验精确 `content-v4` ref/source key、运行/尝试绑定、正文 hash 和同 revision 元数据一致性；原文只用于输入 hash 核验，不进入输出。
没有读取人工标签、任何实验输出或新留出。

| 固定分母 | 本次实测 |
| --- | --- |
| 预登记运行 / 已观察分析尝试 | 3 / 3（含 1 个无 batch 尝试，候选总数 unknown） |
| 完整输入 occurrence / exact revision | 45 / 23 |
| show_notes occurrence / revision | 10 / 4 |
| article revision | 19；形态不能证明它们不是播客，保留 unclassified，不能以标题猜识别结果 |
| transcript occurrence / metadata revision | 0 / 0 |
| 可用封存 transcript / 已核同集配对 / verified speaker map | 0 / 0 / 0 |
| 实际 C 模型评测病例 / 阅读效果结果 | 0 / 未评估 |
| transcript acquisition 尝试/失败/成本分母 | unknown；分析输入表不保留完整采集事实，不能写成 0 次失败或 0 成本 |

四个 show_notes 精确版本的元数据账本（下列长度仅表示冻结 body，不证明完整转写）：

| ContentItem ID | content-v4 hash 前缀 | UTF-16 长度 | occurrence |
| --- | --- | --- | --- |
| `ci_da0034913ac66df2` | `e288688144f2072f` | 50000 | 3 |
| `ci_b4c0eaf0034db9d3` | `694c7a265341cd8f` | 50000 | 3 |
| `ci_c1dc3106d6dab00a` | `557e48eaa02751cf` | 12763 | 3 |
| `ci_5aff012dd49430ff` | `5699d87e34774072` | 4787 | 1 |

每项已经有候选 URL 的脱敏 hash、精确 revision、正文 hash、已有来源家族 connected component 与全部 occurrence refs。
**没有** RSS 单集/节目页/官方转写配对凭据，故 canonical episode、episode version、原文 evidence revision、转写 partner、segment、观点—论据/限定绑定均记录结构化 unknown；segment/binding 数组为空并带缺口原因，不称已选段或零观点。
`content-v4` 是元数据版本，不能冒充完整 evidence revision；source family component 只承接曝光下界，语义家族完整性未知，不能自动变成独立来源证明。
show_notes 的 speaker map 为 not-applicable；正文出现对话样式、标题或时间提纲都不能补出 speaker map 或嘉宾归属。
来源发布、来源版本更新、首次可获取、首次采集时钟均 unknown；本表的 scheduled_at 只是运行计划，不能充来源/节目时钟，`fetched_at` 不充首次采集。

在主树、旧密度树和旧 extraction-probe 的私有文件名范围内未发现可用已封存 podcast/shadow JSON 包；安装依赖中的 transcription 类型文件被排除。
没有为清点打开任何 live/offline SQLite、WAL 或读取配置。这个搜索范围只能说明本次可用离线材料为 0，不能声称源站没有公开 transcript，也不能从旧 show_notes 判定 acquisition outcome=`no_transcript`。

实际私有产物为 `.data/rich-brief-stage0/podcast-prep/frozen-input-v1/`：`inventory.json`、`evaluation-ledger.json`、`summary.json`、最后写出的 `manifest.json`。
目录 0700、文件 0600，gitignored，不提交。输出只保留 opaque refs/hash/状态/计数，不包含正文、标题、URL、quote、配置或凭据。
本次 inventory SHA-256 为 `2d98396dca13b0a62ce0ee7d22baf78bc933f96f9b59415ffa82ec163019bfa4`；summary SHA-256 为 `ac0b549f5d5deb68e3cd06e756bbae8162303562f7a78f071bce11751a09585a`。

## 已核真实 shadow 输入路径的能力与边界

现有 `evals/build-podcast-shadow-eval-input.ts → materializeShadowInput` 没有生产 DB bootstrap；要求显式私有 `EVAL_ISOLATED_ROOT`（禁止 `.data`）、已关闭 DELETE/rollback-journal 的 shadow 快照和无 WAL/SHM/journal 附件。
它在 readonly 单事务中核 candidate/decision/最新 attempt/terminal、source/policy/strategy/adapter、conflict、节目/RSS/载荷 hash 和 `podcast-transcript-evidence-v2`；后续失败或 pending 不回退旧成功。
同一节目多个 candidate、跨源重复 URL 或任一源样本不足失败；输出 manifest 与 evidence 私有副本，所有原输入字节不变。

它复用来源层 `stripTranscript` / HTML cleaners 与真实 `rawToContentItem`，接受 plain/VTT/SRT/subrip/已实现专用 HTML；**不支持 Pragmatic JSON**。
DTO 固定 `body_kind=transcript`、`speaker_map_status=unknown`、map ref null。它提供的是 transcript-only A1 输入，不是同集 show_notes 对照、可靠 speaker 分段、观点—论据链、人标金标或正式 lock；准备成功不能据此称嘉宾观点评测通过。
source/program-page/envelope 与 archive 成功只证明获取/字节链条，不证明 quote 语义支持或允许生产发布。

现有 sampler/store 通过 `collectSource` 的 observe 路径在两个网络子开关都开启后写隔离 shadow facts/archive；与生产 ContentItem 无写入路线。
collector 仍只实现 observe，旧 URL 的 article/show_notes 不能原地升级。`transcript_mode=enabled` 配置本身不执行生产采集，也不是本文的采集/来源许可。

本次代码核对还确认：`ContentItem`/`Citation` 有 speaker-map/attribution 接口，reason enum 有 `speaker_attribution_unknown`，但 `LlmCitationSchema` 未输出 attribution，analyzer/validator/report-gen 主文件没有执行该属性的对应检查。
DB 写入层只对 verified 的 speaker ID/segment 非空和 unknown 字段形状作约束；这些存在性检查不验证实际 speaker map、角色或原文 segment 支持。
**跨层 attribution fail-closed 尚未由这些字段定义实现。** 新 C release 切片必须先让 analyzer 标注、validator 验证 map+segment+role 并 blocked、最终投影禁止复活 unknown/blocked 归属；本准备器不会声称填补此生产缺口。

## 可执行元数据准备器与未来 C 评测账本

`evals/rich-brief-podcast/prepare.ts` 只消费一个显式绝对路径、预先指定 SHA 的冻结 worklist；拒绝 symlink、formal holdout、hash/绑定/重复/版本元数据冲突。
所有 23 revision 均保留，不只取已刊或成功材料；它不会将 URL hash 自封为 canonical episode，也不会从 show_notes 中提取人物发言。
没有 transcript 与人标时，输出 ledger 的 attempts 为真实空数组，model/成本及误接受/误拒指标没有实测样本；不塞合成病例来补分母。

先使用 Node 24.19，然后运行（新目录，不覆盖旧产物）：

```bash
npx tsx evals/rich-brief-podcast/prepare.ts \
  /absolute/private/input-worklist.json <frozen-worklist-sha256> \
  /absolute/gitignored/new-podcast-preparation
```

`podcastEvaluationLedgerSchema` 冻结为 `rich-brief-podcast-evaluation-ledger-v1`，供下一切片准备真实、独立封存病例，不是模型执行器：

- 每尝试独立绑定 dataset/resource、臂（show_notes/transcript）、source revision、episode-pair、speaker stratum、病例类别、模型/prompt hash、token/bytes/time/USD、失败码；unknown 成本不当零成本。
- 每条引用的原始 segment ID、speaker ID/host/guest/unknown 角色、有界 UTF-16 span、quote hash、原载荷定位 ref；观点、论据、限定各绑自己的 segment 集，缺 ref 或反向 span 阻断。账本不生成跨段拼接 quote。
- human gold 只有 pending 或 confirmed；confirmed 必须有 expect+人工 receipt SHA，pending 不允许有暗填答案。此处只核 receipt 的结构，实际审核者/收据及金标有效性仍由独立人评流程核验，不能用一个 hash 自证人工确认。
- `summarizePodcastEvaluation` 分臂统计成功/拒绝/失败/未跑、pending gold、已人标并执行的分母、误接受/误拒及成本 unknown/已观察成本下界。对 pending 项不能给误接受/误拒得分；函数始终 `production_allowed=false`，没有来源/上线裁决能力。

必须分别封存的专用病例包括：主持人问题误归嘉宾、主持概括误归嘉宾、跨 segment 伪引语、unknown map 却归名、verified 候选缺 segment、错误 speaker/role、错节目配对、错版本/locator、观点缺论据或必要限定，以及真实可接受的无人物归属 transcript 与可靠 map 嘉宾观点。
verified stratum 必须提供 map hash，unknown 则单列；原 map 可靠但某候选漏段的负例仍可处于 verified-source stratum，验证器必须拒绝该候选。
工程 fixture 明确为 synthetic_test，不进入真实 cohort、留出、人标或阅读收益统计。

下一波先取得已有许可范围内、明确同集/版本的**已封存**官方转写（当前任务不抓取），再准备以下闭环：

1. 同集 show_notes 和 transcript 两臂共用 episode/work 映射、来源家族分区和预登记窗口；每臂独立输入/body/parser/model/prompt/budget/failure/cost。没有可信 RSS/节目页/转写配对不能仅凭标题、URL 相似或模型归组配对。
2. 可靠 speaker map 与 unknown 分层；人标 guest view/理由/例子/反方/限定和逐字 span；长转写覆盖/漏段/获取失败完整保留。没有可靠 map 只允许明确无人物断言的“节目转写提到”，不能把原先有名的 unknown 发言偷改成 none 来过门。
3. T04 数值与资源版本、人标事件/重要维度/理解题先冻结，实验臂输出封存后才评分；正式留出保持隔离。人工重要性/归属/阅读效果不由 AI 自评替代。
4. source/配对/说话人门、真实模型安全/一致性与引用白名单、生产全展示面同一 artifact、回退和 CI 均分别独立完成。现行专用质量门和 A1/多源门不能由准备器测试替代；relevant_only 还须原规格的召回/成本门，all 不以配额跳过 eligible。
5. 旧节目补转写必须新增不可变 evidence version、保留旧 show_notes 引用并通过 claim history/深读续报门；此前仅 shadow。config enabled 或新 URL 不授予旧事件新增命题资格。

## 检查与 eval-gate

Node 24.19 `npm ci` 完成。准备器 6 项测试通过；真实既有 shadow sampler/store → input CLI 的 30 项回归通过（构造传输 fixture，无原站请求，不是实测转写 cohort）。
`npm run typecheck`（TS7/TS6/tools）及 `eslint evals/rich-brief-podcast --max-warnings=0` 通过。
已使用 eval-gate scoped：只新增离线元数据准备/账本，没有修改 prompt/model/source/validator 或实际 eval gold。
未运行 A1：它不执行本准备器路径，不能作为转换工具的质量证明，更不能在真实 transcript=0 时伪造 C 或生产准入。最终仍待非作者审查和 PR CI。
