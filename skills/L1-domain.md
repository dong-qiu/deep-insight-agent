# L1 — 领域层 (Domain)

> 洞察分析这一领域的提示工程模板与质量标准。

## 领域词汇 (Glossary)

<!-- TODO: signal / insight / theme / source / brief 等术语统一定义 -->

## 提示模板 (Prompt Templates)

### 抽取 (Extract)

<!-- TODO: 从原始数据中抽取信号的标准 prompt 骨架 -->

### 归纳 (Synthesize)

<!-- TODO: 多信号聚合为洞察的 prompt 骨架 -->

### 校验 (Critique)

<!-- TODO: 自检 / 反驳 / 引用核查的 prompt 骨架 -->

## 输出 Schema

洞察对象（`Insight`）及全部管线实体（内容条目 / 引用 / 校验结果 / 报告等）的字段级定义，
统一见 `docs/plan/architecture.md` 的「数据模型」节 —— 单一事实来源。
本层提示模板的输出结构须与该 schema 一致。

## 评分标准引用

详见 `docs/verify/eval-criteria.md`。
