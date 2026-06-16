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

## ADR-0005: 主题持续聚合第一步——演化时间线 + 实体热度趋势的聚合语义

### 背景

MVP 收口后下一阶段优先级 = 差异化护城河深化（`roadmap.md:104`）。四护城河中「主题持续聚合」（围绕主题持续追踪演化，
竞品普遍缺失，`roadmap.md:74`）的承载面已齐全（实体抽取 + 标签 + 主题页 + 报告库六维筛选），但**只完成了数据容器**：
主题页的「关键实体」仅 `名称 ×N` 总频次、「报告时间线」仅按日期列报告，**看不出主题焦点怎么漂移、谁在变热**。
第一步把它从「数据容器」升级为「演化体验」：① 主题演化时间线、② 实体热度趋势。

候选对比中否决了同期的「结构化综述（Executive Synthesis LLM 段）」优先：后者的 LLM 综述段会产出「跨源合成论断」，
挂不上引用、绕过 validator 一致性闸门——**用一条护城河（可读综述）换另一条（可溯源一致性）**；且被「直连 Anthropic key /
Sonnet 降本」阻塞（`roadmap.md:102③`），成本无空间。本 ADR 范围刻意收敛为**确定性聚合**，规避上述两难。

### 选项与决定

1. **数据源用 `report_index`（报告级），不下钻 `insight` 表** —— 复用现有 `queryReportIndex`（主题页已在用），
   零 schema 改、零新表查询。代价：聚合粒度 = **报告级**——实体「热度」= 其出现的**报告覆盖数**，非「提及次数」。
   据实在 UI 文案标注（不夸大成「提及量」）。否决「下钻 insight 表做提及级统计」：第一步收益不抵复杂度，且 insight
   级查询更重；报告级粒度已足够呈现「焦点漂移 / 谁变热」的演化感。
2. **纯确定性聚合（无 LLM、零成本、不碰可溯源闸门）** —— 这是选「主题聚合」而非「综述」的核心理由，必须守住。
   聚合全在查询层纯函数 + 前端渲染完成，不新增任何 LLM 调用。
3. **演化焦点取该报告 `tags` / `entity_names` 前 N（N=3）** —— `report-gen` 写 `report_index` 时按 `selectInsights`
   选中的洞察顺序 `flatMap + uniq`，该顺序 = analyzer LLM 洞察输出序（`selectInsights` 按 `batch.insights` 原序迭代，
   未额外按重要性排——`orderInsights` 只在渲染函数内部用、不影响 index 数组）。故取数组前缀作「焦点」是**启发式**：
   前缀≈ analyzer 先输出的洞察，**不保证按重要性排序**，但足够呈现「该期主要在讲什么」；无需额外存每个 tag/entity 的频次。
4. **实体趋势判定 = 前后半报告集合出现数比较 + 最小样本阈值** —— 报告按日期升序，比较「后半段出现数 vs 前半段」：
   后 > 前 → `up`、后 < 前 → `down`、相等 → `flat`；**`total < 2`（仅出现 1 份报告）直接判 `flat`**，避免少样本噪声。
   sparkline 的 `buckets` 按**报告时间序位等分桶**（rank-based，非按绝对时间均分）——规避「报告稀疏期空桶」与「离群日期
   压扁分布」，桶数 `N = min(8, 报告数)`。否决「按绝对时间均分桶」：主题报告频率不均（brief 日/周 + 不定期 deep_dive），
   绝对时间分桶会产生大量空桶、视觉噪声大。
5. **演化时间线按「有焦点的点」数降级** —— `topicEvolution` 先过滤掉 focus（tags/entities 前缀）皆空的报告点
   （标签/实体抽取 #36 激活前的老报告会产出空焦点点——真机验证 `t_code_agents` 7 篇里 5 篇空焦点），
   再按剩余**有焦点点 <3** 时整体隐藏、回退「报告时间线」。新主题冷启动 / 抽取激活前的历史期都优雅退化、不出一排空「—」。

### 影响

- 改：`src/lib/db/reports.ts`（+ 纯函数 `topicEvolution` / `entityTrends`，+ 导出类型 `EvolutionPoint` / `EntityTrend`）、
  `src/app/topics/[id]/page.tsx`（演化轨迹 + 实体趋势渲染，内联 SVG sparkline 无图表库依赖）、`globals.css`（轨迹/sparkline/趋势徽标样式，含暗色）。
- 测试：`reports.test.ts` 加聚合单测（空序列 / 单篇 / <3 篇降级 / 焦点取值 / 趋势 up·down·flat 边界 / 少样本阈值防抖 / 同日报告分桶退化）。
- **零 schema 改、零数据迁移、零 LLM、零成本、不触可溯源闸门**；纯增量，brief/deep_dive 生成路径与报告库不受影响。

---

## ADR-0006: 主题持续聚合第二步——里程碑自动标注

### 背景

「主题持续聚合」第二步（接 ADR-0005 焦点演化 + 实体趋势）。目标：自动识别主题里的「重大新事件节点」（里程碑），
在主题页拉出里程碑时间线 + 报告徽标——让用户一眼看到「这个主题发生过哪些大事」，而非逐篇翻报告。
关键是 analyzer 已有判定所需的全部洞察级字段（`importance` 1-5、`is_followup`、`type`），无需改采集/分析。

### 选项与决定

1. **判定条件（严格门槛，用户拍板）** —— `importance≥5（最高）+ !is_followup（新事件、非追加进展）+ type=aggregation（具体事件、非趋势）`。
   纯函数 `isMilestoneInsight`，阈值 `MILESTONE_MIN_IMPORTANCE=5` 设为**可调常量**（2026-06-23 看真实里程碑数量再校准——
   太严=永远没有、太松=满屏稀释）。排除 `trend`：趋势变化已由焦点演化（ADR-0005）承载，里程碑专指「发生了一件大事」；
   排除 `is_followup`：同事件的后续进展是「更新」不是「新里程碑」。否决「中等/宽松」门槛：先求含金量，可调常量留校准口子。
2. **判定洞察级、持久化报告级** —— 判定在 `report-gen.buildReport`（手上有完整 `included` 洞察），算出 `milestone_count`
   写进 `report_index`（派生表）。**不动 insight 表 / analyzer**（判定字段全有）。否决「insight 加 `is_milestone` 列」：
   当前只需主题页报告级展示，洞察级里程碑查询无消费方，YAGNI；报告级 `milestone_count` 让主题页 `queryReportIndex` 零额外查询。
3. **展示** —— 主题页：① 报告时间线卡片 `milestone_count>0` 加「里程碑」徽标（与「重大」徽标并列）；
   ② 独立「里程碑」时间线区块（过滤 `milestone_count>0` 的报告，复用报告卡片 + 左饰条），置于实体趋势与报告时间线之间。
4. **迁移** —— `ensureColumn` 幂等补列 `report_index.milestone_count INTEGER NOT NULL DEFAULT 0`；旧报告默认 0
   （重生报告才写正确值），**零数据迁移脚本**——与 ADR-0005 同样的「派生表重生即正确」策略。

### 影响

- 改：`schema.ts`（report_index 加列）、`index.ts`（migrate 补列）、`types.ts`（`ReportIndexEntry.milestone_count`）、
  `report-gen.ts`（`isMilestoneInsight`/常量/`buildReport` 计数）、`reports.ts`（saveReport INSERT + rowToIndex）、
  `topics/[id]/page.tsx`（徽标 + 里程碑时间线）、`globals.css`（徽标/卡片样式）。
- 测试：`report-gen.test.ts` 加 `isMilestoneInsight` 真值表（imp 边界 / followup / type）+ `buildReport` 的 milestone_count；
  `reports.test.ts` 加 report_index 往返含 milestone_count。
- **零 analyzer 改、零 LLM、零成本、不触可溯源闸门**；report_index 是唯一 schema 变更点，幂等迁移零回填。

---
