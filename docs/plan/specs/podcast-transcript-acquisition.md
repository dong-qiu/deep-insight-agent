# Spec: 播客全文采集的预筛、证据与灰度发布

> 状态：实施中 · 2026-09-13

## 目标

在不降低引用可追溯性或改写历史证据的前提下，先以 RSS 元数据判断一集播客是否值得取得完整 transcript。完整流程为：

```text
RSS 单集 → 播客识别 → 预筛决策 →（按需）转写抓取 → 原始证据归档
→ ContentItem → 主题选段 → 引用校验 → 日报
```

本功能是采集成本优化，不改变 `Source → ContentItem → AnalysisBatch → ValidationResult → Report` 的依赖方向，也不放宽 validator 的发布白名单。

## 非目标

- 不自建 ASR，不获取未公开或付费墙后的转写。
- 不原地把已入库 `article` / `show_notes` 改成 transcript。
- 不进行历史回填；历史补齐须先采用证据版本模型并另立 ADR。
- 初版不使用 LLM 拒绝候选；LLM 只能在确定性方案被真实评测证伪后处理 `unknown`。

## Source 配置与模式

每个 Source 有独立的 transcript 策略；全局开关只是一道网络总熔断，不能单独决定某个
Source 是否采集：

| 模式 | 生产 ContentItem | 抓取行为 |
|---|---|---|
| `off` | 原 RSS 行为 | 不生成 acquisition 决策，不请求 transcript |
| `observe` | 原 RSS 行为 | 记录候选和决策；受控样本只写隔离 shadow DB，不影响日报 |
| `enabled` | 新 URL 可成为 transcript | `all` 请求全部 eligible candidate；`relevant_only` 请求 `fetch` 与 `unknown`，只有经 heldout 验证的 `hard_negative` 可跳过 |

每源另有 `transcript_strategy=all|relevant_only` 及 items、bytes、总耗时、单 host QPS 上限。
`eligible candidate` 指已由 RSS audio / podcast 元数据识别、且允许尝试公开 transcript 的播客单集。
限额只暂停 transcript；RSS 采集不能被暂停或熔断。

`off` 时上述策略字段可缺省且不得被读取；`observe` 或 `enabled` 时，strategy、四项限额及非空
`transcript_policy_version` 均为必填。任何会改变候选、预筛决策或请求行为的变更（mode、strategy、
限额、topic 关联、规则或 adapter）必须先升级 policy version，不能覆盖既有事实。

### 全局总熔断与逐源策略

`TRANSCRIPT_FETCH` 是 transcript 网络请求的总熔断：为 `0` 时，任何模式均不得请求
transcript；`observe` 仍可写纯候选/决策事实，`enabled` 若写事实必须标为
`not_attempted/global_gate_off`，不能伪装成抓取失败。为 `1` 时才继续检查 Source mode。
`TRANSCRIPT_SHADOW_FETCH` 是 observe 实际采样的子开关；只有两个开关均为 `1`，observe
才可请求并写隔离 shadow DB/archive。它绝不写生产 ContentItem 或影响日报。

新策略感知镜像的安全默认是两个开关均关闭、每个新 Source 为 `off`。既有生产 Source
不能因旧的全局开关为 `1` 自动变成 `enabled`：先审计实际已批准的源，以显式白名单迁移其
逐源策略，再切换 collector。部署前后的精确优先级和回滚步骤见
[`operations.md`](../../launch/operations.md)。

## 数据与证据契约

1. RSS item 必须明确区分普通文章和播客单集；无全文的播客正文标 `show_notes`，普通 newsletter 保持 `article`。
2. 每次候选、决策、尝试和终态写追加式 `transcript_acquisition_fact`。其完整字段、键、冲突、
   索引、保留和可见性契约在 `architecture.md`；它独立于 `SourceCreditFact`，仅用于采集诊断与
   漏斗观察，不能决定 RSS 熔断、`reader_eligible`、报告选择或引用白名单。
3. 成功入库的 transcript 的 `raw_ref` 必须归档 evidence envelope，至少包含 RSS entry、节目页、实际下载的转写载荷、稳定 URL（去掉签名查询参数）、抓取时刻、adapter 版本、原始/清洗正文 hash。归档前必须从 URL、RSS/HTML/XML/JSON 载荷中移除认证参数和 URL userinfo；归档对象是**凭据脱敏后的载荷**，并同时保存原下载载荷的 SHA-256（仅作不可逆完整性指纹）和脱敏归档载荷的 SHA-256。这样可审查证据仍可回链到下载事实，但绝不把可用 token、密码或 API key 写入 evidence。raw archive 未验证前，`reader_eligible=false`。
4. 抓取失败是单集 acquisition 终态：`no_transcript`、`robots_denied`、`http_error`、`size_limited`、`timeout`、`parse_empty`、`transient_error`。它不能把 RSS 源熔断，也不能伪装成成功 transcript。
5. 既存 URL 从不升级或降级。其历史 citation 仍指向原 ContentItem；新 URL 才能固定其首次正文形态。

The Pragmatic Engineer 是 newsletter 与播客共用一个 Substack feed 的例外：只有 RSS audio / podcast 元数据
证明为单集的 `/p/<slug>` 才进入其专用适配器。适配器必须从同一 canonical episode 绑定的 hydration object
取得可信 `substackcdn.com/.../transcription.json`；推荐集、未绑定 URL 或多条冲突 URL 均失败回退，不能猜“第一条”。
成功证据另归档节目页与实际 JSON 载荷。它从 `observe/relevant_only`、单集/2 MiB 小配额开始；
该上限来自 2026-09 的只读探测（节目页加完整官方 JSON 约 1.88 MiB），仍不足即结构化记录
`size_limited`，不截断写入正文。
## 预筛

纯函数按 source 关联 topic 的标题、show notes、作者和单集元数据作每 topic 判断，返回 `fetch|unknown|hard_negative`、命中 topic、稳定 reason code 和策略版本。

- 分数高：`fetch`。
- 信息不足、标题缺失、多主题冲突、解析异常：`unknown`，必须抓取。
- 只有正文充足且有经评测验证的明确低相关模式：`hard_negative`，才可跳过。

该函数位于低层共享模块，sources 不得反向依赖 agents。Shadow 阶段的原始评测样本在隔离 SQLite / archive 中保存，且通过与生产相同的 `collectSource` 和 source adapter 路径抓取。

## 说话人归属

无可靠 speaker map 的转写一律 `attribution=unknown`。该状态必须由结构化输出、验证和报告投影共同执行：未知状态禁止生成或渲染任何人物/角色发言归属，允许的表述只有“节目转写提到”。这不改变 topic 路由、主题选段或 validator window，但新增跨层准入契约：在任一 Source 进入 `enabled` 前，analyzer 必须按 `architecture.md` 的结构化 attribution 字段标注，validator 必须以 `speaker_attribution_unknown` fail-closed 阻断人物/角色发言归属，报告投影只能消费通过该规则的引用，不能重写或绕过该阻断。speaker 归属的后续开放必须提供 evidence 中的 speaker map、source segment、speaker ID 和稳定的人名映射。

## 指标与准入

观测至少覆盖 source/day 的候选数、播客识别、决策、实际尝试、成功、回退原因、bytes、耗时、配额命中、分析入选、成功引用与已发布洞察。acquisition facts 是观察者，故障不能影响 P0 管线。

任何 Source 进入 `enabled` 前，必须满足：

- show notes / transcript 配对评测证明有可发布的增量事实；引用可达性为 100%。
- 新源 cohort 的 A1 / 多源评测不低于已批准基线；不完整 A1 结果不能作为准入证据。
- 标为 `transcript` stratum 的 cohort 必须只含 `body_kind=transcript`；show notes 或 article fallback
  不能借该标签参与全文指标或基线对比。
- 上述 `attribution=unknown` 的跨层 fail-closed 实现和测试已完成。
  测试至少覆盖 unknown attribution 被 blocked 且不进入报告、verified attribution 缺 source segment/map
  被 blocked、以及只有 `attribution=none` 的 transcript citation 可正常投影。

`all` 是受配额保护的全取对照：它必须满足共同门槛，但不适用召回和降本门，且不得让
`hard_negative` 跳过 eligible candidate。`relevant_only` 除共同门槛外，离线 heldout 还必须满足：

- 每主题至少 60 条 candidate，总样本建议至少 240 条；标注为 `off|mention|reportable|high_value`。
- high-value heldout 零漏召回；总体 reportable recall 点估计至少 95%，下界至少 90%。
- 在同一 `source_id`、策略版本和冻结 heldout cohort 上，配额前的“将请求”决策满足
  `1 - (fetch + unknown) / eligible_candidates >= 30%`。配额暂停不能作为降本证据。

Pragmatic 还需人工核验至少 10 集的 RSS item、节目页、转写 JSON 与标题一一对应。首次灰度为小配额，连续观察 14 天后才允许扩容。

## 实施切片

1. 契约、迁移和默认关闭态。
2. 结构化抓取结果、传输失败分类与 evidence envelope；此切片不得让生产 collector 请求 transcript，
   也不得改变 RSS item 的 `body_kind`。
3. RSS 播客识别与 `body_kind` 固化、确定性预筛、shadow worker、事实和漏斗读模型。
4. Chain of Thought 的 `observe/all` 对照；共同门槛通过后另立批准变更，才可 `enabled/all`。
5. Pragmatic 的播客识别和 `observe/relevant_only`；专属 heldout 门及 10 集人工核验通过后，才可
   小配额 `enabled/relevant_only`，连续观察 14 天后才允许扩容。
6. 历史 evidence version / 回填（单独 ADR，非本功能交付）。
