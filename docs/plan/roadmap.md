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

## M2 — Develop (MVP) (本阶段)

- [x] **DCP-1 → M2 跨门硬门槛**: A1 验证实跑（有条件通过；2026-05-27 复验加固：校验环安全、提炼环非显然 68%/零捏造，见 `docs/verify/a1-runs.md`；条件 ②多源/③幻觉随规模 → M3）+ 成本实测标定（charter A5）
- [x] 端到端 1 条数据流跑通（采集→分析→校验→报告，真模型 + 真持久化）
- [x] 收集 / 分析 / 校验三段 agent 落地（+ report-gen）
- [x] 基础 UI / 输出形态（Next.js：今日 Brief / 报告库 / 看板 / 设置 + 鉴权）
- [x] 数据源接入按 `source-feasibility.md` MVP 清单（23 feed：ai-swe 13 / ai-security 10；现有 rss/arxiv 适配器全覆盖，抓取冒烟 7/8 通）
- [~] 非 web 源采集可行性 spike（播客 / 视频字幕）—— 播客 RSS（show notes）已接入；视频字幕 / ASR 转写待 spike
- [x] 容器化 + 容器内 cron + CI（增量7：Docker standalone + supercronic + GitHub Actions + Dependabot）
- [x] M2 评审修复 round1（4×🔴）+ round2（8×🟡）

## M3 — Verify

- [ ] eval 数据集与基线
- [ ] 回归测试通过
- [ ] 试用反馈闭环

## M4 — Launch

- [ ] 部署上线
- [ ] 文档与使用指南

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

### DCP-2 开发门评 — 待评审（材料包 2026-05-27 备齐）

- **状态**：⏳ 待评审 —— 完整材料包见 `docs/verify/dcp-2-review-2026-05-27.md`。
- **达成度速览**：M2 主链路（brief / deep_dive 端到端 · 三 agent · UI · 23 源 · 容器化 · 评审两轮）✅；
  A1 验证 ✅ 有条件通过；deep_dive（2026-05-27 补最小确定性版）✅；成本阈值已按 Opus 现实重标（brief¥5/deep_dive¥15/initial_digest¥30）。**余缺口**：成本按中转站真实计价测实费验证、中转站稳定性、initial_digest。
- **建议（待裁定）**：✅ 有条件继续进 M3，附条件 = 成本 M3 内测实费验证/收紧 + A1 遗留②③闭合 + 中转站稳定性跟踪；直连 key 不可得故 Sonnet 降本/列表价干净测算推将来，不构成外部阻塞，不建议 HOLD。
- **双签**：负责人 待评审 · 架构师 待评审。
