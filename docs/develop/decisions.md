# 设计决策记录 (ADR)

> 累积式记录。每条决策含：背景 / 选项 / 选择 / 理由 / 影响。新决策追加在文件末尾。

---

## ADR-0001: 容器化与定时调度的实现选型（增量7）

- **日期**: 2026-05-26
- **状态**: Accepted

### 背景

architecture.md 已定调「自托管 Docker 单实例 + 持久卷 + 系统 cron（容器内进程，不用 Vercel Cron）」。
增量7 要把它落地，涉及三个待定的实现细节：镜像如何瘦身、cron 用什么跑、standalone 打包后静态配置如何定位。

### 选项与决定

1. **镜像打包：Next `output: "standalone"`** —— 多阶段构建，运行层仅带 `server.js` + 裁剪后的
   `node_modules`（含被 trace 的 `better-sqlite3` 原生 `.node`）。否决「整包 node_modules 进镜像」（臃肿）。
2. **cron 机制：supercronic（容器内）+ HTTP 触发** —— cron 服务复用同一镜像，跑 supercronic 按
   `ops/crontab` 定时 `curl POST /api/cron`（Bearer `CRON_SECRET`），真正的长任务在 app 容器进程内走
   Job Runner。否决：① 系统 `cron -f`（不向任务传递容器环境变量，需模板化 crontab，繁琐）；
   ② Node 进程内 `setInterval`（非真 cron、漂移、与 Web 进程争事件循环）；③ CLI 直连库（双写进程）。
   supercronic 继承容器环境变量并传给任务，是容器原生 cron 的事实标准。
3. **standalone 下的静态配置：`INSIGHT_CONFIG_PATH` 环境变量覆盖** —— `loadStaticConfig` 原先用
   `import.meta.url` 相对定位 `defaults.yaml`，standalone 打包后该相对路径失效。改为优先读
   `INSIGHT_CONFIG_PATH`，Dockerfile 把 `defaults.yaml` 拷到 `/app/config/` 并设此变量。
4. **单镜像双服务**：app（`node server.js`）与 cron（`supercronic`）共用一个 tag 锁定镜像，compose 里
   override command；持久卷 `/data` 仅挂在 app。

### 理由

- 与「镜像 tag 锁定 / 供应链」对齐：base 镜像锁 patch、supercronic 锁版本 + SHA1 校验下载。
- HTTP 触发让 app 进程是唯一 SQLite 写者，规避多进程写锁；cron 服务只负责「按点敲门」。
- 长任务在容器进程内跑，绕开 serverless 超时（architecture 风险表「长任务 ≤ 10 分钟」）。

### 影响

- 新增：`Dockerfile` / `.dockerignore` / `docker-compose.yml` / `ops/crontab` /
  `.github/workflows/ci.yml` / `.github/dependabot.yml` / `src/app/api/{cron,health}/route.ts` /
  `src/lib/agents/scheduler.ts`。
- 改：`next.config.mjs`（standalone）、`config/index.ts`（配置路径可覆盖）、`repos.ts`（按主题取窗口内内容）。
- 运行依赖新增环境变量 `CRON_SECRET`（未设则 `/api/cron` 返回 503 禁用）。
- 中转站（relay）下定时跑须设 `VALIDATOR_THINKING=0`（校验带思考会挂，见 practice-log）。

---

## ADR-0002: 报告页内追问（Follow-up Q&A）的可信度 / 交互 / 响应三轴选型

- **日期**: 2026-06-08
- **状态**: Accepted

### 背景

A4「页内追问」是 product-definition 写明的 MVP 体验项（line 244），但 M2/M3 有意缺席——
dogfood 先观察需求真实性（`mvp-gap-2026-06-07.md` §3.2）。现决定落地，spec 见
`docs/plan/specs/followup-qa.md`。三个会改变架构走向的轴需定调：可信度策略、交互轮次、响应方式。

### 选项与决定

1. **可信度：约束生成 + 轻校验（缓存兜底一致性）** —— 回答只能引用"报告已收录、已校验的引用池"
   （结构性保证 100% 可溯源）；逐引用走 `checkReachability`（防漂移）+ 缓存兜底 `judgeWithRetry`
   （命中缓存 0 成本，新合成论断才实判一次）；`not_support` 剥离，judge 失败优雅降级为「校验失败·
   待重试」。否决：① **硬闸全校验**（每引用必跑 Opus，~30-60s + ≈ mini deep-dive 成本，叠加追问
   场景体验/成本崩）；② **纯生成不校验**（违背幻觉红线，与产品核心卖点冲突）。
2. **交互：v1 单轮 Q→A，数据模型预留多轮** —— `followup_qa` 表带 `thread_id`/`turn_index`
   （v1 恒 自身id/0），`GET` 历史已是"列表"读路径。否决"一步到位多轮"：会话线程/上下文窗口
   截断/成本随轮增长复杂度大，dogfood 未证需求前不投入；预留口子使升级零返工。
3. **响应：v1 同步等待，API 契约预留 SSE** —— 复用现有 `fetch + busy` 客户端模式，~5-10s 转圈。
   否决：① **SSE 流式**（前端零流式基础设施，且引用校验在生成后做、流式增量体验有限，性价比低）；
   ② **异步轮询**（202+poll 对对话场景违和、还需状态表）。契约不变，将来换流式只改 handler。

### 理由

- 三轴组合自洽且可发布：轻校验让同步 5-10s 可接受；prompt cache + 一致性缓存压住重复成本；
  同步实现把总工作量收在一个可控范围。
- 可溯源红线由"只能引用已验证池 + ref-in-pool + 可达性"**结构性**保证，不依赖每次重判；
  一致性判定作幻觉兜底，按引用封顶（默认 8）界定最坏成本。
- 优雅降级吸取 `validator-uncertain-storms` 教训：中转站抖动不得被记成内容假阳性。

### 影响

- 新增：`src/lib/agents/followup.ts` / `src/app/api/reports/[id]/followup/route.ts` /
  `src/app/reports/[id]/_components/followup-panel.tsx` / `followup_qa` 表 + repo /
  llm.ts `followup` role（env `FOLLOWUP_MODEL`，默认 sonnet-4-6）。
- 改：`schema.ts`、`types.ts`、`db/analysis.ts`（`getInsightsByIds`）、`markdown.tsx`
  （`anchorPrefix`）、`reports/[id]/page.tsx`、`globals.css`。
- 新增运行参数：`FOLLOWUP_MODEL` / `FOLLOWUP_MAX_CITATIONS`(8) / `FOLLOWUP_RATE_LIMIT`(30/h)。
- 红线缺口（与报告生成比）：v1 无每日硬预算熔断、一致性强度依赖缓存命中——已在 spec 开放问题登记。

---

## ADR-0003: 成本预算控制（A5）—— 配置 / 熔断粒度 / 自动 vs 手动

### 背景

度量侧早已具备（每段管线 `Run.cost` 落库 + admin 成本时序图），但**无管控**：`product-definition.md:288-291`
承诺「可配成本上限（日/月）+ 触顶告警 + 限流」、DCP-3 条件①、`architecture.md`「成本控制实现路径」
四行均未落地。Opus-on-relay 含校验单轮 ¥14-26、无刹车，dogfood 期间靠人盯。本 ADR 补齐配额校验 + 熔断 + 看板。

### 选项与决定

1. **配置走 env，不建 quota 表** —— `COST_LIMIT_DAILY` / `COST_LIMIT_MONTHLY`（USD）/ `COST_ALERT_PCT`（默认 80）。
   否决 architecture 原画的 `quota` 表（per account/topic/model）：多账号已显式推后（见 mvp-gap §1.1），
   per-topic/model 配额在单用户下无实义；与项目现有惯例（模型/窗口/推送全走 env）一致，零迁移、零表单。
   `quota` 表 + per-topic 配额留作多账号落地时的 post-MVP 升级。
2. **熔断粒度 = 每个 topic 迭代前检查** —— `runScheduledPipeline` 每 topic 前查 `getBudgetStatus`，
   `exceeded` 则跳过本 topic 及之后全部（summary 标 `skipped-budget-exceeded` + `budgetStopped`）。
   成本每段 Run 完成即落库，故拿到的是近实时已花额；过冲上界 = 单 topic 一轮（含 Opus 校验 ≈ ¥14-26），可接受。
   否决：① 调用内 `AbortSignal` 中断（`llm.ts` 已预留 signal，但需 budget watcher 轮询，复杂易出并发坑）；
   ② validate 前二次检查（过冲更小但多检查点，MVP 不需要——已作预留，未默认开）。
3. **自动硬熔断、手动放行但提示** —— 自动管线（cron）`exceeded` → 硬跳过；手动操作（深挖 `runPipelineForTopic` /
   追问 `answerFollowup`）`exceeded` → **不拦**，仅记日志 + `notifyBudget(context:"manual")` 一次。
   理由：cron 是失控财务风险该刹车；手动是用户主动意图，应保留应急能力。
4. **月窗 = 自然月 UTC**（本月 1 号 00:00 起，对齐账单直觉）；**单位 USD**（对齐 `cost.amount`）；
   **告警每进程去重**（cron 每 6h 一跑 → ≤4 条/天，无需持久化状态）。

### 理由

- 判定收敛为纯函数 `evaluateBudget`（注入两窗已花额 + 限额），DB/env 旁路便于单测各档（ok/alert/exceeded）。
- 未配任何限额 → `verdict` 恒 `ok`：**零回归**——未配预算的部署行为与改动前完全一致。
- 已花额走 SQL `SUM(json_extract(cost,'$.amount'))`（无 cost 的确定性段记 0），比 listRuns+JS 聚合廉价。

### 影响

- 新增：`src/lib/runtime/cost-guard.ts`（`loadBudgetLimits` / `evaluateBudget` / `getBudgetStatus`）、
  `repos.sumRunCostSince`、`alert.notifyBudget` + `budgetToNotification`、admin 预算卡片（`admin/page.tsx`）。
- 改：`scheduler.ts`（自动熔断 + `ScheduleSummary.budgetStopped` + 手动深挖提示）、`followup.ts`（手动追问提示）。
- 新增运行参数：`COST_LIMIT_DAILY` / `COST_LIMIT_MONTHLY`（USD，未设=不限）/ `COST_ALERT_PCT`（默认 80）。
- 测试：cost-guard 各档 + 脏输入 + 日/月窗、`sumRunCostSince` 窗口聚合、`budgetToNotification`/`notifyBudget`。
- 闭合 DCP-3 条件① 的限流半（成本账单定稿仍被直连 key 外部阻塞，见 mvp-gap §1.3）。

---

## ADR-0004: deep_dive 窗口对齐 90 天 + 结构化六段版式（#19）

### 背景

2026-06-14 dogfood 核查（mvp-gap §一.4）发现 deep_dive 两处偏离 spec：① 默认窗口 14 天（`scheduler.ts`
`DEEP_DIVE_WINDOW_HOURS=336`）≠ spec `report-generation.md:27` 的 90 天；② 版式仅「重点关注 / 其他动态」
两节 ≠ spec:31 + `product-definition.md:72` 承诺的六段（TL;DR + 关键发现 + 趋势分析 + 对比表 + 时间线 +
引用清单）。dogfood 真机一次深挖产出 174 引用的两节式报告 = 一堵墙，印证「TL;DR 上浮第一优先 · 报告是产品心脏」
（`product-definition.md:208,231`）未在 deep_dive 落地，直接打到差异化护城河「可读的结构化综述」（`roadmap.md:74`）。

### 选项与决定

1. **窗口默认 14d → 90d（对齐 spec）** —— 关键洞察：深挖成本由 `DEEP_DIVE_ITEMS`（默认 25）封顶，
   **不随窗口宽度涨**。`selectAnalysisItems` 先取候选池（≤800，内存子串打分廉价）再 `rankAndDiversify`
   截前 N；窗口放宽只是让 ranker 从更长时间跨度里选更相关的 25 条（旧 14d 会把两周前的重要研究挤出候选窗口）。
   故「90d×多源易超 25 条上限/超单轮成本」的隐忧不成立——成本基本恒定，覆盖与「主题深挖」语义对齐。可配性保留。
   否决「保留 14d 改 spec 口径」：14d 不符「深度综述」产品语义，且成本理由经核查不成立。
2. **版式补三段上浮可扫读层，详版保留** —— 新版式顺序：① **TL;DR**（按重要性 Top-5 结论上浮）→
   ② **概览**（对比表：一行一洞察，类型/重要性/来源/置信度横向扫读，行号 = 详版 `### N` 号）→
   ③ **趋势分析**（仅 trend 型 + 置信度，无则诚实标注「无显著趋势信号」）→ ④ **时间线**（按事件日期倒序）→
   ⑤+⑥ **重点关注 / 其他动态**（详版块，含完整行内引用 = 引用清单）。
   六段映射：TL;DR ✓ / 关键发现=重点关注 ✓ / 趋势分析 ✓ / 对比表=概览 ✓ / 时间线 ✓ / 引用清单=详版行内引用 ✓。
   保持**确定性模板**（无 LLM、可无 key 全测）——「对比表」MVP 落为确定性概览表（统一维度横向对比），
   领域自适应的语义对比（如方案 A vs B 特性矩阵）需 LLM、留后续迭代。
3. **时间线日期取被引来源最新发布日，回退洞察证据窗口末** —— 比 `insight.time_window`（常等于批次窗）更贴事件实际时点。
4. **自研 Markdown 渲染器加 GFM 表格支持** —— 概览表需 `<table>`；`markdown.tsx` 原不支持表格（`|…|` 会渲染成
   段落墙）。新增表格 block 解析（表头 + `---` 分隔行 + 表体，按未转义管道切分、还原 `\|`），全站报告正文受益。
   HTML 自包含版同步加 `<table>` + 内联样式；`globals.css` 加 `.report-table`（含暗色）。

### 影响

- 改：`scheduler.ts`（默认 336→2160 + 注释写明成本-窗口解耦取舍）、`report-gen.ts`（deep_dive md/html 六段 +
  `orderInsights`/`tldrPick`/`insightDate`/`timelineRows`/`cellEsc` 等共用工具）、`markdown.tsx`（GFM 表格）、
  `globals.css`（`.report-table`）、`operations.md` §env（默认值）。
- 测试：report-gen deep_dive 六段断言（TL;DR 降序 / 概览表列 / 趋势仅 trend / 时间线倒序+回退 / 详版在末 / 无趋势诚实标注）、
  markdown 表格渲染（thead/分隔行跳过/单元 [N] 锚/转义管道/空行收尾）。
- 零数据迁移、零 schema 改动；brief / initial_digest 版式不变（仅 deep 路径分支）。窗口可配性保留，缩窗只需调 env。
- 闭合 mvp-gap §一.4 / issue #19，「报告」行从 ◐ 回升 ✅。

---
