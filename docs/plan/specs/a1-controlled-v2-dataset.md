# Spec: A1 controlled v2 dataset

> 状态：执行中（候选主题与来源已确定；尚未完成受控快照或 DCP 签署）  
> Owner：dongqiu  
> 关联：ADR-0026、`docs/verify/eval-criteria.md`、`evals/dataset/GUIDE.md`

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
4. 受控快照必须冻结内容哈希、source URL/ID manifest、采集时间、license/retention、topic mapping、去重规则和标签分布。第三方全文只留在受控存储，不提交仓库。
5. 一致性集至少 100 对，`not_support` 至少 40 对并覆盖 exaggeration、out_of_context、misattribution；标签由非生成者的两位独立 reviewer 完成。
6. 全量 A1 只能在 lock 验证为 `verified_v2`、无 smoke 截断、模型/Thinking 配置固定时作为自动证据。两次不同 run_id 的同 commit/config/lock automatic pass 才可形成可接受基线候选。
7. 自动通过后，两位 reviewer 必须对同一 `review-queue` 全量盲评；第三位 reviewer 裁决所有分歧，并用 `review:receipt` 生成 `eligible_for_signoff`。该状态不代替 DCP owner/architect 签署。

### 2026-09-10 cohort preflight

- 十来源的最终隔离采集使用生产 collector；上述十个来源均实际写入候选库。首次总采集中的 `src_simonwillison_promptinj` 曾因 `ENOTFOUND` 失败，随后在**同一隔离根**单源重试成功；两份 manifest 都必须随受控快照保存。
- `src_project_zero` 在一次总采集和一次单源重试中均为 `TimeoutError`，因此本轮不得作为安全主题样本或被隐藏在“九源成功”中；已由 `src_anquanke` 替代。
- 确定性构建得到五个 case、每个 4 条 rich-body 输入并覆盖十个指定来源。这只是来源/去重 preflight，**不是** DCP 样本：输入数不能替代每主题 10 条 reader-visible 洞察，且其中宽主题来源可能含离题内容，必须在受控快照的人为主题映射与 A1 结果中继续淘汰。

## 验收标准 (AC)

- [ ] AC1: 两个新增主题的定义、边界和隔离来源对如上表；staged 来源不因评测自动启用。
- [ ] AC2: 每个来源的 collector manifest 记录实际 collected/failed 状态；失败没有被单个成功来源掩盖。
- [ ] AC3: 构建器拒绝跨 topic 的重复 content ID 或 URL；相同来源允许提供不同 URL 的内容。
- [ ] AC4: lock 校验 v2 样本具有至少 5 个唯一主题、100 组一致性对、40 个 `not_support` 和三种负例。
- [ ] AC5: 全量 A1 产物的 `dcp_sample.reader_visible_by_topic` 每个主题均至少为 10，且不存在 duplicate statement+bound quote。
- [ ] AC6: 两次同配置、同 lock、clean commit 的完整 automatic pass 以及完整的三方人工 receipt 均可回链；此前状态只能标为 incomplete/smoke/provisional，不得盖 `Eval-Gate: pass`。

隔离构建必须显式传入五个主题（包括新增的停用主题），例如：

```bash
export EVAL_TOPIC_IDS='t_code_agents,t_prompt_injection,t_ai_industry,t_coding_agent_platforms,t_agent_security'
```

`EVAL_TOPIC_IDS` 只改变本地评测的读取范围，不启用 topic、不修改生产 SQLite，也不替代后续生产启用决策。

## 非功能要求

- 安全：采集和原文只位于 `EVAL_ISOLATED_ROOT` 或获授权的受控快照；采集错误 manifest 不记录 URL、正文或凭据。
- 可观测性：保留 collector、dataset、A1 manifest 的哈希关联；source/body 内容不写入 Git。
- 成本：先以 collector 和确定性构建检查来源可用性，只有形成可锁定样本后才调用完整 A1。

## 依赖与开放项

- `t_code_agents`、`t_prompt_injection`、`t_ai_industry` 的受控来源对需与新增主题一起在本轮 snapshot 确定，且五主题之间必须满足全局去重。
- 受控不可变存储位置、两名标注 reviewer 和第三名裁决者需要 owner 指定；在此之前不能创建 promotable v2 lock 或声称人工标签完成。
