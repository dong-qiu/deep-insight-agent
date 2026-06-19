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

### 2026-06-07 · 安全关键路径的缓存：两轮独立 review 才收敛 + 一份可复用的不变量清单

- **日期**: 2026-06-07
- **情境**: 无直连 key 条件下给 validator 降本，做"跨批一致性判定缓存"（`(statement, body) → Opus 判定`持久化复用）。功能单测全绿、自评通过后，提交前连跑两轮独立 `/code-review`（每轮 5–7 个并行 finder agent）。
- **观察**:
  - **第一轮**就否掉了"看起来没问题"的设计：① 缓存写在 judge 的 `try` 内 → 一次 DB 抖动会把**已成功**的判定误降级为"校验失败"；② key 不含模型/prompt 版本 → 改模型（我正好在 eval 里把 validator 从 opus-4-7 换 4-8）后旧判定**永久命中**，安全 prompt 加固被静默绕过；③ 首写定 + 无 TTL → 偶发错判被永久冻结，"重跑可纠错"这条补救被缓存废掉。这些单测和作者自评都没抓到——**因为它们不是"代码错"，是"安全语义错"**。
  - **第二轮**（硬化后再审）主体判 clean，但仍捞出 4 个边角真问题：`Number("Infinity")` 漏过 `|| 14` 把 TTL 算成 `-Infinity days` → SQLite 返 NULL → 缓存静默失效；`VALIDATOR_THINKING`（运维精度旋钮）没进版本 key；缓存 `uncertain`（最易翻转的边界判定）冻结"待核实"；版本churn 死行无回收。
  - **信噪比逐轮下降**：R1 = 安全语义级硬伤，R2 = 配置边角 + 旋钮遗漏，符合"结构 → 精度 → 边界"的收敛梯度（与 2026-05-21 条一致）。两轮后判定收手。
  - 顺带一个纯技术坑：schema 注释里写的 `\x00`，在 **JS 模板字符串**里成了真 NUL 字符，传给 SQLite C API 被当**字符串终止符截断 SQL** → 其后的建表被静默吞掉、`db.exec` 不报错。表"死活建不出来"查了一轮才定位。
- **经验 / 教训**:
  - **"安全关键路径上的缓存"是独立的高危类别**，不变量比普通缓存多一截。沉淀成可复用清单（下次任何安全判定要缓存先过一遍）：① 只缓存成功，失败/瞬时错绝不入；② key 含**所有影响判定的输入**——模型 + prompt + 关键运行旋钮（不只是业务数据）；③ TTL 给"重跑可纠错"留出口，别永久冻结；④ 写失败不能污染判定（写在判定 try 之外 + 自身 swallow）；⑤ 留运维总开关；⑥ 边界/易翻转判定（uncertain）考虑不缓存。
  - **单测证明"代码不破"，独立 review 才抓"语义错/盲点"**——尤其作者就是写代码的 AI 时，自评天然顺着自己的设计逻辑走，隔离 review 是唯一外部视角。
  - **降本动作撞安全红线时，先问 ROI 配不配得上风险**。这个缓存 ROI 有限（只帮重跑/重生成），是 review 让我把"要不要做"重新摆上桌（差点该撤），最终选择"硬化后保留"。
  - 技术坑记一笔：**转义序列（`\x00`/`\0`/`\n`…）在传给 C-API 的字符串里要警惕 NUL 截断**；SQL/DDL 放进模板字符串时，注释也是字符串的一部分。
- **后续动作**:
  - 把上面「安全缓存不变量清单」纳入 `skills/L3-quality.md`（与已有的对抗式 review 规矩并列）。
  - `\x00` 截断坑 + "slice() 当 parser"/"字符串字段当时间排序"（dogfood-log 已记）一并进 `skills/L0-foundation.md` 的反模式清单。

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

### 2026-06-08 · `docker compose up -d` 不带 `--build` 用旧镜像——配置改对了、代码还是旧的

- **日期**: 2026-06-08
- **情境**: 把新做的多渠道失败告警接进生产：`.env.local` 填好飞书 `ALERT_WEBHOOK` → `docker compose up -d` → 容器内跑 `probe-alert.mjs` 验证。
- **观察**:
  - 探针输出是**旧版格式**（`📡 POST →` / `payload.text` / "去浏览器看 webhook.site"），不是新版的 `渠道识别 = feishu` / `飞书 code=0`。`up -d` 只**用缓存镜像 `deep-insight:0.1.0` 重建容器**，没重新构建——容器里还是 adapter 之前的旧代码。
  - 更阴险的是**假成功**：旧代码把 Slack 形状 `{text}` 发给飞书（飞书要 `{msg_type,content}`），飞书回 **HTTP 200 但 body 带错误 code**，旧探针不解析 code、只看 200 就报"成功"，还提示去 webhook.site（与实际用的飞书渠道完全无关）。手机其实没收到。
  - 修复 = `git pull && docker compose up -d --build`：先把生产 checkout 的 `main` 拉到最新（含 adapter），再**重建镜像**。重跑探针 → `渠道识别 = feishu` + `飞书 code=0 success` + 手机可达，闭环真正打通。
- **经验 / 教训**:
  - **`up -d` 改的是"容器实例 + 运行时 env"，`--build` 才改"镜像里的代码"。** 只改 `.env.local` / compose 配置 → `up -d` 够；动了应用代码 → 必须 `--build`（或先 `compose build`）。这是"配置 vs 制品"两个生命周期，混淆就会"配置对了、行为没变"。
  - **镜像是从源码 checkout 构建的——`--build` 前先 `git pull`**，否则重建的还是旧源码。生产 checkout 的本地 `main` 不会因 `push origin main` 自动前进，得显式拉。
  - **"HTTP 200"在跨服务调用里不等于成功**——这正是上一条加固 `probe` 解析飞书 `code` 的价值；但前提是容器跑的是**新** probe。旧 probe 的 200-假成功 + 误导提示，恰好演示了"陈旧制品"如何把一个已修好的诊断能力又藏回去。
- **后续动作**: 把"改代码必 `--build`、`--build` 前先 `git pull`"补进 `docs/launch/operations.md` 部署/升级章节（§8 升级）；与已有的"`next build` 绿 ≠ 容器能跑""容器部署两个隐式默认坑"同属"容器制品的隐式默认"系列。

### 2026-06-11 · 追问（A4）实跑：设计文档的性能/成本数字是假设，实跑才暴露真瓶颈

- **日期**: 2026-06-11
- **情境**: 新做的"报告页内追问"功能，spec 写明性能"~5-10s、便宜"。落地后对真实库里一份深度报告（`rep_a99a6530`，30 条洞察）实跑一个跨洞察问题，并做了三轮模型/并发对比（写了一次性 dogfood 工具 `evals/run-followup.ts`，对真实库 + relay 直跑 `answerFollowup`，绕开 Next/鉴权）。
- **观察**:
  - **设计估计与实测差一个数量级**：实跑 opus 生成 162.9s/\$0.93、sonnet 生成 93.1s/\$0.56——离"5-10s/便宜"差远了。spec 里那个数字是**拍脑袋的假设**（隐含前提：sonnet 生成 + 缓存命中 + 少量引用），从没被任何真实运行验证过。
  - **换模型不是主矛盾**：opus→sonnet 只省了生成那一小块（~\$0.37）；两轮校验数字完全相同（`9/8/8/1/0`），因为 9 个一致性判定走的都是 opus-4-8。**成本/延迟的大头是一致性判定，不是生成。** 换生成模型治标。
  - **并行化砍延迟、不砍成本**：把 8 个串行 judge 改 `Promise.all` → 93s 降到 51.4s（−45%，符合预期）。但同轮成本反而 \$0.56→\$0.78——**不是并行造成的，是生成非确定性**：这轮模型多吐了几条 claim，每条 claim = 又一次判定。并行只动延迟轴，成本轴纹丝不动。
  - **真正的成本根因要实跑 + 看具体数据才看得见**：这份报告 [12]–[21] 这 8 条引用**几乎全来自同一篇 latent.space 长文**（一个 content_item）。而实现是"按 claim 逐条判定" → **同一篇长文被重复发了 8 次**给 8 个独立 judge（161k token 的来源）。光看代码不易警觉，是"真实报告恰好高度单源聚集"这个数据特征把它放大出来的。
  - **结构性护栏复现稳定**：三轮都 `total=9 reachable=8 blocked=1`——同一个被模型编造的、不在引用池里的 ref 号每次都被 ref-in-pool 抓出剥离。可溯源红线（"展示出来的引用必有效、编造引用进不来"）在真实数据上守住了。但代价是被剥离的那条论断在正文里变成**裸事实句**（无 [n]），可溯源覆盖非 100%——轻校验只管"挂出来的引用"，不强制每句带引用。
- **经验 / 教训**:
  - **spec 里的性能/成本数字，在第一次真实运行前都该标记为"假设"而非"指标"。** 把它当 AC 验收会骗自己。dogfood 一次真实（且数据分布有代表性的）报告，比任何纸面估算都准。参见 [[validator-uncertain-storms]]：同样是"实锤重跑才看清真相"。
  - **优化要分轴：延迟轴 vs 成本轴正交，别用一个手段假装解决两个。** 并行化是延迟解，按 content_item 归并判定（源文只发一遍）才是成本解。混着谈会得出"并行化怎么没省钱"的错误困惑。
  - **成本根因常藏在数据分布里，不在代码里。** "逐 claim 判定"代码上看着合理，是真实报告的"单源高度聚集"特征把重复传输放大成主成本。**审视成本必须拿真实数据跑、看 per-call 明细，不能只读实现。**
  - **轻校验的可溯源是"结构性 + 展示层"保证，不是"逐句"保证。** 护栏拦住了假引用，但裸事实句这个缺口是这套设计的已知代价——dogfood 把它从"纸面开放问题"变成"亲眼所见"，该不该补要按真实使用频率决定。
- **后续动作**: 已做：一致性判定并行化（延迟 −45%）+ 生成默认回落 sonnet（relay 已验证支持）。待评估（按真实使用决定优先级）：① 按 `content_item_id` 归并判定（同源 claim 合一次调用、源文发一遍）——预计把 token 砍到接近 1×源文，是最大成本杠杆；② 裸事实句补标〔未独立核验〕收口可溯源缺口；③ 把"spec 性能数字 = 假设、须 dogfood 实测验证"补进 `skills/L3-quality.md`。

### 2026-06-13 · 长 fire-and-forget 管线别在 `next dev` 里跑——HMR 重启把 in-flight Run 误判 orphaned

- **日期**: 2026-06-13
- **情境**: 验证新做的"实体追踪"端到端点亮，需产一份新报告。第一次走 `next dev`（:3007）的 HTTP 端点 `POST /api/topics/[id]/deep-dive`（202 fire-and-forget）触发深挖管线（analyze→validate→report-gen，5–15 分钟）。
- **观察**:
  - 管线 `analyze` 跑到 **118s 时被标 `failed`**，错误是 `OrphanedOnRestart`（"进程重启时该 Run 仍在 running，无法继续"）。不是模型/relay 出错——是 `next dev` 在期间**热重载/重编译**，重启了持有 DB 单例的模块，`openDb` 路径上的 `recoverOrphanedRuns` 把所有 `running` 的 Run 一律标 failed（它的设计本意：进程崩溃后清理孤儿 Run）。
  - 改用**独立 tsx 脚本**直接 `import { runPipelineForTopic }` 跑同一管线（同 env + 钉绝对 `DB_PATH`），**无 Next、无 HMR、无 HTTP**——一次跑通：`rep_0a4bc9c3`，31 洞察/79 引用，实体抽到数十个，主题页渲染 15 标签。
  - 残留：`/admin` 会看到那条 `OrphanedOnRestart` 的失败 analyze Run（无害，但会污染"失败率"观感）。
- **经验 / 教训**:
  - **`next dev` 是为"请求—响应 + HMR"设计的，不是为分钟级后台任务。** 它会在文件变更/路由编译时重启 server 模块；任何"先返回 202、再后台慢慢跑"的进程内任务都可能被腰斩。`recoverOrphanedRuns` 这种"重启即清孤儿"的健壮性机制，在 dev 的频繁重启下反而成了"误杀正在跑的活"。
  - **验证长管线的正道：脱离 dev server。** 要么独立 tsx 直调函数（最快、最干净，绕开 HTTP/鉴权/HMR），要么 `next build && next start`（无 HMR 的生产模式）。这与 [[validator-uncertain-storms]] / 追问实跑同源——**真实验证要用贴近生产的运行方式，dev 模式的便利会引入假象**。
  - **fire-and-forget 在单进程 dev 下是双重脆弱**：调用方拿到 202 就走人，进程一重启，任务静默死亡且只在 DB 留一条 failed Run——不盯 `/admin` 根本不知道。生产是容器常驻进程、无 HMR，所以这是 **dev-only 陷阱**，不是管线 bug。
- **后续动作**: 已用独立 tsx 完成验证（脚本一次性、跑完即删）。建议把"长管线/定时任务验证须脱离 `next dev`（独立 tsx 或 `next start`）"补进 `skills/L3-quality.md` 或 `operations.md`，与"`next build` 绿 ≠ 容器能跑"同属"运行方式差异致假象"系列。`/admin` 的 `OrphanedOnRestart` 残留 Run 可手动重试或忽略。

### 2026-06-13 · 飞书"关键词"安全模式静默吞掉新类型告警——HTTP 200 ≠ 送达

- **日期**: 2026-06-13
- **情境**: 给 EC2 部署数据陈旧 watchdog 后，飞书账号被删需换 webhook。换好后逼出一条真陈旧告警测试，
  app 日志显示"已触发"、飞书返 HTTP 200，但**手机没收到**。
- **观察**:
  - **根因 = 飞书机器人关键词模式 + 应用层静默拒绝**：直接探机器人响应体——`{"code":19024,"msg":"Key Words Not Found"}`（HTTP 仍 200）。机器人安全设置是"关键词=Run"；**失败告警**标题「🔴 Run 失败」含 Run 能过，我新加的**陈旧告警**「🟠 数据陈旧」不含 Run → 被飞书应用层拦掉。
  - **代码真 bug：`sendAlert` 只看 HTTP 状态、不解析 body `code`** → 19024 被当成"发送成功"。讽刺的是 practice-log 早有"HTTP 200 ≠ 成功"这条（2026-06-08 飞书 probe），但只落实在 probe 脚本里，**告警发送主路径自己没落实**——同一教训在不同代码点要各自硬化，写进文档 ≠ 写进所有相关代码。
  - **加新"告警类型"会悄悄违反既有渠道安全约束**：关键词模式把"能否送达"耦合到了"消息文本含不含关键词"。当初只有失败告警时关键词=Run 工作良好，新增类型时没人想到它得也含 Run。**新增告警类型必须对照渠道安全配置自测一遍真实送达，不能只看 HTTP 200。**
  - **加签 > 关键词（多类型告警场景）**：改用「加签」后任何文本都能发（解耦内容与送达），用 `buildFeishu` 同款签名算法实测 `code:0 success`。关键词模式天然脆——每加一种消息就多一个"忘带关键词"的坑。
- **经验 / 教训**:
  - **"HTTP 2xx ≠ 业务成功"对任何返 200-on-error 的 webhook 都成立**——必须解析应用层响应码。已把该判定下沉进 `sendAlert`（`appLevelError`：飞书 code≠0 → warn），让静默失败变可见。
  - **同一类教训要在所有相关代码点各自硬化**，别指望"文档记过"就免疫；probe 验过的，发送主路径也得验。
  - **告警自身要可观测**：告警系统静默失效是最坏的盲区（它本就是兜底层）。warn 日志是底线，理想还应有"告警发送成功率"指标。
  - **安全模式选型影响可维护性**：加签对"多消息类型 + 经常演进"的系统比关键词更省心。
- **后续动作**: 已做：`sendAlert` 解析飞书 `code`（+6 单测）；EC2 机器人换加签、配 `ALERT_FEISHU_SECRET`、删关键词，实测加签送达 code:0。待评估：告警发送成功率指标（observability）。

### 2026-06-13 · worktree 跑 dev 读到空库——env 文件的"双重身份"与放置目录

- **日期**: 2026-06-13
- **情境**: 在 `feat+mvp-final` worktree 里要"本地开发、云上部署"的最佳实践，顺手验证从这个 worktree 跑 `npm run dev` 报告能否读到。这是 [worktree 相对 DB 路径陷阱]（2026-06-04）与 [worktree 环境隔离 vs 数据共享]（2026-06-07）的第三次同源复现。
- **观察**:
  - **默认 DB 路径是相对 cwd 解析**：`getDb()` 用 `process.env.DB_PATH ?? ".data/insight.db"`、`DATA_DIR` 同理（`src/lib/db/index.ts`、`collector.ts`、`reports.ts` 三处）。从 worktree 跑 dev，`.data` 落到 worktree 根（无库）→ better-sqlite3 **现造空库** → `/api/health` 返 `reports:0`，报告"消失"假象；真库（含 8 条报告）在主仓 `.data`。
  - **`.env.local` 是"双重身份"文件，钉绝对路径会撞车**：它既被 `next dev` 加载，又被 `docker-compose.yml` 的 `env_file: [.env.local]` 读。若按老办法把宿主机绝对 `DB_PATH/DATA_DIR` 写进 `.env.local`，本地 `docker compose up` 时容器会继承 `/Users/...`（容器内不存在）、**覆盖 Dockerfile 的 `DATA_DIR=/data`** → 容器跑挂。解法：路径放 **`.env.development.local`**——`next dev` 优先加载它，而 compose 的 `env_file` 看不见它，两条路径天然隔离。
  - **env 文件必须放在实际 `npm run dev` 的目录（worktree 根），不是主仓根**：第一次我把 `.env.development.local` 建到主仓根 → 不生效、照样现造空库。`next dev` 的 cwd 是 worktree，只加载 worktree 根的 env 文件。`lsof -p <pid> | grep insight.db` 一眼看出进程打开的是哪个库。（讽刺的是收尾追加本条 practice-log 时又踩同款"主仓 vs worktree 路径"坑——Edit 误落主仓副本、worktree 没改，靠 `wc -l`/`grep` 跨两副本对比才发现。**绝对路径省心但要认准是哪个工作树的副本**。）
  - **验证读到的是"活库"而非快照**：验证中报告数从 7→8，追因是**另一个 worktree 同时跑了深挖任务**写进同一主库——反向印证了"多 worktree 钉同一主库、共享生产数据"确实生效（也提醒 SQLite 单写者模型下并行重度写可能撞 `SQLITE_BUSY`）。
- **经验 / 教训**:
  - **"环境隔离靠配置不靠纪律"的延伸：配置项要放在与其作用域匹配的文件层**。DB 路径只对宿主 dev 有意义 → 放只被 dev 加载的 `.env.development.local`；放进被 dev + compose 共用的 `.env.local` 就是把作用域搞混、必然撞车。一个配置文件被两套运行时共用时，先问"这个值对每套运行时都对吗"。
  - **相对路径 + 多 cwd（worktree）= 反复踩的结构性坑**。同一相对 `.data/insight.db`、同一相对 `docs/practice-log.md` 在不同 cwd/工作树指向不同副本。多次复现（相对 DB 路径 / compose 工程名 / env 文件放置 / 文档副本）都是同一根：**把"当前在哪个工作树"隐式带进了行为**。绝对路径解决"读哪个库"，但反过来要时刻认清"在写哪个工作树的文件"。
  - **验证要查到"进程实际打开的资源"那一层**：`/api/health` 的计数 + `lsof` 实际文件 + worktree 下没冒出新 `.data`，三者交叉才算证实，光看接口返回数可能被空库的"0"或缓存骗。
- **后续动作**: 已做：worktree 根建 `.env.development.local` 钉绝对 `DB_PATH/DATA_DIR` 回主仓（`.env.*` 已 gitignore），实测 `reports:8` + `lsof` 确认打开主仓库；更新记忆 [worktree 相对 DB 路径陷阱]（改用 `.env.development.local`、强调放 worktree 根、补验证法）。待评估：把"worktree 跑 dev 前钉 DB 路径"做成 worktree 初始化脚本/checklist，免每次手动建文件（同 06-07"让隔离成为默认"的思路——理想是新 worktree 自动具备指向主库的 dev 配置）。

### 2026-06-14 · 文档写的"限制根因"未必成立——读代码才发现成本由 item 上限封顶、窗口可放心放宽

- **日期**: 2026-06-14
- **情境**: 收尾 MVP 差距分析时，唯一剩下的功能缺口是 deep_dive 报告（mvp-gap §一.4 / issue #19）：默认窗口 14 天 ≠ spec 的 90 天，版式两节 ≠ spec 六段。gap 文档对窗口偏离给的判断是「**根因可能是成本**（90 天 × 多源易超 25 条 item 上限 / 超单轮成本），但代码未写明取舍」——把"成本"当成了保留 14 天的隐含理由。补 #19 前先去代码里求证这个"根因"是否成立。
- **观察**:
  - **"成本根因"经不起读代码**：`runPipelineForTopic` 里 `selectAnalysisItems(db, topic, { since, limit: itemsLimit })`——窗口只决定 `since`（候选起点），**真正喂给 LLM 的条数由 `DEEP_DIVE_ITEMS`（默认 25）封顶**。`selectAnalysisItems` 先取候选池（≤800，内存子串打分、廉价）再 `rankAndDiversify` 截前 N。即：90 天窗口 + 同样 25 条上限 ≈ 从更长跨度里选最相关的 25 条，**analyze/validate 的成本（=喂进去的 item 数）基本恒定，不随窗口线性涨**。文档假设的"90 天 × 多源 → 超成本"在代码层根本不成立。
  - **旧 14 天反而有害且无收益**：窄窗口把两周前的重要研究（arXiv 等慢节奏源）挤出候选池，ranker 根本看不到它——既没省成本（成本本就由条数封顶），又损失了"深度综述"该有的时间跨度。一个"省成本"的限制，实际上零省、纯损。
  - **真机预览印证版式才是主缺口**：拿真实库里那份被 gap 文档点名的"174 引用的墙"（batch_ecfa320f，58 洞察/174 引用），用新代码 `buildReport` 以 deep_dive 重渲染（确定性模板、**零 LLM 成本**），六段（TL;DR/概览表/趋势/时间线/详版）一次成型。无需花一分钱 API、无需起服务，就在真实数据上看清了"改造前后"。
- **经验 / 教训**:
  - **文档里写的"限制 / 取舍的根因"，和 spec 的性能数字一样，在求证前都只是假设。** 这是 [[2026-06-11 追问实跑]] 那条"设计文档的数字是假设"的同构延伸：那条说的是**性能/成本数字**要实测，这条说的是**"为什么这么设计"的归因**要读代码验证。一句"根因可能是成本"被后人当事实接受，就会把一个零收益的限制一直留着。**遇到"因为 X 所以只能这样"的注释/文档，先问 X 在代码里成不成立。**
  - **成本的真实驱动量要定位到"喂给模型的是什么、有多少"**：这里是 item 条数（`DEEP_DIVE_ITEMS`），不是时间窗口。与 06-11"成本大头是一致性判定不是生成、且藏在单源聚集的数据分布里"同一方法论——**审成本必须顺着数据流找到真正进 LLM 的那一坨，别被表层参数（窗口/模型名）带偏。**
  - **确定性模块给了"零成本真机验证"的杠杆**：report-gen 刻意做成无 LLM 的纯函数，使得"在真实库存数据上重渲染看效果"成为可能——不必跑 ¥14–26 的全链路深挖就能验证版式改造。**把确定性与 LLM 调用分层，回报之一就是验证廉价。** 设计期的这个选择，在收尾验证时兑现成真金白银的省钱。
- **后续动作**: 已做：窗口默认 336→2160（90 天，注释写明"成本由 item 上限封顶、与窗口解耦"的取舍）、deep_dive 补结构化六段 + 自研 markdown 加 GFM 表格、HTML 引用接 lookup + URL scheme 守卫；ADR-0004 记录；真机零成本预览验证版式（#21/#22 已合入，issue #19 闭合）。待评估：①一次真实 90 天深挖验证"窗口效果 + 时间线真实铺开 + 触顶熔断"（约 ¥14–26，需 relay key）——版式已验、唯窗口的内容面效果待真机；②把"文档/注释里的归因须读代码求证，别直接当事实接受"补进 `skills/L3-quality.md`，与"spec 性能数字=假设"并列。

### 2026-06-15 · MVP 收尾：「待验证条件」多半是文档滞后或归因错位——去现场核验，要么已满足、要么可换路闭合

- **日期**: 2026-06-15
- **情境**: 从"和 MVP 相比还缺什么"出发，识别出 4 项 M4 待验证条件（被挡源复测 / 定时 eval 的 relay 可达 / 成本定稿 / 生产域名 TLS），逐项收尾。4 项里没有任何"功能没做"，全是验证 / 运维 / 归因类收尾。
- **观察**:
  - **roadmap 的"待办"标记滞后于现实，关条件前先去现场核验当前状态**：文档写"待用户配 repo secrets"，`gh secret list` 一查——`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` + 模型 vars 早在 2026-06-07 就配齐；被挡源标"容器→境外网络层不通、待复测"，SSM 进生产容器查 DB——三源 `enabled=1` 且 06-13 cron 轮全 `done` 持续采集。两处都是"文档说待办、现实已满足"，差点照着文档去做已经完成的事。
  - **CI 红 X 未必是真失败，要看清失败的语义**：eval 冒烟设 `consistency_limit=1` → 只抽到 1 组正例标注对 → 负例样本=0 → 负例召回 0/0=0% 踩 ≥95% 门 → job 红。但同表其余 6 指标全 PASS，脚本自标"⚠️ 子集冒烟模式不代表 A1 结论"。**红的根因是"该指标定义在 n=1 子集下无意义"，不是回归。** 而那次冒烟恰恰证实了最该证的事——GitHub 境外 runner 经 relay 实发 16 次调用全成功（$0.757），即 relay 可达。验证最贵的不是跑，是误读结果。
  - **OR 条件 + 卡 key 子项 = 换条路签字，别让一个外部依赖卡死全局**：成本条件本是"口径定稿 / Sonnet 降本"二选一；只有 Sonnet 降本和 Anthropic 列表价干净测算卡直连 `sk-ant-` key，且都是优化。口径定稿不卡 key（阈值 2026-05-27 已重标 + 预算熔断 ADR-0003 在线 + 这次又拿到 relay 实账锚点 $0.757≈¥5.4 落在区间内）。一个 key 缺失只该挡住优化，不该挡住签字。
  - **两条独立证据交叉才算证实**：被挡源用"容器内实时 `fetch` 200 + 有效 RSS"和"DB 近期 ingest 全 `done`"两条互不依赖的线；成本用"重标阈值"和"relay 实账"两个来源。单看任一条都可能被假象骗（fetch 通但库里没存 / 阈值定了但实际更贵）。
  - **worktree 文档副本坑又双叒复现**：第一次 Edit roadmap 用了主仓绝对路径，改动落进主仓 `main` 而非 worktree，靠 `git status` 空 diff 才发现，再用 `git diff > patch` + `git apply` 搬回 worktree。正是 [[2026-06-13 worktree 跑 dev 读到空库]] 那条"绝对路径省心但要认准是哪个工作树的副本"的第 N 次同源复现。
  - **SSM + 容器内 node 模块解析坑**：把查询脚本写到 `/tmp/q.js` 跑 → `Cannot find module 'better-sqlite3'`；因 `require` 按**脚本所在目录**（/tmp）向上找、不按 cwd，而 `node -e` 按 cwd（/app=WORKDIR）解析所以能找到。修法 `NODE_PATH=/app/node_modules` 或脚本放 /app。小坑，但"`node -e` 能跑 ≠ 同代码写成文件能跑"值得记。
- **经验 / 教训**:
  - **收尾阶段的"差距清单"本身要被验证，不能照单执行。** 这是 [[2026-06-14 文档写的限制根因未必成立]] 的同构延伸——那条把"文档归因"推到"读代码求证"，这条再推一层到"读真实环境状态（DB / repo settings / 生产容器）求证"。roadmap / gap 文档是过去某刻的快照；关条件前先问"现在真实状态是什么"，常发现要么早已满足、要么根因已变。**对收尾清单的第一动作是核验，不是执行。**
  - **关一个条件最便宜的方式往往不是"做完它"，而是"正确分类它"**：4 项里真正动手做的只有补 2 个告警 secret；其余靠核验现状（2 项已满足）、重新归类（成本=换 OR 分支闭合、域名=用户决策推后为 post-MVP）就关掉了。**会签字 ≠ 把每件事做完，而是分清门与非门、满足与待办、必做与可选优化。**
  - **每个验证产物要连同"它为何看起来失败 / 成功"一起解释**：一个红的冒烟 job、一个 200 的 fetch，孤立看都会误判；必须把语义（子集伪失败 / 还要看库里存没存）写进结论，否则后人（含未来的自己）又被表象带偏——这也是上一条"红的根因"要写进 PR/roadmap 而非只标"已闭合"的原因。
- **后续动作**: 已做：被挡源 SSM 复测闭合（#24）、eval relay 可达实测 + 补 `ALERT_WEBHOOK`/`ALERT_FEISHU_SECRET`（#25）、成本口径 relay 实账定稿 + report-generation AC9 旧阈值对齐（#26）、部署上线标 `[x]` + 域名按用户决策推后 post-MVP（#27）；4 项 M4 待验证条件全部闭合或显式降级，worktree 清理。每个 PR 走独立 review→CI→squash 合并→删分支。待评估：把"收尾'待办'先核验现状再动手、分清门与非门"提炼进 `skills/L2-workflow.md`，与"文档归因须读代码求证"成系列方法论。

### 2026-06-15 · 把"门"写进规范前，先验证平台能否强制——否则把纪律误记成硬约束

- **日期**: 2026-06-15
- **情境**: 讨论"main 开 GitHub 分支保护对工作流的影响"。先把"走 feature → PR、不直推 main"写进 `skills/L0-foundation.md`，措辞写成"不直推 `main`（**直推会被拒**）"。随后用户要求用 `gh api` 把保护规则真正写上去。
- **观察**:
  - **"会被拒"是落地前没验证的假设，且是错的**：真去 `PUT /repos/{owner}/{repo}/branches/main/protection` → `403 "Upgrade to GitHub Pro or make this repository public to enable this feature."`；退而试新版 Rulesets API（`/rulesets`）→ **同样 403**。即 **private 仓 + 免费计划下，classic branch protection 与 Rulesets 都不可用**（需 GitHub Pro，或将仓转 public）。我写"直推会被拒"时把"打算开的保护"当成了"已生效的强制"，而平台当前根本不拦直推。
  - **一个"门"有两层，别混为一谈**：策略层（规范里写"不许直推"）与强制层（平台是否真拦）。我把策略误当强制，文档因此过度承诺。修正后明确标注：当前是**纪律门、非平台硬门**——靠 commit-review 自觉，直推技术上不会被 GitHub 拦。
  - **做不到时最有价值的产出是"摆清选项给决策"，不是硬上**：把三条出路（升级 Pro / 转 public / 维持纪律门）连同代价摆给用户选；用户选维持纪律门。这是 [[2026-06-15 MVP 收尾]] "正确分类 > 强行执行"在工具层的又一次体现——关掉这个需求最便宜的方式是"如实归类成纪律门 + 留好升级后的开启基线"，而不是想办法绕开 403。
- **经验 / 教训**:
  - **凡写进规范的"约束 / 门"，落地前要验证执行机制是否真存在。** 这是 [[2026-06-14 文档写的限制根因未必成立]] / [[2026-06-15 MVP 收尾]] "文档=假设，求证"系列再延伸一层：前两条求证的是"性能数字""设计归因""环境现状"，这条求证的是**"作者自己刚写下的约束，平台能不能强制它"**。新写的断言同样是假设，尤其带"会 / 必然 / 会被拒"这类强制语气的描述——最容易在没验证时被当成既成事实。
  - **policy 与 enforcement 要在文档里如实分开标注**：纪律门本身有价值（独立 review + 绿 CI 本就把问题挡在 main 外），但若不写明"靠自觉、非平台强制"，后人（含未来的自己）会误以为有硬拦截而松懈。修正后的 L0 既保留策略（不直推），又点明强制层缺失 + 升级后的开启基线，两层都说清。
  - **"计划档位能力"是隐性架构约束**：免费计划的 private 仓没有分支保护，和此前抓到的"Vercel serverless 文件系统是临时的"、"中转站不认某 SDK 字段"同类——**边界写在平台文档 / 计费档位里、撞上才知道**。写流程 / 选型时要把"当前计划能开什么"也当作约束输入，别假设付费档功能默认可用。
- **后续动作**: 已做：L0 改为"走 PR、纪律门"并删除错误的"会被拒"，附升级 Pro 后的开启基线（API 路径 + 必需状态检查为 `ci.yml` 两个 job `typecheck · test · build` / `docker build` + approvals=0 + 禁 force push/删除 + 留 admin bypass + strict 不开）；两处文档改动各走独立 review→PR→CI 绿→squash 合并→删分支（#30 / #31）；项目记忆同步标注"强制保护当前不可用、纪律门"。待：升级 GitHub Pro（用户决策）后按基线一条命令写上保护。

### 2026-06-15/16 · MVP 真机收口：合入 main ≠ 上线；以及自己埋进仓库的 node_modules 软链坑

- **日期**: 2026-06-15 / 16
- **情境**: 收口前对 gap 文档里一批"待真机验证"项（成本熔断 / 六段 / 报告推送 / hover / 筛选）逐项上生产 EC2 验证；最后 DCP-4 收口前清理 worktree 时发现 `git status` 不干净。
- **观察**:
  - **合入 main / CI 绿 ≠ 上线——真机验证第一步是核对部署版本**：触发的第一次深挖产出的是**旧两段式**报告（白花 ~$5.5）。一查生产镜像 build / 源 mtime 停在约 06-13，而六段（#19）、hover（#18）、筛选（#33/#36）都是 06-14/15 才合入 main。生产是 `deploy.sh` 手动 rsync+build、无 CD 跟 main，所以"main 有"不代表"生产有"。**在旧代码上验新功能 = 必然得出错误结论。** code-only 重部署（SSM 隧道 + rsync + `docker compose up --build`，保留生产 `.env.local`）后才验成。教训入 memory [[verify-check-deployed-version-first]]。
  - **真机验证的最大产出常常不是"验证通过"，而是暴露部署 / 环境断层**：五项功能代码层面早有单测，真机这轮真正抓到的是"main 与生产之间隔着一次没做的部署"。呼应"文档=假设、求证"系列（[[2026-06-14 文档写的限制根因未必成立]] / [[2026-06-15 MVP 收尾]]）再加一层：**生产现状 ≠ main 现状**，验收要认生产那份运行物。
  - **工具便利会反噬：自己把 node_modules 软链提交进了 main**：#33 在 worktree 里为省 `npm i` 做了 `ln -s 主仓/node_modules node_modules`，而 `.gitignore` 写的是 `node_modules/`（**尾斜杠只匹配目录、不匹配软链**），于是 `git add -A` 把这条软链纳入并提交（mode 120000、内容是绝对自指向路径）。后果：此后**每个 worktree 检出都 materialize 出 `node_modules -> node_modules` 死循环**，本地模块解析全挂（多次 "Too many levels of symbolic links"）；CI 不受影响（`npm ci` 先删后装）。靠 `git ls-tree HEAD node_modules` 看到 120000 才定位，#38 `git rm --cached` + 去尾斜杠根治。
  - **临时放宽的"门"要带自恢复**：为放行当日已超额（$6.29>$5）的晚间 cron，把 `COST_LIMIT_DAILY` 临时抬到 $12；但若顺手就改回 $5，会把 1 小时后的 17:00 cron 直接熔断跳过。正确做法是**挂一个等"cron 出报告后再恢复 $5"的后台任务**，而不是按"明天"的直觉立刻改（UTC 与本地日期差还让"明天"判断出错——本地已 06-16、UTC 仍 06-15）。
- **经验 / 教训**:
  - **凡"真机/线上验证"，先确认被测物的版本 = 你以为的版本**（镜像 build 时间 / 源 mtime / 特征串 grep）。这步省掉，后面所有观察都可能建在旧物上。
  - **`.gitignore` 的目录模式对软链无效**：要忽略"无论目录还是软链"的 `node_modules`，写**不带尾斜杠**的 `node_modules`。凡用 symlink 做依赖/产物的便利绕过，`git add` 前要意识到它可能不被既有 ignore 覆盖。
  - **`git add -A` 对非常规文件类型（软链/特殊 mode）要警惕**；提交后留意 `git status` 里本不该出现的路径。
  - **跨时区操作按 UTC 推理**：预算窗口、cron 触发都按 UTC，本地日期会误导"今天/明天"的判断；定时类收尾用"等到某事件发生"而非"等到明天"。
- **后续动作**: 已做：六维筛选补齐（#33/#36）+ 文档同步（#34/#35/#37）；生产 code-only 重部署 + 逐项真机验证（mvp-gap §五）；node_modules 软链根治（#38）；成本上限自恢复后台任务；DCP-4 收口材料备齐（本 PR）。memory 新增 [[verify-check-deployed-version-first]]。待：负责人/架构师对 DCP-4 双签；升级 GitHub Pro 后开分支保护硬门。

### 2026-06-17 · 治本落在数据产出处；而"看着完成"的坑都在我没亲手建的边界上——镜像 COPY 白名单 / 生产目录沉积 / 鉴权门

- **日期**: 2026-06-17
- **情境**: dogfood 反馈"今日 Brief 卡片每条一坨长文、看不到重点"。从"给优化建议"一路做成治本（headline 方案）+ 两项轻量增强（重要性彩色徽标、实体/标签 chips），三个 PR（#47 功能 / #48 Dockerfile 修复 / #49 chip 一致性）各走 review→PR→CI→squash→部署，并真机核对。过程中接连撞到几个"代码合入、CI 绿、看着完成，却在我没亲手建的边界处断掉"的坑。
- **观察**:
  - **治本要落到"数据被产出的那一步"，不是"被渲染的那一步"**：卡片摘要是一坨，根因在 `report-gen` 把前 3 条洞察的完整 `statement` 用空格拼成 `summary`——问题出在**产出阶段**。纯前端把长串拆 bullet 是治标（statement 本身就长）。治本是在 **analyzer** 给每条洞察加一个 ≤40 字 `headline` 字段，再贯通 schema→迁移→读写→`buildReport` 派生 `highlights`→前端→历史回填。判断"该在哪一层修"的准绳：**症状出现处往往不是病灶，顺数据流回溯到"这坨内容是谁、在哪生成的"，在那里修才不复发。**
  - **我自己刚写下的运维说明也是假设——回填脚本的"容器内这样跑"在生产必失败**：`ops/backfill-highlights.mjs` 的 docstring 写"容器内 `docker compose exec app node /app/ops/backfill-highlights.mjs`"，但 Dockerfile 运行层只 `COPY` 了**一份显式白名单**的 ops 脚本（trigger/backup-db/cost-backfill/probe-alert/regenerate-reports-cites），新脚本不在其中——Next standalone 镜像不会自动带任意仓库文件，**那条我亲手写的命令在生产容器里必报"文件不存在"**。是部署时去 `grep` 真实镜像里的文件清单才暴露的（#48 补 COPY）。这是 [[2026-06-14 文档写的限制根因未必成立]]/[[2026-06-15 把门写进规范前先验证平台能否强制]] "文档=假设、求证"系列再深一层：**前几条求证的是别人写的归因/spec 数字/平台能力，这条求证的是"我自己这一秒刚写下的运维文档"——它同样是假设，且因为"刚写的、很确信"最容易免检。**
  - **对长寿命生产目录做 `--delete` 同步前，先 `ls` 它**：现成 `deploy.sh` 用 `rsync -az --delete`，但 SSH 上去 `ls /opt/app` 发现里头堆了**后来手动放的 host-only 敏感文件**——`deep-insight-cli_accessKeys.csv`、`.env.local.bak.verify`——`--delete` 会把它们一并删掉。生产目录早已从脚本作者当初假设的"=仓库内容"漂移。因这次改动**只增不删**任何源码文件，去掉 `--delete` 严格安全（先 `-n` dry-run 核对传输清单=只我改的那些）。**破坏性同步/覆盖前的第一动作是观测目标现状，不是信任脚本默认。** 呼应 [[2026-06-15 MVP 收尾]]"关条件前先去现场核验"。
  - **鉴权门挡住直接截图 → 用真实组件 + 真实 CSS + 真实生产数据离线渲染来核对**：首页 `/` 被 NextAuth 拦，headless 截图要塞 session cookie 很折腾。改用 `react-dom/server` 把**线上同款 `ReportCard` 组件**配**当前 `globals.css`**、喂**经 SSM 拉回的真实生产 brief 行**渲染成静态 HTML 再截图——视觉与生产逐像素一致，绕开鉴权。这正是 [[2026-06-14 文档写的限制根因未必成立]]"确定性模块=零成本验证杠杆"的同构：**纯服务端组件 + 静态 CSS 的"可离线复现"性质，等同 report-gen 无 LLM 带来的"不跑全链路也能在真实数据上看效果"。** 设计期把"可独立渲染/无副作用"做进组件，验证期兑现成"不必硬闯鉴权也能核对真机外观"。
  - **UI 不一致的根因常是"过度区分"**：实体 chip 复用既有实心 `.entity-tag`、标签 chip 我新写了个描边 `.tag-chip`，一次性在**填充/字号/文字色/盒高 4 个维度**同时发散，本意"区分实体 vs 标签"，结果读成"两个不搭的组件"而非"同一组件的两个类别"，标签还显得像被禁用。而 `#` 前缀**早已**足够标识"这是标签"。修法（方案 A）：两类归一到同一实心胶囊，区分只留 `#` 这一个信号。
- **经验 / 教训**:
  - **"完成"的盲区，集中在我没亲手建的那些边界上**：镜像的 COPY 白名单、生产目录的历史沉积、平台的鉴权门——没一个是我这次写的，但每一个都决定"我的产物能不能真用 / 能不能验"。**验收不能停在"代码合入 main / CI 绿"，要顺着产物一路走到真实运行物**：镜像里到底有哪些文件、目标目录里到底躺着什么、线上到底渲染成什么样。这是 [[2026-06-15/16 MVP 真机收口]]"合入 main ≠ 上线"再推一层——不仅版本要对，**承载产物的那层基础设施（镜像/目录/鉴权）也得亲自核，它们各有自己的、和我代码无关的真相**。
  - **自写文档/脚本注释 = 假设，且最易免检**：凡带"容器内这样跑 / 这样部署 / 会如何"的运维说明，落地前对**真实镜像 / 真实环境**核一次再当事实。越是"我刚写的、很确信"越要核——确信感正是免检的来源。
  - **破坏性运维先观测后执行**：`--delete`、覆盖、`rm` 类操作前，先 `ls`/`-n` dry-run 目标，确认现状=脚本作者的假设。长寿命生产目录尤其会沉积手动文件，盲信脚本默认 flag 会误删。
  - **想区分两个类别，只动一个信号**：UI 上别同时叠形态 + 尺寸 + 颜色 + 盒高；一个前缀或一处色差就够。**"复用一个既有类 + 另写一个悄悄发散的兄弟类"是不一致的常见来源**——要么共用基座 + 单点差异，要么显式对齐除区分维度外的所有属性。
  - **review 严格度随改动风险缩放**：一个会话跑了 3 轮 PR，2 行 CSS 那轮显式跳过独立 Agent review、保留对带 schema/迁移/数据回填的 #47 做完整 review。门要分轻重，不是每个 PR 都顶格。
- **后续动作**: 已做：#47（headline 方案 + 两增强）/#48（Dockerfile 带上回填脚本）/#49（chip 统一方案 A）合入并 code-only 上线生产（SSM 隧道 + rsync 去 `--delete` + 容器内 rebuild）；headline 回填生产 27 报告 / 426 条（确定性、无 LLM，幂等）；用真实生产数据离线渲染逐项核对要点化与 chip 一致性；memory [[verify-check-deployed-version-first]] 补"`--delete` 会删 /opt/app 手动沉积的密钥文件"+"新 ops 脚本要加 Dockerfile COPY 才能容器内跑"两坑。待评估：把"自写运维说明须对真实镜像核""破坏性 sync 先 ls/dry-run""区分两类别只动一个信号"提炼进 `skills/L2-workflow.md` 与 `skills/L0-foundation.md`。

### 2026-06-18/19 · 从"打不开"到"对外分享"：真卡点在访问模型不在网络层；部署核验"查产物不查时间戳"再三救场

- **日期**: 2026-06-18 / 19
- **情境**: 用户报"其他电脑打不开"，一路深挖成"对外分享给几个可信的人"，连做 validator 批量化（成本最大杠杆）+ 整条分享链（Cloudflare Tunnel + 多账号分权 + 用户管理 UI + 登出），9 个 PR（#47–#55，跨两条线）合入上线、viewer 账号端到端实测通过。
- **观察**:
  - **"帮我分享/暴露 X"的真卡点是访问模型 / 授权，不是传输层**：用户问"怎么让别的电脑访问"，第一反应差点直接去开安全组端口。但先查了一层——`describe-security-groups` 看到 3000 只放了用户单 IP（这是"别人打不开"的确定原因），再往下想"放开后别人到了登录页也进不去"，才发现**真卡点是应用单 admin 全站强制登录、没有任何只读/多用户能力**。用 AskUserQuestion 把"对外分享=给谁、什么权限"摊开（公开只读 / 单报告链接 / 几个人登录），用户选"几个人登录"——于是先补多账号功能，网络层反而是小事。**没先问授权模型就开端口 = 把后台明文亮给全网还以为在"分享"。**
  - **Cloudflare Tunnel 是"无域名成本 + 零入站端口 + 绕 GFW"的组合解（国内自托管场景）**：免费域名（Freenom 已死；**DigitalPlat `.dpdns.org/.us.kg` 是当前能托管到 Cloudflare 的免费域名**，DuckDNS 类子域名因不能作 CF zone 用不了）+ 命名隧道 → 公网 HTTPS 自动、**源站零入站端口**（安全组 3000 直接删、IP 不暴露）、cloudflared 出站连边缘对 GFW 比直连新加坡 IP 稳。操作切分清楚：**用户在 dashboard 拿 token + 配 public hostname，我经 SSM 在 EC2 装 cloudflared**——浏览器账号的事归用户、机器的事归我。
  - **部署核验"查产物不查时间戳"在这几轮 deploy 里反复救场**：rebuild 后 `docker image inspect ... Created` 时间戳两次把我带偏（一次 UTC vs 本地日期差像"旧码"、一次 layer cache 命中时间戳没动），`pgrep docker-compose-up` 还残留进程、容器 uptime 读数也误导。**真凭据永远是：① 运行容器 image ID == 当前 image ID 比对；② 新代码的字符串字面量在 `.next` bundle 里**。而且 grep 要挑**字面量**（prompt 文案 `待校验结论清单`、错误码 `forbidden`、CSS 类 `header-top`）——**函数名会被压缩混淆**（`isAdminOnlyPath` 在 bundle 里查到 0 是假阴性，差点又被骗）。
  - **SSM 隧道会中途超时掉线，但 detached rebuild 不受影响**：两次 deploy 中途 SSM 隧道断了（`Connection closed by ... 2222`），等待器报 255。但 rebuild 是 EC2 上 `nohup docker compose up -d --build &` **独立跑的**，隧道断只是我丢了核验通道、不影响部署本身。应对：**生产构建一律 detached 在机器上跑；ops 通道死了用独立通道（公网 URL + 线上 CSS/HTML bundle）照样核**。
  - **独立 review 抓到的真洞是"保留标识符的大小写绕过"（S1）**：多账号里 env admin 邮箱"保留"判定用的是精确大小写比较，且 email 是 PK——`Admin@x.com` 能绕过保留判定建出真账号（还能请求 admin 角色）。**review 是唯一抓到这个的**（tsc/测试都过）。修法：**保留/唯一标识符比较，每个边界都归一（PK / 保留判定 / 查找），并加大小写变体测试**。同轮 S2 把"受邀一律 viewer、唯一 admin 是内置 env 账号"定为最小权限默认。
- **经验 / 教训**:
  - **"让别人能访问/用 X"先定授权模型，再碰网络层**：谁能看、什么权限、要不要做功能——这是设计核心；传输层（端口/隧道/域名）是末端。接 [[2026-06-17 治本落数据产出处]]"治本落在数据产出处"的同构：问题摆在网络层、根因在应用的访问模型。
  - **部署核验只认运行产物**：`image ID 比对` + `bundle 里的字符串字面量`；**别信 image Created 时间戳**（UTC/cache 会骗你），**别 grep 会被压缩的符号名**（查 literal）。这是 [[verify-check-deployed-version-first]] memory 这轮被反复印证 + 加细的一条（新增"时间戳不可信 / 查字面量不查函数名"）。
  - **生产构建 detached、验证走独立通道**：`nohup ... &` 在机器上跑，SSM/ops 隧道断了部署照常完成、还能用公网 URL 核——别把"构建"和"我的核验通道"绑死。
  - **保留 / 唯一标识符比较，每个边界都归一 + 测变体**：大小写、空白、Unicode 归一化要在 PK 写入、保留判定、查找三处一致，否则"保留/唯一"的不变量能从某个没归一的边界被绕。这是本轮 review 唯一的真 bug——也再证"安全敏感改动值得独立 review，tsc+测试盖不住授权洞"。
  - **最小权限做默认**：能只给 viewer 就别在 UI/API 暴露 admin 创建口；分权要**服务端双闸**（middleware 一道 + handler 内 `forbidNonAdmin` 二道，护着花钱端点），**UI 隐藏只是体验、不是闸**。
  - **Auth.js split-config 让"DB 后端鉴权"与"Edge middleware"共存**：Edge 安全的 `auth.config`（middleware 只读 JWT 里的 role）+ Node 的 `auth.ts`（authorize 查库验密码），JWT 跨两实例搬 role（同 AUTH_SECRET）。**Edge 安全靠 `next build` 权威校验**（肉眼 import 追踪只是辅助）——CI 的 build 绿就是"middleware 没把 better-sqlite3 拖进 Edge 包"的证明。
- **后续动作**: 已做：validator 批量化（#51）+ A1 eval 精度门（#52，批量 neg-recall 100% == 单条、0 漏网）；卡片要点化系列（#47–#49）；多账号分权（#53）+ 用户管理搬进设置页 DB+scrypt（#54）+ 登出（#55）全部上线；Cloudflare Tunnel（DigitalPlat 免费域名 `insight.dolphinqd.dpdns.org`）+ 删安全组 3000 入站；viewer 账号端到端实测通过。memory [[verify-check-deployed-version-first]] 这轮再被印证并加细（image ID/字面量 vs 时间戳/压缩符号名）。待评估：把"分享/暴露先定授权模型""部署核验查产物三法（image ID/字面量/独立通道）""保留标识符各边界归一"提炼进 `skills/L2-workflow.md`；6/23 跑主题演化回看（[[evolution-review-2026-06-23]]）。

### 2026-06-19 · 报告库去重 + 搜索栏改造：诊断靠真实数据不靠臆测；改底层前先实测；测试失败是在教你"正确行为"

- **日期**: 2026-06-19
- **情境**: dogfood"今日 Brief / 报告库每条重复信息多""搜索不好用"。先给方案，再分两个 PR 落地（#60 条目去重 / #61 搜索栏改造），各走独立 review→PR→CI 绿→squash→SSM 隧道 code-only 部署→真机验证。承接 [[2026-06-17 治本落数据产出处]] 的卡片要点化。
- **观察**:
  - **诊断"重复信息"先查真实数据库行，凭组件代码臆测会修错地方**：派去探查的 agent 顺着 `ReportCard` 代码推断"重复 = 实体/标签 chips 铺陈"。但 `sqlite3` 拉真实 `report_index` 行一看——这批报告 `tags`/`entity_names` 根本是空的，真正的重复是**标题** `${主题名} · 今日 Brief · ${日期}`（report-gen 拼的规范字段）**与 meta 行的日期/行业各重一遍**，外加页头/顶栏已第三次说"今日 Brief"。若按 agent 的臆测去删 chips，等于修了个不存在的问题。**症状描述（"重复多"）+ 组件源码都不够，得看"这一条到底渲染出哪些字面值"——真实数据是唯一仲裁。**
  - **改底层（FTS）前先对 SQLite 实测语法，省掉一轮猜错**：要把搜索消毒成"永不抛错"的 MATCH 前，先拿生产库 `sqlite3 ... MATCH` 试了 6 种包法。实测才发现：① `"软件工程"`（精确短语）命中 0、`"软件工程"*`（短语+前缀）命中 1——**无空格中文必须靠尾随 `*` 前缀**才搜得到分词后的库；② `bm25()` 负值、越小越相关；③ `"-"*` 返回 0 不抛错、`"Cursor!"*` 标点被分词器剥仍命中。这些都不是读 FTS5 文档能一眼笃定的边界，**先在真实引擎上把语法跑通，再写消毒函数，避免"写完一版→测出抛错→再猜"的来回**。呼应 [[2026-06-14 文档写的限制根因未必成立]]"确定性杠杆"：底层行为能 5 秒实测的，别靠记忆/文档假设。
  - **测试失败常是"代码在教你更正确的行为"，不是改代码迁就测试**：补单测时栽了 3 次，每次都是我的**期望**写错、而代码其实更稳：① 单字实体守卫 `length>=2` 我以为"保留单字"，实际把单字整个丢了——逼我想清"单字应跳过子串去重但保留"；② 我断言实体 `Claude Fable 5` 会被正文 `Fable 5` 删，实际**只有全名逐字出现才删**（保守方向、防过度删除），代码是对的；③ `Cursor -foo` 我以为 `-foo` 被忽略仍命中 Cursor，实际消毒成隐式 **AND**（两词都需命中）→ 0 条，也对。三次都是**改测试去对齐代码里更安全的语义**，而非反过来。**红测试先别急着改实现——分清"实现错"还是"我对实现的预期错"。**
  - **既有"零客户端 JS"约束下，优先翻平台原生能力而不是引客户端 state**：搜索栏要解决"153 项实体的 `<select>` 滚动地狱"和"11 个控件挤一行"，本能想上 combobox/实时筛选（要 JS）。但本页设计原则是纯 GET 表单零 JS——改用原生 `<datalist>`（输入即筛、零 JS type-ahead）+ `<details>`（折叠次级筛选）+ 链接式可移除 chips，体验接近 JS 方案却不破约束。**约束不是先要绕过的障碍，先问"平台原生有没有现成的"。**
  - **从干净 worktree 部署，把已知的 `--delete` 误删面放大了一截**：这次在 worktree 里开发，部署投递源是**干净的 worktree 检出**（而非以往堆了本地文件的主仓）。`rsync --delete` 干跑列出要删的不止老相识 `deep-insight-cli_accessKeys.csv`/`.env.local.bak.verify`，还多了 `evals/dataset/*.local.jsonl`（本地评测集）、`evals/out/*`（评测产物）——因为干净 worktree **比主仓少了这些本地/未跟踪文件**，`--delete` 的删除集更大。本次改动只增不删，去掉 `--delete` 严格安全。延续 [[2026-06-17 治本落数据产出处]] 的 `--delete` 坑，加细"投递源越干净、误删面越大"。
- **经验 / 教训**:
  - **诊断 UI/数据类问题，落到"这一条真实渲染出什么字面值"**：用户的症状词 + 组件源码都是间接的；`sqlite3` 拉一行真实数据，是最便宜也最不会骗人的仲裁。臆测一个看似合理的根因（chips）去修，会修出"正确地解决了错问题"。
  - **能在真实引擎上 5 秒实测的底层语法/行为，先测后写**：FTS 包词、bm25 方向、特殊字符是否抛错——实测一遍再动消毒函数，省掉"写→抛→猜"的来回。
  - **红测试先判"实现错还是预期错"**：本轮 3 次失败全是预期错、代码对（且更安全）。改测试对齐代码、而非削代码迁就测试——前提是想清代码那版语义是否确实更稳（保守的"全名逐字才删"就比我预期的激进删除好）。
  - **守约束优先翻原生能力**：零 JS 下 `<datalist>`/`<details>`/链接式 chips 能拿到八成 JS 体验。把"现有设计约束"当输入而非障碍，先查平台原生件。
  - **部署投递源的"干净度"会改变 `--delete` 的破坏面**：从 worktree 部署比从主仓部署的删除集更大；任何 `--delete`/覆盖前 `-n` dry-run 看清单仍是铁律（这次正是 dry-run 拦下的）。
  - **review 严格度随风险缩放、且能抓 tsc/测试盖不住的一致性洞**：#60 reviewer 指出"按主题筛选时行业也恒定，应一并抑制"——纯一致性、测试不会红，但漏了显得去重不彻底，当场补。延续 [[2026-06-18/19 对外分享]]"安全/一致性敏感处独立 review 有真增量"。
- **后续动作**: 已做：#57（首页 Brief 标题去尾缀）/#60（报告库实体 chip 与正文去重 + 已筛选维度抑制）/#61（搜索消毒 + bm25 相关度 + snippet 高亮 + 分层布局 + datalist + 筛选 chips）合入并 code-only 上线生产；真机登录核对去重生效 + 搜索 49 处高亮/中文检索/`q=-` 不抛错/datalist 153 实体；memory [[verify-check-deployed-version-first]] 加细"从干净 worktree 部署放大 --delete 误删面（含 evals 本地数据）"；用完即删 worktree。待评估：把"诊断落到真实数据行""改底层先实测""红测试先判预期错还是实现错""守约束优先翻原生件"提炼进 `skills/L3-quality.md` 与 `skills/L0-foundation.md`。

### 2026-06-19（二）· 两条护城河深化：从产品定义对齐下一步；review 证伪我亲手写下的"构造安全"；机制塌了就重决策

- **日期**: 2026-06-19（同日第二个会话）
- **情境**: 从"按计划接下来干什么"出发——MVP 已收口，转 post-MVP。从 `product-definition.md` 对齐，诊断两条最稀缺护城河（可溯源一致性 / 主题持续聚合演化），依次落地两个 PR：#63 报告「前情链接」演化链、#64 引用覆盖度第三层。两者各走独立 review→PR→CI→部署核对。
- **观察**:
  - **最高杠杆的下一步常是"接上一根没接的线"，不是"造新功能"**：诊断 #63 时发现 `prev_report_id` 字段、`buildReport`/`saveReport`/`getReport` 全都早已支持前情链接——**只缺 scheduler 生成时传参 + 阅读页展示两根线没接**。字段和显示两头都在、中间断着，现状是"报告堆积"非"演化轨迹"。ROI 排序把它排在重改 analyzer 的覆盖度之前：纯确定性、不碰 LLM、不命中 eval-gate、1–2 天闭环。**诊断要落到"这能力到底实现到哪一层"，常发现缺的只是一根连线。**
  - **独立 review 证伪了我亲手写下的"构造安全"——而且会上线一个误导功能**：#64 原设计是确定性自动补引（检测结论里未被引用覆盖的数字/实体 → 从 body 唯一出现处切逐字短句补成 citation）。我论证它"构造安全"：补引只取自已引、一致性已判 support 的源，逐字必可达，且仍过下游 validator，错补会被拦。**review 用一行代码证伪**：`validator.ts:282` 明写"一致性判定只依赖 (statement, 整篇 body)、与具体 quote 无关"——所以补一条"同形不同义"的逐字短句（body 里"350 个停车位"配结论"350 家公司"）会**复用既有 support 判定、通过校验、以与人工引用同形的可点片段进报告**，制造"点开看到了但看错"，比不补更糟。reviewer 还实测构造了通过案例。这是 [[2026-06-14 文档写的限制根因未必成立]]/[[2026-06-15 把门写进规范前先验证平台能否强制]]/[[2026-06-17 治本落数据产出处]] "文档=假设、求证"系列再深一层：**前几条求证的是别人的归因/spec/平台能力，这条求证的是"我这一秒刚写下、且很确信的安全论断"——确信感正是免检的来源**。已记 memory [[validator-judges-body-not-quote]]。
  - **先 review 后跑 eval——省下在错根基上白烧的钱**：#64 改 analyzer 属命中 eval-gate、要跑烧钱的 Opus eval。我把顺序定成"独立 review → 再跑 eval"。结果 review 直接判了原设计死刑——若先跑 eval，就是在一个注定要推翻的方案上白烧。**廉价的对抗性审查放在昂贵的验证之前；机制层的错，eval 这种结果层验证不一定照出来，但 review 能。**
  - **机制前提塌了，把真相摆给用户重决策、不硬上**：我选"确定性自动补引"是基于"构造安全"的前提，前提塌了 = 这个选择是在错信息上做的。我没想办法给补引打补丁绕过，而是把 R1 发现 + 三条新安全路径（检测+外露 / LLM 校验后补 / 补但降权标记）摆出来让用户重选。用户选"检测+外露"，于是**彻底删掉 carveQuote/backfillCoverage**，改成报告渲染层标 〔待补引〕、不碰 analyzer 输出。延续 [[2026-06-15 MVP 收尾]] "正确分类 > 强行执行"——这次发生在设计层。
  - **eval-gate 误命中要如实判 skip、别白烧 eval**：两个 PR 都 pattern-match 命中 eval-gate（#63 改 `scheduler.ts`、#64 改 `analyzer.ts`/`report-gen.ts`），但**都不改 AI 输出**——#63 只透传 prev_report_id 导航指针，#64 只加检测+渲染标记、insight/citation 字节不变、validator 所见不变。两次都如实盖 `Eval-Gate: skip` + 精确理由，且 #64 的 skip 经独立 review 背书"不改输出属实"。**门是 pattern-match、会误命中；判 skip 不是偷懒，是基于"指标可证明不动"的正确分类——前提是你真验证了它不动。**
  - **离线渲染真实数据绕鉴权看线上效果**：#64 部署后线上存量报告不显示 〔待补引〕（生成时烤进 HTML、按用户决定不重渲染），页面又有鉴权。要让用户看到实际视觉 → 把生产库只读副本拷到本地，用**刚上线的同款 report-gen** 离线渲染真实报告、headless Chrome 截图。同 [[2026-06-17 治本落数据产出处]] "纯服务端组件+真实数据可离线复现"。副产物：跑全量 29 份报告，**26/29 有覆盖缺口**（deep_dive 一篇 25 处）——把 dogfood 主观痛点变成可量化的缺口规模。
- **经验 / 教训**:
  - **诊断"下一步"先落到"这能力实现到哪一层"**：常发现护城河的雏形零件都在、只差一根连线；接线比造新功能 ROI 高一个量级，且多半是确定性、低风险。
  - **自己刚写下的"安全/正确"论断 = 假设，且因"刚写、很确信"最易免检**：尤其带"构造安全/必然/会被拦"这类强保证语气的，落地前要找人/找代码证伪一次。审查的对象不只是别人的产物，更是自己上一秒的断言。
  - **廉价对抗审查放在昂贵验证之前**：review→eval 的顺序能在烧钱的结果层验证之前，先用机制层审查砍掉错方案。机制错未必被结果层指标照出来。
  - **机制前提被推翻，是重决策的信号、不是打补丁的信号**：把"为什么塌了 + 还有哪些安全路径"摆给决策者，比想办法绕过证伪更省、更对。
  - **eval-gate/门禁是 pattern-match、会误命中**：改动命中触发文件 ≠ 改了 AI 输出；如实判 skip 并写清"哪个指标可证明不动"，别在不动指标的改动上白烧 eval；但 skip 的前提是你真核过输出字节不变。
  - **鉴权/线上挡住看效果时，用同款确定性模块 + 真实数据离线复现**：report-gen 无 LLM、纯函数 → 可离线在真实数据上渲染并截图，绕开鉴权、零成本、不动生产。
- **后续动作**: 已做：#63（前情链接：scheduler 串链 + 阅读页前后导航 + `ops/backfill-report-chain.mjs` 历史回填，27 报告回填、真机核对）/ #64（覆盖度第三层：`specificClaims`/`coverageGaps` 检测 + report-gen 外露 〔待补引〕，删除自动补引）合入并 code-only 上线生产；离线渲染真实生产数据核对 〔待补引〕 视觉（26/29 报告有缺口）；memory 新增 [[validator-judges-body-not-quote]]。待：① 真正的"补引"需 quote 粒度语义校验（检测→候选句→廉价定向 LLM 校"这句是否真支撑该具体声明"→过才补），检测/外露逻辑已就位可复用；② 今晚 17:00 UTC cron 出新报告后线上可见 〔待补引〕；③ 6/23 跑主题演化回看（[[evolution-review-2026-06-23]]），前情链接上线后正好有"演化"可看。
