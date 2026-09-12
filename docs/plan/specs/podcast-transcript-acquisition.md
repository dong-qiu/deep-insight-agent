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

每个 Source 有独立的 transcript 策略，不能只依赖全局 `TRANSCRIPT_FETCH`：

| 模式 | 生产 ContentItem | 抓取行为 |
|---|---|---|
| `off` | 原 RSS 行为 | 不生成 acquisition 决策，不请求 transcript |
| `observe` | 原 RSS 行为 | 记录候选和决策；受控样本只写隔离 shadow DB，不影响日报 |
| `enabled` | 新 URL 可成为 transcript | `fetch` 与 `unknown` 请求 transcript；只有经 heldout 验证的 `hard_negative` 可跳过 |

另有 `transcript_strategy=all|relevant_only` 与每源的 items、bytes、总耗时、单 host QPS 上限。限额只暂停 transcript；RSS 采集不能被暂停或熔断。

## 数据与证据契约

1. RSS item 必须明确区分普通文章和播客单集；无全文的播客正文标 `show_notes`，普通 newsletter 保持 `article`。
2. 每次候选、决策、尝试和终态写追加式 `transcript_acquisition_fact`。事件键由 source、规范 URL、候选 hash、策略版本和 attempt 派生；重复投递幂等，语义冲突保留审计记录。
3. 成功入库的 transcript 的 `raw_ref` 必须归档 evidence envelope，至少包含 RSS entry、节目页、实际下载的原始转写载荷、稳定 URL（去掉签名查询参数）、抓取时刻、adapter 版本、原始/清洗正文 hash。raw archive 未验证前，`reader_eligible=false`。
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

无可靠 speaker map 的转写一律 `attribution=unknown`。该状态必须由结构化输出、验证和报告投影共同执行：未知状态禁止生成或渲染任何人物/角色发言归属，允许的表述只有“节目转写提到”。speaker 归属的后续开放必须提供 source segment、speaker ID 和稳定的人名映射。

当前实现的确定性底线是：不把 segment 的 speaker/name/role 格式字段写入可分析正文；所有成功
`TranscriptFetchResult` 和 evidence envelope 固化 `speaker_attribution=unknown`。原始标签仍仅在 raw archive
中保存，以便日后提供可靠映射时重新处理；它们不进入 analyzer 输入。

## 指标与准入

观测至少覆盖 source/day 的候选数、播客识别、决策、实际尝试、成功、回退原因、bytes、耗时、配额命中、分析入选、成功引用与已发布洞察。acquisition facts 是观察者，故障不能影响 P0 管线。

进入 `enabled` 前，离线 heldout 必须满足：

- 每主题至少 60 条 candidate，总样本建议至少 240 条；标注为 `off|mention|reportable|high_value`。
- high-value heldout 零漏召回；总体 reportable recall 点估计至少 95%，下界至少 90%。
- 相比全取 transcript 尝试数至少下降 30%。
- show notes / transcript 配对评测证明有可发布的增量事实；引用可达性为 100%。
- 新源 cohort 的 A1 / 多源评测不低于已批准基线；不完整 A1 结果不能作为准入证据。
- 标为 `transcript` stratum 的 cohort 必须只含 `body_kind=transcript`；show notes 或 article fallback
  不能借该标签参与全文指标或基线对比。

Pragmatic 还需人工核验至少 10 集的 RSS item、节目页、转写 JSON 与标题一一对应。首次灰度为小配额，连续观察 14 天后才允许扩容。

## 实施切片

1. 契约、迁移和默认关闭态。
2. RSS 播客识别、结构化抓取结果、evidence envelope 和 body_kind 修复。
3. 确定性预筛、shadow worker、事实和漏斗读模型。
4. Chain of Thought 的 `observe` 与 `enabled/all` 灰度。
5. Pragmatic 的播客识别和 `relevant_only` 灰度。
6. 历史 evidence version / 回填（单独 ADR，非本功能交付）。
