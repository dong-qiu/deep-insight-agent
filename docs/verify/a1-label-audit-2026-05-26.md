# 一致性标注集 · 人工校验工作表（20 条分层样本）

> 目的（A1 复验条件1 追问）：校验器带思考仅 82.1% 准确率——是**校验器错判**，还是 **AI 标注本身错**？
> 方法：从 `citation-consistency.jsonl`(120) 分层抽 20（support5 / 夸大4 / 断章3 / 张冠4 / uncertain4），
> 独立精读「结论 vs 原文」给出判定，与 AI 标签比对。零 API 成本。
> `你的判定` 列留空待复核（尤其建议复核 uncertain 4 条——最依赖判断）。

| # | AI标签 | 我的判定 | 一致? | 依据 | 你的判定 |
|---|---|---|---|---|---|
| 0 | support | support | ✓ | 「0.25→0.61/单周期/无人工」逐项复述原文 | |
| 29 | support | support | ✓ | 「提示注入是最关键漏洞」原文同义 | |
| 53 | support | support | ✓ | 「违规率随暴露长度稳健上升/两类智能体」原文同义 | |
| 75 | support | support | ✓ | 「锚定检索证据→降幻觉/提准确」原文同义（略去 promising 限定，可接受） | |
| 98 | support | support | ✓ | 「网页导航 >30% 相对提升」原文同义 | |
| 1 | not_support/夸大 | not_support | ✓ | 原文 0.61≠「所有任务满分」 | |
| 25 | not_support/夸大 | not_support | ✓ | 原文 17.1%≠「100%」 | |
| 63 | not_support/夸大 | not_support | ✓ | 原文 test 0.8997≠「100%」 | |
| 97 | not_support/夸大 | not_support | ✓ | 原文「only 40.2%」≠「大多数」 | |
| 2 | not_support/断章 | not_support | ✓ | 原文「经验证+同意门控」≠「未经任何验证」（实为直接矛盾） | |
| 36 | not_support/断章 | not_support | ✓ | 原文仅「群聊注入」≠「所有输入面」（过度泛化） | |
| 76 | not_support/断章 | not_support | ✓ | 原文「低资源语言尚未验证」≠「所有语言已充分验证」 | |
| 3 | not_support/张冠 | not_support | ✓ | 原文「源代码级自改写」≠「不改源代码」 | |
| 32 | not_support/张冠 | not_support | ✓ | 原文主流范式=数据-指令分离≠上下文完整性 | |
| 60 | not_support/张冠 | not_support | ✓ | 原文 memory-bound≠「受算力限制」 | |
| 86 | not_support/张冠 | not_support | ✓ | 0.66 是 4 篇经典基准；8 篇智能体是 0.38（张冠李戴） | |
| 4 | uncertain | uncertain | ✓ | 原文讲 OpenClaw 四任务,未提 SWE-bench/优于所有基线→信息不足 | |
| 33 | uncertain | uncertain | ✓ | 原文「最关键漏洞」未提经济损失→信息不足 | |
| 61 | uncertain | uncertain | ✓ | 原文给加速比,未提十亿级是否保持→信息不足 | |
| 87 | uncertain | uncertain | ✓ | 原文讲审计 schema 五字段,未提「三人独立交叉打分」→信息不足 | |

## 结果：20/20 标签经独立精读均判**正确**（含 4 条 uncertain）

**含义（与原假设相反）**：这批 AI 标注**质量高、可信**——「校验器的错是标签错导致的」假设在本样本上**不成立**。
故 82.1% 是校验器对**可信标签**的真实准确率，校验器确实在 ~18% 的干净对上判错。

**但错的方向是「安全侧」**：负例召回 **100%**（所有真 not_support 全抓到，0 漏网），
即 18% 的错几乎都是**把 support/uncertain 判得更严**（过度保守、误杀），而非放过坏引用。
对「引用闸门」这种宁可误杀不可漏网的场景，**这是正确的偏置**——损失的是产出率/yield，不是安全性。

> 注：我是 LLM 复核 AI 标签,可能有共同盲点；20 条偏清晰样本。建议你重点抽查 uncertain 4 条（最依赖判断）。
