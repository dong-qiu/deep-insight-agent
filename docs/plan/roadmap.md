# 里程碑计划 (Roadmap)

> 阶段性目标与时间盒。按 IPD 阶段分。

## M0 — Concept

- [x] charter.md 完成
- [x] product-definition.md 完成
- [x] 关键假设列表与验证方式

## M1 — Plan

- [x] 核心 spec 拆分（specs/ 4 份达基线，经 3 轮独立评审收口）
- [x] architecture.md 收敛技术选型（六节齐全，含 Agent 运行时 / 安全 9 项落点 / 成本控制路径）
- [x] 评测指标确定（`eval-criteria.md` 阈值暂定，M1 末标定）
- [x] DCP-0 附条件 ①: A3 数据源核实（`source-feasibility.md`）
- [x] DCP-0 附条件 ②: 竞品分析（`competitive-analysis.md`）

## M2 — Develop (MVP) ✅ 收口（DCP-2 有条件通过 2026-05-27）

- [x] **DCP-1 → M2 跨门硬门槛**: A1 验证实跑（有条件通过；2026-05-27 复验加固：校验环安全、提炼环非显然 68%/零捏造，见 `docs/verify/a1-runs.md`；条件 ②多源/③幻觉随规模 → M3）+ 成本实测标定（charter A5）
- [x] 端到端 1 条数据流跑通（采集→分析→校验→报告，真模型 + 真持久化）
- [x] 收集 / 分析 / 校验三段 agent 落地（+ report-gen）
- [x] 基础 UI / 输出形态（Next.js：今日 Brief / 报告库 / 看板 / 设置 + 鉴权）
- [x] 数据源接入按 `source-feasibility.md` MVP 清单（23 feed：ai-swe 13 / ai-security 10；现有 rss/arxiv 适配器全覆盖，抓取冒烟 7/8 通）
- [~] 非 web 源采集可行性 spike（播客 / 视频字幕）—— 播客 RSS（show notes）已接入；视频字幕 / ASR 转写待 spike
- [x] 容器化 + 容器内 cron + CI（增量7：Docker standalone + supercronic + GitHub Actions + Dependabot）
- [x] M2 评审修复 round1（4×🔴）+ round2（8×🟡）

## M3 — Verify ✅ 收口（DCP-3 有条件通过 2026-05-29，进入 M4 Launch）

- [x] eval 数据集与基线（多源本地快照 `eval:build-local` + `baseline.json`；A1 标注 20/20 人评固化）
- [x] 回归测试通过（`run-a1` 对照 baseline >3pp 阻断；CI 确定性 eval 绿，102 tests）
- [x] 试用反馈闭环（dogfood 双主题重生 swe 30 + security 15；**2 名独立评审完整轮回填、幻觉 0/45、无 🔴 → ⑤ 闭合** 2026-05-29）
- [~] **DCP-2 附条件**：① 成本——阈值已按 Opus 现实重标 + 富多源砍半实测落阈内；真实账单定稿待直连 key（**附条件**）；② A1 遗留——多源压测完成（可达性 24%→89%、security 0→8）；**幻觉率 ≤2% 待规模数据 + 人评**；③ 中转站稳定性——120s+分批+重试已兜底，告警接线待运维；④ initial_digest / 视频字幕 spike（低优，推 M4）
- **DCP-3 准入体检**（门评前）见 `docs/verify/dcp-3-readiness-2026-05-28.md`：可溯源红线（发布层 100%）已构造即成立；门差在幻觉率首轮人评 + 试用首轮闭环两项最小证据。

## M4 — Launch

- [~] 部署上线（**产物就绪 + 冒烟验证通过**：Docker compose `up --wait` exit 0、app healthy / cron 运行，修了 2 处 healthcheck 阻断，2026-05-29；**待真正部署到生产服务器**——域名/TLS/反代/卷备份）
- [x] 文档与使用指南（README 简介 + `docs/launch/operations.md` 部署运维手册：env 速查 / 中转站 Opus 约束 / 监控 / 备份恢复 / 故障排查）
- **DCP-3 附条件（M4 内闭合）**：① 成本含校验口径定稿 / Sonnet 降本（待直连 key）；② **失败告警钩子已接 ✅**（`notifyFailure`，待 operator 配 `ALERT_WEBHOOK` channel）+ 带 key 定时 eval job；③ 产出 yield/质量迭代——**引用覆盖 rule 4 补引已强化 ✅**（◐ 降幅待下轮 dogfood 测）、isCompleteStatement 名词结尾放宽（待取证）、跨源综合提升；④ initial_digest 冷启动 / 视频字幕 spike（低优）。

## DCP 决策日志

> 每次 DCP 评审结论追加于此：日期 / 门 / 决策 / 理由 / 双签人（负责人 + 架构师）。

### DCP-0 立项评审 — 2026-05-17

- **决策**：✅ 继续（CONTINUE）—— 进入 M1 Plan。
- **依据**：准入通过（`charter.md` v0.3、`product-definition.md` v0.5 完成，无遗留开放问题）；评审清单 4/4 通过 —— 痛点真实、边界清晰、关键假设可验证、差异化成立（第 4 项带 M1 遗留）。
- **附条件（M1 须完成）**：
  - 用真实数据小样本验证假设 A1（洞察可靠性），并作为 DCP-1 硬门槛；
  - 逐源核实假设 A3（数据源可达性），首版只接确定可达的源；
  - 补一次竞品分析，深化差异化论证。
- **双签**：负责人 dongqiu ✓ · 架构师 ✓。

### DCP-1 计划评审 — 2026-05-21

- **决策**：✅ 继续（CONTINUE）—— 进入 M2 Develop（MVP）。
- **依据**：准入通过（4 份 spec 达基线 + `architecture.md` 六节齐全 + `eval-criteria.md` 阈值定稿 + DCP-0 附条件 ① / ② 完成）；评审清单 4 ✅ + 2 ⚠️（成本条件 + 迭代节奏软通过），无 🔴 阻断项。
- **关键产出**：4 份 spec 经 3 轮独立 agent 评审收口；architecture.md 经 1 轮独立评审、Vercel+SQLite 误选已纠正为自托管 Docker；`source-feasibility.md`（17 ✅ / 8 ⚠️ / 6 ❌，MVP 接入清单 22 feeds）；`competitive-analysis.md`（16 竞品，4 项差异化护城河窗口 18–24 个月）；`practice-log.md` 记录人机协同经验。
- **M2 早期跨门硬门槛**:
  - A1 验证实跑（`insight-analysis` AC10，真实数据评测集达上线门槛）；
  - 成本实测标定（deep_dive / brief / initial_digest 三类报告平均成本验证 `eval-criteria.md` 暂定阈值）。
- **战略备忘**：4 项差异化护城河强度排序与产品定义叙事顺序不一致（最稀缺：② 可溯源一致性、③ 主题持续聚合）；最警惕竞品 = Inoreader；一致性校验为 MVP 必做的"双重校验"，不能退化为只过可达性。
- **双签**：负责人 dongqiu ✓ · 架构师 待会签。

### DCP-2 开发门评 — 2026-05-27

- **决策**：✅ 继续（CONTINUE）—— 进入 M3 Verify（有条件）。
- **依据**：M2 主链路齐备（brief / deep_dive 端到端 · 收集/分析/校验/生成四 agent · Next.js UI · MVP 23 源 · 容器化/cron/CI · 评审 round1/2 收口）✅；A1 验证**有条件通过**（校验环安全·100% 负例召回；提炼环非显然 68%/捏造 0，人评固化）；deep_dive 最小确定性版补齐（MVP 承诺兑现）；成本阈值按 Opus-on-relay 现实重标。评审清单通过、无 🔴 阻断。材料包见 `docs/verify/dcp-2-review-2026-05-27.md`。
- **附条件（M3 内闭合）**：① 成本按中转站真实计价测实费、验证/收紧重标阈值；② A1 遗留——非 arXiv 多源压测 + 幻觉率随规模收紧至发布门 ≤2%；③ 中转站稳定性跟踪（成本测量曾反复超时）；④ initial_digest 冷启动路径 / 视频字幕 spike（低优）。
- **外部依赖（不阻塞）**：直连 `sk-ant-` key 目前不可得 → Sonnet 降本 + Anthropic 列表价干净测算待将来有 key。
- **双签**：负责人 dongqiu ✓ · 架构师 待会签。
- **双签**：负责人 待评审 · 架构师 待评审。

### DCP-3 验证门评 — 2026-05-29

- **决策**：✅ 继续（CONTINUE）—— 进入 M4 Launch（有条件）。
- **依据**：两条红线安全——可达性**发布层 100%**（`validator.checkReachability` + `report-gen.selectInsights` 白名单构造强制）+ **幻觉率人核 0/45**（双主题、2 名独立评审全 45 条复核）；试用反馈闭环 ⑤ 成立（45 条无 🔴）；回归 + CI 绿（112 tests + typecheck + build）；负例召回 100%。**0 项明确未达**。材料包见 `docs/verify/dcp-3-review-2026-05-29.md` + `dcp-3-readiness-2026-05-28.md`。
- **关键产出（M3 内）**：HTML 治本（引用覆盖根因）· uncoveredClaims 误报细化 · analyzeWithSplit 拒答隔离（security 0→可产出）· statement 截断 streaming 治本 · isCompleteStatement 窄放宽；双主题报告重生（swe 30 + security 15）；dogfood 双主题人评固化（幻觉 0/45、可达 100%、非显然 44%、有用 98%）。
- **附条件（M4 内闭合）**：① 成本——按"含校验端到端"重订阈值/口径 或 validator 降本（Sonnet，待直连 key）；② 失败告警接线（运维）+ 带 key 定时 eval job；③ 产出 yield/质量迭代——引用覆盖◐ 9 条补引、isCompleteStatement 名词结尾放宽（待取证）、跨源综合提升；④ initial_digest 冷启动 / 视频字幕 spike（低优）。
- **战略备忘**：成本口径新发现——校验（opus-4-7 逐条一致性）是成本大头，含校验一轮 ≈ ¥14–26、超 analyze-only 阈；中转站 Opus-only 约束下 validator 降本待直连 key。
- **双签**：负责人 dongqiu ✓ 有条件通过（2026-05-29）· 架构师 ✓ 会签同意（2026-05-29）。
