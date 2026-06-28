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

## ADR-0007: 播客接入——抓取已发布转写稿（不自建 ASR）+ 长稿话题制导抽取式选段

- **日期**: 2026-06-19
- **状态**: Proposed（前瞻决策，尚未实现；落地时转 Accepted）
- **评审**: 经**三轮**独立对抗性评审修订。① B1（CHECK 迁移）实测证伪、降非阻塞；② B2（eval 硬门）升前置依赖；红线决策 2026-06-19 定标——**reframe：可达性红线=上报可溯源、由 blocking 守住，不动红线**，transcript 原始可达率降为信息量指标（关闭评审 M-3，见前置依赖段）；③ B3（校验喂全量 body）：首版"topic 选段"二轮否决（validator 链无 topic）→ 改 **citation-locator 邻域窗口**（决定⑤，零 topic 依赖）→ 三轮再揪出该窗口需 validator.ts **内部局部重构**才接得上（locator 在去重结构里被丢、`Ref` 不带它）+ locator 失效退化，**均已在决定⑤ 据实订正、非零改动**；④ Major 6（body 切换使旧引用失效）升 Blocker。**实现定稿（2026-06-20）**：决定⑤=**per-item locator 窗口**（切片4 已实现，比首版 per-pair 更简、`Ref` 无需改）；Major 6=**B 族「只抓新+不降级」并入切片6**（否决 re-analyze/快照）。见各段末与「切片化落地」。

### 背景

当前三个播客源（Practical AI / Risky Business / Darknet Diaries，`defaults.yaml`）走通用 rss 适配器，`parseRss` 仅取 `<description>`/`<content:encoded>`（`rss.ts:19`）——即 **show notes 文字**，质量两极：敷衍单集只剩一句话 + 链接，analyzer 实际无料可炼。瓶颈不是"没有音频处理能力"，而是"没吃到已经存在的文本"：

- Practical AI 母厂 Changelog 把**全部单集 markdown 全文稿开源**（`github.com/thechangelog/transcripts`）。
- Darknet Diaries 官网每集有完整文字稿（`darknetdiaries.com/transcript/<N>/`）。
- Podcasting 2.0 的 `<podcast:transcript>` 标签把转写文件 URL 直接写进 RSS，Apple/Spotify/Pocket Casts 已直读；头部科技播客采用面渐广。

故判断：**不自建 Whisper/ASR**——转写已被发布方/平台做好；自建 = 下载数百 MB 音频 + 小时级转写 + 按时长付费 + 清洗脏稿，当干净全文稿白送时是纯重复劳动。本 ADR 收敛为"抓取已发布转写稿 + 把长稿喂进现有 analyzer/validator 而不破可溯源闸门"。ASR 留作长尾兜底（某播客无任何文字稿、内容又必吃时）。

### 选项与决定

1. **转写发现：扩 `parseRss` 读 `<podcast:transcript>`，金牌源走专用适配器** —— RSS 2.0 分支在取 description 前先查 `item["podcast:transcript"]`（可多个，`asArray`），按 MIME 优先级（`text/plain` > `text/html` > `text/vtt`/`srt`，`rel="captions"` 字幕降级）取 url；命中则 `safeFetch` 该 url（复用 `safe-fetch.ts` 的 SSRF 防护 + `readTextCapped`）→ `body`=清洗后转写、`body_kind='transcript'`；未命中回退 description（`body_kind='show_notes'`）。无 transcript 标签的金牌源（Practical AI→GitHub raw、Darknet Diaries→官网 `/transcript/`）走 source 级专用适配器（按 endpoint 模式映射 episode→transcript URL，在 `index.ts` 按 source 分发）。否决"为播客新增 `source.type='podcast'`"：转写在 rss 流程内发现，type 仍 `'rss'`，零 CHECK 约束改动、零源配置迁移。

2. **长稿管线插点 = 替换 analyze 时的 `truncateForAnalyze` 为话题制导抽取式选段，不动存储 body**（核心取舍）—— 现状 `truncateForAnalyze`（`analyzer.ts:134`）对超 10k 正文取**前缀**，对 arXiv 安全（abstract/导语在前），但对转写**致命**：前 10k 字 ≈ 开场 10 分钟寒暄，正题全丢。改为 `selectForAnalyze(body, topic)`：按 `topic.keywords` 对转写分段（空行/说话人转折/定长窗），打关键词密度分，取分最高的若干**逐字连续段**拼到 `ANALYZE_BODY_CHARS` 预算内。**可达性不变量（修订自评审）**：reachability 真正比对的是**全量存储 body**（`validator.ts:302` `checkReachability` 取 `byId.get(...).body`），与"喂模型的是不是全文"无关——`quote ⊂ 全量 body` 即可达。但选段是**非连续段拼接**，模型可能引用「跨段A末 + 段B首」的句子（在它眼里连续），该 quote 在全量 body 里**不连续 → 不可达**，且 `repairQuote`（`analyzer.ts:114`）以起头为锚只能救「后半漂移」、救不了真跨段拼接（它在段边界停止延伸）。`selectForAnalyze` 在选段间插显式分隔标记（提示模型不得跨段引用）以**降低**跨段拼接概率——但据评审 M-2 据实承认：这只是 prompt 纪律，**降概率非消除**（现有 SYSTEM 已有十余条"逐字宁短勿拼"纪律仍失守，`repairQuote` 的存在即证据）。故**跨段拼接残差会被可达性闸门判 blocked → transcript 的 reachability_pass 必然 <100%**，这是已知必然结果（直接喂前置依赖段的红线讨论），不靠"压到最低"假装消除。`computeLocator` 不变。仅 `body_kind='transcript'` 走 select，article/show_notes 仍走旧 truncate（**零回归**）。否决：① **入库时摘要成 body**——摘要非逐字，validator 可达性全挂，等于拿可溯源换长度；② **滑窗多次 analyze、每窗一调**——每集 N 次 analyzer 调用，成本翻 N 倍，违背降本主线（M3-3）。抽取式制导是"成本基本不变（仍封顶 `ANALYZE_BODY_CHARS`）+ 守住逐字闸门"的唯一组合。

3. **存储：`content_item` 加 `body_kind`，转写正文上限按 kind 放宽** —— `MAX_BODY_CHARS`（`normalize.ts:11`）50k ≈ 45 分钟单集，长访谈（2h ≈ 20 万字）会被截掉尾部，故对 transcript 提到 200k（仅这一类，避免普通正文异常膨胀撑库）；SQLite TEXT 存储廉价，真正的 token 约束由插点② 的 `selectForAnalyze` 兜住。`body_kind` 驱动三处：选段策略（②）、analyzer 渲染 label（"播客转写"提示模型内容口语化、可逐字摘）、人评/排障时区分料源。

4. **抽取式选段用确定性启发（关键词密度），LLM 抽取留后续** —— 与 ADR-0005/0006 同一取向：纯函数、零 LLM、零成本、可无 key 单测。关键词密度选段对"找到主题相关段落"已够用；语义级抽取（指代消解、跨段主题聚合）收益不抵复杂度与成本，留迭代。

5. **一致性校验喂「citation-locator 邻域窗口」而非全量 body（修订自评审 B3；二轮否决了首版"topic 选段"方案）** —— 现状一致性 judge 喂全量 `item.body`（`validator.ts:316,338`），对 transcript = 整篇 200k 发 Opus、每 `(statement, 源)` 对一次，成本随集时长线性膨胀、击穿 brief ≤¥5 成本门（`eval-criteria.md:92`）。

   **首版"validator 重算 `selectForAnalyze(body, topic)` 选段"被二轮评审否决，理由成立**：① validator 整条链（`validateBatch:286` / `runValidation`(`pipeline.ts:34`) / judge 路径只吃 `sourceText:string`，`validator.ts:67,118,159,182`）**拿不到 topic**，要接上得跨 3-4 个函数加 topic 形参——比原问题（能跑只是贵）更糟（编译就接不上）；② 选段按 topic 关键词选，可能漏掉某条结论实际综合的非关键词段，judge 看不到 → 把本该 `not_support` 的放行（`verdictFor`，`validator.ts:44-52`），是**放松幻觉闸门**，非"更老实"。

   **改为 citation-locator 窗口**：validator 在 Pass 1 遍历 `ins.citations` 时**手握每条 citation 的 locator**（`char_start/char_end`，`validator.ts:300-303`）。对每个 `(statement, 源)` 对，取其**所有 citation 的 locator 各 ±N 字邻域并集**当 judge 的 `sourceText`。优势：**零 topic 依赖**（B-1 消解，validator 链无须接 topic）；锚在**真实被引证据**上而非 topic 关键词，且**保证 judge 看到该结论引用的全部证据段**（补偿首版的漏判风险）；成本封顶（窗口×引用数）。

   **⚠️ 实现订正（三轮评审 B-NEW-1，实读证实）**：不是"零签名改造"。当前 `Ref`（`validator.ts:297`）**不带 locator**、`missByItem`（`:309`）只装 statement，judge callsite（`:338/344/358`）喂的仍是全量 body——locator 在去重两层结构里被丢了。落地需 **validator.ts 内部局部重构**（**不跨文件、不需 topic**）：Pass 1 即按 `pairKey(statement,itemId)` 预算好窗口文本、存一张 `Map<pairKey, windowText>`，Pass 2 取 `windowText` 代替 `body` 喂 judge + cache。**这是 contained 重构、非零改动**，须如实写入「影响」。
   **⚠️ locator 失效退化（三轮评审 B-NEW-2，实读证实）**：`checkReachability` 用 fold-equivalent（`compareKey`，`validator.ts:28,37`）判可达，而 `computeLocator` 用**原始** `body.indexOf`（`analyzer.ts:102`）。存在 **fold-pass 但 raw-miss** 的 citation（typography 差异，正是 fold 被引入的动机）→ reachability=pass 不被跳过、却带 `locator=-1`。此时窗口锚在 -1 = 垃圾。**必须定退化**：locator 无效（-1）则该对 judge **退回全量 body**（牺牲成本保校验正确，仅这一类）。另据实承认：窗口太窄会引入 reachability 测不到的一致性**误杀**方向（窗口里看不到远距语境 → 把 support 判 not_support → blocked），不只首版承认的漏判方向；`±N` 下界须由真实跑批定、不预设。

   `consistency_cache` 机制据二轮订正：key = `sha256(version,statement,body)`（`consistency-cache.ts:24`），其 `body` 形参 = **喂进 judge 的源文**；judge 改喂窗口后，传入 `cache.get/set` 的就是窗口文本，**key 自动随之变**（`validator.ts:317,331`）——**无需也无法手动 bump**「schema.ts 注释的 version」（version 由 `consistencyCacheVersion()` 代码侧算，只哈希 prompt+模型+thinking，`validator.ts:263-272`；改注释不失效任何缓存）。副作用：历史 transcript 的全量-body 缓存自然 miss、重校验时触发一轮重判（成本一次性）。**reachability 仍比对全量存储 body（不变）。**

### 理由

- **不破护城河**：抽取式选段保持 body 逐字性 → 可溯源一致性闸门（roadmap 四护城河之一）零损；与 ADR-0005 否决"LLM 综述段"同一逻辑——不拿可溯源换别的。
- **近零增量成本（前提：决定⑤ 的窗口重构落地）**：转写发现/抓取是纯 HTTP（无 LLM）；analyze 封顶 `ANALYZE_BODY_CHARS`，**且一致性校验喂 citation-locator 窗口而非全量 body（决定⑤）**——两端都不随集时长膨胀，单集成本与今日 show notes 同量级。⚠️ **此条依赖决定⑤ 的 validator 内部重构真正落地**：在重构前（judge 仍喂全量 200k body）本条为假、会击穿成本门（评审 B3/M-1 实锤）。无 ASR = 无按时长计费、无 GPU/转写服务依赖。
- **复用既有防护**：抓取任意转写 URL 经 `safeFetch`（SSRF 黑名单 + 大小封顶 `readTextCapped`）+ robots 检查，与现有 rss 抓取同一安全面。
- **优雅退化**：无 transcript 标签 → 回退 show notes（即今日行为）；对未提供转写的播客零行为变化，纯增量。

### 影响

- **改**：`sources/rss.ts`（`parseRss` 读 `podcast:transcript` + 抓取分支；金牌源专用适配器经 `index.ts` 分发；抓 transcript URL 前对**其 origin** 补 `fetchRobots`——与 feed origin 不同，评审 Major 5）、`sources/types.ts`（`RawItem` + `body_kind?` / 可选 `transcript_url`）、`sources/normalize.ts`（`rawToContentItem` 透传 `body_kind`；`MAX_BODY_CHARS` 按 kind 取值；新增转写清洗纯函数 `stripTranscript`——剥 VTT 时间轴/cue 序号/`-->` 行/可选说话人标签，幂等可测）、`agents/analyzer.ts`（`selectForAnalyze` 替换 transcript 分支的 `truncateForAnalyze`，**选段间插分隔标记防跨段引用**；`renderItems` label 区分；`chunkByChars` 不变）、`agents/validator.ts`（**已实现·切片4**——`buildWindowByItem`：用 citation locator 按 **itemId** 建 `Map<itemId,windowText>`（窗口=该 item 全部 citation 的 locator ±N 邻域并集、从全量 body 逐字切片、重叠合并），Pass2 两处 `body` 换 `judgeBody(itemId)`=窗口∥全量；**比首版 per-pair 更简**：windowByItem 另起一遍按 itemId 算，**`Ref`/`missByItem` 无需改**（三轮评审 B-NEW-1 的"去重结构丢 locator"问题随之消解）；locator=-1 退回全量 body（B-NEW-2）；零 topic、不跨文件；cache key 随 judgeBody 文本自动变、无 version bump——决定⑤）。
- **schema**：`content_item` 加列 `body_kind TEXT NOT NULL DEFAULT 'article'`，CHECK in `article`/`show_notes`/`transcript`（**已实测**：SQLite `ALTER TABLE ADD COLUMN` 支持带 `NOT NULL DEFAULT`+`CHECK`，存量旧行取默认 `article`、约束即时生效——评审 B1「迁移加不了 CHECK」经实测证伪），`db/index.ts` `ensureColumn` 幂等补列（沿用 ADR-0006「派生即正确、零回填」——旧行默认 `article`，重采才写真值）；`types.ts` `ContentItem` 加字段。本列**无新表、无破坏性迁移**——但注意：若 Major 6 选方案②（body 快照），则**另需** `citation` 加 `body_snapshot` 列或新快照表，那条迁移不在此列、与本句不冲突但须在 Major 6 处单算（评审 M-4）。
- **配置**：`defaults.yaml` 三个播客源加标记（如 `transcript: true` 或源级 kind 提示）；可选 env `TRANSCRIPT_MAX_BODY_CHARS`(200k) / `TRANSCRIPT_FETCH`（默认 on，故障可一键回退 show notes）。
- **⚠️ 前置依赖（评审 B2，实测确认）——必须先合独立 eval-harness PR，否则功能 PR 永远盖不了章**：现 `evals/run-a1.ts` 把 `reachability_pass >= 1.0`（`L20`/`L176`）作**写死硬阈值**，差一点即 `process.exit(1)` 阻断合并，且 `smoke` 标志压不住硬阈值（`L273`）；回归门只读 `auto_metrics`（arXiv 基线，`L248`）——**「分形态阈值/基线」当前根本不存在**。transcript 因跨段拼接残差（决定②）注定 <100% 可达 → 必被判 FAIL。
  - **✅ 红线决策（2026-06-19 产品负责人定标，关闭评审 M-3）——reframe，红线不动**：`eval-criteria.md:41,49-51` 的「可达性 100%」本质是**上报引用的可溯源底线**（traceability floor），而生产里不可达引用由 validator 判 `blocked`、**结构性不上报**——红线靠 blocking 机制守住，与 analyzer **原始**输出可达率是两回事。`run-a1.ts` 量的是原始可达率（arXiv 干净文本下 ≈ shipped，故历史等价）；transcript 因跨段漂移残差原始 <100%，但残差被 blocked、**上报引用仍 100% 可溯源**。故**不改红线、不破例、无需签字**：那条"0.90"是量错对象（撤回）。**定标**：transcript 形态的「原始可达率」降为**信息量指标**（quality 信号、不作硬门）；硬门改为 ① shipped 可达 = 100%（blocking 保证、对全形态恒成立）② **yield 下限**（漂移挡掉多少引用/洞察，新增指标、防"挡到没产出"）③ 一致性 95% / 幻觉 2% 两条红线对 transcript **照旧硬守**。代价是 yield 损、非可溯源损。
  - 前置 eval PR（**不动功能**）：① `run-a1.ts` 按 `body_kind` 分层——transcript 的 `reachability_pass` 转信息量（不计入 `failed`）、新增 yield 指标、一致性/幻觉门照旧；② `baseline.json` 支持 `transcript` 段自动对比；③ transcript 样本**不进** arXiv 那个 100% 门的池子；④ `eval-criteria.md` 记上面 reframe（红线=上报可溯源、由 blocking 守住）。本功能 PR 排其后。
- **eval（重点，硬触发 eval-gate / L3）**：本 PR 命中 `src/lib/sources/` + analyzer 截断路径 + `defaults.yaml`，是 eval-gate 硬触发项。但**不能拿现有基线直接比**——`baseline.json` provenance 是 **arXiv 单源 + 方案 B 多源**（均书面体），转写是**全新内容形态**（口语、长、auto-gen 噪声、无段落结构、说话人转折），会压三个指标：
  - `reachability_pass`：口语逐字引用更难（run-on、填充词、复述）；`repairQuote` `minLen=24` 是按书面散文调的，对转写很可能需重调。
  - `consistency_ok` / `flagged_rate`：口语反讽/对冲/"我觉得可能"易触 `exaggeration`/`out_of_context`。
  - `non_obvious_ratio`：转写冗长，选段质量直接决定上限。
  - **动作**：给 `evals/dataset` 两集（`insight-quality` / `citation-consistency`）**加 transcript 分层样本**（取真实单集转写，AI 构造标注 + 人工抽检，沿用 `dataset/GUIDE.md` 流程）；`baseline.json` **新增独立 `transcript:{}` 段**（含自己的 provenance），**不混入 arXiv/multisource 段**——否则跨形态对比会假告警；门槛沿用 eval-criteria「任一指标较**同形态**基线降 >3pp 告警」。合入前按 eval-gate 出对比表盖章。
- **🔴 Blocker（评审 Major 6 → Mn-1 升级；落地前必须有方案、不可与功能 PR 同批留待定）**：某集 `<podcast:transcript>` 某天才上线时，body 从 show_notes 切到 transcript → `content_hash` 变（`normalize.ts:71`）→ 走原地 upsert 更新 body（`repos.ts:116-130`，id 不变）。这对采集是好事（自动吃到新转写），但**确定性**触发数据正确性退化：**已发布报告里旧 insight 的 quote 取自旧 show_notes，在新 transcript body 里必不可达**，下次重校验/重生报告时这些引用集体 blocked。这不是"可能"是"必然"，故升 Blocker。方案择一并写死，**两案各有未决坑（评审 M-4）**：① **重 analyze**——body_kind 升级触发该 url 重 analyze、旧 insight 作废重出；坑：采集每轮都跑，须**防重入/重复计费**（同 url 不得反复升级反复重判），且旧 insight 作废要级联清旧 `citation_check`/旧报告引用，须定。② **body 快照**——为历史 citation 冻结其所引 body 切片、`checkReachability` 优先读快照；坑：`citation` 表当前无快照列（`schema.ts:106-113`），**需加 `body_snapshot` 列或新表 + 改 `checkReachability` 取数**，且每 citation 存一份 transcript 切片会显著膨胀库。**落地前必须二选一并连带其 schema/迁移影响一起定。**
  - **✅ 定稿（2026-06-20，深度分析后）——改走 B 族「只抓新条目 + 不降级」，否决 ①重 analyze /②快照**：根因是 collector 对同 url 跨 kind **原地改 body**（`collector.ts:50-57`）。B 族让转写**只对库里没有的新 url 抓**（已存在 item 永不被 show_notes→transcript 原地切换 → Major 6 从根上消失）+ collector **不把 transcript 降级回 show_notes**（已是 transcript 的 item 再采到 description 时跳过；`getContentByUrl` 多返 body_kind 供判断）。**零 schema 改、零选材去重**，且这正是切片6 翻开关必做的「只抓新条目」性能优化——**一刀解决 Major6 + 性能**，翻开关时零 backlog churn。代价：**迟到的转写**（show_notes 已入库后才在 feed 出现的 transcript）不再收（边缘情形，可接受）。需把转写抓取从 `fetchRss` 移到 collector 去重**之后**（只对新 url 抓）。**并入切片6（翻开关）做，不单独成切片5。**

### 切片化落地（2026-06-20）

ADR 实现拆为可独立合入的小 PR，`TRANSCRIPT_FETCH` 默认关贯穿前 5 刀（行为中性）：
- **切片1**（#76）数据模型地基：`content_item` 加 `body_kind`。
- **切片2**（#78）`rss.ts` 读 `<podcast:transcript>` + 抓取 + `stripTranscript`（开关默认关）。
- **切片3**（#80）`selectForAnalyze`（决定② transcript 话题制导选段 + `[…]␟` 分隔哨兵）。
- **切片4**（#81）决定⑤ `buildWindowByItem`（per-item locator 窗口，validator 一致性校验降本）。
- **切片6**（✅ 已上线，「点亮」刀，2026-06-20）——开关仍关贯穿 6a/6b、6c 翻开关上线：
  - **6a B 族重构**（代码、开关关、行为中性）：转写抓取从 `fetchRss` **移到 collector 去重后**——`fetchRss` 只解析 `transcript_url`、不抓；collector 对**库里没有的 url** 才抓转写（`fetchTranscript` 提为 sources 导出 helper、`getContentByUrl` 多返 `body_kind`），并**不降级**（已是 transcript 的 item 不被 show_notes 覆盖）。一举解决 Major6（根除跨 kind 原地改 body）+ 性能（不再每轮抓 50 集）。代价：迟到的转写不收（边缘）。
  - **6b transcript eval 数据集 + baseline 段**（✅ #88）：`evals/dataset` 加 `stratum:"transcript"` 真实样本（2 集 Practical AI 真转写 + 5 一致性对），跑 transcript eval、`baseline.json` 开 `transcript:{}` 段。真机结果：可达 100% / judge 100% / yield 0.692（provisional 小样本，yield 略低于暂定门 0.7，待扩样重标）。analyzer 模型可达性已探明（中转站 opus-4-7/4-8 可用、sonnet-4-6 403）。
  - **6c 翻开关 + 真机验证**（✅ go-live，2026-06-20）：`TRANSCRIPT_FETCH=1` 固化进 `gen-env.sh`（#89）+ 经 SSM 翻生产 `.env.local` 开关 + `force-recreate`；生产实抓真实转写 **HTTP 200 + 合法 VTT**（Practical AI 44KB / Darknet 52KB，AWS 新加坡 IP 未被拦）；红线由已部署 validator blocking 守。collector「只抓新条目」→ 从上线时刻起对新发布剧集生效。
  - **6d 金牌源专用适配器** ——**经 2026-06-20 实测，现有源不需要**：Practical AI（`feeds.transistor.fm/...`）feed 内带 `<podcast:transcript>` **280/362**、Darknet（`podcast.darknetdiaries.com/`）**172/175**，**走标准 6c 路径即可**，无需 Changelog GitHub / 官网 `/transcript/` 专用适配器（本 ADR 早先"这些不在 feed 放标签"的前提已被证伪）。Risky Business（`risky.biz/feeds/...`）**0/100 且 feed/单集页/站点均无转写**——6d 也无从抓起，正确维持 `show_notes`。**结论：6d 对当前 3 源全部 N/A，仅当未来接入"转写在 feed 之外"的播客才需要，本 ADR 范围内不做。**
- **不做**：音频下载、ASR/转写生成、多模态音频输入——均留长尾兜底，本 ADR 不含。

---

## ADR-0008: 数据源管理升级——可达性体检结论 + 差异化调度 / 健康自愈 / 按源抓取策略

### 背景

「加 FreeBuf / 安全客」过程中做了一次**全源体检**（2026-06-20，生产实测 24 源 + 运行历史 + 代码层通用性分析），暴露出**源管理**层一批结构性缺口。本 ADR 是这次体检的结论沉淀 + 改进方向定标，供分批实施（不一次性大改，符合 IPD 流程）。

**体检结论（事实，生产实测）：**

- **可达性整体健康**：22 个启用源现在全部 `200` + 出 feed + 在产出。
- **抖动源**（间歇 failed 但实测可达）：`src_thehackernews`(failed×9)、`src_google_research`(×9)、`src_hn`、`src_arxiv_se`(×7)——多为 FeedBurner / 中转抖动（见 practice-log「Node fetch 代理陷阱」），无退避机制放大了失败计数。
- **可复活源**：`src_bleeping`（停用、06-06 起连挂、0 条），**实测现在 `200`+15 条正常**——当时挂的原因已恢复，可重新启用。
- **死源**：`src_freebuf`（阿里云 WAF 按 IP 拦 `405`，海外 IP 无解，保持停用）。
- **低产出疑点**：`src_owasp_llm`(3 条)、`src_github_eng`(10)、`src_mitre_atlas`(12)——产出极低，疑 feed 稀疏或部分静默失败，待单独核。

**代码层通用性结论（适配器架构评 3/5）：**

- 最强资产 = `RawItem` 中间产物（`sources/types.ts`）把"解析"与"下游归一/去重/落库"彻底解耦，加同族源近零成本。
- 三类短板（下文逐条定标）：① `fetch_interval` 死字段；② 解析/抽取静默失败；③ 适配器接口空挂 + `api` 半开陷阱。

### 选项与决定

按「收益/成本」分优先级；P1 三项打包成「源管理」专题先做，P2 随相关改动顺带，P3 后置。

**决定① [P2，原 P1，评审降级] `fetch_interval` 差异化调度——依赖调度形态拆分，非零成本小切片。**
- 现状澄清（评审修正）：`source.fetch_interval`**无任何调度代码消费**（`agents/scheduler.ts` 无条件全采所有 enabled 源，证实），但这**不是被遗忘的 bug，而是有意取舍且已写注解**：`ops/crontab:6-10` 明确「源 `fetch_interval=6h` 是采集层『想多久抓一次』的**提示**，与 cron 触发频率**无关**——前者描述意愿、后者真触发」。当年 dogfood（2026-06-06）把管线从「每 6h」收敛为「**每日 1 次**」（`0 17 * * *`，"一天 4 份 brief 名不副实"），采集与分析/报告**绑死在同一条日跑管线里**。
- **致命前提**（评审指出）：在「**日跑一次 + 采集-分析-报告一条龙**」的现实下，`fetch_interval` 做「到点二级闸」**没有降流空间**——每天本来就只跑一次，arXiv 6h / 新闻 1h 在「一天一次」面前**全部退化为『每次都到点』**，interval 形同虚设。原 P1 版本假设的「1h 心跳 + interval 二级闸」**与生产实际（日跑）不符**。
- 决定：**先回答「推翻还是承认当年取舍」**。要让 `fetch_interval` 真有价值，前提是**把调度拆成「高频采集 cron（如 1-2h）+ 日频分析/报告 cron」**——采集解耦后高频跑、interval 才有二级闸意义，分析仍日产（不破 dogfood 的「日 brief」收敛）。这是个**调度形态重构**，远大于「加个到点判定纯函数」，故**降级到 P2**、且明确**前置依赖 = 采集/分析解耦**。在调度不拆之前，本决定不动（避免做出"interval 装作生效但实际无效"的假象）。
- 若未来拆调度：解析 `fetch_interval`→ms 纯函数 + 单测；按「最近成功 ingest run 时间 + interval」判到点；skipped 语义须与决定②的零产出看门狗**联合定义**（skipped 既不算 fail、也不进零产出计数，否则误判静默失败）。

**决定② [P1] 源健康闭环——从「被动展示」到「软熔断自愈 + 按源告警」。**
- 现状澄清（评审修正）：`runtime/run-stats.ts` 的 `aggregateSourceHealth` **已算**每源成功率 / 最近成功 / `consecutiveFails`，**且已被 admin 看板消费做展示**（`app/admin/page.tsx:68,76,278`，看板已用 `consecutiveFails>=3` 标红、列问题源计数）。所以缺的不是「计算/展示」，而是**自动处置**——算了、显示了、但没人据此动作。staleness 看门狗（`runtime/staleness.ts`）是**全局**的（管线整体停没停），非按源。**本决定是新增一条控制回路，不是「接通半成品」**（评审纠正：别低估为接通）。
- 决定（评审加固后）：
  1. **软停用 + 半开自愈（取代"硬停用等人工"）**：坏源判据**叠加时间维度**——`consecutiveFails >= N`（默认 12，**调高**）**且**最近一次成功距今 `> K 天`（默认 3）才"软停用"。**关键：软停用 ≠ 置 `enabled=0`**——用新列 `disabled_reason`/`disabled_by` 区分**系统熔断 vs 人工停用**（或复用 `audit_log.actor` 反查）。**人工停用的源系统永不自动改**（避免与人工管理打架）。
  - **半开探测的调度（第二轮评审🔴——原文悬空，须钉死）**：现调度是**日跑一次全管线**，软停用源不进正常采集，那"半开探测"由谁触发?**决定：搭日跑管线的旁路，不引新 cron**——`runScheduledPipeline` 采集阶段对"系统熔断且距上次探测 ≥1 天"的源**额外探一次**（成功则解除熔断、失败则维持），探测在 collector 之外做、不计入正常 ingest 统计。**与决定①口径一致**（不为此新增独立 cron，避免又一个调度面）；这是日跑管线内的一个旁路分支、非新调度形态。
  2. **⚠️ 先补退避（评审指出的根因）**：当前**只有 arXiv 有 429 退避**（`sources/arxiv.ts`），rss/article 无退避——抖动源（thehackernews `failed×9`、google_research `×9`，均 ADR 自己认定的**实测可达好源**）的失败被无退避**放大**。**若不先补退避就上自动停用，上线第一轮就会误杀这两个好源**（原 P1 版 `>=8` 阈值正会误杀，已撤）。故顺序：**先给 rss/article 加失败退避（连续失败→下几轮跳过该源、指数退避），再上软熔断**；退避吸收抖动、软熔断只对"真死 + 久未成功"动手。
  3. **按源零产出看门狗**：enabled 源连续 M 轮 `inserted=0`（最近成功 ingest 距今 > 阈值）→ **按源**告警。专治**静默失败**（feed 变标题党 / 解析返 `[]` / WAF 软封 → 成功率显示 100% 但实则 0 产出——体检里 guid bug、决定⑤的相对 URL 丢条目都属此类被掩盖）。
  4. 告警走已上线的 `runtime/alert.ts`（飞书 + 邮件扇出），文案带源 id + 连失次数 + 最近 error + 熔断/复活状态。

**决定③ [P1] 全文抓取升级为「按源策略」——取代全局开关 + 猜容器。**
- 现状：`ARTICLE_FETCH` 是**全局**开关，且**仅对空正文**触发（`agents/collector.ts`）；正文容器靠 `sources/article.ts` 的 id/class 白名单**猜**，命名外站点（先知社区）回退整页灌噪声。标题党（安全客=空 description）已能处理，但**短摘要**（先知=80 字 summary）不触发、**无容器站点**抽取脏。
- 决定：`source` 表加两列——
  - `fetch_mode TEXT DEFAULT 'feed'`（`feed` = 仅用 feed 正文；`full_text` = 按条目 URL 抓全文）：把"要不要抓全文"从全局猜变成**按源声明**。保留、干净。
  - **`content_container TEXT`（评审修正，原 `content_selector`，可空）：按源覆盖正文容器，值为单个 `class`/`id` token（如 `js-article`、`rich_media_content`），不是 CSS 选择器。**——**理由（design-must-connect-to-code）**：`article.ts` 抽取引擎是**纯正则 + 同名标签深度配对、无 DOM**（注释三次强调极简无依赖）；用户填 CSS 组合选择器（`div.post > article .body`）这个引擎**执行不了、会静默失效**。收窄为单 token 可**直接喂现有 `CONTAINER_PATTERNS` 正则模板**（把该 token 加进容器定位的优先匹配），**零新依赖**。明确**不承诺 CSS 选择器、不引 cheerio**（引 DOM 解析器 = 破坏极简原则，否决）。无明显容器的站点（先知）手填一次 container token 即可，不靠全局白名单猜。
  - 触发条件从「空正文」放宽为「`fetch_mode=full_text` 且正文短于阈值」覆盖短摘要源（先知 80 字），但**仅对声明了 `full_text` 的源**（不波及 feed-only 源、不误伤正常短摘要）。**阈值复用已有 `article.ts` 的 `MIN_ARTICLE_CHARS=200`（评审建议），不新增按源旋钮**——避免正文恰在阈值附近的源每轮抓/不抓抖动。
  - **总闸交互（第二轮评审🟡——须明确，否则收益落空）**：`articleFetchEnabled()`（全局 `ARTICLE_FETCH`，默认关）与按源 `fetch_mode` 的关系——**决定：`fetch_mode=full_text` 的源不受全局总闸约束**（按源声明即抓），否则存量库默认 `ARTICLE_FETCH` 未开 → 决定③上线后先知仍不被抓、收益落空。`ARTICLE_FETCH` 总闸语义改为「**全局应急熔断**」（设 0 时连 `full_text` 源也停，用于一键止血），平时无需开。
  - **container token 注入须按源隔离（第二轮评审🟡）**：`CONTAINER_PATTERNS` 是**全局共用**正则数组，按源 token 若直接 OR 进全局模板（如某站泛 `content`）会**污染对其他站点的匹配**。**决定：抽取时按当前源的 `content_container` 动态构造一条最高优先级正则、置于全局模板之前**，不改全局数组、不跨源污染。
- 对标 RSSHub 的 route 级配置：每源自带抓取/抽取策略，而非全局一刀切。

**决定④ [P1（堵陷阱）+ 后置（注册表）] 落地适配器注册表 + 实现 `api` 类型——随「加新源类型」时重构。**（评审：堵 api 提 P1）
- 现状：`SourceAdapter` 接口（`sources/types.ts`）**定义了但从未用**，`sources/index.ts` 是硬编码 switch；`api` 类型在 schema CHECK / validator 白名单里**允许建源**，但 `index.ts` 适配器直接抛"待实现"→ 用户能建 `api` 源、过校验、每轮采集必抛 failed（半开陷阱）。
- 决定：① 短期**堵陷阱**——`validateSourceInput` 暂时拒 `api` 类型建源（在适配器实现前），避免 UI 建出必败源；② 中期当真要加 JSON API / GitHub API 等新类型时，**用 `Map<type, SourceAdapter>` 注册表替换 switch**，让 `SourceAdapter` 接口真正落地，新类型 = 加一个适配器文件 + 注册一行。**不为重构而重构**：无新类型需求前不动 switch（当前 rss/arxiv 够用），仅先堵 `api` 陷阱。
- 注意：加新 type 仍需同步 schema CHECK（`CREATE TABLE IF NOT EXISTS` 不改存量 CHECK → 需 `ensureColumn` 式迁移）/ validator Set / UI 下拉——这部分的「枚举闭合」成本注册表省不掉，文档记之。

**决定⑤ [P1（相对 URL）+ P2（其余）] 解析鲁棒性补强 + robots 缓存。**（评审：相对 URL 提 P1）
- **相对 URL：`itemUrl` / Atom link 不对 feed base 做 `new URL(link, base)`——评审指出这其实是「静默丢数据」bug**（相对 link → 下游 `new URL(url)` 抛异常 → collector 丢条目，与决定②要治的静默失败同类），故**提 P1（切片1）**：补 feed base 解析。
  - **⚠️ 副作用（第二轮评审🟡A，两轮才发现）**：唯一索引建在 `content_item.url` 上；修复后同一条目 url 从「相对串/异常」变「绝对串」→ 若该源历史上已用旧形态入过库，会以新 url **再存一份**（url 不同、索引不拦）= 一次性重复。当前用相对 URL 的源极少（体检 24 源均绝对 URL），**实际影响面接近零**；但落地时须确认「上线的源里没有正用相对 URL 入库的」，若有则一次性归一存量 url 或接受短期重复尾巴。
- RSS 1.0 / RDF（`<rdf:RDF>` 根）→ 现 `parseRss` 返 `[]` 静默 0 条：加 RDF 分支（P2）。
- robots **每轮每源重拉**（`fetchRobots` 无缓存）：加进程级 `Map<origin, {rules, ts}>` TTL 缓存（决定①降频后压力已小，但全文抓取按文章 origin 各拉一次时收益明显）。
- `media:content` / `enclosure`、非中英语言检测（`detectLanguage` 只分 zh/en/mixed）：记为已知盲区，按真实需求再补（当前源无此需求）。

**决定⑥ [P3，但属"分析质量"而非"便利性"] 跨源去重 / feed 自动发现——当前后置、接入高重叠源即提级。**（评审改理由）
- `content_hash` 当前只做**同 URL** 变更检测，唯一索引建在 url 上 → 同文不同 URL（转载/镜像）各存一份。**评审纠正定性**：对洞察系统而言，跨源去重**不是便利性、是分析质量问题**——重复内容进 analyzer 会**虚高某事件的"热度/共识"信号**（同一篇被 N 家转载 → 误判为「广泛报道的重要事件」），污染洞察排序。
- 决定：**当前源以一手源（arXiv/官方博客/厂商）为主、重叠低，故后置可接受**；但**一旦接入新闻聚合类高重叠源（如多家安全媒体转载同一漏洞通告）须立即提级**。决定②的零产出看门狗可顺带统计跨源标题相似度作为提级触发信号。feed 自动发现属纯便利性，后置。

**决定⑦ [P1-新增，评审最重要遗漏] 按源成本 / ROI——洞察系统源管理的第一性约束。**
- 评审指出：这是个 **LLM 洞察系统**，源管理的第一性约束**不是抓取频率、而是每源每轮的分析花费**。现状只有 **topic 级**成本熔断（`scheduler.ts:155` A5、`runtime/cost-guard.ts` `getBudgetStatus`/`notifyBudget`），**没有按源成本归因**。整份原 ADR 零字谈成本——缺了最贵那一维。
- 真问题：体检里的**低产出源**（`owasp_llm` 3 条、`github_eng` 10 条、`mitre_atlas` 12 条）——它们的条目**每轮仍占用 analyzer 预算**，但产出/被采纳的洞察极少。该回答的核心是：**每源的 cost-per-adopted-insight（单位成本产出多少被纳入报告的洞察）是多少？低 ROI 源是否值得继续每轮花分析钱？**
- 决定：归因**每源 → 贡献的洞察数 / 被采纳进报告数 / 摊到的分析成本**，产出**按源 ROI 看板 + 低 ROI 告警**。
- **⚠️ 归因链现状（第二轮评审纠正——原文"数据已落库"夸大，须诚实）**：
  - **分子（被采纳洞察）可拉通、但口径有限**：唯一真路径是 `citation.content_item_id → content_item.source_id`（即"洞察引了哪些 item、item 属哪些源"）。`insight`/`analysis_batch` 表**本身无 source 维度**（`schema.ts` insight 只有 `source_count`/`multi_source` 计数、batch 只有 `topic_id`），所以"insight→batch→source"这条路**不存在**——只能经 citation 链，且**只覆盖被引用的洞察**。
  - **分母（每源分析成本）无现成数据、须摊派估算**：analyze 的 `run.cost` 是按 `(topic, window)` **批记**的（`agents/pipeline.ts` analyze run target=topic_id），一个 batch 跨多源，**成本无法从现有数据拆到源**——只能按"该源贡献的 item 数 / batch 内总 item 数"**摊派**，这是个**建模假设、不是取数**。（注：`ingest` run 的 target 有 `source_id`、采集成本可按源归因，但采集非 LLM 大头。）
  - 故：决定⑦是**建模/口径设计任务**（先定 ROI 公式 + 摊派口径），不是"拉个现成数"。
- **健康与 ROI 是两个正交维度，不可混（第二轮评审纠正🔴）**：health 坏（连失+久未成功）≠ ROI 低（如 OWASP 权威但稀疏、health 满分 ROI 低）。**决定②的软熔断只读 health 信号、绝不读 ROI**；**ROI 仅产出看板 + 告警供人工决策、绝不自动触发停源**（删去原文"指导自动停启"的自相矛盾表述）。成本低≠不重要。
- 落地依赖：归因口径设计先行，**技术上不依赖切片②③**（citation 链已落库），可独立/并行做。

### 理由

- **多数建立在已有资产上**：决定②复用**已算好**的 `consecutiveFails` + 已上线告警扇出 + 已有 `audit_log.actor`；决定③复用 `article.ts` 抽取 + `MIN_ARTICLE_CHARS`；决定⑦的归因数据（`run.cost`/`insight`/`report`）已落库。**但评审纠正：决定② 是新增控制回路（软熔断状态机 + 退避）、不是"接通"，成本别低估**；决定① 依赖调度形态重构、更非小切片。
- **直击体检暴露的真问题**：死字段（①）、静默失败被掩盖（②的零产出看门狗 + ③的按源抽取）、半开陷阱（④）——都是这次实测/分析**确证**的缺口，不是臆想。
- **对标业界但不过度**：差异化调度（①）、健康自愈（②）、route 级抓取策略（③）、适配器插件化（④）是 RSSHub / Huginn / Scrapy 的核心能力；跨源去重 / 自动发现（⑥）是锦上添花，按自托管单人/小团队规模后置。
- **风险可控**：每项可独立小 PR 合入；决定①②有「跳过/停用」语义，逻辑错也只影响调度不毁数据；决定③加列走 `ensureColumn` 幂等补列（沿用 ADR-0007「派生即正确、零回填」），存量源默认 `feed` 行为不变。

### 影响

- **改**（按重排后切片）：`db/validate.ts`（切片1 ④堵 api、切片2 ③新字段校验）、`sources/rss.ts`（切片1 ⑤相对 URL `new URL(link,base)`；切片5 RDF 分支）、`agents/collector.ts`（切片2 ③按 fetch_mode 触发）、`sources/article.ts`（切片2 ③container token 覆盖）、设置页 `source-form.tsx`（切片2 ③fetch_mode/container 表单）、`sources/<adapter>.ts` + `sources/robots.ts`（切片3 ②失败退避）、`agents/scheduler.ts`（切片3 ②软熔断半开）、`runtime/run-stats.ts` 或新 `source-watchdog`（切片3 ②零产出 + 切片4 ⑦按源 ROI 归因）、`sources/robots.ts`（切片5 缓存）。决定① scheduler 到点判定**待调度拆分后**（P2）。
- **schema**：`source` 加 `fetch_mode TEXT NOT NULL DEFAULT 'feed'` + `content_container TEXT`（决定③，单 class/id token 非 CSS）；决定②的「系统熔断 vs 人工停用」区分可加 `disabled_reason`/`disabled_by` 或复用 `audit_log.actor` 反查（落地时定）。均走 `db/index.ts` `ensureColumn` 幂等补列、存量默认值、无破坏性迁移、无回填（同 ADR-0007 手法）。
- **配置**：`fetch_mode`/`content_container` 进 `defaults.yaml` 源定义（仅对新空库 seed 有意义，存量改 DB——见 MEMORY「DB 覆盖 config 源配置」）；env（决定②加固后）：`SOURCE_CIRCUIT_FAILS`(12) + `SOURCE_CIRCUIT_DAYS`(3)（连失**且**久未成功双条件）、`SOURCE_ZERO_YIELD_ROUNDS`(M)、`ARTICLE_FETCH` 保留为总闸。
- **eval**：本 ADR 改动集中在**采集/调度层**，不碰 analyzer/validator/report-gen 提示与评分 → eval-gate 多为 `skip`（决定③改变入库内容形态时，若影响下游分析，按 eval-gate 评估是否需重测）。
- **不破护城河**：可溯源/一致性闸门不动；决定③抓的全文仍走 `normalizeBody` 逐字清洗 + 下游 validator 同一闸门。

### 切片化落地（评审重排后——按「低风险 + 高价值」真实排序）

原版把"看着小、实则牵动调度形态/误杀风险/引擎重写"的三项排进 P1，真正零风险的反在 P2。评审重排后：

- **切片1（真·零风险，先做）**：决定④ 堵 `api` 陷阱（`validate.ts` 拒建 api 源，5 行）+ 决定⑤ 相对 URL `new URL(link,base)` 解析（治静默丢条目）。无 schema、无行为变化、即时收益。
- **切片2**：决定③ 按源全文策略（`source` 加 `fetch_mode` + **`content_container` 单 token**（非 CSS）两列 + collector 按 mode 触发 + 复用 `MIN_ARTICLE_CHARS` 阈值 + 设置页表单）。落地后**先知社区**等短摘要/无容器源可接入。`ensureColumn` 幂等补列、存量默认 `feed`。
- **切片3（"需重新设计"的 P1，非"接通"）**：决定② 健康闭环——**先**给 rss/article 加失败退避（吸收抖动），**再**上软熔断半开自愈（叠加时间维度 N 次连失 **且** 久未成功，区分系统/人工停用）+ 按源零产出看门狗。**顺序不可颠倒**（不先退避就上停用 = 误杀抖动好源）。
- **切片4（技术上不依赖②③、可并行）**：决定⑦ 按源 ROI——**先出归因口径设计**（分子=citation→source 链/分母=batch 成本按 item 占比摊派，见决定⑦），再实现看板 + 低 ROI 告警（决策信息，**只进看板、不喂决定②软熔断**）。
- **后置（P2/P3）**：决定① `fetch_interval`（**前置依赖：采集/分析调度解耦**——在拆调度前不做，避免"装作生效"）；决定⑤ 其余（RDF 分支 / robots 缓存）；决定⑥ 跨源去重（接入高重叠源即提级）。
- **不做（本 ADR）**：注册表重构（无新类型需求前 YAGNI）；feed 自动发现；ASR；多模态。

### 评审修订记录（第一轮，独立 AI 评审 2026-06-20）

独立架构评审对 v1 的修正（已并入上文）：
- **事实纠错**：① 决定②原称 `consecutiveFails`「无人消费」**错**——已被 admin 看板消费做展示（`admin/page.tsx:68`），实为「有展示、无自动处置」，措辞已改。② 决定①原假设「cron 1h 心跳」**与生产不符**——实为日跑一次（`crontab:11`）且 `fetch_interval` 是有意取舍（`crontab:6-10` 注解），已改为"直面历史取舍 + 依赖调度拆分 + 降 P2"。
- **取舍加固**：决定②阈值 `>=8` 会**误杀** ADR 自认的抖动好源（thehackernews/google_research），已改为"先退避 + 时间维度 + 软熔断半开"；决定③ `content_selector`（CSS）与无 DOM 正则引擎不兼容，已收窄为 `content_container` 单 token（不引 cheerio）。
- **优先级重排**：④堵api + ⑤相对URL 提 P1（真零风险）；① 降 P2（依赖调度拆分）。
- **新增决定⑦（成本/ROI）**：评审指出"LLM 系统源管理第一性约束是成本"，原 ADR 零字谈成本——补按源 cost-per-adopted-insight 维度。
- **定性纠正**：决定⑥跨源去重从"便利性"改为"分析质量问题"（重复内容虚高热度信号）。

**第二轮（独立 AI 评审 2026-06-20，结论 GO + 切片1 可立即实施）。** v2 修正：
- 🔴 **决定⑦归因链"数据已落库"夸大**——核 `schema.ts`：`insight`/`analysis_batch` 无 source 维度，"insight→batch→source"不存在；分子只能经 `citation→content_item.source_id`（仅覆盖被引用洞察），分母（每源分析成本）无现成数据、须按 batch 内 item 占比**摊派估算**。改为诚实口径：⑦是建模任务非取数。
- 🔴 **决定②半开探测调度悬空**——日跑形态下软停用源不进采集，半开由谁触发未定。钉死：**搭日跑管线旁路、不引新 cron**（与①降级口径一致）。
- 🔴 **决定⑦ ROI 与决定②软熔断联动自相矛盾**——health 与 ROI 正交，删去"ROI 指导自动停源"；软熔断只读 health、ROI 只进看板。
- 🟡 决定③ 总闸交互（`full_text` 源不受 `ARTICLE_FETCH` 约束、总闸降为应急熔断）+ container token 须按源隔离不污染全局正则。
- 🟡 决定⑤ 相对 URL 修复改变 url 形态→唯一索引→潜在一次性重复（当前源全绝对 URL、影响≈零，落地核一遍）。
- 切片4 标注「不依赖②③、可并行」。
- **GO 结论**：切片1（堵 api + 相对 URL）真零风险、无🔴阻塞，可立即开做；切片3/4 启动前先消化上述🔴（先出半开调度/ROI 归因口径设计、接上 `pipeline.ts` target 与 crontab 调度形态再开工）。

---

## ADR-0009: 增量分析——消除时间维度的重复分析（analyze 结果复用）

### 背景

2026-06-21 做了一次**全管线成本体检**（生产实测 `run.cost`）。结论：**analyze 占 LLM 成本 84%**（近 7 天 $35.51 / validate $6.56），且暴露一个结构性浪费——**同一条内容跨日被反复分析**。

**事实（生产实测，2026-06-21）：**
- 近 7 天 **19 个 analysis_batch**；统计「同一 content_item 被几个不同 batch 的洞察引用」：被 1 个 batch 引 62 条、2 个 28 条、3 个 17 条、4 个 13 条、5 个 8 条、**6 个 4 条** → 被引证内容**平均被 ~2.2 个 batch 分析**。**注：这只统计了产出引证的；被 `rankAndDiversify` 选中但没产出的同样每轮被重选重析，真实冗余更高。**
- **根因（connect to code）**：`scheduler.ts:runScheduledPipeline` → `selectAnalysisItems(since = now − PIPELINE_WINDOW_HOURS)`（默认 168h/7天）→ `rankAndDiversify(candidates, keywords, limit=PIPELINE_ITEMS_PER_TOPIC=15)`，**无任何「已分析则跳过」**。窗口 7 天 + 每日跑 + 相关性排序稳定 → 今天的 top-15 ≈ 昨天 top-15 → **~50-70% 的 analyze 在重析昨天已析过的内容**。
- **可行性前提（已验证）**：`analyze` 是 **chunk 级**（`chunkByChars` → 每 chunk 一次 `callStructured`，多 item 同喂 → 能产跨条洞察）；但**单源洞察占比 96%**（生产 citation 实测：546 洞察引 1 条 item、16 引 2、8 引 3、1 引 5）。即 **96% 的洞察可归因到单一 item**。
  - **⚠️ 评审纠正（Major 1）：单源「引证」≠ 生成「独立」。** chunk 级分析下，一个 item 产不产洞察、怎么框，会受 chunk 内邻居影响（**新颖性抑制**：同一事件被更新的 item 覆盖时，analyzer 本会压掉重复洞察）。故「96% 单源 → 逐条缓存**基本无损**」是**过度声称**。正确口径：复用旧洞察保证的是**事实可靠**（`content_hash` 守内容未变、quote 仍逐字可达、当初已校验），**风险是冗余/陈旧而非造假**；冗余交由 report-gen 的排序/去重消化（已有机制），并由 eval 对照守底。按条缓存前提**成立但需配冗余治理**，非裸用。

**与 ADR-0008 的关系（用户要求一同考虑）**：本 ADR 与 ADR-0008 同属「管线成本/效率」专题，但**攻不同维度、正交可叠加**：
- ADR-0008 **决定⑦（按源 ROI）**：管「**哪些源/item 值得分析**」（低 ROI 源是否还每轮花分析钱）。
- 本 ADR（增量分析）：管「**同一 item 别跨天重析**」（时间维度去重）。
- ADR-0008 **决定⑥（跨源去重）**：管「**同一内容别跨源重复进 analyzer**」（空间维度去重，防热度虚高）。
- 三者乘性叠加：⑦ 砍源 × 本ADR 砍时间冗余 × ⑥ 砍跨源重复。
- ADR-0008 **决定①（采集/分析解耦、高频采集+日频分析）**：若落地，采集变高频、分析仍日产——**本 ADR 让"日产分析"无论频次都廉价**，两者组合。
- **共享的数据约束**（沿用 ADR-0008 ⑦ 第二轮评审的诚实结论）：`analyze` 的 `run.cost` 按 `(topic, window)` **批记**、无法拆到单 item/源（只能摊派）。故本 ADR 的「省了多少」也只能**按"减少的 analyze 调用数/重析 item 数"估**，不是从 cost 列直接取数。

### 选项与决定

**选项 A：逐条分析缓存（镜像 `CONSISTENCY_CACHE`）。** 按 `(content_hash, topic_id, analyzer_version)` 缓存 analyzer 对该 item 的洞察；内容未变 + 版本未变 → 命中即复用、不调 Opus。版本随 analyzer prompt/模型变自动失效（同 `consistency-cache.ts` 的「模型+prompt 哈希」隔离）。**痛点**：analyze 是 chunk 级、一个 item 的洞察理论上受 chunk 内邻居影响——但 96% 单源使该影响对绝大多数洞察可忽略。

**选项 B：增量选取（只析新进窗 item）。** `selectAnalysisItems` 排除「本主题已在仍有效的旧 batch 里分析过」的 item，只把**新 item** 喂 analyzer；brief = 复用旧洞察（仍在窗的已析 item）+ 新洞察。选取级、非缓存级。**痛点**：丢「新 item × 旧 item」的跨条综合（4% 风险面）。

**选项 C（决定）：A+B 混合 + 跨条综合兜底。**
1. **逐条洞察存储 + 复用（A 核）**：新增「item 分析结果」缓存（见下「关键设计」），键 `(content_hash, topic_id, analyzer_version)`，存该 item 产出的单源洞察。
2. **增量选取（B 核）**：每轮 `rankAndDiversify` 仍对**全量在窗候选**排序取 top-N（保证 brief 覆盖最相关的 N 条，复用+新混合），但**只对其中缓存未命中的（新 item / content_hash 变了的）调 analyzer**；命中的直接取缓存洞察。
3. **跨条综合兜底（治 4%）**：跨条洞察不进逐条缓存。两条候选路径，落地时选一：
   - **(a) 周期性全析**：每日增量 + **每周一次全窗 full re-analyze**（跨条综合按周刷新，成本仍砍 ~6/7）；
   - **(b) 综合子 pass**：增量时把「新 item + 近期洞察 headline 摘要」一起喂一个轻量综合 pass，让 analyzer 能跨新旧综合。
   - 默认倾向 (a)（更简、风险低）；(b) 留待 (a) 实测综合洞察损失偏高时再上。

### 关键设计（connect-to-code，落地前须接上真实结构）

1. **洞察存储与复用的载体**：现 `insight` 表挂 `batch_id`（每 batch 一套洞察），无 `(content_hash, topic)` 维度、无直接 `content_item_id`（经 `citation` 多对多）。复用需二选一：**(i) 新增 `analysis_cache` 表**（`content_hash + topic_id + analyzer_version → 洞察 JSON`，镜像 `consistency-cache.ts`，最干净、不动 insight 表语义）；**(ii) 让 insight 携带 `content_hash` 并跨 batch 复制进新 batch**（动 insight 表 + batch 语义，复杂）。**倾向 (i)**：新 batch 组装时，命中缓存的 item 把缓存洞察「实例化」进本 batch（新 insight 行、新 batch_id，但跳过 LLM）。**⚠️ 实例化机制须落细（评审 Minor）**：insight 行有 `batch_id` 外键 + citation 行挂 `insight_id` → 实例化要**重生成 insight id + 复制 citation 行**；且校验结果按 batch 存（`saveValidationResult(batch.id)`），复用洞察须**在新 batch 重挂校验判定**——靠 `CONSISTENCY_CACHE` 命中（同 statement+body → 0 成本复判）自然重得，但「validate 仍要对复用洞察跑一遍（缓存命中、近零成本）」这一步不能省，否则新 batch 的洞察无校验记录、report-gen 取不到可溯源状态。即：**analyze 跳过、validate 不跳过（但走缓存）**。
2. **缓存键的正确性**：`content_hash`（已有，`normalize.ts:contentHash`）保证内容变即重析；`analyzer_version` = analyzer prompt + 模型的哈希（仿 `consistency-cache` 的版本隔离），prompt/模型一改全体失效、强制重析（防旧 prompt 的洞察泄漏进新版报告）。
3. **跨条洞察的标记**：缓存只存「citations 全部指向本 item」的单源洞察；多源洞察（4%）不缓存、由 C-3 的兜底路径产出。组装 brief 时去重（同 content_hash 的缓存洞察不重复实例化）。
4. **校验侧顺带省**：复用的洞察其 `(statement, source)` 多半已判过 → `CONSISTENCY_CACHE`（已上线）命中、validate 也跟着省。本 ADR 不改 validator，纯靠现有一致性缓存吃这部分。
5. **选取交互**：`rankAndDiversify` 不变（仍按相关性+多样性对全量在窗候选取 top-N），只在「取到 N 条后」按缓存命中分流（命中→复用、未命中→析）。**保证 brief 覆盖面与现状一致**，只是省掉重复的 LLM 调用。
6. **正确性闸（eval 必做）**：增量产出的 brief 必须与「全析」brief **质量等价**。风险=跨条综合损失（4%）。**eval-gate：跑 A1 对照——同一窗分别用「全析」vs「增量(C)」产 brief，比 reachability/一致性/洞察数/被采纳数**；若增量版洞察数/质量掉 >阈值，回退到周期性全析(a) 兜底或上综合子 pass(b)。**这条是本 ADR 从"省钱"变成"无损省钱"的关键，不可跳。**

### 理由

- **直击 84% 大头的结构性浪费**：实测冗余 ~2.2×（且低估），砍重析 = 砍掉大量重复 analyze **调用**。
  - **⚠️ 评审纠正（Major 2）：~50% 是「砍掉的 item-分析次数」的上界、不是「省下的 token/钱」。** 只析新 item → chunk 变小 → analyzer 的**巨大稳定指令前缀按 chunk 重付**、摊销变差。在当前 **Opus-only 无 cache 中转站**上（`PROMPT_CACHE=0`，relay 不读 cache），小 chunk 会**重付前缀**、吃掉相当部分省幅。**故本 ADR 的实际省幅与杠杆2（prompt caching / 直连 key）强耦合**——caching 开着时（前缀≈1/10 价），增量的小 chunk 几乎不为重付付代价、省幅接近调用数降幅；caching 关着时省幅明显缩水。**结论：ADR-0009 与「拿直连 key 开 caching」叠加才显著，单独上（当前 relay）收益打折。落地前用切片1 实测「前缀占 analyze token 比」定量化此折扣。**
- **建立在已有资产上**：镜像 `consistency-cache.ts` 的版本化缓存模式（已验证可靠）；`content_hash` 派生即正确、零回填（同 ADR-0007 手法）；校验侧白吃现有一致性缓存。
- **不破护城河**：可溯源/一致性闸门不动；复用的洞察当初已逐字校验过，content_hash 守住「内容没变」。
- **与 ADR-0008 正交**：源 ROI（⑦）砍源、跨源去重（⑥）砍空间重复、本 ADR 砍时间重复——同一成本目标的三条独立战线，互不依赖、可分别落地。

### 影响

- **改**：`agents/scheduler.ts`（`selectAnalysisItems` 后加缓存分流）、`agents/pipeline.ts` 或 `agents/analyzer.ts`（`analyze` 前查缓存、命中跳过 LLM、未命中析完写缓存）、新 `db/analysis-cache.ts`（仿 `consistency-cache.ts`）、`agents/report-gen.ts`（brief 组装去重——大体不变，洞察来源透明）。
- **schema**：新增 `analysis_cache` 表（`content_hash TEXT, topic_id TEXT, analyzer_version TEXT, insights_json TEXT, created_at` + 复合键），走 `db/index.ts` 建表；TTL 清理仿 `CONSISTENCY_CACHE_TTL_DAYS`。**不动 `insight`/`citation`/`source` 表**。
- **env**：`ANALYSIS_CACHE`（默认开、`0` 关用于排查）、`ANALYSIS_CACHE_TTL_DAYS`（默认 14，对齐一致性缓存）、`FULL_REANALYZE_CRON`/周期（兜底(a)用）。
- **eval**：**本 ADR 必须过 eval-gate**（改 analyzer 调用路径 → 直接影响 analyze 产出），不可 skip。**⚠️ 评审纠正（Minor）：现有 `evals/run-a1.ts` 是「固定数据集上 analyze→validate 质量」、不做「时序的增量 vs 全析对照」**——后者要在同一多日窗上分别跑「逐日全析」与「逐日增量」、比末日 brief 的洞察集/可达/一致/被采纳。**需新建一个时序对照 harness（非 run-a1 现成能力）**，不是画饼但要单列工作量。作为缓和：切片1「只写不读」阶段可先离线用缓存命中率 + 「命中项的缓存洞察 vs 当轮实析洞察」逐条 diff 验「复用是否等价」，成本低、先验证再上读路径。
- **切片化（建议）**：切片1 = `analysis_cache` 表 + 写缓存（行为中性，先只写不读、验证命中率与内容稳定性）；切片2 = 读缓存分流 + 跨条兜底 + eval 对照；切片3 = 监控（缓存命中率 / 省下的调用数 / 综合损失）。
- **与 ADR-0008 的耦合（评审纠正 Major 3——原"正交可并行"低估）**：概念上正交（砍时间冗余 vs ⑦砍源/⑥砍空间重复），但落地有两处真耦合，须协调而非裸并行：
  - **文件合并面**：本 ADR 改 `scheduler.ts`/`pipeline.ts`，ADR-0008 ②⑦也改 `scheduler.ts` + `run-stats.ts`/新 watchdog → 同文件编辑面，须排序合入或一人统筹（避免 #82 式并行撞车，见 MEMORY「删分支前先确认 MERGED」）。
  - **⑦成本口径联动**：ADR-0008 ⑦按源 ROI 用「该源 item 数 / batch 内总 item 数」**摊派** batch 成本。本 ADR 改变「被分析的 item 集」（只析新 item、复用旧的）→ batch 不再覆盖全部在窗 item → **⑦的摊派分母变了**。两者落地须共定口径：ROI 的成本分母应按「**实际触发 LLM 的新 item**」算，否则复用的旧 item 会被错记零成本或重复记账。建议：⑦的归因口径设计**显式纳入缓存命中维度**（命中=该轮零增量成本）。
- **技术前提已落库**：citation/content_hash/consistency-cache 模式均在产，本 ADR 不引新外部依赖。

### 风险

- **跨条综合损失（主要质量风险）**：4% 多源洞察。由 C-3 兜底 + eval 对照守；若实测损失偏高，周期性全析(a) 是确定性回退。
- **缓存命中率不及预期**：若内容/选取波动大、命中率低，省幅缩水。切片1「先只写不读 + 量命中率」先验证、再决定切片2 是否值得。
- **版本失效抖动**：analyzer prompt 频繁微调会使缓存频繁全失效。缓解：版本哈希只纳入「影响产出的稳定前缀」，小注释改动不触发失效（落地时定哈希口径）。
- **正确性**：复用旧洞察须保证 content_hash 严格一致（内容一字未变）——`contentHash` 基于 `normalizeBody`，清洗逻辑一改即全失效重析，安全。

### 评审修订记录（第一轮，独立评审 2026-06-21）

实读 `analyzer.ts`/`scheduler.ts`/`consistency-cache.ts`/schema 核对 connect-to-code，发现 3 Major + 3 Minor，均已据实修订（非推翻、是收口诚实化）：

- **Major 1（已纠正）**：「96% 单源 → 逐条缓存基本无损」混淆了「单源**引证**」与「生成**独立**」。chunk 级分析下 item 的洞察受邻居影响（新颖性抑制）。改口径为「复用保证**事实可靠**（content_hash + quote 逐字 + 已校验），风险是**冗余/陈旧非造假**，冗余交 report-gen 排序去重 + eval 守」。
- **Major 2（已纠正）**：~50% 是「砍掉的分析次数」上界、非省下的 token。只析新 item → chunk 变小 → analyzer 巨大前缀**按 chunk 重付**；当前 Opus-only **无 cache** relay 上会吃掉大部分省幅。**本 ADR 收益与杠杆2（prompt caching/直连 key）强耦合**，叠加才显著，单独上打折。已标注 + 切片1 量化前缀占比。
- **Major 3（已纠正）**：与 ADR-0008「正交可并行」低估耦合——① 同改 `scheduler.ts`/`pipeline.ts`（合并面，须排序合入）；② 本 ADR 改「被分析 item 集」→ 改变 ⑦按源成本摊派的分母，须共定口径（ROI 成本分母按「实际触发 LLM 的新 item」算、显式纳入缓存命中维度）。
- **Minor（已纠正）**：①「实例化进 batch」须重生成 insight id + 复制 citation + **validate 不跳过但走缓存**（否则无校验记录）；② eval「全析 vs 增量」非 run-a1 现成能力，需新建**时序对照 harness**，切片1 阶段先用「命中项缓存洞察 vs 当轮实析」逐条 diff 低成本先验；③ 省幅 ~50% 待切片1 实测命中率定。
- **Nit**：`consistency_cache` 是 1 判定/键、`analysis_cache` 是 N 洞察/键——「镜像」指版本化+TTL+首写定模式，非值形态，已在关键设计1澄清。

**结论：可作为实现依据，但须按上述修订执行**——尤其（a）切片1「只写不读」先量化命中率 + 前缀占比，用真数据校准省幅再决定切片2 是否值得；（b）与 ADR-0008 ②⑦合入排序 + ⑦口径联动须事前对齐；（c）落地必过新建的时序 eval 对照。本 ADR 的价值不取决于「单独能省多少」，而在于**与杠杆2（caching/直连 key）叠加后的数量级降本**——两者应作为同一「analyze 降本」工程统筹推进。

### 落地校准（ADR-0008 完成后，2026-06-22）

ADR-0008 长线完成（#93–101）后，按其**实际落法**校准本 ADR 的两处假设：

- **前置闸1（等 ADR-0008 落地）✅ 已满足。** 健康自愈/按源全文/相对 URL 均上线。**关键：ADR-0008 改的是 collect 阶段（源熔断/半开/零产出/全文抓取），未碰本 ADR 的 `selectAnalysisItems`/`rankAndDiversify`** → M3「文件合并面」撞车风险消解，rebase 当前 main 即可。本 ADR 冗余前提**仍成立**（`selectAnalysisItems` 仍无「已析跳过」、调度仍日跑一条龙——决定① fetch_interval 差异化调度未做、P2 后置）。
- **M3「⑦成本口径联动」已 moot。** 评审 M3 当时担心「增量改了被分析 item 集 → 改 ⑦ 的成本摊派分母」。但 **ADR-0008 ⑦ 实际降级为「按源贡献计数」**（`repos.ts:sourceContribution` = 每源被引证的 distinct 洞察数，**计数口径、非均摊**，multi-source 各计 1 护稀疏权威源），**精确成本摊派被明确否决**（spec：「统计无效已否，真要做先 validate 归因、非 analyze char」）。故本 ADR 实现**无须与 ⑦ 共定成本分母**——反印证本 ADR 背景里「analyze `run.cost` 批记、拆不到源」的判断。
- **剩余唯一前置 = 直连 key（杠杆2）仍挡 big win**，但**切片1（只写不读、量命中率+前缀占比）不需要 key、闸1 开后即可独立起**——是当下解锁的、零外部依赖的第一步。
- **顺带**：⑦贡献列（#101）已合**但未部署**，下次任意部署随之上线；部署后 admin 看板可见按源贡献，与本 ADR「低产出源每轮仍花分析钱」相互印证、辅助决策。

### 切片2 决策校准 + 切片2a 落地（2026-06-27）

**先量后建——切片1 真数据校准了切片2 的省幅（数字支持，继续建）**：
- **稳态命中率（生产切片1，自 06-22 收 ~3 满天）= wouldHitRate 37.3%**（远高于早期 1 天的 10%，随 7 天窗填满朝 ADR 猜的 50-70% 爬）；41.6% 内容至少复析 1 次；每日仅 8-15 条真新。**冗余前提实锤、非被证伪的假设。**
- **前缀占比（实测代码）= SYSTEM 1349 tok + 脚手架 ≈ 1400 tok/chunk，占满 chunk 输入 15.7%（半满 27%）+ 未计的历史事件清单**。即 Major 2 的「前缀重付」折扣**中等、非吃光**：当前 relay 净省估 **~20-26% 总 LLM 成本**（37% 调用降 − ~16% 前缀拖累），有直连 key + caching 时逼近满 37% + caching 的更大奖。**当前 relay 就有真省，故继续建；big win 仍待 key。**

**切片2a（读路径地基，行为中性·flag 默认关）已实现**：
- `analyzerCacheVersion` 纳入 `ANALYZER_OUTPUT_VERSION`（review m3：schema/派生变也失效，非只 SYSTEM）。
- `lookupCachedInsights`（按 content_hash 分流命中/未命中）+ `instantiateCachedInsights`（复用洞察重生 id、保 event_id 稳定身份、按当前 history 重判 is_followup）。
- `runAnalysis` 接入，gated `ANALYSIS_CACHE_READ`（**默认关**）——开则只析 miss、命中复用、validate 不跳（reachability 重算 + consistency 走缓存）；关则与现状字节一致。
- **M1 防御（独立评审 Major）**：缓存键按 content_hash 但被引 id 是原始 item——同内容换 id（同步源/re-fetch 新 id/原 item 滑出窗）时复用会断引被静默丢；故仅当全部被引 id 在当前窗内才复用、否则退回重析。单测覆盖。
- eval-gate：**skip**（flag 默认关 → analyze 输出字节不变；run-a1 直喂 items、不经 pipeline 读路径；版本串变只重置度量缓存、不碰 LLM 输出）。

**剩余**：切片2b = **时序 eval 对照 harness**（run-a1 做不了——同多日窗「逐日全析 vs 逐日增量」比末日 brief 洞察集/可达/一致/被采纳，守跨条综合 4% 损失）；切片2c = 开 flag + **周期性全析兜底**（跨条综合按周刷新）+ 生产灰度验证。切片2a 是 2b/2c 的安全地基，本身不改生产行为。

### 切片2b 落地——时序 eval harness + 首跑结论（2026-06-27）

**`evals/incremental-analysis-eval.ts`（新建）**：同一窗口「全析 vs 增量」对照——把每 case 的 items 按 published_at 排序，older 60% 当「已缓存」（seed=单独 analyze 模拟前几日产的缓存洞察）、newer 40% 当新 item；全析 analyze(all)、增量 lookupCachedInsights→analyze(miss)+复用缓存；比洞察数/**多源(跨条综合)**/可达/一致/被采纳。复用真生产构件（lookup/instantiate/recordAnalysisCache），content_hash 按真 `contentHash` 派生。`INC_EVAL_CASES=N` 控成本。

**首跑（committed `insight-quality.jsonl` 5 case，opus-4-7 析 / opus-4-8 校，$5.35）**：
- **跨条综合净损失 = 0**（全析多源 0 → 增量多源 0，5 case 全 0）——ADR 主忧的「4% 多源损失」**实测未现**。
- 洞察数「保留率」**2 case 72.7% → 5 case 126.7%**（增量反而更多）——**这指标是 LLM 噪声、非质量信号**（chunk 大小影响拒答率 + 全析大批的新颖性抑制 vs 增量小批不抑制）。**别拿原始洞察数当判据**；多源-delta + 被采纳才是质量门。
- 被采纳（≥1 pass 引用、可溯源）：14 → 16，持平偏好。

**诚实 caveat（关键）**：committed 数据集是 arxiv 重、**本身 0 多源洞察** → 无法在「真有跨源综合」处压测损失。即「0 损失」一半是「这数据本就没综合可丢」。但这与 ADR-0011 实测「多源综合结构性稀少（~1.5%）」一致——**跨源综合损失在生产里本就小**。另：本 harness 的 seed 单独析 cached（比生产「前一日全窗」更弱）→ 是**保守(worst-case)估计**，生产实际更好。

**对 2c 的判读**：证据（多源损失 0 + ADR-0011 综合稀少 + 被采纳持平）**倾向「增量质量等价、可灰度」**，但 caveat 未消（无真综合用例压测）→ **2c 必带周期性全析兜底**（每周全窗刷新捞回偶发跨源综合）作安全网，并在生产灰度时盯被采纳/多源数。若将来要更硬的证据，需拉一个**真含多源洞察的生产窗**喂本 harness 压测。

### 切片2c 落地——周期全析兜底 + 启用（2026-06-28）

**决策：合成压测(b) 不做，改用「生产灰度 + 监控」当更硬的 eval。** 理由：slice 2 真实风险 =「需新×旧 item 综合才出的洞察」被丢，但跨天 old×new 综合**稀中之稀**（多源本 ~1.5% + 不复报已压跨天复报），合成压测大概率测不到东西；生产灰度用**真数据 A/B**（增量日 vs 全析日的多源/被采纳数）远胜合成，且 `ANALYSIS_CACHE_READ=0` 是**一秒 killswitch**（env 即时生效不需部署）、周期全析把损失上界钉 ≤1 周——三重安全网下灰度即正解。亦合 ADR 切片3（监控）+ 本项目「数据驱动决策有时要先部署能产数据的东西」纪律。

**代码（行为中性·读路径仍默认关）**：
- `isFullReanalyzeToday(now)`（analysis-cache.ts）：默认每周一（UTC dow=1）全析；`FULL_REANALYZE_DOW` 0–6 可调、-1/非法关闭兜底。可注入 `now` 单测。
- `runAnalysis`：读路径条件改 `analysisCacheReadEnabled() && !isFullReanalyzeToday()`——**读已开且非全析日**走增量，全析日临时绕过读路径全量析（捞跨条综合）。读路径关时此判无影响（行为中性）。
- 注：周期全析当日 `recordAnalysisCache` 照写（存量键首写定不覆写、单源洞察内容稳定、新 item 入缓存）；全析的价值在「当日全 brief 含跨条综合」，非刷缓存。
- eval-gate：**skip**（`ANALYSIS_CACHE_READ` 仍默认关 → analyze 输出字节不变；isFullReanalyzeToday 仅在读开时生效；run-a1 不经 pipeline）。

**启用与灰度（运维步，本 PR 合入后）**：① 部署带上 2a/2b/2c 代码；② 生产 `.env.local` 设 `ANALYSIS_CACHE_READ=1`（FULL_REANALYZE_DOW 取默认周一）；③ 监控：连续几日查每 batch 洞察数/多源数/被采纳数 + `analysisCacheStats` 命中率 + analyze `run.cost` 降幅，对比启用前；④ 退化即 `ANALYSIS_CACHE_READ=0` 关、不需部署。**降本（~20-26% 总 LLM 成本）在此步才真正生效**——前面 2a/2b 都不动生产。

**至此 ADR-0009 收官**：切片1（度量）→ 切片2a（读地基）→ 2b（eval harness 验证）→ 2c（周期兜底 + 灰度启用）。big win（叠加 caching/直连 key 逼近满 37% + caching 更大奖）仍待拿到直连 key 时统筹。

---

## ADR-0010: 分类体系重构——topic（实体）+ archetype（行为 profile）+ facets（分面标签），取代刚性 industry

> 本 ADR 是重写版（替换初稿）。初稿（domain/topic + tags）经两轮独立评审暴露根本问题：把「组织/行为/路由」三件事混在一根刚性 industry 轴上、且为 1 个主题预埋分类学（YAGNI）。本版按业界最佳实践重构，并让落地由当前真痛点（产业主题离题入料）拉动、每步交付真价值。

### 背景

新增「AI 产业动态」（t_ai_industry，#105）塞进 `industry=ai-swe` 暴露现有分类的结构性问题，根因是 **`industry` 一根刚性轴在干三件互不相干的事**：

- **① 路由**（哪些内容进哪个分析）——实际**不靠 industry**，靠 `source.topic_ids` → `content_item.topic_ids` → `repos.ts:listContentForTopic` 的 `topic_ids LIKE`。industry 一字不进路由。
- **② 行为差异**（这主题要不要不同的采/筛/选材/评判）——散落在全局 env（`PIPELINE_WINDOW_HOURS`/`ANALYZE_BODY_CHARS`）、源级注册表（`podcast-golden.ts`）、`run-a1` 的 per-stratum 门、`scheduler.ts:rankAndDiversify`，**无一等概念统起来**。
- **③ 组织展示**（用户/运营怎么浏览主题与报告）——industry 用于 report 库 faceted 筛选（`reports.ts:395` 的 `industry=?` + `report_index.industry`）、admin 分组、brief 头部标签。

`industry` 自身三病：**刚性枚举**（`source`/`topic` 两表 DB CHECK，加值须重建表）、**单亲树**（一 topic 只挂一 industry，放不下跨域的「产业动态」）、**混了组织与行为两份工作**。

**当前真痛点（本会话 2026-06-21/22 生产实测，待补 practice-log 锚点）**：横向主题（产业动态）天生宽、低命中——`openai_news` 0% 被引、HN 2%、转写 yield 0.69，与垂直主题（arxiv_se 21%/arxiv_cr 17%）的处理口径完全不同。且第二轮评审挖出机制根因：`scheduler.ts:79` `rankAndDiversify` 的**无条件短路**（候选 ≤ limit 即整池放行、相关性打分都不跑）——低命中窄主题的离题内容**绕过相关性逻辑直接进分析**。

### 业界最佳实践（本 ADR 据以设计的 4 原则）

1. **分面分类（faceted classification）取代单亲树**——Ranganathan → 现代电商/CMS/Feedly：真实事物沿多个**正交维度**归属、常跨类，刚性单亲树必破 → 用「若干正交 facet、受控词表、可多值」治跨域。
2. **「是什么」与「怎么行为」彻底分开**——Stripe（`type`+`metadata`）、Notion（template+properties）、K8s（`StorageClass`/`PriorityClass`）、Datadog（monitor type）：成熟系统从不把归类与行为塞进一个字段 → archetype（行为）与 facets（组织）分立。
3. **行为差异用命名策略预设（profile）+ 引用，不用散落 if**——云厂商 instance family、K8s 的 *Class（策略模式）：命名预设、资源引用之，加预设 = 加配置不动骨架。
4. **可演进的受控词表放配置/引用，不放 DB CHECK**——reference-data 模式。CHECK = 每加值迁移（industry 的病，第二轮评审 M-new-1 警告 archetype 别重蹈）。

### 选项与决定

- **选项 A**：industry 改 app 校验 + 加 ai-industry。只治刚性，没治「混三件事/单亲树」。
- **选项 B（初稿）**：domain/topic + archetype + tags。方向对但把行为落点接错代码（yield 门运行时不存在、源级筛子无 topic 上下文），且为 1 主题预埋（两轮评审记录见末）。
- **选项 C（决定）**：**把分类拆成三件正交的事，各用对的模式**：
  - **`topic`（实体，不变）**：分析/出 brief 的功能单元，路由仍 `source.topic_ids`。
  - **`archetype`（行为 profile，策略预设·配置驱动·1:N）**：命名策略对象，捆绑该类主题的采/筛/选/评策略；topic 引用其 key；**词表在 config、app 校验（不用 DB CHECK）**。
  - **`facets`（分面标签，受控多值·M:N）**：取代单值 industry 的组织/筛选；首个 facet = `domain`（学科域，可多值、容跨域）。

### 关键设计（connect-to-code）

**1. archetype = 行为 profile（策略预设）**
- `topic.archetype TEXT NOT NULL DEFAULT 'deep_vertical'`，走 `db/index.ts:ensureColumn` 补列（**同 `fetch_mode`/`body_kind` 已实测可加 NOT NULL DEFAULT 列**，index.ts:62-77）、存量默认不变。
- **profile registry 落代码常量**（统一落点，回应 R1-M3「config vs 常量」矛盾）：`lib/topics/archetype.ts` 导出 `ARCHETYPE_REGISTRY`(key→profile) + `ARCHETYPE_VALUES`(校验集，`validate.ts` 仿 `INDUSTRY_VALUES` 用之，**app 校验、不用 DB CHECK**——加型零迁移)。**为何代码常量而非 config**：profile 是行为策略（代码/政策）、非用户数据；`topic.archetype` 这个**值**仍随 topic 落 DB/defaults.yaml（同 topic 数据），但 profile 的**旋钮**在代码——免把 config 穿过纯函数 `rankAndDiversify`。
- 每型 profile 的**真正差异化**旋钮：

  | profile 旋钮 | `deep_vertical` | `horizontal_pulse` | 消费点 |
  |---|---|---|---|
  | **相关性策略** | 软（保留兜底补齐） | **硬：score==0 落选 + 跳过兜底补齐** | `scheduler.ts:rankAndDiversify` |
  | 选材窗口/预算 | 默认 | 可放宽窗/收预算 | `PIPELINE_WINDOW_HOURS`/`ANALYZE_BODY_CHARS`（后续，v1 留全局） |
  | 默认排期 | daily | 可 weekly | `topic.brief_schedule`（后续） |

  ~~eval 口径 by archetype~~ **删**（回应 R1-B1：run-a1 不分 topic/archetype、且绕过选材层，无处可绑）。
- **profile 注入链（回应 R1-M3，须画出）**：`selectAnalysisItems(db, topic, opts)`（有 topic ✓、但不读 config）读 `topic.archetype` → 查 `ARCHETYPE_REGISTRY` → 取 `relevanceFloor` → 传入 `rankAndDiversify(candidates, keywords, limit, { relevanceFloor })`。**rankAndDiversify 函数签名要变**（多收 profile 参）——这是 Step1 骨架。
- **archetype 不另造闸、而是参数化 rankAndDiversify**：① **全局修短路 bug**（`scheduler.ts:79` 候选 ≤ limit 时也跑打分，对所有主题都好、**可独立 commit/回退**）；② `relevanceFloor` 由 profile 给。
- **⚠️ 硬下限语义须裁决（回应 R1-B2，与现有兜底冲突）**：现 `rankAndDiversify:72-73,98-106` 设计是「不硬过滤 0 命中、由多样化兜底补齐捞回」。**裁决：horizontal_pulse = 过滤 score==0 且 跳过兜底补齐**（宁可少喂、不喂离题，代价 brief 可能偏薄、可接受）；**deep_vertical 保持现状（含兜底）**。
- **⚠️ 硬下限效力有限、不夸大（回应 R1-M1）**：`relevanceScore`（scheduler.ts:64）是 title+body 子串命中**计数**、无字段权重/密度。「score==0 落选」**只砍完全不沾边的纯噪声**——对 openai_news 这种「必命中 OpenAI/GPT 但内容离题（健康/化学）」的**沾边离题无能为力**。**Step1 的相关下限是「砍纯噪声」、非「治沾边离题」**；后者要更细阈值（命中数 ≥N？title 加权？）+ 数据定参，列为 Step1 开放设计点、用单测/离线样本定，不默认 ≥1 就够。
- profile 在**分析层**消费、不在采集层——回应 M1：`podcast-golden` 源级（无 topic），一源喂多主题、采集层无「源的 archetype」可问。

**2. facets = 分面受控标签（取代 industry）**
- **字段改名 `topic.facets`（非 `tags`，回应 R1-M2）**：`tags` 已被 `ContentItem.tags`/`Insight.tags`/`report_index.tags`(schema.ts:190) 占用，`topic.facets TEXT DEFAULT '[]'`（JSON，元素 `"domain:产业"`，前缀消值歧、改名消列名/概念歧）。domain 词表落代码常量（同 archetype，app 校验）。
- industry 迁移消费点（全，回应 R1-M2 补 NOT NULL/白名单）：① `report_index.industry`（`schema.ts:184`，**NOT NULL** + `reports.ts:43-46` INSERT 写死）→ **Step2 须定：留列派生 or 改 schema 迁历史行**；② `reports.ts:395` faceted 筛选（等值 `industry=?` → 包含；其白名单现 import `INDUSTRY_VALUES`，**改后 domain 白名单来源须定**：reports.ts 不读 config → 用代码常量注入）；③ `app/api/reports/route.ts` query；④ `report-card.tsx`/`reports/page.tsx` 展示与筛选项；⑤ `validate.ts` 去 industry、改 facet 校验。**routing 不变**（仍 topic_ids）。

**3. 不变 / 不冲突**
- topic 功能单元、`source.topic_ids` 路由、analyze/validate/report 管线核心、可溯源/一致性闸门——全不动。
- 与 ADR-0008 源级 `fetch_mode`（`collector.ts:67`，采集层 IO）**正交不冲突**：archetype 在分析层、fetch_mode 在采集层、串行不读对方——**二者概念相邻但勿合并**（一源级一主题级）。

### 当前 3 主题归型

| topic（名以 defaults.yaml 为准） | archetype | facets（domain） |
|---|---|---|
| AI 时代的软件工程（t_code_agents） | `deep_vertical` | [软件工程] |
| AI 时代的安全（t_prompt_injection） | `deep_vertical` | [安全] |
| AI 产业动态（t_ai_industry） | `horizontal_pulse` | [domain:产业, cross-cutting] |

> facets 值用前缀消歧：`domain:产业` 是 domain facet 的值；`cross-cutting`（跨域）是一个**独立 facet/标志**，非 domain 值——Step2 落地前统一其表示（回应 R1-n3）。

### 落地次序——诚实拆分（第二轮评审后大改）

第二轮评审证伪「(1b) 当场治产业离题」（M-2：openai 必命中关键词、过不掉 score==0 闸），故把无争议的真价值与待论证的预埋**彻底拆开**：

- **Step 1a｜修 `rankAndDiversify` 短路 bug——现在就做，与 archetype 无关**：
  - line 79 候选 ≤ limit 时整池放行、相关性打分不跑 → 低命中窄主题的离题项绕过筛选。修为「候选 ≤ limit 也跑打分排序」。
  - **真 bug、对所有主题都好、独立小 PR、纯函数单测**。这是本 ADR 当下唯一无争议、该立即落地的一刀。
- **Step 1b｜archetype 机制——决策记录，但建议缓建（见下「(1b) 的 YAGNI 裁决」）**：
  - 完整字段贯通链（回应 R2-B1，注入链原断在源头）：`types.ts:Topic` 加 `archetype` 字段 → `repos.ts` 的 `rowToTopic`/`insertTopic`/`updateTopic` 三处映射 → seed 解析 → `selectAnalysisItems` 读 `topic.archetype` → `ARCHETYPE_REGISTRY` → `relevanceFloor` → `rankAndDiversify(…, {relevanceFloor})`。**漏任一环则线上 undefined、死代码**。
  - horizontal_pulse 语义 = 过滤 score==0 + 跳兜底。**但须加保护（回应 R2-M1）**：① **冷启动 `initial_digest` 阶段豁免过滤**（首报用软策略，否则新横向主题首报被掐空）；② **下限保护**：过滤后不足 K 条则回退软策略，**否则撞 `scheduler.ts:273` 的 `skipped-no-content` → 整轮 0 brief**（不是「偏薄」）。
  - 门禁:`scheduler.test.ts` 四态单测 + **一条 `selectAnalysisItems` 级集成测**（给真 Topic 行、断言 horizontal 的 0 命中被过滤——堵 B1 字段贯通的死代码盲区，回应 R2-m2）。
  - 前端:archetype 下拉须从 `ARCHETYPE_VALUES` 渲染（现 `topic-form.tsx` 的 industry option 是写死字面量——若照搬则「零迁移加型」对前端不成立，回应 R2-m1）。
- **Step 2｜facets 取代 industry**：加 `topic.facets` + domain 词表；迁 topic 侧 industry 五处 + **裁决 `source.industry` 去留（回应 R2-M3，第一轮静默丢失）——建议：source.industry 标 dead 字段、不再校验**（routing 靠 topic_ids、report 的 industry 来自 topic，source 侧分类无消费者）；report_index NOT NULL 处置 + reports 白名单来源。
- **Step 3｜随增长扩（日常）**：加 archetype = 加 REGISTRY + 前端常量一项；加 domain = 加词表一行；零迁移。

#### ⚠️ (1b) 的 YAGNI 裁决（两轮评审反复顶回来的核心问题，正面回答）

两轮评审一致指向：**(1b) 此刻对唯一举证的真痛点（openai 离题）近乎零效**——因为 openai 离题样本必命中关键词、过不掉 score==0 闸；真正能治的是「**沾边离题阈值**」（命中 ≥N / title 加权 / 密度），而那需要离线样本定参、未做。且当前 horizontal 实例仅 1。故 **(1b) 单独上线 = 为一个当前几乎不触发的过滤建一套字段+注入链+UI**。

**裁决（建议）**：
- **(1b) 的 archetype 机制本身不在当下建**——避免「为 1 主题预埋分类学」。
- 真要治 openai，应做 **(1c) 沾边离题阈值**（用 openai/HN 离线样本定 ≥N 或 title 加权）——**这才是解真痛点的一刀**，且它本身**不需要 archetype**（可作 horizontal 主题或全局的一个相关性策略参数）。
- archetype/facets 作为**已确认的目标架构**记录在案（本 ADR 的价值），**触发条件**:出现第 2 个行为差异化主题、或 (1c) 阈值策略需要按主题分化时，再建 (1b) 把策略收成 profile。

**即：本 ADR 落地 = 现在做 Step1a（修 bug）+ 规划 (1c)（治 openai 的真阈值）；archetype/facets 是写入案的方向、按触发条件建。**

### 理由

- **三件事三种对的模式（目标架构）**：实体 + 策略预设（profile）+ 分面标签，均业界收敛的最佳实践；治了 industry 的「混三件事 + 刚性 + 单亲」。这套**方向**经两轮评审确认成立且接代码——作为目标架构记录在案。
- **诚实分离「现在做的」与「记录的方向」（两轮评审收敛）**：当下无争议、该立即做的只有 **Step1a（修短路 bug）+ 规划 (1c)（治 openai 的真阈值）**；archetype/facets 机制是**写入案的方向、按触发条件建**，不为 1 个主题预埋（避免 YAGNI）。
- **零迁移扩展**：archetype/facet 词表走代码常量 + app 校验，加值不动 DB CHECK（吸取 industry 教训）。
- **不破护城河**：路由/可溯源/一致性闸门不动；archetype 只调采/筛/选的尺子；阶段化、可独立小 PR、可回退。

### 影响

- **schema**：`topic` 加 `archetype TEXT NOT NULL DEFAULT 'deep_vertical'`（Step 1，**无 CHECK**，app 校验）、`facets TEXT DEFAULT '[]'`（Step 2），走 `ensureColumn`。industry Step 1 保留、Step 2 迁移。
- **改·Step 1**：新 `lib/topics/archetype.ts`（`ARCHETYPE_REGISTRY` 代码常量 + `ARCHETYPE_VALUES`）、`agents/scheduler.ts`（修短路 + `rankAndDiversify` 加 `relevanceFloor` 参 + `selectAnalysisItems` 注入）、`agents/scheduler.test.ts`（四态单测）、`db/validate.ts`、`db/repos.ts`、`config/defaults.yaml`（3 主题归型）、设置页 topic 表单。
- **改·Step 2**：`db/reports.ts`（faceted 等值→包含 + domain 白名单来源）、`app/api/reports/route.ts`、`report-card.tsx`/`reports/page.tsx`、`report_index.industry`（NOT NULL 处置）、`report-gen.ts` 头部、admin 分组、`validate.ts` 去 industry。
- **eval/门禁（回应 R1-B1）**：Step1 门禁 = `scheduler.test.ts` 纯函数单测（选材层改动 run-a1 不经过、零敏感）；run-a1 仅 deep_vertical 提炼质量回归、行为应不变可 skip。**不把 eval-gate 列为 Step1 必过项**。
- **配置**：archetype profile 在代码常量；`topic.archetype` 值入 defaults.yaml + 生产 DB（运行时源以 DB 为准，见 [[db-overrides-config-sources]]——存量主题归型须改生产 DB，不只 defaults.yaml）。

### 风险

- **硬下限只砍纯噪声、不治沾边离题（回应 R1-M1）**：`relevanceScore` 粗（子串计数无权重）→ score==0 落选挡不住「命中关键词但内容离题」（openai 健康/化学必命中 OpenAI/GPT）。**Step1 不宣称治好 openai 离题**；沾边离题需更细阈值（命中 ≥N / title 加权）+ 数据定参，列 Step1 开放设计点。
- **硬下限误杀（反向）**：阈值过严砍掉有效内容。缓解：`relevanceFloor` 可配、先保守、单测固化四态。
- **rankAndDiversify 改动面**：修短路 + 加 `relevanceFloor` 参触及选材核心——单测覆盖**四态**：「候选 ≤ limit 也打分」「候选 > limit」「horizontal 砍 score==0 且不兜底」「过滤后不足 limit」（回应 R1-B2 补第四态），deep_vertical 保持原行为（含兜底）。
- **facets 迁移（Step 2）**：含 report 库筛选维度（report_index NOT NULL + 等值→M:N 包含 + 白名单来源），比「改展示」重——故后置、单独切。
- **archetype 边界模糊**：「深挖 vs 态势」偶有灰色（如 ai-swe 域的「软工行业周报」= horizontal）。缓解：archetype 在 **topic 层**即容此例外；默认 deep_vertical、按需显式标。
- **过度设计**：当前 horizontal 实例仅 1。缓解：Step1 由真 bug（短路）+ 真痛点（产业噪声）拉动、archetype 是顺带沉淀；Step3 扩展零成本、不靠押注。

### 评审修订记录（第一轮重写版，独立评审 2026-06-23）

实读 `scheduler.ts`/`validate.ts`/`config`/`reports.ts`/`run-a1.ts`/`db/index.ts`/`schema.ts` 核 connect-to-code。**2 Blocker + 3 Major + 小项**，均据实修订（方向不变、把没接上代码的落点纠偏）：

- **B1（已修）**：run-a1 直接喂手挑 `c.items` 给 analyze、**绕过 selectAnalysisItems/rankAndDiversify**，Step1 改的选材层在 eval 链路零执行。**门禁改为 `scheduler.test.ts` 纯函数单测**，eval-gate 从 Step1 必过项移除；删「eval 口径 by archetype」。
- **B2（已修）**：「0 命中落选」与现有 `rankAndDiversify:98-106` 多样化兜底补齐冲突。**裁决：horizontal_pulse = 过滤 score==0 且跳过兜底；deep_vertical 保留兜底**。补第四态测试「过滤后不足 limit」。
- **M1（已修）**：`relevanceScore` 是粗子串计数 → 硬下限只砍纯噪声、治不了 openai「沾边离题」。**删「当场治好 openai 离题」的过度声称**，沾边离题列为开放设计点（更细阈值 + 数据定参）。
- **M2（已修）**：facets 字段**改名 `topic.facets`**（避 `report_index.tags` 同名）；补 industry 迁移真成本（report_index NOT NULL 处置、reports 白名单来源）。
- **M3（已修）**：`rankAndDiversify` 纯函数无 config/topic → **画出 profile 注入链**（selectAnalysisItems→REGISTRY→relevanceFloor→rankAndDiversify 新参、签名变更）；**REGISTRY 统一落代码常量**（非 config，免穿纯函数）。
- **小项**：短路修复标为可独立 commit（解耦 archetype）；ensureColumn 引 fetch_mode 先例；archetype/fetch_mode「相邻勿合并」；「跨域」表示待 Step2 统一。

**结论：方向（三轴正交 + profile 策略预设 + reference-data 词表）经评审确认成立且比初稿更接代码。**

### 评审修订记录（第二轮重写版，独立评审 2026-06-23）

实读 `scheduler.ts`(全)/`repos.ts`/`types.ts`/`reports.ts`/`run-a1.ts`/`topic-form.tsx` 再核。第一轮 5 项确认真落地，但其修订叠加暴露更深问题：**1 Blocker + 3 Major + 小项**，已据实修订，且**触发对 (1b) 时机的诚实裁决**：

- **B-1（已修）**：profile 注入链断在源头——`Topic` 类型/`rowToTopic`/insert-update SQL 均无 archetype，即便 DB 有列、内存仍 undefined → 死代码。**注入链补全字段贯通链 + 加 selectAnalysisItems 级集成测**堵盲区。
- **M-1（已修）**：horizontal 过滤+跳兜底 → 低命中横向主题 `items` 可能为 0 → 撞 `:273 skipped-no-content`、**整轮 0 brief**（非「偏薄」），且与冷启动 initial_digest 相反。**加冷启动豁免 + 过滤后不足 K 回退软策略**。
- **M-2（已修·关键）**：(1b) 对唯一真痛点 openai 近乎零效（必命中关键词、过不掉 score==0）；真解法是 (1c) 沾边阈值、且不需 archetype。**新增「(1b) YAGNI 裁决」段正面回答**：现在做 Step1a（修 bug）+ 规划 (1c)（治 openai 真阈值）；archetype/facets 作目标架构记录、按触发条件（≥2 差异化主题）建，不为 1 主题预埋。
- **M-3（已修）**：`source.industry` 第一轮静默丢失 → Step2 裁决「标 dead 字段、不再校验」（routing 靠 topic_ids、source 侧分类无消费者）。
- **小项**：前端 archetype 下拉须从常量渲染（现 industry option 写死，「零迁移」对前端本不真）；归型表 `cross-cutting` 待 Step2 统一。

**最终裁决（两轮收敛）**：本 ADR 作为**目标架构决策记录**成立、可合入；但**实现层面拆为**——① **Step1a 修短路 bug：现在做（无争议、真价值、独立小 PR）**；② **(1c) 沾边离题阈值：规划做（解 openai 真痛点、不依赖 archetype）**；③ **archetype/facets 机制：写入案、按触发条件建（避 YAGNI）**。即「方向定案、(1b) 缓建」。

### 实现决定（2026-06-23，推翻「(1b) 缓建」）

**用户明确决定现在就建 (1b) archetype 机制**（「我坚持做 ADR-0010」），推翻上文「缓建」裁决——故 Step1 实现 = archetype 行为轴（types/registry/DB列/校验/UI/注入链 + horizontal_pulse 相关性硬下限）。已实现 + 独立 code review（见实现 PR）。两点澄清：

- **Step1a「短路 bug」不单列**：实现期 connect-to-code 核实，`rankAndDiversify` 的「候选 ≤ limit 短路」对 **deep_vertical 实为 no-op**——候选 ≤ limit 时所有项都会被分析（重排序不改被分析集合），单独「修短路」无产品效果；而 **horizontal_pulse 已在 floor 路径内绕过短路**（`relevanceFloor !== undefined` 时不短路、跑过滤），真正需要绕过的场景（低命中横向主题）已覆盖。deep_vertical 短路保留、无害。
- **(1c) 沾边离题阈值仍未做**：本实现硬下限只砍「命中 0 关键词的纯噪声」，治不了 openai「沾边离题」——(1c) 仍后续。Step1 价值 = 落地 archetype 目标架构 + 给横向主题砍纯噪声，**不宣称解决 openai 沾边离题**。
- **Step2（facets 取代 industry）不含于本 PR**，仍后置。

### 实现决定（2026-06-23，Step 2 拆 2a/2b 落地）

Step 2 按「加性先行、迁消费后置」拆两片，均已实现 + 独立评审：

- **Step 2a（facets 字段基座，加性·行为中性，PR #108 已合）**：加 `topic.facets`（受控多值分面 `domain:<值>`）+ 词表常量（`topics/facets.ts`）+ ensureColumn + 派生即正确零回填 + 三道校验 + 设置页 domain 复选框。facets **暂不被消费**（筛/选/路由仍走 industry），零可观测行为变化。defaults.yaml 标 3 主题（含 `domain:ai-industry`——industry 枚举塞不下、立项之因）。
- **Step 2b（报告库筛选/展示迁 facets，行为改变）**：报告库分类维度从「industry 等值」迁为「domain 分面包含」，使 `t_ai_industry` 报告（industry=ai-swe）可作独立 `domain:ai-industry` 域筛选。落点：`report_index` 加 `facets` 列（ensureColumn + 历史行一次性回填 `json_array('domain:'||industry)`）；`reports.ts` 筛选 `EXISTS(json_each(facets))`、`ReportQuery.industry→domain`；`report-gen` 写入端取 `topic.facets`；`api/reports` `?industry→?domain`；报告库下拉/卡片改 domain 标签；`report-card` `CardOmit.industry→domain`。

**两点 connect-to-code 修订 ADR 原计划（计划与代码不符，从代码）**：

- **`source.industry` 不标 dead、不去校验**（推翻原 M-3 裁决「source 侧分类无消费者」）：实读发现 `settings/page.tsx` 按 `source.industry` 分组列源（活消费者，ADR 漏看）。故 source.industry 原样保留。
- **`topic.industry` 降级而非删除**：仍是 facets 的派生锚（`deriveFacetsFromIndustry`）+ 主题页展示字段，故保留为真实字段，仅不再作报告库筛选主维度。

**历史口径 caveat（合「零回填」哲学）**：`t_ai_industry` 历史报告 industry=ai-swe → 回填为 `domain:ai-swe`（非 `domain:ai-industry`），历史行不再校正；**新报告**在生产 `topic.facets` 校正为 `domain:ai-industry` 后即写正确值（部署步：send-command 改生产 DB，同 Step1 archetype 先例）。

- **(1c) 沾边离题阈值仍未做**，独立于 facets，见下「(1c) 关闭裁决」。

### 实现决定（2026-06-24，Step 2c——彻底砍 industry）

Step2b 把 industry 在 report 库**降级**但保留（派生锚 + source 分组）。Step2c **彻底移除**——`facets`/`domain` 成分类唯一事实源。两个保留点的处置（决策点经确认）：

- **source 域改「派生」（Option A，非加 source.facets）**：源不再带分类字段；设置页分组改为「按源的 topics 的 domain 派生」（`sourceDomains(source, topicById)`：源 → topic_ids → topic.facets 的 domain 并集）。**单一事实源、白送修好 openai_news 错标**（其 topic=ai-industry → 自动归「AI 产业动态」组，旧 source.industry 表达不了 ai-industry 才错标 ai-swe）。一源跨多域在多组各现一次；无 topic 的源归「未分类」。
- **派生锚退役**：`deriveFacetsFromIndustry` 删；`parseFacetsOrDerive`→`parseFacets`（纯解析，空/坏 JSON → []）。topic facets 输入**必填 ≥1 domain**（validate + config schema + 表单已有复选框）。
- **DB 列 DROP（Option B）**：`migrate()` 自包含——对带 industry 列的表先把**空** facets 从 industry 回填（`json_array('domain:'||industry)`，`WHERE facets IN ('[]','')` **跳过已设值**→ 不覆盖 Step2b 已校正的 `t_ai_industry=domain:ai-industry`），再 `DROP COLUMN`。守卫「列存在才执行」→ fresh DB 跳过、旧库迁一次、二次 openDb 幂等。列级 CHECK 随列 DROP（SQLite 3.35+），三列无索引/FK 可安全删。source 无 facets → 只删。**无需手动改库**（区别于 Step2b 的 t_ai_industry 手工修，那次已做）。
- **移除面**：`Industry` 类型 + Source/Topic/ReportIndexEntry 的 industry 字段；validate（`INDUSTRY_VALUES` 删、facets 必填）；repos/reports 读写；report-gen 正文 `（industry）`→domain 标签（`facetLabel`）；`ppt-polish` 的 LLM prompt `关注 industry`→domain 标签（缺省回退 topic.name）；设置页/主题页展示；source 表单删行业下拉；schema 三列 + config schema + defaults.yaml。
- **eval-gate**：唯一碰 AI 输出的是 `ppt-polish` prompt（industry→更丰富的 domain 标签 + topic.name 兜底，质量中性偏好）；**不在 A1（analyze→validate）链路**（run-a1 不经过 ppt-polish）→ skip。report-gen 正文是确定性渲染。
- **门禁**：迁移 guard 级测试（ADD industry 列 → reopen → 断言空 facets 回填 + **已设 facets 不被覆盖**（t_ai_industry 防回归）+ 三列 DROP + 二次幂等）；source 域派生单测；facets 必填校验测试。748 通过。

### (1c) 关闭裁决（2026-06-23，离线 eval 证伪 lexical 阈值）

两轮评审把 (1c)「沾边离题阈值」列为治 openai 真痛点的方案（命中 ≥N / title 加权 / 双语词）。**部署 Step1/2 后用生产真样本做离线 eval 验证，lexical 阈值被数字证伪**，故关闭，不建。

**eval**：`evals/relevance-floor-eval.mjs` —— 45 条真样本（生产 t_ai_industry / openai_news 近 30 天，全文计算分数 + 人工标注 on/off-topic）。口径：on = 产业/市场结构事件（并购/IPO/政策/基建/产品发布/平台/合作）；off = 垂直应用（health/chem/bio/edu）+ 客户案例 + 研究/CSR。

**before/after（应保留=on，算 P/R/F1）**：

| 变体 | kept | keptOff(噪声) | dropOn(误杀) | P% | R% | F1% |
|---|---|---|---|---|---|---|
| 当前 floor=1 (sc≥1) | 37 | 21 | 3 | 43.2 | 84.2 | 57.1 |
| 双语 floor=1 (sb≥1) | 38 | 21 | 2 | 44.7 | 89.5 | **59.6** |
| 双语 floor=2 (sb≥2) | 21 | 10 | 8 | 52.4 | 57.9 | 55.0 |
| 双语 floor=3 (sb≥3) | 11 | 3 | 11 | 72.7 | 42.1 | 53.3 |
| titleHit≥1 OR sc≥2 | 22 | 11 | 8 | 50.0 | 57.9 | 53.7 |

**结论（数字实锤）**：
1. **最优 lexical 变体仅比现状 +2.5pp F1**（双语 floor=1），且**噪声一条没少**（仍 21 条）——想砍的离题项（health/chem/客户故事）也含 `openai`/`gpt`，照样过 floor=1。
2. **想砍噪声必须抬 floor，一抬就误杀真新闻**：floor=2 精度 +9pp 但召回 −26pp（误杀 Partner Network/欧盟政策/Michigan 数据中心等 8 条真产业贴）；floor=3 召回崩到 42%。F1 全低于 baseline。**精度天花板 ~52%（再高召回崩盘）**。
3. **根因**：substring 评分分不开「OpenAI 做产业」vs「OpenAI 做医疗」（两者同含实体词）；且关键词中文为主、源是英文 → 只能靠实体名命中；双语词又被 substring 污染（`valuation`⊂evaluation、`sec`⊂secure）+ 漏配（"data center"≠`datacenter`）。

**裁决**：lexical (1c) 不建（ROI 实测 +2.5pp F1 封顶）。**唯一数字上能同时拿高 P/R 的是语义判断**（LLM 判「是否 AI 产业动态」，语言无关）——但那是新管线阶段（成本+延迟+独立 eval），为这点残留（且客户/采用类故事是否算「产业」本身可争议）ROI 偏低。**floor=1 + 主题分离（#105）已解决粗噪声，残留可接受**。语义闸门记为已知天花板、按触发条件（残留显著变多 / 出现第二个语言错配源）再评。eval 作证据留仓、可复跑。

### 后续提议草案（2026-06-24，未定·按触发条件建）：lens 视角轴——把 industry 从 domain 解放

> **状态：草案，不实现**。本节是 facets 维度扩展的方向记录，遵循本 ADR 一贯的反预埋立场（见「(1b) YAGNI 裁决」）——写入案、按触发条件建，不为当前 3 主题预埋。Step2c 刚收官（`facets`/`domain` 已是分类唯一事实源），近期不动词表。

**问题（Step2c 暴露，非新增）**：`DOMAIN_VALUES = ["ai-swe", "ai-security", "ai-industry"]`（`topics/facets.ts`）三个值**不在同一抽象层级**——`ai-swe`/`ai-security` 是技术学科域，`ai-industry` 不是学科、是「用产业/市场眼光看 AI」的**视角**。把视角塞进 domain 词表，是当年 industry「一根轴干多件事」的余孽缩小版（这次混的是「学科」与「视角」两类，而非组织/行为/路由三类）。`t_ai_industry` 的 domain 之所以一直别扭（topic name 与 domain label 同字「AI 产业动态」、`horizontal_pulse` 也只为它而设），根因即此。

**提议**：facets 加第二个维度 `lens`（视角），与 `domain` 正交。

- **`domain`（学科/对象）**：这条内容**关于哪个技术学科**。回归纯学科域。
- **`lens`（视角）**：用**哪种眼光**看它——`technical`（实现/研究/攻防/工程实践）/ `business`（市场/产业/资本/厂商竞争）/ `policy`（监管/治理/合规，**按需，当前无主题拉动→不立**）。
- 两者皆 M:N 多值、可跨；克制原则同 domain：**只在 topic 主体确实横跨时多值，不为偶尔沾边加**（如「AI 时代的软件工程」偶尔聊到「AI 写代码的安全」≠ 加 `domain:ai-security`，否则污染安全域筛选）。

**双轴归类（提议态）**：

| topic | domain | lens |
|---|---|---|
| AI 时代的软件工程（t_code_agents） | `software-engineering` | `technical` |
| AI 时代的安全（t_prompt_injection） | `security` | `technical` |
| AI 产业动态（t_ai_industry） | **见开放点** | `business` |

- **最大红利**：`ai-industry` 不再是 domain 值——它本质是 `lens:business`。domain 词表随之纯化为学科域，`t_ai_industry` 找到正确归属，topic/domain 字面重复消解（topic 携带「AI 时代」语境，domain 只说学科）。

**`ai-` 前缀（顺带）**：现 domain 值全带 `ai-`（`ai-swe`/`ai-security`/`ai-industry`）。一个在**所有取值**里都出现的前缀区分度为零、是噪声——它编码的「整个产品关于 AI」是**产品层恒定前提**，不该下沉进每个域值。提议借本次去前缀：`software-engineering`/`security`。若真做 lens 迁移，顺带改最省（否则每加一个域都要纠结「带不带 ai-」）。

**唯一须拍板的开放点——`t_ai_industry` 的 domain 填什么**（它谈厂商/模型/资本/基建，cross-cutting、不专属某学科）：
1. **`foundation-models`（倾向）**：给它一个真实学科锚点，不破坏「每 topic ≥1 domain」不变量（`validate.ts` 现强制 ≥1 domain），不污染 swe/security 筛选。
2. **多值** `[software-engineering, security]`：诚实声明横跨，但筛选变重、且仍不覆盖「资本/政策」这类非技术内容。
3. **放宽 facet 约束**，允许只挂 `lens:business` 不挂 domain：最简，但要改 validate 的「≥1 domain」校验 + config schema + 表单——动到不变量，不建议。

**connect-to-code（迁移成本，非加性）**：本提议比 archetype（加性、零迁移）重，属**词表迁移 + 维度新增**：
- `topics/facets.ts`：加 `LENS_VALUES`/`LENS_LABELS` + `lensFacet()`；`DOMAIN_VALUES` 改值（`ai-swe→software-engineering` 等）、删 `ai-industry`。
- `report_index.facets` 历史行回填：`domain:ai-swe→domain:software-engineering`、`domain:ai-industry→domain:foundation-models + lens:business`（一次性 migrate，同 Step2b/2c 回填先例；生产 `topic.facets` 经 send-command 改库）。
- `validate.ts`：domain 校验集换值；若引入 lens 必填则加校验（**建议 lens 选填**——只有 business 一个真实拉动，technical 可作缺省，不强制每 topic 标）。
- UI（`topic-form.tsx`）：加 lens 复选框/下拉（从 `LENS_VALUES` 渲染，同 domain）；报告库筛选（`reports.ts` 的 `EXISTS(json_each(facets))` 已是包含语义、天然支持多维度，`api/reports` 加 `?lens=` query）。
- 报告卡片/`facetLabel`：现只解 `domain:` 前缀，须扩展认 `lens:`。

**触发条件（何时从草案转实现）**：
- **强触发**：出现第 3、第 4 个 topic，其差异**沿视角轴**（如「AI 监管动态」=`lens:policy`、「AI 时代的软件工程·商业向」=同 domain 异 lens）——届时 lens 从「为 1 主题预埋」变成「≥2 主题真需要」，与 archetype 当年的触发逻辑一致。
- **弱触发**：报告库用户反馈「想跨域看所有产业/商业向内容」——证明 lens 是真筛选需求而非纸面正交。
- **在此之前**：`ai-industry` 留在 domain 词表（能用、瑕疵不影响功能），lens 仅作方向记录。**当前 3 主题不足以拉动 lens（business 仅 1 例），不建。**

**与既有决策的一致性**：本草案不推翻 Step2c（facets 仍是唯一事实源、industry 仍已砍）——它是在 facets 框架内**加第二维度 + 纯化第一维度的值**，正是 Step2c 时 facets 设计预留的扩展点（「首个 facet = domain」隐含会有第二个）。`archetype` 轴不受影响（行为策略，与 lens 组织视角正交）。

### 实现决定（2026-06-24，推翻「按触发条件建」，现在就建 lens）

**用户明确决定现在就建 lens 视角轴 + domain 去 ai- 前缀**，推翻上文「未定·按触发条件建」（同 (1b) archetype 当初的推翻先例）。已实现 + 全测试通过（754 passed）。落地与草案一致，三处开放点的最终取值：

- **domain 全量去前缀**：`ai-swe→software-engineering`、`ai-security→security`；`ai-industry` 退役为域值，改 `foundation-models`（学科锚点）。
- **lens 选填**：词表 `technical`/`business`（`policy` 未拉动、不建）；未标 lens 视作 technical 缺省。`hasDomainFacet` 守 domain 必填、lens 不强制。
- **3 主题归型**：t_code_agents=`[domain:software-engineering, lens:technical]`、t_prompt_injection=`[domain:security, lens:technical]`、t_ai_industry=`[domain:foundation-models, lens:business]`。

**connect-to-code 落点**：`topics/facets.ts`（domain 改值 + LENS_VALUES/LENS_LABELS/lensFacet/lensValueOf/isLensValue/hasDomainFacet + facetLabel 兼容两维度）；`validate.ts` + `config/types.ts`（每项受控 + ≥1 domain）；`reports.ts` ReportQuery.lens 筛选 + `api/reports` `?lens=` + `reports/page.tsx` 视角下拉/chip；`topic-form.tsx` lens 选填复选框；`report-card`/`report-gen`/`ppt-polish`/主题页经 `facetLabel` 自动显 lens 标签（无需改）。

**自包含迁移（db/index.ts，无需手动改库——区别于 Step2b/2c 的 send-command）**：① 旧产业主题（keyed on `domain:ai-industry`）补 `lens:business`（json_each 判定 + 无 lens 守卫，幂等；只动 topic、report_index 历史行不臆造 lens）；② `topic`+`report_index` 两表 facets 链式 REPLACE 去前缀/改名（三 token 互不为子串、新值不含旧 token → 顺序无关 + 天然幂等）。门禁：reports.test.ts 加「lens 后续迁移」guard 测试（旧值重开→重命名+补 lens+二次幂等）。

**eval-gate：skip**（同 Step2c 理据）——唯一沾 AI 输出的 `ppt-polish` 动态 facet 标签变化不在 A1（analyze→validate）链路；report-gen 正文是确定性渲染。

**残留**：report-gen/ppt 的报告卡片/正文现把 lens 标签也并入「领域」展示行（如「基础模型 · 产业」），未单独区分维度名——可读、暂不细分。lens 多值/跨视角尚无实例（business 仅 t_ai_industry 1 例），同 archetype 当初「实例仅 1」，靠真实主题增长拉动验证。

## ADR-0011: 引用屏蔽诊断——多点综合洞察 vs 整句一致性；per-citation 粒度（方向定案、缓建）

> 状态：**诊断 + 方向决策记录**。ADR-0010 收尾后做「质量迭代」——用生产真数据诊断最大质量缺口，连环证伪多个「简单修」，定位真解为 per-citation 一致性粒度，但 ROI 未到、缓建。

### 背景 / 诊断方法
产品全部上线后转「质量迭代」。**不凭感觉挑要修什么，先用生产真数据诊断**（同 (1c)/ADR-0009 的「先量后建」纪律）。诊断对象：analyzer 提炼 + validator 校验链路的真实产出。

### 诊断过程（连环证伪 = 止损）
1. **跨源综合**（看似最大缺口，~1.5% insight 多源）→ **证伪**：是内容结构（一主题内源互补不重叠 + 同事件多源多属跨主题、被架构分开），非 analyzer 缺陷；强推会逼出「为综合而综合」弱链接。
2. **headline（93% 有）/ coverage（83%）** → **健康**，非缺口。
3. **blocked-rate** → 第一个有清晰复发模式的真缺口，深挖（见下）。

### 数据（生产，2026-06-24~26）
- `citation_check` 1806 条，blocked 223 = **12.3%**；consistency=not_support **91%**（out_of_context 108 / exaggeration 64 / misattribution 31）+ reachability 9%（quote_not_in_source）。
- **影响**：619 洞察中 **67（10.8%）全部引用被屏蔽 → 0 条干净引用可显**；73% 健康（≥1 通过引用）；16% 有 flagged（带警告仍显）。
- 全屏蔽**广布全主题**（t_prompt_injection 31 / t_code_agents 29 / t_ai_industry 7），源分散（hn/latent_space/thehackernews/arxiv/openai/krebs…）→ **非单源 PR firehose，是全局 analyzer 行为**。

### 根因（读 3 条全屏蔽真实例定性）
- **Ex1（连贯论点）**「客户去 Anthropic 风险化：Orosz 建议路由器…有人转 Codex…」——引用各支撑一个分点，被拦因 validator 拿每条对**整句**。
- **Ex3（干净 roundup）**「三星、BBVA、MUFG 同窗口部署 ChatGPT Enterprise」——每家各一条干净引用，纯被整句粒度误拦。
- **Ex2（真过度声称）**「微软72仓库被感染…**与 Risky Business 同一波态势**」——陈述加了没引用覆盖的综合，validator 拦得**对**。

**根因 = validator 一致性判 `(整句, body)`（`validator.ts:282`），对「多点综合洞察」系统性误拦支撑分点的好引用。** 关键：**洞察本身准确、statement 都成立——没 ship 错的或捏造的内容**；这是**校验粒度局限**，不是 analyzer 提炼缺陷，也不是 validator 该松。

### 选项与裁决
- **Fix 1｜标题纳入可达性**：离线验证仅 6/21 reachability blocks 是稳健标题引用（11 条 body 已含=历史漂移、4 条真不可达），净回收 ~3% 且有「可达放行后被一致性二次拦」风险 → **弃**。
- **Fix 2｜atomize（拆原子单事件洞察）**：3 例显示多数是**准确有价值的多点综合**，原子化**毁综合价值** + 碎片化（`non_obvious_ratio` 降）→ **弃**。
- **Option C｜per-citation 一致性粒度**（每条引用对它**所声称的分点**判，而非整句）：**真解**——保综合价值、更精确、还能照拦 Ex2 过度声称。但需 analyzer 标注「引用→分点」+ validator 改判定粒度 = **碰 moat 核心、ADR 级、高风险**。

**裁决：方向定案（per-citation 粒度 = 真解），但缓建。** 理由：① 内容本身准确（非正确性/捏造问题，是显示粒度）；② 为 11% 的「引用显示粒度」改护城河最核心的 validator，ROI/风险不划算；③ 73% 洞察已健康。

### 触发条件（再评 Option C）
可溯源**显示**成为优先级 / 多点综合洞察占比显著上升 / 出现真「ship 错内容」证据（当前无）。

### 顺手可选小项（独立于 Option C）
**防过度声称**：轻推 analyzer「别写超出所挂引用证据的综合判断」（治 Ex2 型）——低风险、轻微降过度声称；改 analyzer prompt 仍命中 eval-gate，须过 A1（fabrication 零容忍）。当前一并缓做。

### 影响 / 风险
- **不动**：~11% 洞察显示时缺干净引用锚（〔待补引〕外露），但**内容仍准确**、护城河「不 ship 错内容」未破。
- **将来做 Option C**：analyzer 输出 + validator 双改，A1 eval 重保 `fabrication_rate=0`、`consistency_ok` 不退、`reachability_pass` 不退。

### 价值（为何记这条）
把「**多点综合洞察 vs 整句一致性**」这对张力、以及 per-citation 是其真解、**钉在案**——避免下次又从「atomize / 标题修」这些被证伪的简单修重走一遍。这一程质量迭代**有据收尾**：诊断清楚、证伪错药、定位真解、ROI 判断留痕。

## ADR-0012: 知识图谱第一步——实体共现图（确定性派生·零 LLM·切片 S1）

> 状态：**设计 + 切片决策记录**。MVP 收口后转「护城河深化」（roadmap 战略备忘）。产品定义核心能力④「知识图谱」显式推后，现做第一步。**先勘察承载面再设计**（同 ADR-0009/0011「先量后建·设计先接上代码」纪律）。用户认可三推荐（d3-force+SVG / 按主题 / 纯共现不占位）。

### 背景 / 承载面勘察（决定建法的关键事实）
代码勘察结论——**节点已有、边没有**：
- **节点 ✅**：`insight.entities` 每条洞察抽 `{name, type}`（type∈`organization/person/project/product`，analyzer rule 11 已要求**规范名跨条一致**、专为聚合设计）；`report_index.entity_names` 报告级反范式；已有聚合 `queryReportIndex({entity})` / `entityTrends` / `distinctIndexValues` / `focus_entities`——实体的「点」「热度」「趋势」都现成。
- **边 ❌**：**全代码库零关系抽取**。「发布/收购/依赖/对立」这类**有向语义边不存在**。

边有两条来路、成本差一个数量级 →**切片**：

| 切片 | 边来源 | 成本 | 风险 |
|---|---|---|---|
| **S1 共现图**（本 ADR） | 同洞察共现两实体连边、weight=共现洞察数。**确定性派生、零 LLM、零新抽取**，全从现有 `insight.entities` 出 | 低（读路径聚合 + 图 UI） | 几乎无；不碰 prompt/模型/数据源 → eval 不受影响 |
| **S2 类型化语义边** | LLM 抽有向关系（新 analyzer 字段或独立 pass） | 高·改分析管线·须过 eval-gate | 改 prompt 命中 A1、成本升 |

**裁决：S1 先行**——节点全现成、只差派生边 + 图 UI，能最快把真图摆面前，用 **dogfood 验证「图到底有没有用、会不会看」**，再决定是否为 S2 的 LLM 语义边投钱。共现图自身有价值（谁和谁总一起出现 = 事件簇/阵营）。

### S1 具体设计

**1. 数据派生（纯函数·不新建表·镜像 `entityTrends` 范式）**
- `deriveCooccurrenceGraph(insights, opts) → {nodes, edges}`：
  - **节点 = 实体**，属性 `name` / `type`（决定颜色）/ `mentions`（提及洞察数，决定大小）。
  - **边 = 共现**：取**洞察粒度**（同一条洞察内两实体）—— 报告级共现太松（一篇 brief 几十实体全互连成糊），洞察级 = 「同一分析判断里被一起提及」才是真关联，且带 `type`。`weight` = 共现洞察数。
- 配单测；**零 LLM、零迁移**（派生于读路径，图小、按页重算，需要再加物化/缓存）。

**2. 节点筛选（图能看清的命门）**
- **Top-N=40**（可调）按 `mentions` 降序，防 hairball；**孤点（无边）剔除**。
- **实体规范化**：rule 11 已推规范名，S1 只 `trim`；变体合并（"OpenAI" vs "OpenAI Inc"）= **已知限制**，留 S2/后续别名表。

**3. 边阈值**：`weight≥2` 默认（滤一次性偶然同现）；UI 滑块可降到 1 看全量。

**4. 视觉编码 + 作用域**：力导向布局；节点大小∝mentions、颜色∝type（4 类 4 色）、边粗∝weight。作用域**复用报告库 facet 口径**（topic / domain / 时间窗过滤进图的洞察集），不另造筛选。

**5. 溯源交互（护城河命门：可点回原文）**
- **点节点** → 侧栏列「提及该实体的洞察/报告」，复用 `queryReportIndex({entity})`，点进报告。
- **点边** → 列「两实体共现的那些洞察」+ 各自 citation 锚回原始 content（与报告同一条全链路可溯源口径）。

**6. 落点**：新 `/graph` 路由（图需整屏，不塞 `/topics/[id]`），顶部 topic/domain/时间筛选、默认当前主题。

### 三叉口裁决（用户认可）
- **叉1 图库 → `d3-force`（仅力模拟，包小）+ 自绘 SVG**：避 React 19 peer-dep 雷、点击溯源完全可控、确定性好。弃 `react-force-graph-2d`（canvas 命中测试要自接 + React 19 peer 未知）。
- **叉2 作用域 → 按主题一张图**（节点数控制在几十、贴现有主题承载面）；全局大图留后续。
- **叉3 → 纯共现、不为语义边占位**（不为未验证的东西留半成品字段，S2 真做时另设计）。

### 切片内分砖（落地顺序）
1. `deriveCooccurrenceGraph` 派生函数 + 单测（确定性、可先离线验证图形状）。
2. API / page 数据层（吃 facet 筛选 → 喂洞察集 → 出 `{nodes,edges}`）。
3. `/graph` 图 UI（d3-force + SVG）+ 溯源侧栏。

### 先量校准（生产真数据·砖①后，2026-06-28）
砖① 派生函数落地后**先拿生产真 insight 量一遍**（SSM 在容器内跑、只回汇总）：**422 条带实体洞察 / 3 主题**。读数（top40/w2）：

| 作用域 | 节点 | 边 | 最大度 | 最大权 | 连通块 |
|---|---|---|---|---|---|
| t_code_agents(244) | 34 | 96 | 17 | 22 | 2 |
| t_prompt_injection(123) | 36 | 46 | 7 | 5 | 9 |
| t_ai_industry(55) | 28 | **78** | **22** | 10 | 3 |

top 实体都对得上各主题真玩家（图有意义非噪声）。**量出两个真问题 → 修进设计：**
1. **密度高度依主题、单默认不通吃**：`t_ai_industry` w2 是准 hairball（OpenAI 度 22/28 近星型），`t_prompt_injection` 反而碎（9 块、maxW 5）。→ **weight 滑块/top-N 是承重非装饰**；初始阈值应自适应。
   - **⚠️ 自适应信号 = 边密度，不是洞察数**（数据自证伪了「w 随洞察数缩放」的初版猜想：ai_industry 仅 55 洞察却比 123 洞察的 prompt_injection 更密 → 洞察数不预测密度）。正解：**升阈值直到边数 ≤ 预算（~60）**。验算：ai_industry w2(78E)→w3、code_agents w2(96E)→w3(52E)、prompt_injection w2(46E)→留 w2，**每主题各得其所**。落为 `pickEdgeWeightForBudget`（砖①，density-adaptive）。
2. **边权值域跨主题差 ~4 倍**（maxW 22 vs 5）→ **边粗必须按「本图自身 maxW」归一化**，绝对值会让低权主题边全细到看不见（砖③ UI）。
> 价值：UI 没动手就避开「全细线」「ai_industry 糊成星」两坑，还当场证伪一个错启发式——印证砖① 先量纪律。

**砖③ 可视化验证（生产真数据离线渲染 + headless 截图，2026-06-28）**：拉生产三主题真 nodes/edges → Node 跑同款 d3-force 布局 → Chrome headless 截图。**自适应阈值实证各得其所**：code_agents w4(96→47E)、ai_industry w3(78E hairball→10E 清爽星)、prompt_injection 保 w2(碎成几簇=该主题真实结构)。**数字先量说"可读"、真渲染却暴露一坑**：硬夹画布把断开/孤立节点全压边缘摞成标签糊团 → 修为 `forceX/forceY` 弱居中替代硬夹 + 斥力 -220→-340 + 碰撞半径 +3→+8，重渲染后各簇散开可读。**再证可视化验证不可省**（数据层 legible ≠ 像素 legible）。

### 影响 / 风险
- **零 LLM、零迁移、eval 不受影响**（不碰 prompt/模型/数据源 → eval-gate skip）。
- 风险：① 引入图库（d3-force 选型即为压低）；② 实体变体未合并 → 同实体可能裂成两点（已知限制、留别名表）；③ 节点规模 legibility（top-N 兜底 + 先量证自适应阈值必要）；④ **共现≠因果**——S1 边只表「共同出现」非语义关系，UI 文案须讲清、别误导成「A 影响 B」。
- **⑤ 图读 `insight` 全表，含未过 validator 校验的洞察**（独立 review 提）：刻意展示「原始分析判断」——共现/溯源是实体关系层、非引用精度层，且 blocked 多为引用粒度问题（statement 本身准确，见 ADR-0011）。**S1 单用户 dogfood（实际仅 owner）可接受**；引入真 viewer / 公开前须按 `citation_check` verdict 过滤到 includable（drill 路由当前仅登录门、非 admin-only）。

### S2 触发条件（再评类型化语义边）
S1 dogfood 证图有用 + 确需有向语义（谁收购谁 / 谁对立谁）→ 才投 LLM 关系抽取（届时过 A1，保 `fabrication_rate=0`）。

### 价值（为何记这条）
把「**知识图谱 = 节点已有、边分共现(确定)/语义(LLM)两档**」这个切片判断钉在案：S1 用确定性派生**零风险验证图的 dogfood 价值**，避免一上来就为没验证的语义边改分析管线、付 LLM 成本与 eval 风险。

### S1.1：关联强度口径（Jaccard，2026-06-28）
S1 上线后第一个优化。**问题**：边权=生频次 → hub 实体（Anthropic/OpenAI）和谁都连，图全是显然的大势、埋掉非显然的紧密对。**解**：加 `metric` 口径切换——`frequency`（默认，按共现次数）vs `association`（按 **Jaccard = cooc/|A∪B|**，∈(0,1]，天然压低 hub）。
- **关键设计**：① **支持度下限 weight≥2** 挡「各出现 1 次恰好同条→Jaccard=1」噪声（关联规则 min-support 原则）；② 两模式**边集不同才有价值**——频次自适应抬计数阈值、关联固定支持度 2 再按 strength 取 top-40（浮出频次埋掉的弱频紧密对）；③ 边粗按当前口径值 + per-graph 归一化。
- **先量证价值（生产真数据）**：association 浮出 frequency 看不见的结构——code_agents 的基准簇(Codex 5.5 High~SWE-Bench Pro)/人物链(Karpathy~Latent Space)、**ai_industry 的「前沿模型对比」clique**(Google/xAI/Gemini/Claude/Grok/安全机构，频次模式被 OpenAI hub 完全淹没)、prompt_injection 的威胁行为者/住宅代理/模型家族簇。可视化验证（离线渲染+截图）：40 边预算清爽不糊。
- 观察：dense 主题关联 top 多 s=1.0/w=2（紧密弱频对）——`maxEdges` 由 60 降 40 更聚焦；用户可调「最小共现」抬支持度。**这是把"共现图"升级成"洞察图"的一步，仍零 LLM、零迁移。**
- **已知限制（独立 review 提）**：候选实体先按 mentions 取 top-40 再在候选内选边——若某紧密对两端 mentions 偏低、在 dense 主题挤不进 top-40，会在算 strength **前**被 mentions 门挡掉（防 hairball 门与"浮低频紧密对"的内在张力）。生产数据下价值已验，非阻断；未来可让 association 模式候选集纳入高 strength 边的端点。

### S1.2：节点→报告导航（2026-06-28）
让图从死胡同变成导航面。**点节点** → drill 改走 `queryReportIndex({topic, entity})` 返回「提及该实体的报告」（标题链进 `/reports/[id]` + 日期/类型）；**点边**保留 S1.1 的共现洞察（statement+引证，精确解释「为何相连」比报告链接更贴切）。移除不再用的 `insightsMentioningEntity`（避免死代码）。
- **图实体(insight.entities) ↔ 报告(report_index.entity_names) 对齐验证（生产真数据）**：各主题 top 实体均命中多份报告（code_agents 7-13/26、prompt_injection 2-4/22、ai_industry 2-5/5，无一为 0）→ 导航有效。niche 实体可能 0 报告，drill 优雅兜底「无已发布报告提及」。
- 注：报告导航天然只显**已发布报告**——与 ADR 风险⑤（图本身含未过校验洞察）形成互补：图给全貌、点进只到已发布。仍零 LLM、零迁移。

### S1.3：节点 drill 显「关于该实体的洞察」+ 每条链报告（2026-06-28，supersede S1.2 node 行为）
**dogfood 当场暴露 S1.2 缺陷**：点节点显示一摞报告，但报告标题是通用的（主题+日期，如「AI 时代的软件工程·今日 Brief·2026-06-26」），**看不出该实体到底干了啥**——为导航丢了实质。正解：node 显示**关于该实体的洞察**（headline=实质信息），**每条再链进它所在的报告**（实质+导航兼得）。
- **关键映射**：`report.insight_ids`（report-gen 写入 included 洞察 id）反查 → `reportLinkMap(db, topic)` 给 insight_id → 最新报告（date 升序覆盖）。node 走（恢复的）`insightsMentioningEntity`、edge 走 `insightsCooccurring`，**两者都给每条洞察附报告链接**。
- **生产验证**：「Claude Code」26 洞察、**23 条可链报告**（3 blocked 显 headline+「未入报告」）；离线渲染确认 headline 是干货（"Anthropic/OpenAI/Cursor 数据：AI 代理已主导代码产出与评审"…）。
- **教训**：S1.2「为导航换掉实质」是错权衡——导航是锦上添花、实质（洞察内容）才是点击要看的核心。**dogfood 一轮就抓出来了**，印证「先用真实使用驱动优化」。

### S1.4：交互增强 PR-A——缩放平移 + ego 聚焦（2026-06-28）
治 dogfood 看到的「密集簇标签糊」。纯客户端 SVG 交互、不动数据层：
- **缩放平移**：graph 内容包进 `<g transform=translate scale>`；滚轮缩放（以光标为中心，用 ref 挂**非被动** wheel 监听——React onWheel 被动、preventDefault 无效）；背景 `<rect>` 拖动平移；＋/－/复位按钮；touchAction:none。
- **ego 聚焦**：点节点 → 它 + 直接邻居全亮、其余淡化到 0.12（密图里抽出单实体关系网）；点边 → 两端点+该边；点空白（未拖动）→ 复位。聚焦与既有 drill（关于该实体的洞察）同一次点击触发。
- 验证：离线渲染「聚焦 Cursor」确认邻域 11 节点弹出、其余淡化；typecheck/build 过。客户端组件无单测（项目惯例）。
- review 修讫：窄屏锚点偏（svg 加 `height:auto` 消 letterbox）、拖出 svg 误清选择（onMouseLeave 走 cancelPan 不判空白单击）、缓存盒尺寸免每帧 getBoundingClientRect。**桌面优先；移动端 touch pan/zoom 待后续**（已禁 touchAction 但未实现触摸操作）。

### S1.5：交互增强 PR-B——口径/最小共现实时滑块（2026-06-28）
口径/最小共现从服务端表单（点「应用」刷新）改为**客户端实时**（拖动即变、免刷新、布局不跳）。架构改动：
- **派生拆两步**（`cooccurrence.ts` 重构、行为中性·24 测）：`deriveCandidateGraph`（扫洞察一次→top-N 节点 + 全部候选边 weight≥1 带 strength）+ `selectGraph`（纯函数按口径/阈值选边+剔孤点·**客户端可用**）。`deriveCooccurrenceGraph` = 二者组合（服务端/eval 不变）。
- **数据流**：`page.tsx` 用 `buildTopicGraphData` 只送「候选图」+ 初值（自适应 minW）/上界（maxW）；客户端 `ForceGraph` 持 metric/minWeight state、`useMemo(selectGraph)` 毫秒级重筛。**布局对全部候选节点+边只算一次**（`useMemo([data])`）→ 拖滑块节点位置不动、不跳。topic/时间窗仍走服务端表单（改洞察集→`key` 强制重挂载重置 state）。
- **association 恒保支持度≥2**（`selectGraph` 内 `max(2,minWeight)`），滑块降到 1 也不放 Jaccard=1 噪声。
- 验证：离线渲染初始态（布局在全 144 候选边、显示 minW=4 的 47 边）确认仍清晰不糊（比旧略紧、有缩放/滑块兜底）；809 全量绿。客户端组件无单测、selectGraph 逻辑单测覆盖。

### S1.6：实体归一化（变体归并·2026-06-29）
解 ADR-0012 已知限制（同实体裂成多点）。**先量定 ROI**：生产 544 实体名仅 **5 候选变体簇**（GPT-5.5/GPT 5.5、NVIDIA/Nvidia、SWE-Bench/SWE-bench、GPT 5.6/GPT-5.6、Sakana AI/Sakana）——分析器 rule 11 规范名约束基本管用，问题小、是 polish。
- **确定性归一化，不模糊匹配**：`normKey`=小写+去标点/空格（**只做安全变换**），把 4 个系统性变体簇归并，但 `GPT-5.5`≠`GPT-5.6`（数字）、`Claude`≠`Claude Code`（词）→**零语义误并**（prod probe 实证我的 normKey 正好这 4 簇、无意外）。后缀类（Sakana AI）走**小人工别名表** `ENTITY_ALIASES`（显式可控、不自动剥后缀防 `X AI`≠`X` 误并）。
- **读时归一化、零迁移、可回退**：`entity-normalize.ts`（`normKey`/`canonKey`/`buildCanonicalizer`）；图派生 `deriveCandidateGraph` 统计前 canonicalize（展示名取簇内最高频写法）；**drill 按 `canonKey` 匹配**（点 GPT-5.5 节点连变体 GPT 5.5 的洞察一并纳入）。不改 DB 里 insight.entities。
- **范围**：只图域（报告筛选/主题页同名归并 + 写时回填留后续）。818 全量绿（+9 测）。别名表随新变体可手动增长。
- **已知限制（独立 review 提）**：①**F1 标点敏感名误并**——normKey 去全部标点，`C++`/`C#`/`C`→`c`、`.NET`/`Net`→`net` 会被静默归并（真不同实体）。prod probe 实证当前 544 实体无此碰撞，但**接 code 类源 / 出现 C++/C#/.NET 类实体时须复查**（读时归一、可回退；届时考虑「禁并 denylist」或保留区分性标点）。②**F2 别名 key 精确串匹配**——`sakana ai`（小写）等别名 key 的变体不命中，需各列一条。③**F5 别名无条件改写**——非严格机制中性（数据巧合中性），扩别名表须重核 eval 基线。④ drill 空 key 已守卫早返回（与图侧一致）。
