# Dogfood 摩擦日志

> 用产品时记下"我想做 X 但做不到"。**不要清洗、不要分类**，按时间倒序追加即可。
> 每周复盘一次，识别频次最高的摩擦类型，决定要不要做对应功能。

## 用法

每次用产品（看 brief、点引用、深挖、改源、看报告……）遇到"想做但做不到"时，
追加一行：

```
- YYYY-MM-DD HH:MM · <场景描述> · <我想做的事> · <可选：当前怎么绕过 / 怎么放弃>
```

## 观察焦点（不限于此）

- **A4 多轮追问**：读完报告后，是否经常想"我想就这条洞察再问一个问题"？多久一次？
- **A1 引用 hover 预览**：点 `[N]` 跳到列表 vs 想 hover 预览，是否有差别？
- **A3 流水线进度**：点深挖 / 立即抓取后，是否经常想"现在跑到哪步了"？
- **B1 跨日 / 跨主题串联**：是否经常想"这条洞察和昨天那条 / 另一主题那条相关"？
- **C1 标记 / 收藏 / 反馈**：是否想给单条洞察打"有用"/"不准"标签？
- **失败处理**：cron / analyze / validate 失败时，看 /admin 重试是否够用？
- **冷启动**：新主题怎么试、effort 高不高？

## 复盘节奏

- **每周日**：扫一遍本周追加的条目，按"摩擦类型"分类
- **三类信号**：
  - 同类摩擦 ≥3 次/周 → 进 roadmap 候选
  - 同类摩擦 ≥10 次/周 → 优先级 🔴
  - 单次 / 偶发 → 留观察

## 起点（2026-06-06）

dogfood 开始时间：2026-06-06
当前可读报告：8 个 brief（2026-06-04）+ 历史 5/28 报告
关注假设：**A4 多轮追问** 是否真的需要

---

## 条目（按时间倒序追加）

<!-- 示例（删除即可）：
- 2026-06-07 14:30 · 读 rep_04df240d 关于 prompt injection 趋势 · 想问 "这条结论在 2024 vs 2025 有何变化" · 当前打开 Google 搜了
- 2026-06-08 09:15 · 触发 t_code_agents 深挖 · 想看到"正在采集 7/23 源"的实时进度 · 当前看 /admin Run 表数数
-->

- 2026-06-06 23:xx · settings 修 t_code_agents 关键词时 · 想输入 "coding agent"（含空格）但空格被吃掉 · 改成 "codingagent" 凑合（**bug 已修**：input onChange 即时 split+trim 导致；改 raw string state 提交时才切分）
- 2026-06-06 23:xx · 同一次 · 想要 "重置该主题到 defaults.yaml" 按钮——以后再被测试 / 误操作污染可一键复原 · 当前要手敲 10 个关键词（**摩擦观察 #1**）
- 2026-06-06 23:xx · 同一次 · 关键词输入框是单行 input 装 10 个逗号分隔短语，**很难一眼看清哪些已填**——想要 "chip 输入"（每个关键词一个 tag）或多行 textarea · 当前凑合用（**摩擦观察 #2**）
- 2026-06-06 23:xx · 修完 t_code_agents 点保存后 · 编辑框没自动收回，还摊在那儿——以为没保存成功又点了一次 · 当前没明显"已保存 ✓"反馈（**bug 已修**：submit 成功后 closest('details').open=false 自动关）
- 2026-06-06 23:xx · 关键词单行 input 文字超出一行就看不见末尾，难审视全集 · 想要多行展示 · 当前要左右滑动光标看（**摩擦观察 #3 已改进**：input → textarea 4 行，submit 接受 `,` 或 `\n` 双格式分隔，旧逗号串照样可用）
- 2026-06-06 23:xx · 读 rep_16c20be4 引用列表项 · 期望看到 [1]/[2]/... 序号但只看到默认圆点——视觉上没法把 statement 里的 [1] 和列表里的"第 1 条"对应起来（**bug 已修**：之前 Markdown 组件把 [N] 剥成 id 用、不渲染可见文本；现 list 项以蓝色 [N] 序号居首、隐去原本圆点）
- 2026-06-06 23:xx · 读 rep_16c20be4 引用列表项 · 看到 `ci_05747174ffb61840` 这种 id 觉得唐突 + 想点 quote 直接看原文（**两点都修**：report-gen 输出 `[「quote」](url) — 源名 · 日期`、Markdown 组件支持 `[text](url)` 链接；规模化 dogfood 提示一个 spec 漏洞：MVP 设计原则"可溯源优先"里没写明"展示层不暴露 id"——隐式假设但易遗漏）
- 2026-06-06 23:xx · 读完一篇 brief · 排版/层级不够清楚、不够美观——所有内容都是默认 markdown 渲染（h1/h2 全黑 + ul 默认圆点 + 无卡片化）（**已改**：Markdown 组件把"## N. 标题"自动包入 `<section class="insight-block">`，CSS 加卡片化样式——白底 + 左 4px 蓝色条 + 圆角 + 边框 + 1.25rem 内边距；hero 元数据条用浅蓝背景；行宽限 44rem 避免长行眼跳；字号 scale 1.25 倍率三档；引用块次级层级——小一号 + 虚线分隔 + 无圆点 + tabular-nums [N] 编号；dark mode 适配。参考 Stripe Docs / Notion 类排版）
- 2026-06-06 23:xx · 引用项末尾日期 "Tue, 02 Ju" 截断垃圾 · 不需要日期、看着烦（**两步修**：report-gen 不再产日期段；regen 脚本加 Pass 3 用 ISO/RFC2822 双格式正则把已生成报告末尾 ` · 日期` 段去掉，6 份 6/4 报告全部清干净；根因：published_at 来源 RSS feed 多种格式，slice(0,10) 切 RFC 2822 → "Tue, 02 Ju" 垃圾。**留观察**：未来若 spec 真要日期，需要写 ISO/RFC2822 统一 parser，不能盲 slice）
- 2026-06-06 23:xx · 引用项源名末尾"最新"（"arXiv cs.CR 最新"）· 是 papermark、不该作为源名一部分（**三步修**：defaults.yaml 4 个 arxiv 源去掉" 最新"后缀；DB UPDATE source SET name 同步；regen Pass 4 strip " 最新" suffix；3 份受影响 6/4 报告清干净。根因：配置写作时给"feed 含义"加了说明性后缀，但 source name 字段应是**展示用 brand name**，含义说明应在配置注释或单独的 description 字段。配置 schema 设计 papermark）
- 2026-06-06 23:xx · 读 rep_16c20be4 · 24 引用 100% 来自 Latent Space 2 篇长文——担心是 LLM 系统性偏差（**触发完整诊断 + cron baseline 验证 + 结论反转**）：①诊断脚本 diag-select.mjs 复现 selectAnalysisItems → rankAndDiversify 选 15 条 / 7 源 / perSourceCap=5 完美执行，但 analyzer 实际只用了 2 篇 Latent Space 长文；②触发 cron 跑今晚 baseline rep_763b2e55（35 洞察 / 97 引用 / 4 源 / 8 篇），Latent Space 占比降到 48.5%、arxiv_se 进来 3 篇、GitHub Eng 2 篇、HN 1 篇——**多源印证恢复正常**；③结论修正：6/4 那份是 outlier（窗口 arxiv release 少 + HN 无相关 + OpenAI 灌 backlog 导致 LLM 候选受限），不是系统性偏差。**Path B/A/C 全部暂停、不修代码**。元教训：质疑数据先于改算法——dogfood 真正价值在此
- 2026-06-06 23:xx · rep_763b2e55 中 GitHub Eng 引用是 March 12 / Mar 31 的文章——不是新闻（**真问题、Path A 修**）：①根因 = 窗口语义错位——listContentForTopic 用 `fetched_at >= since` 当新鲜度，但旧文章被 cron 反复"重新抓回"使 fetched_at 一直 fresh，而 `published_at` 是 RFC 2822 原始字符串、SQL 字典序 ≠ 时间序；②方案 A 落地：写 parsePublishedAt 把任何源（RFC 2822 / ISO / 偶尔非标）归一化到 ISO 8601 → normalize.ts 接入 → 已有 2180 条全 backfill → listContentForTopic SQL 改 `COALESCE(published_at, fetched_at) >= since`；③hero 元数据条加"内容窗口"标记让用户知道是哪段时间发布的内容；④实测：7 天窗口下 GitHub Eng 0 条入窗口（之前 10 条全过）——MVP 设计原则"诚实的空状态"开始真生效。元教训：**`slice()` 当 parser** + **字符串字段当时间字段排序** = 两个 anti-pattern 早就该写进 L0 foundation skills
- 2026-06-06 23:xx · rep_763b2e55 中每个引用项日期格式不一样（旧镜像产出含 "Tue, 02 Ju" 截断垃圾）· 希望统一 YYYY-MM-DD（**已修**）：①根因——rep_763b2e55 由 cron 触发时镜像没含"删日期 + 归一化 ISO"的合并版本；②修法对偶：a) report-gen 恢复 datePart 但用 `slice(0,10)` on 归一化后的 ISO published_at（"2026-03-31T16:00:00.000Z" → "2026-03-31"）；b) regen 脚本 Pass 3 旧"去日期"反转为"日期 → YYYY-MM-DD"，从 URL 反查 DB content_item.published_at（现已 ISO）重写一致；③效果：8 份历史报告全部 reformat，rep_763b2e55 所有 Latent Space 引用日期统一 "2026-06-02"。元教训补：第二次"日期段"反复修——证明 spec 漏写了"展示层日期格式契约"，需要单测保证 YYYY-MM-DD 永不回退
- 2026-06-06 23:xx · /reports 列表 17 份太杂——同日多份 brief（cron 每 6h 跑 + 历史毫秒级双写）+ 2 份空报告（0 洞察）· 希望清理（**已修**）：①写 ops/cleanup-reports.mjs，dry-run / --apply 两段；策略：空报告（0 洞察/引用）+ 同 topic 同日多份留洞察最多 + 引用最多 + 最晚那份其余删；②FS 缺失的 5 月历史包袱保留不动（留作"诚实空状态"测试样本）；③9 删 / 8 留 / FS 12 文件清；④留观察：cron 每 6h 跑 = "Daily Brief" 名不副实，spec 隐含"每日 1 份"但实现是"每 6 小时 1 份"——应改 ops/crontab 为 daily（凌晨 1 次），或 brief 改名"6 小时综述"。配置 schema 设计 papermark 第 2 例
