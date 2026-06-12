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
