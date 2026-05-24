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
