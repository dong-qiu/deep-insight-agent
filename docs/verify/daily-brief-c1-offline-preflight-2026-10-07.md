# C1 首次提取：离线输入、分账 ledger 与执行前检准备

2026-10-07；隔离分支 `feat/daily-brief-c1-shadow-prep-20261007`，实查 base `49a00b0`。本波只准备 shadow 资源，未调用模型、未抓新来源、未收集/读取正式留出、未修改生产代码或评测标签、未启用新生产模式；未访问现场，不能认证生产开关状态。B1 仍 no-go。本页的 C1 专指首次提取实验，与备份恢复 C1 无关。

依据：[新版方案](../plan/specs/daily-brief-rich-insight-freshness.md)、[单主题协议](../plan/specs/daily-brief-density-one-topic-eval-protocol-draft.md)、[共同证据/发布契约 v0](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)、[阶段 0 数据工具](daily-brief-stage0-data-protocol-2026-10-07.md)。金标只给 scorer，必须覆盖完整输入；模型候选数、字数及 AI 评分均不能代替人工重要维度或阅读效果。

## 实际材料与边界

只读旧封存备份及 DELETE-journal 字节副本，经原 manifest 的 DB SHA/size、稳定备份区间、原件/副本字节一致、对应 `brief-density-s0-v2` export hash 及其 backup-manifest 绑定核验后，以 `readonly/fileMustExist` 打开。原件与副本均拒绝 WAL/SHM/journal 侧文件，不导入应用 bootstrap/getDb/migration，不复制 DB。打开前拒绝 sidecar/WAL、篡改、未认证 manifest；快照撤回或 pending request 非空也拒绝。DB 及 manifest 在读取后重验 hash。三份备份整体 incomplete，本波仅认证指定 DB/区间的输入来源，不升级为完整恢复点或当前撤回状态证明。

实际恢复 **3 个预登记运行、3 次分析尝试、45 个输入 occurrence、23 个 exact revision**。全部 body/hash/body-kind/content-v4 元数据与既有 stage0 输入逐项匹配，通过实际 `getContentItem/getTopic` 读回 author/language/tags/raw_ref/topic 等完整 `ContentItem` 和 `Topic`，不以假空值充未知。三次原候选总数 47 / unknown / 99，10 月 4 日失败原尝试留在分母。

实际 dispatcher payload 均可读，`window_hours=168`，三次 `endIso` 为：

| 软件工程运行 | 冻结 endIso / history cutoff | cutoff-safe 历史 occurrence | 排除晚于 cutoff 的 occurrence | 不能证明已刊时间的 occurrence |
| --- | --- | --- | --- | --- |
| 10 月 3 日 | `2026-10-03T17:00:53.239Z` | 66 | 4 | 0 |
| 10 月 4 日（失败） | `2026-10-04T17:00:47.103Z` | 70 | 0 | 0 |
| 10 月 5 日 | `2026-10-05T17:00:47.347Z` | 70 | 4 | 0 |

历史读取调用真实 `listRecentPublishedInsightOccurrences(db, topic, {asOf:endIso})`，随后以 `report.generated_at` 和唯一 committed `report_file` effect 的 `updated_at<=endIso` 作保守出版时点门；不把当期报告或备份之后资料补到历史。生产查询本身以日期筛下界，并不按秒拒绝备份中的后来报告，所以不能直接把备份查询结果视为原模型收到的历史。

上述历史是 **cutoff-safe lower bound**，不是 exact runtime history：旧开始事件未持久化模型可见的完整历史、当时 reader/source 状态和 Topic 全量输入快照；后来的删除或元数据变化不可由当前快照反向证明不存在。未知不变成空历史。若未来改用统一、明确的 cutoff-safe 离线历史作为两臂新实验输入，应另预登记其重建规则/未知分母并裁定与原基线比较的边界；本前检不自行授予 exact 状态。

机器资源、scorer 资源完全分开：`machine-input.json` 仅白名单 `Topic/ContentItem`、run/attempt/occurrence、来源版本/body hash、窗口、历史、可见输入诊断及代码/快照资源；不含人工维度、事件裁定、固定题、重要性标签或 scorer 路径。`scorer-bindings.json` 单独指向 pending 人工标签及原确认索引。对机器输入注入额外 gold 字段、缩小分母、替换 revision/body/window/可见片段均拒绝。原确认与人工新答复由集成负责人保管，本波未代签。

## 可执行工具与真冻结门

`evals/rich-brief-c1/prepare.ts prepare CONFIG NEW_PRIVATE_DIR` 只读准备 bundle；`check MACHINE PLAN [FROZEN_PROTOCOL]` 输出 counts/阻断码，返回 2。输入、正文、prompt 和资源均写本树 gitignored `.data/rich-brief-stage0/`，目录 0700、文件 0600；console 不输出原文、候选正文或凭据。旧包不覆写。

`input.ts` 用真实 `truncateForAnalyze/selectForAnalyze/chunkByChars/analyzeChunkInputSha256` 生成可见正文、遗漏标记及分块 hash，不以 substring 近似展示或 validator。当前准备进程未加载 `.env.local`；记录的是当前代码解析到的诊断 profile，**不认证旧运行 ANALYZE_BODY_CHARS/ANALYZE_BATCH_CHARS/SELECT_WINDOW_CHARS**，也不能直接作为新实验正式 runtime profile。当前样本中的长 article/show_notes 均继续按真实前缀路径处理；源金标分母仍为完整输入，不能删掉模型看不到的维度。深读选段/增加正文预算须另立实验臂，不归给 C1 prompt 收益。

`preflight.ts` 不信任 `ready` 字段：核 frozen artifact SHA、真实 freeze 时间、逐项资源、原 input/labels/protocol 精确字节及 payload 一致性，重新从 stage0 原 config/export 准备输入，并以 freeze 时点重跑阶段 0 全部 human/数值/七角色/cache/thinking/模型分离/配对检查；缺任一资源或删除来源不可冒充真冻结。机器分母和每项 revision/body 再与被冻结 stage0 输入对照。机器、plan、prompt、快照、代码和 ledger 契约还必须在 T04 protocol 的路径/hash 资源列表中，arm prompt 与 ledger schema 必须一致。

前检**固定为 closed**：不存在已实现并经评审的 C1 shadow prompt 接口，且可见 profile/历史仍有资源证明缺口。本波 `model_calls_authorized=false`，不会因单元测试绿或 synthetic ready 标签而执行模型。实际返回四个 blocker：

- `t04_protocol_not_frozen`：人工完整金标、阅读初测及数值协议仍 pending。
- `original_model_visible_history_not_exactly_proven`：安全重建历史不能伪装原运行完整历史。
- `visible_profile_requires_frozen_runtime_resolution`：诊断 profile 尚未绑定正式的完整 runtime 资源。
- `c1_shadow_prompt_interface_not_implemented_or_reviewed`：本波没有改共享 analyzer。

最终私有准备包共 8 个文件；工具修订后重新创建 v2 目录，原包未覆写。machine SHA-256 为 `f32bb21e81271cc3199543da105145758845748a9c47f77c5c2986309264dfe4`，ledger contract 为 `4e76840b29a84f87d618ed80a90fa1af4545a04324a43546aaf18173c6c09bb1`，baseline prompt 为 `1481ae6c5c7eb7dad82f5a887383236bba281d2777bb473b6de52f72de104d20`，C1 候选 prompt 为 `9bc42f7a308d660167d00489daa58bec305d023af4ee2798ac32cb04015cd7d2`。实际 machine/scorer 白名单及权限复核通过；`check` 返回 2/blocked，无模型 call ledger。

## 首次提取候选与最小接线提案

精确 baseline `ANALYZER_SYSTEM` 已从生产模块导出，按原字节写私有资源，不额外添加 Markdown 换行。候选只替换规则 8 的“同一发现不拆”粒度，并补充重要命题提取要求：同事件不重复的重要结果、机制、比较、范围/局限各作独立原子候选；保持唯一自足主引用、必要限定、来源观点归属、相同 `AnalyzerOutputSchema` 和现有历史规则。不存在证据时允许少产出，不预填人工维度、不放开编辑推论、不把摘要/show notes 当全文/嘉宾原话。它是**未评测的候选 prompt**，没有任何增量或安全收益收据。

实查生产接线：`analyze(topic, items, timeWindow, onCost, {history})` 内部运行 schema/派生、reader-language repair、`filterByQuoteCoverage` 及独立 quote-only countercheck；其结果再交真实 `validateBatch(insights,items,onCost,cache,signal)`。C1 应使用同一完整输入、同一历史/窗口、模型/provider/七 operation、安全策略与预算，唯一改变首次提取 system prompt，输出经过上述共同实际门。人工 scorer 在两臂固化结果之后关联标签；不能给 C1 手写源支持事实，不能把“quote 可搜索”当作独立语义 support。

后续供集成负责人串行实施的最小接口提案（**本波未实现**）：

1. 为 `AnalyzeOptions` 增加显式 `shadowFirstExtraction` 配置，携带 `execution_scope=shadow`、精确 system 字节及 prompt/protocol hash；默认生产调用仍用 `ANALYZER_SYSTEM`。仅隔离 runner 可提供，不用全局 env 改生产 prompt。
2. 从 `analyze → analyzeWithSplit → analyzeChunk` 将该参数传至真正 `callStructured`，包括所有 split/retry 分支；schema、派生、reader-language repair、展示主审计/quote-only 和 validator 保持共同路径。异常继续 fail closed，不把失败变成无重要事件。
3. 两臂直接调用实际 `analyze`，不写生产 DB，不复用外层 `runAnalysis` 的生产缓存；shadow 的 cache 模式及隔离 namespace/snapshot 必须冻结且配对。现有 completed-chunk checkpoint 只绑定输入，不绑定 prompt，故此最小 runner 先禁止复用；若支持恢复，另按 protocol/arm/prompt/input/七角色版本完整隔离，不能把 A 的结果复用为 C1。
4. 每次真正 provider 请求，包括子拆分、主展示审计、countercheck、单条/批 validator 和修复操作，产出独立 call ID、实际 system/user/schema/input hash 与 role/version/budget 收据。`onCost` 按臂、按请求记账；错误前无 usage/cost 回执标 unknown，不从全局 meter 差分臆算，也不把 failed/timeout 的潜在账单当零。
5. 上述共享代码切片必须先冻结行为/资源，运行真正候选覆盖的配对 C1 eval 和相应 prototype display/quote-only safety、生产展示/validator 回归及独立非作者 review。A1 若仍调用默认 prompt，就不能证明候选 prompt；必要时明确传入候选的专用离线 eval，而非更名盖 pass。

## Ledger 契约与验证

`ledger.ts` 给出版本化 JSON Schema；每条按 `arm/run/source attempt/call/operation/retry_of` 分别登记：真 freeze/machine/operation input hash、模型/provider/transport/prompt/policy/cache/thinking、输出 cap、起止/耗时/终态、输出 hash、token/cache usage 和账单。金额用整数 USD micros 的十进制字符串，无浮点聚合漂移。失败、timeout、cancelled 必须有原因；成功必须有输出 hash；重试必须引用前一失败，同输入/operation且顺序正确，不能抹掉原尝试。

usage/cost 各自 `known(receipt)` 或 `unknown(reason)`；unknown 状态禁止混入零金额。汇总按 arm 分开列 known 金额下界、unknown cost/token call 数及失败终态，空 ledger 为 `not_executed`，没有零成本成功或候选收益。实际 bundle 的 ledger 没有 calls。此波 schema/版本拒绝器不替代未来 runner 的全局 token/cost/timeout/stop 执行守卫；后续须在每次请求前按冻结限额裁决，unknown 账单不得继续假定还有完整预算。

环境与实际验证：Node `24.19.0`、npm `11.17.0`；本树独立 `npm ci --ignore-scripts` 完成，0 vulnerabilities；仅为只读快照使用重建本树 `better-sqlite3`，未改共享依赖。

```sh
npx vitest run evals/rich-brief-c1/preflight.test.ts evals/rich-brief-stage0/data.test.ts
npm run typecheck
npx eslint evals/rich-brief-c1 --max-warnings=0
```

**32/32**（本波 13 + 共用 stage0 19）通过，TS7/TS6 app/tools 通过，定向 lint 通过。覆盖完整分母/失败 unknown、gold 隔离、原文/可见段/窗口/revision 篡改、真正 freeze 拒绝、资源变更、跨 arm/version 漂移、失败/重试/未知成本、WAL/sidecar/DB/manifest 拒绝；包含原件和副本各自存在 DELETE `-journal` 时的实际 negative test。所有有意构造的模型、账单和运行测试只在合成 fixture，不进入真实收益分母。

真实 `ops/ci-docs-check.mjs` 的 `checkDocuments` 对本文通过（1 份），本地链接/章节/围栏/格式及 `git diff --check` 通过。首次调用误传 scope 参数的失败已纠正，失败调用不作为通过收据；正式检查使用 Node 24.19。

已按 `eval-gate` 核对路径：本波是离线准备和拒绝门，候选 prompt 模板在 `prepare.ts` 版本化，生成的精确字节写私有资源且未执行，不称候选质量 pass；未运行 A1、未签 baseline/候选收益/人评/来源或生产准入。A1 当前默认路径不执行本次候选，不能给它盖假 pass。未跑 build（无构建/路由/部署修改），未 push/PR/merge；精确 head 的非作者 review 与 CI 由集成负责人另记。

## 下一波入口及未解除门

```sh
node --import tsx evals/rich-brief-c1/prepare.ts prepare /abs/private/prepare-c1-config.json /abs/worktree/.data/rich-brief-stage0/new-c1-prep
node --import tsx evals/rich-brief-c1/prepare.ts check /abs/private/machine-input.json /abs/private/execution-plan.json
# 真 T04 冻结后才可附第三个参数；本波仍固定拒绝模型执行。
node --import tsx evals/rich-brief-c1/prepare.ts check /abs/private/machine-input.json /abs/private/execution-plan.json /abs/private/frozen-protocol.json
```

机器与 scorer 分离、完整源文、真实 endIso、cutoff-safe 历史、可见片段、候选精确 prompt 和分账 schema 已成为可 hash 绑定的私有准备资源，可解除 T04 的这些资源准备依赖。仍需人工完整事件/重要维度/限定/固定题、阅读初测/数值、真实 runtime 解析与模型分离、历史比较边界裁定、最小 shadow 接口/实际 gate 收据和独立 review。它们未过前，本切片保持关闭，不阻止 F/P/C/I 的独立准备。
