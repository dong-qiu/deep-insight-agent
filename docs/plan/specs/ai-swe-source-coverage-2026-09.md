# Spec: AI 时代软件工程信源覆盖审计（2026-09）

## 背景

「日报偏薄或遗漏关键工程变化」不能仅凭感觉通过增加 feed 数量解决。2026-09-06 对生产库
`t_code_agents` 做了近 14 天只读审计：已有 10 份已发布日报、16 个启用源和 1 个人工停用源。
其中 9 个源已被已发布洞察引用，说明系统已有跨社区、论文、newsletter、中文资讯和实践博客的
有效输入；问题不是“完全缺源”。

历史复盘也证明，未经筛选地接入高产源会形成 backlog，并挤占研究型内容。因此本轮采用
**一个候选、无显式历史分页、受限首轮导入、观察后决定**的准入策略。RSS adapter 每次最多
读取当前 feed 的 `RSS_MAX_ITEMS`（默认 50）条；这不是历史分页回填，但首次启用仍可能写入该
feed 当时可见的未见条目，不能误称为“零导入”。

## 生产审计基线

审计命令（只读）：

```bash
TOPIC=t_code_agents NEW_DAYS=14 ./ops/aws/source-contribution.sh 14
```

2026-09-06 的结果：

| 类别 | 已验证结论 |
| --- | --- |
| 核心有效源 | arXiv `cs.AI/cs.CL/cs.SE`、Hacker News、InfoQ AI、Latent Space、Martin Fowler、Practical AI、The Pragmatic Engineer、量子位、Simon Willison 都有被引洞察。 |
| 低量零贡献源 | GitHub Engineering（2 条）、GitHub Next（3 条）、Google Research（7 条）、Lex Fridman（1 条）在 14 天内未被引；窗口和样本不足，禁止据此自动下线。 |
| 非故障零采集源 | Aider feed 在生产出口、robots 和全文抽取均正常，但最近内容较久；这不是采集故障。 |
| 人工停用源 | Changelog 当前停用，审计不改变其状态。 |

## 候选准入裁决

候选必须先从生产出口以 `InsightAgentBot` 探测：feed 可达、feed 与文章页 robots 允许、正文满足
现有 source adapter 的最小要求，才可进入 staged rollout。

| 候选 | 生产探测结果 | 裁决 |
| --- | --- | --- |
| GitHub Changelog `https://github.blog/changelog/feed/` | HTTP 200、robots 允许、RSS 首条正文约 1,471 字符；当前包含 Copilot 周更与 Copilot 能力发布。 | **第一阶段接入**：作为 `feed` 源，6 小时抓取；无显式历史分页，首次最多导入当前 feed 的 `RSS_MAX_ITEMS`（默认 50）条未见条目。 |
| Hugging Face Blog `https://huggingface.co/blog/feed.xml` | HTTP 200、robots 允许；feed 正文不足，但文章页 HTTP 200 且可抽取约 21,080 字符。 | 第二阶段候选；先观察 GitHub Changelog，避免同时扩大候选池。 |
| OpenAI News `https://openai.com/news/rss.xml` | feed 与 robots HTTP 200，但生产出口抓第一篇文章为 HTTP 403，feed 首条无可用正文。 | 暂缓；不得以空正文或绕过访问限制接入。 |
| Vercel Changelog / Anthropic 社区桥接 | 未形成稳定、官方且与现有 adapter 相符的 feed 证据。 | 暂不接入。 |

## 第一阶段：GitHub Changelog

受控写入脚本为 `ops/aws/seed-github-changelog-source.sh`，只有显式传入 `--apply` 才会写生产库。

| 字段 | 值 |
| --- | --- |
| `id` | `src_github_changelog` |
| `name` | `GitHub Changelog` |
| `type` | `rss` |
| `endpoint` | `https://github.blog/changelog/feed/` |
| `topic_ids` | `["t_code_agents"]` |
| `fetch_interval` | `6h` |
| `backfill` | `null`；不请求显式历史分页，首次抓取仍受 `RSS_MAX_ITEMS`（默认 50）约束 |
| `fetch_mode` | `feed` |

该源先以 `enabled: false` 放入 `defaults.yaml`，避免空库播种或重部署时隐式扩大采集范围。
脚本为幂等保护：对于同一精确配置的已停用 staged 源，只将 `enabled` 改为 `1`；字段不一致或
带停用原因时失败而不是覆盖人工改动。回退只将该源 `enabled=0`，不删除已经采到的可追溯内容。

## 验收与观察门

1. 新源不得修改 prompt、模型、validator、schema 或既有选择配额。
2. 接入前必须再次运行生产 probe，确认 endpoint 和 robots 仍可达。
3. 接入后连续观察至少 14 天，以 `source-contribution.sh` 为唯一贡献口径：已发布报告中
   被引用的 distinct insight 数。
4. “采集大于 0 且有被引”才可判定保留；“采集大于 0、被引为 0”只触发人工相关性复核，
   不自动下线；“采集为 0”先排查 feed、robots、频率和观察窗口。
5. 新源接入后的日报选择漏斗，必须通过 #295 的 dashboard/trace 观察；若候选数明显增长而
   `selected_count`、`fresh_selected_count` 或发布数不增长，不扩大第二阶段候选，先处理选择或
   引用校验损失。

## Eval-Gate 说明

Eval-Gate: scoped（staged source configuration；生产 probe + 14 天贡献/选择漏斗观测；受影响
单测 + typecheck；未改 `src/lib/sources/` 或 AI 语义）。A1 不执行本次脚本路径；worktree 未配置
API 凭据，不能将缺失凭据伪装为评测通过。若后续为该源增加 adapter、过滤或 AI 语义，必须补多源
A1 重测并与 `evals/baseline.json` 比较。
