# 实践记录：AI 时代的软件开发 (Practice Log)

> 本项目的元目标产物 —— 记录开发 Deep Insight 过程中，对 AI 时代软件开发新范式的
> 探索、经验与教训。累积式，按主题归类，新条目追加在对应主题下。
> 背景见 `docs/concept/charter.md` 的「探索性目标」。

## 记录体例

每条记录追加在对应主题下，含字段：

- **日期**
- **情境** —— 发生了什么
- **观察** —— 看到的现象 / 数据
- **经验 / 教训** —— 可复用的结论
- **后续动作** —— 据此要改的流程 / skill / 文档

主题之外的新探索方向，自行新增 `## 主题` 小节。

---

## 人与 AI 协同

> 8 人团队 + Claude Code 如何分工、评审、决策。

### 2026-05-21 · 独立 AI 评审捕捉作者盲点 + review treadmill 现象

- **日期**: 2026-05-21
- **情境**: M1 计划阶段，4 份 spec + `architecture.md` + `eval-criteria.md` 完成后，跑了多轮独立 agent 评审（4 份 spec 3 轮 + architecture 1 轮，每轮 1–4 个 general-purpose agent 并行），作者修订后再评。
- **观察**:
  - 最尖锐的一次：作者（我）在 `architecture.md` 选了「Vercel 默认 + SQLite + 本地 FS」，独立 agent 一眼指出 Vercel Functions 文件系统是临时的、SQLite 无法在 serverless 下持久化 —— **根本性兼容错误**，作者自己写时没察觉。
  - 评审收敛但**不归零**：spec 3 轮 review→fix —— 第 1 轮大量结构性硬伤；第 2 轮 17 个 🔴（精度问题）；第 3 轮 11 个 🔴（边界 / 派生规则）。每轮问题更细，但总有新发现。
  - 4 个 agent 并行时，**跨 agent 一致指向 = 强收敛信号**；单 agent 独有的发现往往是个体视角偏向。
- **经验 / 教训**:
  - 独立评审的核心价值不是找 typo，而是**捕捉作者的认知盲点** —— 技术选型这类「看起来流行 / 自然」的组合错误，AI 作者尤其容易踩。
  - **评审治理需要人判断何时停**。「0 🔴」不是能达到的状态；按 IPD「DCP 是业务门、TR 是技术门」的精神，DCP 应在「契约自洽、AC 可测、跨 spec 一致」的成熟度判可过，spec 精度细节归 TR / develop。
  - 收敛信号：严重度从结构性 → 精度 → 边界 的渐变 + 跨 agent 一致性下降 = 该停的标志。
- **后续动作**:
  - 重大技术选型应跑至少 1 轮独立 agent 评审，作为 ADR 流程的实践增强。
  - 把「评审何时停」的判据沉淀进 IPD 流程（待 `docs/process.md` 重建时纳入）。

### 2026-05-25 · A1 迭代循环：AI 预评驱动定向修复，但受限组件会让 auto-metrics 误导

- **日期**: 2026-05-25
- **情境**: A1 验证切片在「第三方中转站 + validator 无思考」约束下跑了三轮全量，配合「生成 → AI 预评 → 据发现改 prompt / 加守卫 → 重跑验证」的循环。
- **观察**:
  - **AI 预评驱动定向修复有效**：对 AI 生成的洞察做一遍 AI 预评，定位出引用未覆盖、过度泛化、跨句拼接、截断、安全拒答等具体缺陷；据此改 prompt / 加规则后重跑，**拒答**与**引用可达性**两处一次修好（可验证）。
  - **但聚合指标会误导**：提示让洞察更综合（跨源 22%→56%），反而把无思考 validator 的 flagged 从 9.7% 推到 29.7%、自动门槛从 3/6 掉到 1/6——「更好的产出」撞上「受限的评判器」，指标不升反降。只看「门槛过几项」会得出完全相反的结论。
  - **prompt 不是万能**：截断的「敏感域安全行为」假设被一条**非敏感**技术句的截断证伪——根因在结构化输出对长字符串的过早截断，只能靠产出守卫 / 换输出方式，prompt 改不动。
- **经验 / 教训**:
  - 评判链路里只要有一环受限（这里是 validator 没法带思考），**聚合指标就不可信**，必须回到**逐条产出的核对**找真信号（可达性、逐条引用覆盖、人评非显然/幻觉）。
  - **AI 评 AI 有同源偏好**：预评只能当 triage 起点，不能当结论；真判定交人。
  - 改进先分类：「prompt 可解」（拒答框定、引用覆盖、不放大）vs「prompt 不可解」（结构化输出截断）——后者别在 prompt 上空耗。
- **后续动作**: A1 代码迭代告一段落，交人评（`docs/verify/a1-review-sheet-2026-05-25.md`）+ 直连 key 补带思考校验。把「组件受限时别信聚合指标」写进 `skills/L3-quality.md`。

## SPEC 的使用

> spec 作为人类意图与 AI 实现之间的契约是否有效。

### 2026-05-21 · spec 收口的精度阶梯 + 中心化数据模型的加速作用

- **日期**: 2026-05-21
- **情境**: 4 份核心 spec（`data-collection` / `insight-analysis` / `citation-validation` / `report-generation`）经过 3 轮独立评审 + 3 轮 targeted 修复才到 DCP-1 基线。每轮发现的问题性质不同。
- **观察**:
  - 收敛是**阶梯式的**：
    - 第 1 轮（spec 第一稿）：契约只有散文、AC 不可测、schema 缺失、跨 spec 断点 —— **结构性缺失**
    - 第 2 轮（schema 落 `architecture.md` 后）：偏函数处置矩阵、占位符未填、口径未定 —— **精度问题**
    - 第 3 轮（精度补齐后）：必填字段语义、空批次特例、状态机不自洽、字段派生规则 —— **边界 / 派生规则**
  - 把数据模型集中落在 `architecture.md` 后，4 份 spec 用「字段见 architecture.md」引用，跨 spec 一致性问题大幅减少 —— **「单一事实来源」是收敛的关键加速器**。
  - 「处置矩阵」从「散文规约」改为「全函数表」（覆盖全部 `(reachability × consistency)` 组合 + `consistency_reason` 取值约束）是**质的飞跃**：散文允许歧义，全函数表强制完备。
- **经验 / 教训**:
  - spec 写作的硬规则：
    1. 契约要**字段级 schema**，不要散文
    2. AC 要带**度量 + 通过线**，不要"达标 / 完整"
    3. 涉及多状态判定时用**全函数表**（覆盖所有组合），不要散文
    4. 跨 spec 引用同一份 schema，不要各自重定义
  - **「中心化制品」（数据模型 / 处置矩阵 / 评测集）应在 spec 之前定**。spec 引用它们；比每个 spec 各自定义事后对齐高效得多。
- **后续动作**:
  - 上述 4 条硬规则写进 `docs/plan/specs/_template.md` 作为模板约束。
  - 「spec 之前先定中心化数据模型 / 处置矩阵」加入 `skills/L2-workflow.md` 的 Plan 阶段约束。

## Skill 的选择与使用

> `skills/L0–L3` 分层约束的有效性。

### 2026-05-24 · 写 SDK 代码前先取 skill，而非凭训练记忆

- **日期**: 2026-05-24
- **情境**: 实现 A1 验证切片（本项目首段真正调 Claude API 的代码）。动手前先调 `claude-api` skill 取当前 Anthropic SDK 用法，再写。
- **观察**: skill 给出的关键用法大多在模型训练 cutoff 之后 —— 结构化输出走 `messages.parse()` + `zodOutputFormat`、Opus 4.7 仅支持 adaptive thinking（传 `temperature` / `budget_tokens` 会 400）、模型 ID 不带日期后缀。若凭记忆写，大概率会用已废弃的 `output_format` 或给 4.7 传 `budget_tokens`。
- **经验 / 教训**: 对「版本漂移快」的依赖（厂商 SDK、模型 API），skill 是「最新事实来源」，应作为**写代码前的固定前置步骤**，而非事后纠错。AI 的训练记忆对这类 API 是负债，不是资产。
- **后续动作**: 把「调外部 SDK / 模型 API 前先取对应 skill」纳入 L0/L2 开发阶段约束。

## AI 代码质量保障

> 评审、测试、eval 如何应对 AI 生成的代码。

### 2026-05-24 · typecheck + 无 key 单测兜住 AI 的「记忆性 API 错误」

- **日期**: 2026-05-24
- **情境**: A1 切片代码写完，先跑 `npm run typecheck` + `npm test`（纯函数单测，不需 API key）。
- **观察**: typecheck 第一时间抓出一个 AI 凭记忆写错的细节 —— schema 用了 zod 经典入口 `import { z } from "zod"`，而 SDK 的 `zodOutputFormat` helper 实际要 `zod/v4` 入口，类型对不上、编译失败。改成 `zod/v4` 后通过，8/8 单测过。这个错误「读代码看不出来」，是真跑工具链才暴露的。
- **经验 / 教训**: AI 生成的 SDK 调用常常「看起来对、跑起来错」。第一道质量关应是**不依赖外部服务的确定性检查**（typecheck + 纯函数单测）—— 便宜、可在沙箱/CI 跑、专抓这类记忆性偏差。有意识地把「确定性逻辑（可达性校验、处置矩阵）」与「需真模型的部分」分开，让前者可被**无 key 单测**覆盖，是可测性设计的一部分。
- **后续动作**: CI 至少跑 typecheck + `npm test`（无需 key）；`eval:a1`（需 key）作为人工/定时门槛。把「区分确定性逻辑 vs 模型依赖逻辑、前者必须有无 key 单测」写进 `skills/L3-quality.md`。

### 2026-05-24 · typecheck + 单测全绿，真跑仍崩 —— 子集冒烟的不可替代

- **日期**: 2026-05-24
- **情境**: 评测集扩到规模后，先跑「1 主题 + 10 组」的子集冒烟（而非直接花 $5-10 跑全量）再上真模型。
- **观察**: typecheck 干净、13/13 单测全过的代码，**第一次真调 API 就崩**：`new Anthropic()` 写在模块顶层，import 时即执行，早于 `main()` 里的 `loadEnvLocal()`，于是客户端拿不到 key（`Could not resolve authentication method`）。改成懒加载后再跑，又用一次最小 curl 探针发现 key 本身无效（`401 invalid x-api-key`，前缀 `sk-V…` 而非 Anthropic 的 `sk-ant-`）。两个问题——一个代码 bug、一个配置错误——都在花钱跑全量前、用不到 1 美元暴露了。
- **经验 / 教训**: 「typecheck + 单测全绿」只覆盖**确定性逻辑**，覆盖不到**模块初始化顺序**和**外部服务真实契约**这类问题——它们只在真跑时显形。所以**真依赖（模型 API）的冒烟是一道独立的、不可省的质量关**。两条具体规则：①依赖环境变量的单例必须懒加载（或在 import 前注入 env）；②昂贵的真 API 跑前，先用最小子集冒烟（`A1_*_LIMIT`）验证链路+标定成本。
- **后续动作**: 已加 `A1_QUALITY_LIMIT` / `A1_CONSISTENCY_LIMIT` 子集开关 + key 前缀格式告警。把「真依赖冒烟 = 独立质量关」「env 单例懒加载」纳入 `skills/L3-quality.md`。

### 2026-05-26 · 独立评审 M2 后端：抓出自评 / 单测全漏的真 bug

- **日期**: 2026-05-26
- **情境**: M2 后端四 agent 管线写完（46/46 单测绿、typecheck 干净），按方法论起 3 个独立 agent 分块评审（数据模型 / 管线逻辑 / 源安全），不自评。
- **观察**:
  - 三 agent **强收敛**，抓出 4 个 🔴：① **校验闸门洞**——validator 一致性调用出错时静默 `continue` 丢掉该 check，report-gen `selectInsights` 又把「无 check」当「未 blocked」保留 → **未校验的引用伪装成已核实进报告**；② **去重违约**——同 URL 内容更新时插新行 + 新 id，违反 `data-collection` AC2「原地更新、id 不变、不新增」；③ **SSRF 全缺**——`Source.endpoint` 用户可控，三处 `fetch` 零校验且默认跟跳；④ **analyzer 把外部 body 裸拼进 prompt**、无 `<untrusted-source>` 包裹，违反安全设计，且 validator 已正确包裹、自相矛盾。
  - **46/46 全绿却全没抓到** —— 因为单测只构造 happy path：从不构造「引用无 check」「同 URL 内容更新」「恶意 endpoint」这类失败 / 对抗场景。
- **经验 / 教训**:
  - **全绿 ≠ 正确**：测试只验你想到的路径；**闸门类逻辑必须专门构造「未通过 / 缺失 / 对抗」输入**，否则「黑名单式默认放行」（把「未校验」当「通过」）会一路绿灯。
  - 自评有同源盲点；**独立评审对「作者默认假设」（无 check = 保留、endpoint 可信、body 可信）的捕捉不可替代** —— 这是继 architecture Vercel 选型之后的第二个印证。
  - 安全契约（SSRF / untrusted 包裹）在「能跑」阶段最易被跳过，应在评审 checklist 硬挂。
- **后续动作**: 闸门改白名单（无 check 即排除）、analyzer 补 untrusted 包裹、加 `safeFetch`（SSRF + 超时）、去重改 upsert 对齐 AC2；把「闸门 / 安全类逻辑必须有失败与对抗用例」写进 `skills/L3-quality.md`。

### 2026-05-31 · 端到端 SQL 审计揭示两批两类失败模式零交叉

- **日期**: 2026-05-31
- **情境**: A1/A2/A3 把 validator 屏蔽信号外露到 UI 后，跑纯 SQL（~$0）审计 Run 3 输出的 swe `rep_54ed154e`（45 洞察 / 123 引用）与 security `rep_b91964bd`（4 洞察 / 15 引用）的屏蔽分布。
- **观察**:
  - swe 屏蔽率 13/123 = 10.6%，**13 条全部**是 `quote_not_in_source`（reachability fail，rule 3 引用纪律）；
  - security 屏蔽率 3/15 = 20%（样本小），**3 条全部**是 `exaggeration ×2 / out_of_context ×1`（consistency not_support，rule 5 不得放大）；
  - **两批零交叉**：长内容（latent.space/Pragmatic 长文）触发 quote 漂移→reachability；短结构化内容（ATLAS release notes）触发借题发挥→consistency。同一管线在不同内容形态上呈现两条完全分离的失败路径。
- **经验 / 教训**:
  - **"屏蔽率"作为单一指标会隐藏失败结构**——必须按 reason 分布看才知道是哪类问题。本批两个数字（10.6% / 20%）都不算高，但根因截然不同，治理方法也截然不同（前者是字符比较，后者是 prompt 强化）。
  - **不同主题触发不同失败模式**——不能用一类内容验证另一类的 yield；dogfood / eval 集必须跨主题/源风格取样以覆盖两条路径。
  - "100% by construction" 是双重保证（reachability 和 consistency 闸门分别拦不同问题）——两批数据**实证**了这一点：13 + 3 = 16 条被屏蔽，其中 13 不可达 + 3 不一致，0 重叠，缺一类就漏。
- **后续动作**: A1 渲染默认外露 reason 分布（已落地 `校验阻断: N 条（理由：X×n）`）；admin 看板按 reason 维度统计（A3 已有 kind 维度，可扩 reason）；dogfood 选片硬约束「至少覆盖两类源风格」写入 `skills/L3-quality.md`。

### 2026-06-01 · 自动分类的"无信号"实际是关键信号：13/13 rewrite 错觉

- **日期**: 2026-06-01
- **情境**: B 审计抓出 swe 13 条 blocked quote_not_in_source 后，写了一个分类脚本把每条按"漂移程度"归类：whitespace-only / mid-drift / early-drift / rewrite-from-start / major-rewrite。期望分类直接定位根因。
- **观察**:
  - 一跑：0/13 whitespace-only · 0/13 mid-drift · 0/13 early-drift · 5/13 rewrite-from-start · 8/13 major-rewrite。
  - 看分类直觉是"全是 model 严重漂移，rule 3 违规、prompt 改进"，差点据此就改 prompt。
  - 改看 raw 案例（3 条样本 quote vs body 逐字对比）才发现：所有"差很多字"实际是 **typography 不匹配**——body 含 smart quote `"`（U+201C/D）+ HTML 命名实体残留 `&rsquo;`，模型 quote 用 ASCII `"`/`'`。一个 codepoint 差异让 substring 永久失败，外加 `repairQuote` 用前 24 字锚定遇 typography 差异即放弃，导致**整段被分类为"重写"**。
  - 实际修复方案不是 prompt，是 fold typography（双侧 substring 前归一）+ stripHtml 补 7 个命名实体。13/13 全恢复，0 行 prompt 改动。
- **经验 / 教训**:
  - **自动分类器给出"全集中在一类"时反而要警惕**——可能是 false negative 的均匀分布（所有项都被同一种问题阻断在分类器看得见的早期）。
  - **抽 3 条 raw 数据看一眼成本极低，能颠覆全局诊断**。本次若按分类直觉改 prompt，会浪费几轮迭代且不解决问题。
  - **分类的精细度不等于诊断的深度**：分类器只能区分它的维度之外的差异；它没说出来的细节（例：1 个 codepoint 差异）往往才是答案。Codepoint-level diff 维度本应在分类器里。
  - 启发用在更广场景：任何"自动指标看起来集中"的情况，都先抽 raw 样本看，不要被 aggregation 欺骗。
- **后续动作**: A2 报告详情页的"校验下钻"已能展示原 quote + reason（部分覆盖此需求）；可考虑后续给分类脚本加 `byte-level diff(quote, body-substring)` 维度，自动报"U+xxxx → U+yyyy"；写进 `skills/L3-quality.md` 的「诊断方法学」段。

### 2026-06-01/06-02 · 异构 + 隔离上下文 review：突破单模型自审盲点

- **日期**: 2026-06-01 ~ 2026-06-02
- **情境**: typography fold 主修做完后要 review；自审风险很大（我作为作者有动机维护自己的诊断结论）。改用 `Agent` 工具 spawn **Sonnet sub-agent**（不同型号 + 完全隔离的上下文，不带本会话记忆），用对抗式 prompt + 结构化 YAML 输出。三轮迭代收敛。
- **观察**:
  - **R1** 抓出 1 critical（`repairQuote` 返 `nb.slice` 弱化 byte-verbatim 承诺）+ 4 concerns（U+2032/U+2033 prime 安全混淆、CJK 引号缺口、computeLocator 漂移、compareKey 应单点）—— 我自审根本没看到，因为这些都是"作者认为已经处理好"的隐性假设。
  - **A/B 修订**：移 prime/double-prime + 加 CJK 「」『』 + 契约文档明确"fold-equivalent ≠ byte-verbatim"。R1 critical 降级为 follow-up。
  - **R2** 终审 + 抓到我**全新的笔误**——`it("含 U+2032")` 测试描述与代码（已移除 U+2032）相反，是 A/B 修订时改了代码却忘改测试描述字符串。如果不复审会让未来读者困惑。
  - **F1/F2/F3** 落地（byte-verbatim + locator 自愈 + compareKey 单点抽离）。
  - **R3** 全部 verdict yes、7 个 edge cases 全部 holds: yes、approve_with_followup high confidence；剩余 2 个 optional 微调（trimEnd + 旧测试断言强化）就地修复。
  - **每轮成本** ~$0.05–0.20（Sonnet 通过 Max 订阅，单次 review 极便宜）。三轮总成本 < $1，比一次 `/code-review ultra`（$1–5）便宜数倍。
  - **三轮发现独立**：R1 找的是设计缺陷、R2 找的是新引入的笔误、R3 找的是边界精确性。轮次叠加而非重复。
- **经验 / 教训**:
  - **同模型 / 同会话自审有系统性盲点**——作者的认知偏差不会因为"我再看一遍"消失。需要**机制层面**的隔离：不同型号 + 不带本会话上下文 + 对抗式 prompt。
  - **轮次迭代很快收敛**：R1→A/B→R2→F1/F2/F3→R3，从 `request_changes` 到 `approve_with_followup high confidence` 三轮。每轮花的不是更多分析时间，而是**给前一轮发现一个明确的响应路径**（修 / 降级 / 留 follow-up），让下一轮可以专注新维度。
  - **对抗式 prompt 是关键**：让 reviewer 扮演 "skeptical / find what's wrong"，比 "check this looks ok" 信号强很多。R1 找到的 critical 就是因为它被明确要求"verify or refute the recovery claim"。
  - **结构化输出（YAML schema）方便聚合**——critical / concerns / suggestions / strengths / verified_claims / verdict / confidence。同一 schema 跨轮可比、跨模型可比、可写脚本聚合。
  - **隔离上下文要做到位**：sub-agent 不能看到我的根因分析（否则它会顺着我的逻辑走，等于自审）。**只给数据（diff + raw blocked 数据）+ 问题陈述**，让它自己推。
  - **跨厂商比同厂跨型号独立度更强**——但同 Max 订阅下 Sonnet sub-agent 已是 95% 收益、零额外成本，先把这个用起来再升级到跨厂。
- **后续动作**:
  - 把"PR 提交前 spawn Sonnet R1 隔离 review"写进 `skills/L3-quality.md`，作为下次 PR 默认动作。
  - 长期搭 v2 多厂商脚本（GPT/Gemini/Claude 并发 + 结构化聚合）；中期把 review 流程做成可重放（每次都用同一对抗 prompt + schema）。
  - 异构 review 的发现要保留在 commit message 里（已实践：本次 commit 详尽记录三轮发现），让 review 历史成为代码资产。

## 基础设施与集成（模型接入）

> 真实接入 LLM 时，环境/中转站对架构假设的冲击。

### 2026-05-24 · 第三方 API 中转站打破多个架构假设

- **日期**: 2026-05-24
- **情境**: A1 实跑用的不是 Anthropic 直连，而是第三方中转站（`ANTHROPIC_BASE_URL=yibuapi.com`）。冒烟时逐层踩坑、逐层探针定位。
- **观察**:
  - token 非 `sk-ant-` 格式（中转站自有 token），且只授权了 **Opus（4.6/4.7），无 Sonnet/Haiku** → 默认 `analyzer=sonnet-4-6` 直接 403。靠「模型可配」用 env 切到 `opus-4-6 / opus-4-7` 绕过。
  - 中转站对「**非流式 + adaptive thinking 的长响应**」会卡死（连接超时，4 次重试全超时）；但**同样请求体**用 curl 发小内容能 4–9s 返回 → 是长响应缓冲/超时问题，不是鉴权或参数非法。关掉 validator 思考后整条链路一次跑通。
  - 代价：validator 在中转站上只能**不带思考**跑，子集三分类准确率仅 80%（< 90% 门槛）—— 精度受损是**中转站约束**导致，不是方法本身的问题。
- **经验 / 教训**:
  - 「模型可配」从纸面设计变成救命稻草：换接入方/中转站时**不改一行代码、env 切模型**即可。值得作为默认实践保留。
  - 架构里「校验用 Opus + 思考」的假设**隐含依赖直连或流式**。经中转站要用 thinking，必须给 validator 上 streaming（claude-api skill 早有提示：长输出/高 max_tokens 一律 stream）。
  - 第三方中转站会在**模型清单、特性支持、长响应稳定性、数据出境**多个维度悄悄打破假设；接入前应显式核验，别假设它等价于直连。
- **后续动作**: validator 加了 `VALIDATOR_THINKING` 开关、客户端短超时（60s）+ 多重试（3）。要拿**可信的 A1 结论**，需直连 Anthropic、或给 validator 实现带 thinking 的 streaming。

### 2026-05-26 · `next build` 绿 ≠ 容器能跑：standalone 打包的隐藏假设

- **日期**: 2026-05-26
- **情境**: 增量7 给应用容器化，用 Next `output: "standalone"` 瘦身镜像。
- **观察**:
  - standalone 只拷被 trace 到的 JS + 原生模块，**不拷非 JS 资源**。`loadStaticConfig` 用
    `import.meta.url` 相对定位 `defaults.yaml`，打包后该路径失效——`next build` 照样全绿，问题只在容器运行时才暴露。
  - 同类隐患还有原生模块：`better-sqlite3` 的 `.node` 是否被 trace 进 standalone，肉眼看构建日志看不出来。
  - 关键动作：**不等 Docker build，先把 `.next/standalone/server.js` 用容器同款 env 直接起起来冒烟**
    （`/api/health` 命中库、`/api/cron` 鉴权 401）。一次本地启动就确认了原生模块加载 OK、配置外挂路径 OK，
    把「镜像 build 完才发现起不来」的长反馈环砍掉。
- **经验 / 教训**:
  - 与「子集冒烟不可替代」同源：**构建期检查（typecheck / build）兜不住运行期的资源定位与原生加载**，
    打包形态变了就要对**产物本身**冒烟，而不是只看 build 退出码。
  - 凡「相对自身模块读文件」的代码，在 bundler / standalone 下都要预设会失效，改走**环境变量指定绝对路径**。
- **后续动作**: 配置路径加 `INSIGHT_CONFIG_PATH` 覆盖；Dockerfile 显式 COPY `defaults.yaml` 与
  `better-sqlite3`（兜底 trace 漏拷）；决策记入 ADR-0001。

### 2026-05-27 · 广度 ≠ 源数量：一次真多源 populate 暴露 4 个 curated-demo 测不出的问题

- **日期**: 2026-05-27
- **情境**: 数据源从 2 个 arXiv 扩到 MVP 清单 23 个、主题拓宽为行业级后，跑一次真 populate「看广度变现」。
- **观察**:
  - **加源反而更差**：swe 主题"近期 top-10"被 OpenAI feed 一次灌回的 **968 条全历史 backlog** 占满（全是 DALL·E 等旧营销帖），把相关的 arXiv 挤出 → analyzer 正确判 **0 洞察**。安全主题直接超时。**源多了，信号反被淹没。**
  - 一次真多源实跑**连带抖出 4 个潜伏问题**，全是之前 curated 的 6 条 arXiv demo（`rep_ddf10bd4` 那篇好报告）+ 单测都测不出的：① SSRF 把 `192.0.0.0/16` 整段误拦（误杀 github.blog 公网，实际只该拦 `/24`）；② RSS 无每次抓取上限（backlog 灌库）；③ 朴素 recency 选片被高产源独占；④ arXiv 连发多查询触 429 限速。
  - 那篇"好报告"之所以好，恰恰因为它是**人工精选的 6 条对口 arXiv 摘要**——curated 输入掩盖了规模化采集/选择的全部短板。
- **经验 / 教训**:
  - **「广度」是工程能力，不是源清单长度**：= 限流（每源每次封顶 F1）+ 选片（相关 token 命中 + 来源多样 F2）+ 限速（arXiv token bucket F5）。少了任一条，加源只会增噪。
  - 与「子集冒烟」「standalone 冒烟」同一脉络：**curated / 小而美的输入会系统性掩盖真实形态下的问题**；要验证规模化能力，必须喂**真实、异构、带噪**的全量数据跑一遍。
  - 真 populate 的 ROI 极高：一次跑出 4 个潜伏 bug，比读代码/单测高效得多。
- **后续动作**: 修 F1（`RSS_MAX_ITEMS`）/F2（`rankAndDiversify` token 化 + 候选池放大）/F3（SSRF `/24`）/F5（arXiv ≥3s 节流 + 429 退避）；干净重采复验：安全侧 5 源多样、swe 侧 arXiv 15/15 回归。analyzer 大池分批仍待办。

### 2026-05-31 · 免费云部署选型 + GCP 落地踩坑：架构约束定可行域，身份对齐是隐性关

- **日期**: 2026-05-31
- **情境**: 评估 AWS / GCP / Azure 免费档能否承载本应用，并尝试落地 GCP e2-micro（Always Free · 1GB）+ CD 自动部署。配齐 secret、修阻断项后，因服务器侧用户/拉码认证不对齐中途暂停、清理收尾。产出 `operations.md` §11 文档。
- **观察**:
  - **架构约束（而非免费档规格）决定可行域**：本应用是「进程内长任务 14–42min + 有状态本地 SQLite + 单实例常驻」，这一刀切掉三大云**全部 serverless/PaaS 免费档**（Lambda 15min 上限 / Cloud Run 临时盘+缩容丢状态 / Functions 同理）——免费额度再大也用不上。三家**唯一可落点都是「常驻微型 VM」**，且其中只有 **GCP e2-micro 永久免费**（AWS 新政 $200/6 月、Azure B1S 12 月均限时）。这是继 2026-05-21「Vercel serverless 不持久化 SQLite」之后，**同一条架构判据在「选型」语境里的二次印证**。
  - **构建期 vs 运行期资源画像必须分开估**：1GB 机上 `next build` + better-sqlite3 编译 >1GB 必 OOM，但运行期实测仅 ~0.5–0.8GB。运行期低占用的判断**靠读代码事实落定**（`ingestConcurrency:1` 串行采集、`safe-fetch` 8MB 抓取封顶且流式、`normalize` 正文截断 50KB、单批 ≤25 条 ≈1.25MB、LLM 流式输出有界），不是拍脑袋。解法是 swap / 预构建镜像绕开构建峰值——「能不能跑」要拆成「构建扛不扛得住」和「运行扛不扛得住」两问。
  - **上线前「配置 × 代码断言」体检抓出启动阻断**：对照 `.env.local` 与代码里的启动校验，抓出 `ANALYZER_MODEL == VALIDATOR_MODEL`（`llm.ts:assertModelSeparation` 会 `throw` 同源偏差约束）——这条 scp 上服务器就直接起不来。「键都填了」≠「能启动」，得拿**代码里真正会 assert 的约束**去验配置，而非只看非空。
  - **部署期「身份对齐」是独立于代码正确性的一类摩擦**：CD 流水线把「登录用户 / 家目录路径 / SSH key / 私有库拉码认证」四者编码进 secret，而**交互便捷路径（GCP 浏览器 SSH → Google 身份 `dolphinqd`）天然偏离 CD 配置的用户（`deploy`）**；私有库 HTTPS 拉码又撞上 GitHub 停用密码认证（需 deploy key）；OS Login 还可能让机器级 SSH key 失效。这些与代码对错无关，全是「环境/身份契约」没对齐，且只在真落地时显形。
- **经验 / 教训**:
  - **选型先问架构判据，再看免费档规格**：长任务 + 有状态 + 单实例这类约束一旦成立，serverless 免费档整类出局，比较只在「常驻 VM」这一轴上有意义。一句话筛掉一大片，比逐家对参数高效。
  - 资源可行性**拆构建期/运行期两问**；运行期估算**回到代码里的并发度/缓冲上限/截断常量**取证，与「子集冒烟」「standalone 冒烟」同脉络——别信笼统印象。
  - 把「**部署前 env 体检 = 拿代码的启动断言验配置**」当一道独立关；同源偏差、必填、格式这类一跑就崩的，应在 scp/CD 触发前先核。
  - **CD「身份/认证契约」要在配 secret 时一次对齐**：交互登录用谁、CD 用谁、私有库怎么非交互拉码（deploy key）、OS Login 是否吞掉机器级 key——任一不齐，代码全对也部署不动。
  - 「**免费不等于零成本**」：永久免费 VM 的外部 IPv4 仍按 ~$3.6/月 计费、省机器钱省不掉模型调用钱（中转站 Opus ≈¥14–26/轮）——「免费方案」要把**未被免费档覆盖的尾巴**显式列清。
- **后续动作**: 选型结论 + e2-micro/1GB 注意点（swap、`NODE_OPTIONS`、区域、IP 计费）落 `operations.md` §11（已合并 main）。待续做时：①「部署前 env 体检脚本化」可纳入 CD 预检；②把「CD 身份/认证契约清单」沉淀进 §8/§10–11 或 `skills/L2-workflow.md` 的发布约束。本轮 GCP 实例 + secret + 密钥已清理，零遗留成本。

### 2026-06-03 · 中转站第二次打破假设：`output_config.format` 拒收 + 「新 SDK 字段是隐性技术债」

- **日期**: 2026-06-03
- **情境**: PPT B 阶段（LLM polish）跑端到端验证，第一次真调 LLM 全部 400 失败。错误体：`output_config.format: Extra inputs are not permitted`。换 analyzer probe 同样 400 → **整条 `callStructured` 链路（analyzer / validator / ppt-polish 全部）瞬间挂掉**。
- **观察**:
  - 同一中转站、同一 key、同一 model；前一天 cron 还跑得好好的，**当天起就拒收 `output_config.format`** 字段。中转站收紧了请求体校验，没通告。
  - `output_config.format` 是 Anthropic SDK 2024H2 新增的结构化输出新路径；`tools` + `tool_choice: {type:"tool", name}` 是 2023 起就存在的事实标准。中转站对**老路径稳定支持、对新路径滞后或拒收**。
  - 修复就是把 callStructured 内部从 `messages.stream({output_config.format})` 迁到 `tools + tool_choice`：zod schema 用 zod v4 内置 `z.toJSONSchema` 转 JSON schema、流尾内容块里找 `tool_use` 取 `input`、再 `schema.safeParse` 校验。15 分钟改完，relay probe 验通。
  - **意外收益**：这个 bug 是 PPT 子线的 B 阶段 probe 当时碰上的，但**真正受影响的是下游 cron 的 analyzer/validator**——若不是 B 阶段当天动了 LLM 路径，下一次 6h cron 才会暴露，那时会**静默产出 0 洞察的报告**（之前 6/2-6/3 容器 volume 里的两份空报告就是这个根因）。
- **经验 / 教训**:
  - **新 SDK 字段是隐性技术债**：选结构化输出实现时不该追新——`output_config.format` 是新路径、`tools+tool_choice` 是老接口。中转站、私有部署、降级链路下，**老接口的事实兼容性 = 真稳定性**。同样情形若在直连 Anthropic 不会触发；中转站把这个隐性假设照出来了。
  - **B 阶段 probe 顺带救了下游 cron** 是个范式信号：每个**触碰底层调用面**的新功能 commit 配的端到端 probe，**会顺带验证既有功能是否还活着**——这是次生质量关。建议：调底层（callStructured / safe-fetch / DB 句柄等）的变更，commit 时跑一次极简 probe 命中线上路径，比单测多一层 catch。
  - 中转站从 5/24（首次打破假设）到 6/3（第二次）连续两次，**对中转站的"突变"不可控**；架构对此的真正抵抗策略是：① 调用面保持最稳老（不追新 SDK 字段）；② 每个外部依赖一道 fallback / 解析降级；③ Optional：在 callStructured 加 try-old-shape-on-400 自愈，把这条经验固化进运行时。
- **后续动作**: tool_use 迁移已 commit `9369ba7` 合 main；`operations.md` §7 增加这条故障排查（含治本指引）。下次中转站再变（很可能还会有第三次），优先确认 callStructured 是否还在最稳老路径上。

### 2026-06-03/04 · merge 增量收敛：对抗 flaky 上游的标准缓存范式

- **日期**: 2026-06-03 ~ 2026-06-04
- **情境**: PPT B 阶段 LLM polish 跑 13 重点条 + 1 executive 并发；D 阶段加缓存，初版严格门槛"perInsight 全 + executive 非 null 才入缓存"。
- **观察**:
  - **并发=14 流式 tool_use 偶发截断**：实测 14 路并发，36% 单条 `JSON.parse` 失败（中转站累积 `input_json_delta` 时截字节）；同一中转站单笔调用次次通——**并发场景对 SSE 流稳定性是独立问题**。限并发到 4 后失败率降到 14%，但仍非 0。
  - **严格缓存门槛在中转站现实下不可达**：3 次 polish=1 真跑全 partial（每次 executive 都挂、单条挂 2-5 条），"全成功才入缓存"实测**从来不命中** → 缓存永空 = 没做。
  - 改成 **总是缓存 partial + merge 增量收敛**：每次跑都与同 hash 既有缓存做并集（新成功覆盖旧、新失败仍能拿旧），状态 header 报 N/M + exec 覆盖度；用户多次 `refresh=1` 时新批补漏不重做成功的，**自然渐进收敛**。实测：cold miss 12/13 partial → refresh 1 次 → 13/13 no-executive，下次 hit 26ms / $0。
- **经验 / 教训**:
  - **理想化门槛 = 把功能砍了**：设缓存门槛前必须看真实成功率分布。把"全成功"当门槛只在上游 100% 稳定时正确；上游 < 70% 单笔成功率下，"全成功"是空集。
  - **merge 增量收敛是对抗 flaky 上游的标准范式**：每次努力不浪费（新成功必入），失败不回退（旧成功必留）；多次 refresh 单调升级。比"严格门槛 + 全失败重试"成本低得多、用户感知更平稳。同模式可推广到：multi-source ingest（每源单独缓存）、batch validation（每批独立 commit）、retry-with-progress 类所有"上游不稳但子任务可独立成败"的场景。
  - **并发上限要可配 + 默认保守**：`PPT_POLISH_CONCURRENCY` env 默认 4。把"并发到上游能力上限"的诱惑收住——上游能力是上限不是均值，**并发数应按 P95 不超时容量定**。本应用上游是中转站，P95 容量明显低于 P50。
  - **partial 状态要外露**：`X-Ppt-Polish-Status` / `X-Ppt-Polish-Coverage` 让用户知道何时该 `refresh=1`，否则缓存命中后用户不知道"上次只跑齐了 12/13"。状态透明 = "用户能自己判断要不要再花钱"。
- **后续动作**: D 阶段已合 commit `a3ab0fb`；后续如有类似"调上游多次 + 子任务独立"场景，**默认走 merge 收敛**而非全成功门槛。把"flaky 上游的 merge 缓存"写进 `skills/L3-quality.md` 作为推荐范式。

### 2026-06-04 · 容器部署两个隐式默认坑：arch 透传 + `cp` 覆盖卷

- **日期**: 2026-06-04
- **情境**: D 阶段验证要在容器里真跑（不是 dev server），本地 `docker compose up -d --build` 起服务 + cp 本地 DB 到容器卷做演示数据。
- **观察**:
  - **隐式默认 1（arch 透传）**：`Dockerfile` `ARG TARGETARCH=amd64`，compose 默认不传 → 本地 aarch64 主机 build 出的镜像里 supercronic 仍是 `linux-amd64` 二进制，cron 容器起来立刻 `exit 139` 段错误。app 服务由于全是 JS/native 模块（QEMU 能勉强跑），假性 healthy。`TARGETARCH=arm64 docker compose build` 重 build 后 cron 才正常。
  - **隐式默认 2（cp 覆盖卷）**：`docker compose cp .data/insight.db app:/data/insight.db` 把容器里的 DB **直接覆盖**——容器原本 cron 跑出的 6 月新报告（rep_b91964bd 等 4 条）瞬间没了，被 5/28 的本地 DB 替换。后来发现要演示 6 月数据时不得不手动触发 `/api/cron`：耗时 17 min、花费 $1.85、跑 29 个 Run，才把丢的两条 6 月报告（部分）重生回来。
  - **句柄缓存放大第二个坑**：cp 完后 `getDb()` 单例还握着旧句柄，第一波请求全返 404；`docker compose restart app` 让 Next.js 重读 DB 才恢复——这是另一个"隐式默认"：单例 DB 句柄不知道文件被换了。
- **经验 / 教训**:
  - **跨平台默认值不能写死**：`TARGETARCH=amd64` 在 ARM 主机上是隐式 wrong default。要么用 `${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}` auto-detect，要么 compose `build.platform` 显式锁；ARG 默认值是"分布环境下的隐患"，**任何"在新机器跑就错"的默认值都是 bug**。
  - **`docker compose cp` 是单向覆盖、不是 merge**：默认行为对关键文件危险；操作前应 ① 先 `docker compose exec` 备份目标到容器内 `.bak`，② 或拒绝 cp 已存在的关键文件（rsync `--ignore-existing` 语义）。**ops 文档要把这条警告写明**——下次同坑成本是$1.85 + 17 分钟 + 操作焦虑。
  - **演示数据准备的 cost > 演示本身**：cp 覆盖前 5 秒的犹豫能省 17 分钟 / $1.85。"快速操作"在生产/演示场景下应该有 5 秒确认门槛——尤其涉及覆盖的命令。
  - **单例句柄要对外部文件变更可感知**：长进程 + 文件被换 = 静默 404；要么 `getDb()` 用 mtime check 失效重开、要么文档明确"换 DB 后必须 restart app"。本次按文档化处理（restart 操作明示）即可，不需要代码改。
- **后续动作**: `Dockerfile` 默认 TARGETARCH 改 auto-detect（commit 单独走）；`operations.md` §6 备份/恢复加 **"cp 进卷前必先 dump 既有数据 / 或先 backup"** 警告 + restart 步骤；`skills/L0-foundation.md` 加 "覆盖类命令 5 秒确认门槛" 微规则。

### 2026-06-04 · 反例反思：B/C/D 三个 commit 自评通过 ≠ 反证 6/01 立的 review 规矩

- **日期**: 2026-06-04
- **情境**: 6/01 复盘 typography fold 后，明确把 **"PR 提交前 spawn Sonnet R1 隔离 review"** 写进 `skills/L3-quality.md` 作为下次 PR 默认动作。随后的 B / C / D 三个 commit（`f2e0956` / `6bfcfcb` / `a3ab0fb`），**全没跑 R1**——只跑了 typecheck + 单测 + 主 agent 自评 + 端到端 probe + 用户 ack。结果没出大问题（容器部署、缓存、UI 链路都正常）。**规矩自打脸了**——但要诚实分类回答"为什么这次没出事"，而不是把"运气好"包装成"自评也行"。
- **观察**:
  - 三条新代码与 typography 那次的**性质差异**：
    - **typography fold**：涉及 byte-verbatim 契约这种**隐性语义约定** + `repairQuote` 返 `nb.slice` 弱化承诺这种**跨组件一致性 bug**——人眼审 + 单测覆盖都难抓，Sonnet R1 一眼挑出。
    - **B (LLM polish)**：写 prompt + 调用现成 `callStructured` + zod 校验 + try/catch fallback。**认知负载低**：prompt 是人眼可读的自然语言、runtime 别人写好、schema 由 zod 强制。
    - **C (API route + button)**：orchestrator 把已有片段串起来 + 标准 Next route + 客户端按钮。**结构清晰、无隐性契约**。
    - **D (cache)**：SHA-256 + UPSERT + merge 逻辑。merge 逻辑稍复杂，但 vitest 写了 4 个用例（hit / partial / refresh / merge 升级）+ 在线实测 4 步循环验通——**测试可观测性硬挡了 review 该挡的部分**。
  - 反过来想：B/C/D 真有**潜伏的设计错**未被自评抓住，是 **D 的初版严格缓存门槛**（"perInsight 全 + executive 非 null 才入"）——实测中转站现实下永不命中、缓存=没做。但这个**review 也抓不到**：要看真实运行成功率分布才显形，是数据驱动的产品决策、不是静态推理能预判的（连"上游 < 100% 稳"这个假设本身都是踩到才确认）。
- **经验 / 教训**:
  - **Review 的有效区是"可静态推理的错误"**：契约违反、命名混乱、安全漏洞、跨组件一致性、隐性约定弱化。这些 review 该抓也能抓。
  - **Review 的盲区是"需真实数据反馈才显形的设计错"**：初版缓存严格门槛、prompt 调参不对、并发上限定得太大、cost cap 设错——这类**靠跑出来 + 看分布**才暴露，不是再多一道 review 能预防的。
  - 所以**"是否跑异构 review"应按工作性质分类，不是按"是否合规"机械跑**：
    - **必跑**：涉及隐性契约（byte-verbatim / SSRF / 闸门白名单 / 数据一致性）、跨组件协调、安全敏感、改"已经被信赖"的 API。
    - **可跳**：纯 orchestration、纯 UI/路由层、有完整端到端 probe 兜底、改"全新没人依赖"的代码。
  - **但跳的时候要诚实记账**：本次"跳过 review × 3 commit + 没出事"是**带条件的样本**——条件是上面四类"可跳"匹配。**不要把它当成"自评够用"的归纳证据**——要不是 D 的严格门槛在 PPT polish 实测里立刻被砸醒，就会以"完全可用"的错觉合进 main 并影响后续 Iteration。
  - **6/01 那条规矩本身不需要改**：它说"下次 PR 默认动作"，默认动作就是 default，遇到"可跳"的明确分类时显式跳——`skills/L3` 应该补"何时可跳"的判据，让规矩长出例外维度。
- **后续动作**: `skills/L3-quality.md` 把"可跳"判据补进异构 review 那节（**契约/安全/跨组件一致性** vs **纯 orchestration/UI**）；本次反思条目本身也是个范例，下次 commit 时如果跳 review 应在 commit message 显式声明"本次跳过 R1，理由：纯 UI/orchestration、有 e2e probe"——把"跳"做成可审计动作，不是默认隐式。

### 2026-06-06 · "深度 MVP 分析 → 路径化补齐"作为一种 IPD 收口工作法

- **日期**: 2026-06-06
- **情境**: PPT A/B/C/D 子线收尾后，对"MVP 是否完整"做了次深度回扫——把 charter / product-definition 的 MVP 范围 + specs 的 AC 逐项对照实际 src/ 代码 + 看板/设置/列表 UI 实况，识别出 4-5 处中等严重度缺口（报告库无搜索/筛选/排序、设置只读、admin 无重试 + 无成本时序、主题深挖无入口、引用 [n] 无行内交互、按需触发抓取缺失）。然后用"B 路径"（4 commit · 38 测试）+ "C 路径"（3 commit · 14 测试）系统补齐 7 项缺口、每项都"API + UI + 测试 + 容器实测 + 提交"五件套收口。
- **观察**:
  - **MVP 完成"对照 spec 项"远比"凭直觉觉得跑通了"严格**：A1 验证、5/27 多源、6/4 cron 都跑通后，**直觉上"MVP 完成"**——但拉回去对照 product-definition 表格 / specs AC，发现"设置 readonly + 自注释'于后续子增量补'"、"报告库纯卡片列表无任何筛选"、"看板缺重试 / 时序图"、"主题深挖无 UI 入口"等明确写在 MVP 范围里却未做的项。**"对账"是收尾的独立动作**，不会自动发生。
  - **超 MVP 范围的事（PPT A/B/C/D）反而被先做了**：因为 PPT 是新场景、有完整端到端 probe 驱动；而 MVP 内的 UI 缺口（搜索/筛选/CRUD）是"在已有代码上加表单"——心理感觉"不够新鲜"反而被一直推迟。"**新鲜度偏置**"是 IPD 收口的隐性反向力。
  - **路径化（B-1+2/B-3/B-4/B-5）比"逐项做"效率高**：把 4-5 个缺口规划为有内部依赖关系的路径后，公共抽象（CSS .ppt-btn 系列、admin _components 目录、URL searchParams 模式、客户端 form + router.refresh、FK 友好错处理范式）只设计一次，复用 4 次。如果逐项独立做，每项都要重新发明这些。**路径化 = 公共抽象的批量摊销**。
  - **服务端组件 + URL searchParams 比客户端 state 更简洁（B-1+2 实例）**：报告库搜索/筛选用 HTML 原生 GET 表单 + Server Component 读 searchParams，**零客户端 state、零 JS、零 useEffect**，纯刷新即重渲染。比想象中省事得多——React 生态默认推客户端 state 是被 SPA 时代影响的"过度复杂化"。
  - **FK 违例的友好错处理范式（B-3 复用 3 次）**：repos.ts delete*() 直接 throw，路由层 catch 后返 409 + 中文文案"…被 X 引用，无法删除（建议改 enabled=false 停用）"。这个范式被 source/topic 删除复用、可拓展到其他实体删除。
  - **fire-and-forget 长任务用 Node runtime 是合理的（C-1）**：14-42 min 的深挖任务用 `void runPipelineForTopic(...)` 直接 fire，202 立即返；Node runtime 下事件循环会挂着 promise 直到完成（实测 21ms 后 analyze Run 落库）。如果是 Edge / Serverless 早就丢了。**这强化了 5/31 GCP 那条"架构判据 = 长任务 + 状态"的判定**——我们就是为这个选了"常驻 Node + Docker"。
- **经验 / 教训**:
  - **"端到端跑通"不等于"MVP 完成"**：前者是技术可行性证明，后者是 spec 落点对账。两者之间隔了一道"逐项对照"动作——必须显式做，不会自然发生。
  - **MVP 缺口收口要路径化、不要碎片化**：批量做 4-5 项 UI 缺口时，至少识别出 3-4 个公共抽象先沉淀，再喂给逐项。这次摊出来的：CSS button system、admin/settings _components 目录、URL searchParams 表单模式、客户端 fetch + router.refresh、FK 友好错——全是"做一项发明、做四项摊销"。
  - **"新鲜度偏置"对 IPD 收尾有害**：超 MVP 范围的事（PPT 子线）因新鲜被优先；MVP 内补缺口因"不够新鲜"被推。**收口阶段需要纪律性反偏置**——把"补齐"列入 roadmap 显式条目，按对账优先级排，而不是按"想做"优先级。
  - **HTML 原生表单仍然是好答案**：在 React Server Components 时代，URL searchParams + Server Component 是最简单的"无 state 表单"方案。reach for client state should be a deliberate choice, not a default.
- **后续动作**:
  - 把"MVP 完成 = 端到端跑通 + spec 对账"两条独立判据写进 `skills/L2-workflow.md` IPD 收口约束；
  - 公共抽象（FK 友好错 / fire-and-forget 长任务 / URL searchParams 表单）作为模式收录到 `skills/L0-foundation.md`；
  - 本次路径化补齐总计 7 commit / +52 测试 / 7 个 MVP 项闭合——作为"路径化补齐"的范例案例留档。

### 2026-06-07 · 并行 worktree 的"环境隔离 vs 数据共享"——靠配置钉死，别靠纪律

- **日期**: 2026-06-07
- **情境**: 在 `bugfix+docker` / `bugfix+collection` / `feat+deploy` 等多个 worktree 并行开发时，问"本地 docker 部署 + 数据库会不会不一致"。回扫 `docker-compose.yml` 发现 `name: deep-insight` **写死**——4 个 worktree 全解析到同一 compose 工程：容器互相顶替、共用命名卷 `deep-insight_insight-data`、3000 端口冲突。这是 [worktree 相对 DB 路径陷阱] 的同源新变体（上次是 .env.local 没钉绝对 DB_PATH，这次是 compose 工程名没隔离）。
- **观察**:
  - **同一类坑第二次踩**：上次结论就是"能用配置钉死的别靠记性"，这次又出现"靠约好只在一个 worktree 起 docker"的诱惑。**约定型纪律对这类并发隔离问题必然失效**——会忘。
  - **关键技巧 = 把"隔离"与"共享"解耦**：compose 工程名按 worktree 分（`COMPOSE_PROJECT_NAME` 环境变量可覆盖文件里写死的 `name:`，实测优先级成立）→ 容器/卷天然隔离；要共享数据则单独走"外部卷 / 快照"，不靠同名硬绑。
  - **`COMPOSE_PROJECT_NAME` 必须放 compose 目录的 `.env`，不是 `.env.local`**：后者是 `env_file:`，只注入容器内部环境，compose 解析工程名时根本不读。这点不踩对，改了也没用——是个隐性的"两个 .env 各管一段"认知陷阱。
  - **共享 live SQLite 库是反模式**：跨分支读写同一库 → 写锁竞争（SQLITE_BUSY）+ 迁移漂移（A 分支迁移、B 旧代码崩）。最佳实践是**共享"配方"（不可变快照 / seed）不共享"做好的菜"（live 文件）**——各 worktree 起独立库、从同一快照恢复成共同起点，之后各自漂移互不影响。
  - **本仓库迁移是纯增量的（ensureColumn 只 ADD COLUMN IF NOT EXISTS）**，把"漂移"风险压低一大半——旧代码读到多几列的库通常没事，只有删列/改约束才真崩。这降低了"必须严格隔离"的压力，但不改变结论。
- **经验 / 教训**:
  - **并发隔离问题的判据：能用配置/路径钉死的，永远别留给纪律。** 第二次同源踩坑印证这条该升级为硬规矩，而不是 case-by-case。
  - **"环境隔离"是特性不是缺陷**：12-factor 的 dev/prod parity 要求每个开发环境独立可丢弃——一个分支的迁移/脏数据绝不该污染另一个分支的验证。要的恰恰是"互不一致"。
  - **数据是产物不是真相来源**：真相 = 代码 + seed/迁移；库文件只是其缓存。只要 seed/快照能重建已知状态，"跨 worktree 数据一致"就是伪需求。
  - **真共享可变状态只在 staging/生产级用真 DB server（Postgres）**，绝不在开发机跨 worktree 挂同一 SQLite 卷——那是过度工程。
- **后续动作**: 已落地（commit `e51c798`）：compose 端口参数化 + `.env.compose.example`、`busy_timeout=5000`、`ops/db-snapshot.mjs`+`db-restore.mjs`（VACUUM INTO 快照/恢复）。判据"并发隔离靠配置不靠纪律"已补进 `skills/L0-foundation.md`。
- **补记（同日演进，commit `5fc32b8`）**: 初版隔离是"每 worktree 手动建 `.env` 设 `COMPOSE_PROJECT_NAME`"——仍是"靠记得建文件"的弱纪律。进一步删掉 `docker-compose.yml` 写死的 `name:`，让工程名回落目录 basename → **worktree 零配置自动隔离**（"危险的事默认不发生"，比"手动隔离"更彻底）。代价是默认行为翻转：**权威/生产实例**（拥有真数据）反过来须显式钉 `COMPOSE_PROJECT_NAME=deep-insight`，否则换目录跑回落新工程名→挂新空卷→孤立数据（同款"worktree 空库"陷阱，主体换成"该稳定的实例"）。**教训升级**：隔离的最优解不是"让每个环境记得声明隔离"，而是"让隔离成为默认、让少数需要稳定的实例显式声明稳定"——把显式声明的负担放在"少且固定"的一侧。实测 `bugfix+docker`→`bugfixdocker_insight-data`、主 worktree 仍 `deep-insight_insight-data`（与运行中容器卷一致，数据安全），并排实跑两套四维隔离验证通过。
