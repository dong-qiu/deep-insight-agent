# Spec: A1 controlled v2 dataset

> 状态：原型内部研究执行中；正式 v2 提升已按 ADR-0030 延期（受控候选快照与原型内部使用决策已完成；正式 human 标签、receipt、v2 lock 与 DCP 签署均不在当前范围）
> Owner：dongqiu
> 关联：ADR-0028、`docs/verify/eval-criteria.md`、`evals/dataset/GUIDE.md`

## 背景与目标

当前 A1 的仓内样本是 legacy fixture，且产品只配置了三个主题；因此不能作为 v2 DCP 或可比基线的证据。本规格建立受控 v2 的采集、去重、标注和签署顺序，而不把第三方正文或人工标签伪装成仓内 fixture。

新增的真实订阅主题限定在既有两个行业范围内，避免为了数量引入无产品归属的题目：

| topic_id | 主题 | 用户价值 / 边界 | 首轮隔离来源对 |
| --- | --- | --- | --- |
| `t_coding_agent_platforms` | AI 编码 Agent 平台演进 | 追踪 Codex、Cursor、OpenHands 等平台的可验证发布、接口和工作流变化；不将厂商营销或泛模型新闻包装为工程事实。 | `src_openai_codex_releases`、`src_cursor_changelog`（均保持 staged，未因本评测自动启用） |
| `t_agent_security` | AI Agent 攻防与提示注入 | 追踪间接提示注入、工具/数据外泄和 Agent 执行边界的攻防证据；不把一般网络安全事件混入。 | `src_embracethered`、`src_simonwillison_promptinj` |

前三个主题仍为 `t_code_agents`、`t_prompt_injection`、`t_ai_industry`。五主题本轮 cohort 的来源分配如下；每对都必须在 snapshot 中使用互不重复的 URL。

| topic_id | 本轮来源对 |
| --- | --- |
| `t_code_agents` | `src_simonwillison`、`src_aider` |
| `t_prompt_injection` | `src_trailofbits`、`src_anquanke` |
| `t_ai_industry` | `src_semianalysis`、`src_techcrunch_ai` |
| `t_coding_agent_platforms` | `src_openai_codex_releases`、`src_cursor_changelog` |
| `t_agent_security` | `src_embracethered`、`src_simonwillison_promptinj` |

新增主题在隔离 cohort 和受控快照成功前，不构成生产启用授权。

## 用户故事

- 作为质量负责人，我希望 v2 的每个主题都有独立、可追溯且不重复的真实输入，以便 A1 指标能反映真实覆盖而非重复样本。
- 作为 DCP 审阅者，我希望自动结果、数据锁和人工复核可分别回链到同一次不可变快照，以便不会把 smoke 或人工未完成误判为上线通过。

## 输入 / 输出契约

| 项 | 说明 |
| --- | --- |
| 输入 | 临时 SQLite/原文目录中由生产 `collectSource` 路径取得的内容；每个来源的采集 manifest；人工独立标注。 |
| 输出 | 受控环境保存的 v2 原文快照及 URL/ID manifest；仓内只保存 dataset-lock、配方、哈希和非正文审计产物。 |
| 去重键 | `content_item_id_or_url`：同一 content ID 或 URL 在整个 quality snapshot 中最多出现一次，不因分配给多个 topic 而重复。 |
| 触发 | 先隔离 cohort，再建立锁定快照；自动 A1 全量通过后才进入人工盲评。 |

## 行为规约

1. 对五个主题各指定至少两个来源，隔离 collector 必须逐源走生产采集、robots、正文提取和存储路径；任一失败记录脱敏 manifest 并使该 cohort 失败。
2. 构建 quality case 时，按全局 `content_item_id` 与 URL 去重。若先处理的宽主题已占用文章，后续子主题必须换用另一篇合格文章；不能关闭去重或用相同正文补足数量。
3. 每个主题最终须有至少 10 条 `reader-visible` 洞察；输入条目数、analyzer 草稿数或 blocked 候选均不得代替该计数。
4. 受控快照必须冻结内容哈希、source URL/ID manifest、采集时间、license/retention、topic mapping、去重规则和标签分布。每个候选必须为 `fetch_status=ok`，并有可读取、可验证的 raw archive：对归档的正文输入做一次与采集相同的规范化后，必须与 `ContentItem.body` 逐字相等；再校验该存储正文的 `content_hash` 与 archive 中声明的 hash 一致。这样既证明正文确实由原文输入导出，也避免嵌套 HTML 实体的非幂等清洗产生假阴性。manifest 只记录 raw archive 的 SHA-256、字节数和正文来源类型，绝不复制正文或 `raw_ref` 路径。第三方全文只留在受控存储，不提交仓库。A1 v2 采用专用的私有 S3 bucket、独立 KMS key、versioning 和 Object Lock Compliance 90 天；第 91 天起才允许 lifecycle 受控清理，且不得复用 redaction registry 或 DR bucket。`ops/aws/setup-a1-eval-snapshot.sh` 是默认只读的核验/显式 `--apply` 配置器。
5. 一致性集至少 100 对，`not_support` 至少 40 对并覆盖 exaggeration、out_of_context、misattribution；每条必须有稳定 `id`。两位非生成者的独立 human reviewer 对同一 `(id, statement, source_text)` hash population 完成盲标，第三位 human 只裁决分歧。受控 `consistency-label-receipt` 必须校验两份提交、最终 JSONL、分歧裁决和分布下限的 hash 绑定；其 v2 回执还记录两位不同 human 的 blind-attestation、提交 hash 与必要的第三人 provenance。v2 lock 除不可变引用与 SHA-256 外，必须读取受控本地副本，校验回执版本/状态、JSONL 的 bytes/ID/pair hash 三重绑定和分布；不能用一句“已双标”的描述或 AI-assisted/prototype 回执替代。
   - 为减少人工从零起草 claim 的负担，可由 AI 从每条受控原文生成一个**未定标签** candidate pair；candidate 文件只能含 `id`、statement、原文窗口及 source hash。生成意图、模型、prompt hash 和任何预判只能留在隔离 `diagnostic_only` artifact，绝不可随候选文件提供给盲标者，也不可成为 receipt 输入。
   - 候选规划须以至少 50 条诊断性负例意图为目标，并把负例位置跨每个来源的输入交错分配；不得把负例集中在按来源排序的尾部。每一条 candidate 在进入 checkpoint 前，生成器可给出 3–5 个不同草稿；若结构化响应有有界的额外草稿，进程内先按首次出现去重并只取前 5 个。输出仅接受与请求 ID 一一对应的有效草稿：未知、重复、缺失或无效 ID 只能在有界次数内仅重试缺失 ID，绝不按顺序猜配。随后必须由与生成器独立、且**不接收请求 intent** 的 validator 对每个保留草稿与原文的关系做诊断性校准，观测关系再由调用方与请求 intent 精确比对，只选择首个精确匹配草稿。未通过项可在有界次数内仅在生成进程中获得其观测关系和上一版草稿后定向重写；该反馈、校准输出、重试次数、模型/Thinking/prompt provenance 只留在 diagnostic artifact，绝不可提供给盲标者。校准仅降低候选失配风险，不能替代正式 human 标签、也不能声称保证最终 40 条 `not_support`。
   - **可行性优先分配**：不得把第 N 条输入永久绑定为某一 intent。探测阶段只能记录“该输入在以该 intent 请求生成后，独立 validator 也观察到同一 intent”的可行边；每条边必须绑定候选 ID、具体 statement、statement/source/pair hash 和 calibration provenance，`support` 被观察到不能事后当成所需负例。probe ID 必须不编码 intent，且校准请求不得含请求 intent；在创建 checkpoint 或任何 LLM 调用前必须验证 analyzer 与 validator 模型不同。完成探测后，按每个 topic 的固定 20 条、`topic × source × intent` slot 做确定性受限匹配：source 有 n 条时负例配额为 floor/ceil(n/2)，先取 floor、再按稳定 source ID 为奇数来源补足到 topic 的 10 条负例；两个 10 条来源须各有 5 条且保留 2/2/1 的 exaggeration/out_of_context/misattribution 分布。每条最终 candidate 恰占其自身来源的一条可行 slot。不存在完整匹配时，run 必须写仅含 hash/聚合缺口的本地 `failed_matching` diagnostic 并失败；不得降配、重标、补造或创建候选/盲审 worklist。checkpoint v6 只保存连续完整的探测批次，包含 probe matrix、可行边、未选草稿与观测、每条受控 source 坐标、最终 candidate→topic/source/intent slot→pair 的 matching、累计 probe 调用指标、模型/Thinking/prompt/schema/transport/token 配置的 hash 及草稿/重试上限；旧 checkpoint 或任一配置漂移均拒绝恢复。只把匹配选中的 100 个 label-free pair 写入候选文件，输出前重算 pair hash；候选和 worklist 必须不含 intent、observed_intent、feasible edges、calibration 等字段。worklist 创建还必须校验 completed feasibility manifest、候选文件、source body hash、v6 checkpoint、精确选中 pair 和 pair population 的交叉绑定；所有可行边、未选草稿、观测关系与匹配诊断均只留本地受控 checkpoint/diagnostic。候选/diagnostic、AI 对比的 dispute/receipt 及 AI final JSONL/receipt 均以字节相同的可恢复配对发布：第二次写入中断时只可补写缺失的同字节伴随产物，任一既有不同字节都必须失败而非覆盖。
6. 全量 A1 只能在 lock 验证为 `verified_v2`、无 smoke 截断、模型/Thinking 配置固定时作为自动证据。两次不同 run_id 的同 commit/config/lock automatic pass 才可形成可接受基线候选。
7. 自动通过后，两位 reviewer 必须对同一 `review-queue` 全量盲评；第三位 reviewer 裁决所有分歧，并用 `review:receipt` 生成 `eligible_for_signoff`。该状态不代替 DCP owner/architect 签署。
8. A1 的长主题必须以 analyzer 已有的确定性正文分块为可恢复边界。每完成一个**完整**分块，才可原子写入该分块的已审计 analyzer 输出与展示覆盖决定；超时中的半分块不得进入 checkpoint。任何 quality topic 的执行错误（网络请求超时、结构化输出残缺、审计调用失败或截止超时）都必须终止整次运行并发布 `failed` artifact，绝不可跳过该 topic 后形成“completed”结果。恢复时必须校验完整 `EvalConfig`（含会影响截断风险的展示审计输出预算）、质量数据集哈希、topic/case 顺序以及每个分块的输入哈希，只复用连续前缀，配置或输入漂移一律拒绝恢复。
   - 恢复不会缩小 20 条输入、抽样替代全量、或修改 topic 聚合 / validator / 指标口径：全部分块仍先在同一 topic 内合并，再走一次完整 `validateBatch` 与 production `selectInsights`。已完成主题的 analyzer+validator 结果可整体复用；未完成主题只可复用其已完成的 analyzer 分块。
   - checkpoint 是本地受控运行产物，其中的模型输出可能含原文短引；它不得入仓、不得上传到非受控位置，也不得被解释为 partial pass、baseline、DCP 或人工 review 证据。失败 manifest 必须哈希绑定 checkpoint；新的 run 只记录来源 checkpoint 的 SHA-256，不记录本地绝对路径。

### AI 预标注与人工签署的隔离

AI 可以承担三个**诊断性预标注者**，用于发现分歧、估算人工工作量和改进标注说明；它们不能替代两位独立人工标注者或第三位人工裁决者。每个预标注结果必须绑定同一 `run_id`、`dataset_lock_sha256`、`review-queue` hash、模型/Thinking 配置和 prompt hash，并单独保存为 `diagnostic_only` 产物。

1. 三个预标注任务必须各自记录实际模型与配置；若共用模型、prompt 或上下文，它们是相关的辅助信号，不得写成“独立人工复核”或拿来计算人评一致性。
2. 两位人工 reviewer 在各自提交完整、带 hash 的盲评前，拿到的输入不得包含 AI 标签、AI 理由、彼此标签或裁决建议。AI 预标注只能在两份人工提交都冻结后，作为分歧诊断材料揭示。
3. 第三位**人工** adjudicator 只裁决两位人工 reviewer 的分歧；AI 结果可供查阅但不能覆盖、补齐或生成任何人工决定。
4. `review:receipt` 明确要求 `reviewer_kind` 与 `adjudicator_kind` 均为 `human`。传入 `ai` 会生成 ineligible receipt；预标注文件绝不能被当作 receipt 输入。
5. 预标注、人工盲评、裁决和最终 receipt 均保留独立的 artifact hash；没有两份完整人工盲评、第三人裁决和 DCP owner/architect 签署时，任何 AI 结果都不得形成可发布或可比基线结论。

### Prototype AI-assisted consistency labels

原型阶段可以降低人工全量标注负担：由两个**模型不同、role 不同**的 AI reviewer 对同一 immutable blind worklist 分别给出 100 条判断；只把它们不一致的 pair（不附 AI 标签）交给一位 human adjudicator。每位 AI submission 必须绑定 worklist SHA-256、pair population、模型、Thinking、prompt/transport 版本与输出 hash。human 裁决必须覆盖全部且仅覆盖分歧 pair，并声明 `human` 与 `blind_attestation`。

这条路径的 receipt 状态只能是 `prototype_ai_assisted` 或 `ineligible`，且 `lock_eligible=false`。它可用于内部原型调试、比较模型分歧、生成暂定 consistency JSONL；不得输入正式 `labels:receipt`、不得创建 `verified_v2` lock、不得晋级 baseline 或构成 DCP/发布质量证据。正式双 human 路径仍由上节和 AC4 约束。

若 human 在作出分歧裁决前，明确要求查看额外 AI 建议或理由，则必须改走 `human_with_ai_advice` 变体：输入 progress 和最终 adjudication 必须显式记录 `blind_attestation=false`、显示建议的事实和逐条 human reason。该变体只能使用独立的 `labels:ai-chat-to-adjudication` 与 `labels:ai-chat-finalize`，不得调用或伪装为盲裁决的 `labels:ai-dispute-to-adjudication` / `labels:ai-finalize`。其 receipt 继续是 `prototype_ai_assisted`、`lock_eligible=false`，并额外记录 `human_adjudication_mode=human_with_ai_advice`；正式 human receipt、v2 lock、baseline 和 DCP 验证器必须拒绝它。

原型 A1 运行后若要用逐条 human_with_ai_advice 边界复核修订暂定标签，必须另建**派生** JSONL/receipt，不得覆盖已冻结的 parent JSONL 或 receipt。派生器必须同时校验 parent dataset/receipt SHA-256、完成的 review progress SHA-256、以及每条复核的稳定 `id + pair hash`；仅允许应用由该 progress 精确给出的标签或 negative type 变更，任一父字节、行序、旧标签、pair hash 或绑定清单漂移都必须失败。父行的任何额外审计字段必须原样保留。绑定清单和派生 receipt 不含原文；派生 receipt 必须显式记录 `human_adjudication_mode=human_with_ai_advice` 与 `human_adjudication_blind_attestation=false`。派生 JSONL 仍只留受控存储：CLI 必须显式指定仓库外的 `EVAL_ISOLATED_ROOT`，拒绝 `..`、符号链接和仓库内输出；receipt 固定 `prototype_ai_assisted`、`lock_eligible=false`、不可用于 v2 lock、baseline、DCP 或发布质量结论。

### 2026-09-10 cohort preflight

- 十来源的最终隔离采集使用生产 collector；上述十个来源均实际写入候选库。首次总采集中的 `src_simonwillison_promptinj` 曾因 `ENOTFOUND` 失败，随后在**同一隔离根**单源重试成功；两份 manifest 都必须随受控快照保存。
- `src_project_zero` 在一次总采集和一次单源重试中均为 `TimeoutError`，因此本轮不得作为安全主题样本或被隐藏在“九源成功”中；已由 `src_anquanke` 替代。
- 确定性构建得到五个 case、每个 4 条 rich-body 输入并覆盖十个指定来源。这只是来源/去重 preflight，**不是** DCP 样本：输入数不能替代每主题 10 条 reader-visible 洞察，且其中宽主题来源可能含离题内容，必须在受控快照的人为主题映射与 A1 结果中继续淘汰。

## 验收标准 (AC)

- [ ] AC1: 两个新增主题的定义、边界和隔离来源对如上表；staged 来源不因评测自动启用。
- [ ] AC2: 每个来源的 collector manifest 记录实际 collected/failed 状态；失败没有被单个成功来源掩盖。
- [ ] AC3: 构建器拒绝跨 topic 的重复 content ID 或 URL；相同来源允许提供不同 URL 的内容。
- [ ] AC4: lock 校验 v2 样本具有至少 5 个唯一主题、100 组一致性对、40 个 `not_support` 和三种负例，并绑定 `eligible_for_lock` 的双人 human consistency-label receipt（引用与 SHA-256）。
- [ ] AC5: 全量 A1 产物的 `dcp_sample.reader_visible_by_topic` 每个主题均至少为 10，且不存在 duplicate statement+bound quote。
- [ ] AC6: 两次同配置、同 lock、clean commit 的完整 automatic pass 以及完整的三方人工 receipt 均可回链；AI 预标注须隔离为 `diagnostic_only`，不得参与 receipt；此前状态只能标为 incomplete/smoke/provisional，不得盖 `Eval-Gate: pass`。
- [ ] AC7: 若走 prototype AI-assisted consistency flow，两个 AI submission 的模型和 role 不同，所有分歧且仅分歧均有 blind human adjudication；其 receipt 明确为 `prototype_ai_assisted` / `lock_eligible=false`，并被 v2 lock 拒绝。
- [ ] AC7a: 若 human 在裁决前收到 AI advice，专用 chat 变体必须将 `blind_attestation=false` 和 `human_with_ai_advice` 写入 hash 绑定的 adjudication/receipt；盲裁决命令和正式 receipt 均拒绝该输入，最终产物仍不可晋级。
- [ ] AC7b: post-run human_with_ai_advice 边界复核若产生标签修订，必须输出不可覆盖 parent 的派生 JSONL/receipt；每个修订须绑定 parent dataset/receipt、review progress 与 `id + pair hash`，并继续声明 `prototype_ai_assisted`、`lock_eligible=false`。
- [ ] AC8: A1 本地构建不选取 `partial` 或缺 `raw_ref` 的条目；受控快照准备拒绝 `partial`、缺失/不可读 raw archive、旧格式归档、归档正文输入单次规范化后与存储正文不一致，或正文/归档声明的 `content_hash` 不一致的条目，且不创建候选 manifest。

隔离构建必须显式传入五个主题（包括新增的停用主题），例如：

```bash
export EVAL_TOPIC_IDS='t_code_agents,t_prompt_injection,t_ai_industry,t_coding_agent_platforms,t_agent_security'
export EVAL_TOPIC_SOURCE_IDS='{"t_code_agents":["src_simonwillison","src_aider"],"t_prompt_injection":["src_trailofbits","src_anquanke"],"t_ai_industry":["src_semianalysis","src_techcrunch_ai"],"t_coding_agent_platforms":["src_openai_codex_releases","src_cursor_changelog"],"t_agent_security":["src_embracethered","src_simonwillison_promptinj"]}'
```

`EVAL_TOPIC_IDS` 只改变本地评测的读取范围，不启用 topic、不修改生产 SQLite，也不替代后续生产启用决策。
`EVAL_TOPIC_SOURCE_IDS` 让指定来源对优先并且只能为各自 topic 补样；它不能与旧的全局 `EVAL_REQUIRED_SOURCE_IDS` 混用，从而避免共享 source route 先占用条目、使后续 topic 单源或空缺。

构建成功后，先生成无正文的 candidate source manifest，再把质量 JSONL 与该 manifest 上传至受控 bucket；candidate 的 `pending_source_terms_review`/`candidate_pending_labels` 状态不构成 `verified_v2` lock：

```bash
npm run eval:prepare-controlled-v2-snapshot -- \
  evals/dataset/insight-quality-v2.local.jsonl /tmp/a1-v2-candidate a1-v2-candidate-20260910 \
  /tmp/<isolated-root>/collection.json /tmp/<isolated-root>/dataset-v2-expanded.json
```

## 非功能要求

- 安全：采集和原文只位于 `EVAL_ISOLATED_ROOT` 或获授权的受控快照；采集错误 manifest 不记录 URL、正文或凭据。
- 可观测性：保留 collector、dataset、A1 manifest 的哈希关联；source/body 内容不写入 Git。
- 成本：先以 collector 和确定性构建检查来源可用性，只有形成可锁定样本后才调用完整 A1。

## 依赖与开放项

- `t_code_agents`、`t_prompt_injection`、`t_ai_industry` 的受控来源对需与新增主题一起在本轮 snapshot 确定，且五主题之间必须满足全局去重。
- 受控不可变存储位置、两名标注 reviewer 和第三名裁决者需要 owner 指定；在此之前不能创建 promotable v2 lock 或声称人工标签完成。
