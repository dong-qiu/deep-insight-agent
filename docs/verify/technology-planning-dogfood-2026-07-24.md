# 技术规划 Dogfood 记录（2026-07-24）

> 状态：🟡 协议 v2 已就绪；真实质量结论仍待独立人工盲标。
> 目标：验证“已校验技术线索 → 技术机会 → 研究 / PoC / 立项候选”是否为人工规划带来有效输入；不以自动映射结果冒充人工标签。

## 0. 协议 v2（2026-09-10）

v1 的样本口径容易只看到已进入机会池的信号，无法测量“应排除却进入”和“应进入却未进入”。v2 改为从**合格 TechLead 全体**做固定、脱敏、带 UTC 时间戳的分层抽样；盲标清单不含映射结果，人工先填写 `expected_*`，封存后才生成确定性结果。

- 标签：预期 candidate、direction 与 lane，以及封存后生成的确定性结果、`not_enough_evidence`、`exclusion_reason`；证据不足样本不进入分母，人工排除必须写原因。
- 评分：candidate precision/recall、按 topic/kind/期望 lane 的覆盖、candidate/direction/lane 混淆矩阵、可回查 sample id 的错分归因。
- 首个 20 条 fixture 只验证协议的抽样、盲标、排除与评分契约可运行，不来自生产快照，**不构成质量结论，也不替代 50–100 条真实独立标注**。
- 边界不变：仅评估显式词项的确定性投影；不引入语义映射、自动立项、自动方向修改或生产写入。

运行方式与脱敏字段见 `evals/technology-opportunities/README.md`。真实样本必须由只读快照在隔离目录生成。

## 1. 基线

2026-07-24 11:58 UTC 从生产只读快照确认：

| 项 | 数值 | 说明 |
|---|---:|---|
| 技术线索 | 30 | 全部为 `recommended` |
| 近 48 小时技术线索 | 19 | 均有成功校验引用 |
| 活跃技术方向 | 7 | 三个主题下的现有方向 |
| 技术机会 | 0 | 规划投影上线后尚无新的分析批次；不能据此判断映射质量 |

因此，本轮的首个有效机会样本从**部署后的下一轮生产管线**开始计入。不得通过修改生产库或伪造历史机会补齐样本。

## 2. 真实执行（仅 v2；50–100 行）

v1 是历史记录，**不可执行、不可用于新增 dogfood 或评分**。在隔离目录、使用独立的只读 DB 快照，唯一允许的顺序如下；不得从机会池、500 行 UI view 或任何旧 v1 标签回填：

```bash
npm run eval:opportunity-export -- qualified-snapshot.json <UTC>
npm run eval:opportunity-sample -- qualified-snapshot.json blind-manifest.json <fixed-seed> <count>
# 评审者此时按 labels.v2.template.json 的 expected-only 结构填写 expected-only.json
npm run eval:opportunity-seal -- blind-manifest.json expected-only.json sealed.json <UTC>
npm run eval:opportunity-mapping-export -- qualified-snapshot.json deterministic-mapping.json
npm run eval:opportunity-materialize -- qualified-snapshot.json blind-manifest.json sealed.json deterministic-mapping.json labels.json <UTC>
npm run eval:opportunity-map -- labels.json qualified-snapshot.json blind-manifest.json sealed.json deterministic-mapping.json
```

`expected-only.json` 必须从 `evals/technology-opportunities/labels.v2.template.json` 复制 manifest 行的 `sample_id`、topic/kind 与分桶字段，并且只填写 `expected_*`、`not_enough_evidence` 与 `exclusion_reason`；不能包含任何结果映射字段。每次累积 50–100 行，保留 manifest digest、expected commitment、deterministic mapping export 和 score 输出。

## 3. 历史操作记录（不可作为当前执行手册）

1. 在“技术线索”中阅读最近 48 小时的卡片与 `pass` 证据。
2. 标记线索：
   - 值得持续跟踪：`关注`；
   - 对当前主题没有研究价值：`忽略`；
   - 暂不确定：保持 `recommended`，不把“尚未阅读”误标为无价值。
3. 在“技术规划 → 机会池”记录高价值候选的人工判断：
   - 期望方向：某个现有方向，或 `null`；
   - 期望通道：`core` / `adjacent` / `challenge` / `horizon`；
   - 是否应进入候选池；
   - 1 句理由，区分“事实不足”与“方向不适用”。
4. 对准备推进的候选，先核对原始引用，再把状态置为 `research_candidate`；不因评分高直接置为 PoC 或立项候选。

## 4. 每周校准（建议每周一次）

1. 汇总错分、漏分和方向外信号。
2. 在“管理方向”只修改能解释这些样本的最小词项集合。
3. 用“预览影响”检查新增进入、通道迁移、不再匹配；确认后才“保存并重投影”。
4. 重投影产生的 `stale` 候选必须逐条复核；既有人工状态不得因规则更新而回退。

## 5. 人工盲标与评分（仅 v2）

- 标签模板仅为 expected-only 的 `evals/technology-opportunities/labels.v2.template.json`；实际值只能由第 2 节的 deterministic mapping export 后 materialize。
- 标注者应独立于词项编写者；不复制原文全文、密钥或个人数据到标签文件。
- 达到 50–100 条、覆盖三个主题和四个通道后，必须使用第 2 节的完整六步命令评分；评分器不接受单个 labels 文件。
- 记录 candidate precision/recall、direction/lane 混淆矩阵与错分归因，并同时审阅“本应排除却进入候选池”的误报。低于人工认可门槛时，仅调整显式词项或继续人工处理；不得以自动立项绕过复核。

## 6. 收口条件

- 连续两个自然周完成每日线索审阅与至少两次周校准；
- 累积 50–100 条人工标签，且覆盖 core / adjacent / horizon / challenge；
- 至少 3 条机会完成研究候选的人工分诊，证据链可回溯；
- 输出一次映射评分与错分归因，再决定是否开展语义映射、概念聚类或自动方向建议。

## 7. 本轮观察日志

| 日期 | 新线索 | 新机会 | 人工标签 | 规则调整 / 结论 |
|---|---:|---:|---:|---|
| 2026-07-24 | 基线：19 条近 48h 线索 | 0 | 0 | 规划功能在最新一轮线索之后部署；等待下一轮生产管线生成首批候选。 |
| 2026-08-05 | 生产累计 144 条 | 生产累计 166 条 | 0 | 已具备首轮人工标注样本；下一步由规划负责人从机会池选择跨三个主题、覆盖四通道的 50–100 条进行独立标注，不能用系统推荐回填人工标签。 |
