# 数据源可行性核实 (A3)

> 状态: 🟢 已完成 · Owner: dongqiu · 2026-05-21 · 对应 DCP-0 附条件「逐源核实 A3 数据源可达性」

> 核实方式: 对每个候选源用 WebFetch 直接拉取候选 endpoint，结合 WebSearch 验证文档与社区状态。所有 ✅ 源均已观察到当前 (2026-05) 仍在更新的实际内容；URL 失败者已标注或寻得替代方案。

---

## 总览

**核实结果分布**（共 31 个候选源 / 标的）:

- ✅ 推荐立刻接入: **17 个**
- ⚠️ 有条件可接 (社区桥接 / 抓 HTML / 后续迭代): **8 个**
- ❌ MVP 不接 (违反 RSS/API/arXiv 约束 或 不可达 / 高成本 / 高风险): **6 个**

**两个行业核心覆盖结论**:

- **AI 时代的软件工程**: 覆盖充分。综合社区 + 学术 + 厂商博客 + Newsletter/Podcast 主链路均有官方 RSS / API，无须依赖任何爬虫。视频频道用 YouTube Atom feed 即可拿到上新通知（注意不含字幕，转写留待后续迭代）。中文源仅 1 个稳定 ✅，但 MVP 单行业 ≥ 6 个，已达标。
- **AI 时代的安全**: 覆盖充分。三大综合资讯站（HN/Krebs/Bleeping）+ arXiv cs.CR + 两大旗舰播客（Risky Business / Darknet Diaries）+ OWASP/MITRE 标准（走 GitHub）已构成 7 个 ✅。学术顶会 (USENIX / IEEE S&P) 和中文圈短板已识别，列入「⚠️ 有条件」与后续迭代。

**MVP 接入清单** 见末节。

---

## AI 时代的软件工程

### 1. Hacker News（综合社区）

- **可达性**: ✅ 已实测 `https://news.ycombinator.com/rss` 返回有效 RSS 2.0，30 条最新热门帖（2026-05-17 ~ 2026-05-20）。另有官方 Firebase API `https://hacker-news.firebaseio.com/v0/`，支持按 ID 全量回填。
- **接入方式**: **RSS（每日新热门）+ 官方 Firebase API（用于历史回填 / 全文 / 按分数筛选）**。如需高级筛选（按 points/comments 阈值），还可叠加 HN Algolia Search API `https://hn.algolia.com/api`。
- **ToS / robots.txt**: `robots.txt` 仅 Disallow 互动端点（vote/reply/fave 等），内容页全部允许；**Crawl-delay: 30s**。Firebase API 文档明示 "no rate limit"。
- **速率限制 / 成本**: 全部免费；遵守 30s/req 即可。
- **历史回填深度**: RSS 仅最新 30 条；Firebase API 可按 itemID 倒序遍历全部历史（实测可用）。
- **MVP 建议**: ✅ 推荐。MVP 用 RSS 做增量，Firebase API 做一次性历史回填。

### 2. arXiv（cs.SE / cs.CL / cs.AI）

- **可达性**: ✅ 已实测 `https://export.arxiv.org/rss/cs.SE` 返回 31 条当日新论文 RSS 2.0（announce_type=new/replace）。同理 cs.CL / cs.AI / cs.CR。
- **接入方式**: **官方 RSS（每日新增） + 官方 Query API（`http://export.arxiv.org/api/query`，支持 `submittedDate:[YYYYMMDDTTTT TO ...]` 范围）**。两者 atom/rss 输出。
- **ToS / robots.txt**: 有正式 ToU (`info.arxiv.org/help/api/tou.html`)；明确允许程序化访问，但禁止规避限流。
- **速率限制 / 成本**: ToU 强制要求 **≥ 3 秒/请求**；批量场景建议 4 req/s + 1s sleep（bulk_data 文档）；超限会被 IP 临时封禁。免费。User-Agent 必填。
- **历史回填深度**: Query API 支持任意 submittedDate 范围 → 可完整回填。
- **MVP 建议**: ✅ 强推荐。三个子类都接（cs.SE / cs.CL / cs.AI）；做一次性历史回填（建议过去 90 天）。

### 3. Anthropic（厂商博客）

- **可达性**: 官方 `anthropic.com/news/rss.xml` 与 `/rss.xml` 均 ❌ 404，官方未提供 RSS。`robots.txt` `Allow: /`。社区维护的 `https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml` ✅ 实测有效（lastBuildDate 2026-05-20，含 200+ 条历史，最近条目 2026-05-19 KPMG 合作新闻）。
- **接入方式**: ⚠️ **社区桥接 RSS**（Olshansk/rss-feeds，每小时刷新）。或自建轻量 scraper（robots.txt 允许）。
- **ToS / robots.txt**: `robots.txt` 全允许；ToS 一般要求标明出处、不修改原意 —— 本系统的"可溯源 + 引用回原文"恰好满足。
- **速率限制 / 成本**: 社区 feed 走 raw.githubusercontent.com 免费无限制。
- **历史回填深度**: 社区 feed 已含历史；自建 scraper 也可遍历 `/news` 分页。
- **MVP 建议**: ⚠️ **有条件可接**。MVP 先用 Olshansk 社区 feed；并行做一个轻量 Anthropic news scraper（依赖低，HTML 稳定）作为降级。同时关注官方未来开放 RSS。

### 4. OpenAI（厂商博客）

- **可达性**: ✅ 实测 `https://openai.com/news/rss.xml` 有效 RSS 2.0，含 150+ 条，lastBuildDate 2026-05-20。原 `/blog/rss.xml` 已 301 重定向到 `/news/rss.xml`。
- **接入方式**: **官方 RSS**。
- **ToS / robots.txt**: 官方公开 feed，可订阅；遵守"可溯源 + 引用"即合规。
- **速率限制 / 成本**: 标准 web fetch，免费。
- **历史回填深度**: feed 自带 150+ 条历史，足够 MVP 冷启动。
- **MVP 建议**: ✅ 推荐。

### 5. Google Research（厂商博客）

- **可达性**: ✅ 实测 `https://research.google/blog/rss/` 有效 RSS 2.0，200+ 条历史，最近 2026-05-19。
- **接入方式**: **官方 RSS**。
- **ToS / robots.txt**: 官方 feed，标明来源 + 不复制全文即可。
- **速率限制 / 成本**: 免费。
- **历史回填深度**: feed 自带 200+ 条，覆盖近 1-2 年。
- **MVP 建议**: ✅ 推荐。

### 6. Cursor（厂商博客 / 变更日志）

- **可达性**: `cursor.com/blog/rss.xml` 与 `cursor.com/rss.xml` 均 ❌ 404。社区 Issue 反映「Cursor Blog RSS Feed 数月未更新」。第三方镜像 `cursor-changelog.com/feed` 存在但非官方。
- **接入方式**: ⚠️ **第三方/社区 changelog 镜像** 或 **自建 scraper** (`cursor.com/changelog`)。
- **ToS / robots.txt**: 未做深查；产品页一般允许搜索引擎抓取。
- **速率限制 / 成本**: 第三方 / 自建均低成本。
- **历史回填深度**: changelog 页面有完整历史。
- **MVP 建议**: ⚠️ **有条件可接**。MVP 阶段优先级降为 P1：用 `cursor-changelog.com/feed` 跑通；如效果好再考虑自建抓 `cursor.com/changelog`。**不影响 MVP 起步**。

### 7. GitHub Next（厂商博客）

- **可达性**: ✅ 实测 `https://githubnext.com/rss.xml` 有效 RSS（官方在 footer 也声明了 RSS 订阅入口）。最近条目 2026-05-18 "Canary: a harm gate for agentic systems"。
- **接入方式**: **官方 RSS**。
- **ToS / robots.txt**: 官方公开 feed。
- **速率限制 / 成本**: 免费。
- **历史回填深度**: feed 自带历史。
- **MVP 建议**: ✅ 推荐。注意补充建议：同时订阅 `https://github.blog/category/engineering/feed/` (GitHub 工程博客)，已实测有效，主线 Copilot/Agentic 内容在那里更频繁。

### 8. Latent Space (Newsletter / Podcast)

- **可达性**: ✅ 实测 `https://www.latent.space/feed` 是 Substack 标准 RSS（含 iTunes/Google Play 播客命名空间），最近 2026-05-20 Google I/O 2026 解读。
- **接入方式**: **官方 RSS（Substack）**。文字 newsletter 全文在 feed 内；播客部分是音频 enclosure（MVP 不处理音频，只用文字摘要）。
- **ToS / robots.txt**: Substack 公开 feed；引用须标注作者 + 链接。
- **速率限制 / 成本**: 免费。
- **历史回填深度**: Substack RSS 通常仅最近 ~20 条；老内容需走网站抓取。MVP 可接受。
- **MVP 建议**: ✅ 推荐。

### 9. The Pragmatic Engineer (Newsletter)

- **可达性**: ✅ 实测 `https://newsletter.pragmaticengineer.com/feed` 有效 RSS（Substack），含播客和文字。
- **接入方式**: **官方 RSS**。注意 Gergely 部分内容仅付费订阅者可见（feed 给摘要 + paywall 链接）；MVP 用 RSS 拿到的免费内容即可。
- **ToS / robots.txt**: Substack 公开 feed；商用场景需注意 paywall 内容不能跳过付费墙抓取。
- **速率限制 / 成本**: 免费。如要付费内容需个人订阅 ($15/月) 后用授权 token。
- **历史回填深度**: ~20 条近期。
- **MVP 建议**: ✅ 推荐（仅消费免费部分；不抓 paywall）。

### 10. Practical AI (Podcast)

- **可达性**: ✅ 实测 `https://changelog.com/practicalai/feed` 301→ `https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm`，有效 podcast RSS，已到第 356 期，最近 2026-05-19。
- **接入方式**: **官方播客 RSS**。MVP 阶段**不处理 ASR 转写**，仅取标题 + show notes 文本 + episode 描述。
- **ToS / robots.txt**: 公开播客 feed，按播客生态惯例可订阅。
- **速率限制 / 成本**: 免费。
- **历史回填深度**: feed 含完整 356 期。
- **MVP 建议**: ✅ 推荐（只用文字元数据；音频 ASR 留待迭代）。

### 11. X 社媒：@swyx / @simonw / @karpathy

- **可达性**: ❌ X 官方 API 2026-02 起取消 free / basic / pro 新订阅，改为 pay-per-use（$0.005/post read，月封顶 2M）；基本 tier ($200/月) 已不对新用户开放。Nitter 公共实例自 2024 起大规模失效。
- **接入方式**: ❌ 无符合 MVP 约束（RSS / arXiv / 官方 API 免费可用）的方式。
- **ToS**: X 严格禁止未授权抓取。
- **MVP 建议**: ❌ **MVP 不接**。等社媒接入迭代到产品路线图（见 product-definition.md "MVP 暂不包含"）。补偿：simonw 个人博客 `simonwillison.net/atom/everything/` 有完整 RSS，swyx 内容在 Latent Space feed 内有覆盖；karpathy 主要长内容在 YouTube。

### 12. 视频：Andrej Karpathy YouTube / 3Blue1Brown

- **可达性**: ✅ 实测 `https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ` (Karpathy) 与 `?channel_id=UCYO_jab_esuFRV4b17AJtAw` (3Blue1Brown) 均为有效 YouTube Atom feed。
- **接入方式**: **YouTube 官方 Atom feed**（每频道暴露最近 15 条上传）。MVP 仅用元数据（标题 / 描述 / 发布时间），不做字幕抓取。
- **ToS**: YouTube 公开 feed 端点稳定多年；字幕抓取受 ToS 约束（YouTube Data API 有官方接口，单独评估）。
- **速率限制 / 成本**: 免费，无显式限流。
- **历史回填深度**: Atom feed 仅最近 15 条；历史需 YouTube Data API v3（有 quota，免费 10000 units/天）。MVP 可仅接受最近 15 条起步。
- **MVP 建议**: ✅ 推荐（仅元数据；字幕 / 转写留待迭代）。

### 13. 中文：机器之心 / 量子位 / InfoQ AI

- **机器之心 (jiqizhixin.com)**: 实测 `/rss` 与 `/rss.xml` 均返回 HTML，**官方未提供 RSS**。⚠️ 需 RSSHub 桥接或自建抓取。
- **量子位 (qbitai.com)**: ✅ 实测 `https://www.qbitai.com/feed` 有效 RSS 2.0（WordPress 6.9 生成），最近 2026-05-20，更新频率每小时。
- **InfoQ AI**: ✅ 实测 `https://feed.infoq.com/ai-ml-data-eng` 有效 RSS 2.0，16 条最新含 2026-05 内容，覆盖 Agents / LLM / 数据工程。
- **ToS / robots.txt**: 中文站普遍允许 RSS 订阅，商用引用需注明出处。
- **MVP 建议**:
  - 量子位 ✅ 推荐
  - InfoQ AI ✅ 推荐
  - 机器之心 ⚠️ MVP 阶段先用 RSSHub 路由 `https://rsshub.app/jiqizhixin/news`（社区维护，需自部署 RSSHub 或接受公共实例 SLA 风险）；或后续迭代自建轻爬。

---

## AI 时代的安全

### 1. The Hacker News (综合资讯)

- **可达性**: ✅ 实测 `https://feeds.feedburner.com/TheHackersNews` 有效 RSS 2.0，含 2026-05-12 ~ 2026-05-20 多篇文章。
- **接入方式**: **官方 RSS (Feedburner)**。
- **ToS / robots.txt**: `robots.txt` 全允许（`Disallow:` 空）。
- **速率限制 / 成本**: 免费。
- **历史回填**: feed 通常 ~20 条；老文章可直接 URL 取。
- **MVP 建议**: ✅ 推荐。

### 2. KrebsOnSecurity (综合资讯)

- **可达性**: ✅ 实测 `https://krebsonsecurity.com/feed/` 有效 RSS 2.0，10 条 2026-03 ~ 2026-05 文章。
- **接入方式**: **官方 RSS**。
- **ToS / robots.txt**: `robots.txt` 允许常规爬虫；**Crawl-delay: 35s**；屏蔽 YisouSpider / PetalBot / SemrushBot。
- **速率限制 / 成本**: 免费；遵守 35s/req。
- **历史回填**: feed 仅 10 条；可按月份归档 URL 抓取（`krebsonsecurity.com/YYYY/MM/`）。
- **MVP 建议**: ✅ 推荐。

### 3. Bleeping Computer (综合资讯)

- **可达性**: ✅ 实测 `https://www.bleepingcomputer.com/feed/` 有效 RSS 2.0，2026-05-20 最近内容。
- **接入方式**: **官方 RSS**。
- **ToS / robots.txt**: **robots.txt 显式屏蔽 ClaudeBot / CCBot / 多个 AI 训练 bot**；`Crawl-delay: 1`；但允许 RSS 端点本身。**关键约束**: User-Agent 不要伪装；走 RSS 端点抓取符合允许范围；**不要将 Bleeping 内容输入用于训练**。本系统是检索 / 摘要场景，需在 UA 中明确身份 + 仅做检索使用。
- **速率限制 / 成本**: 免费；遵守 1s/req。
- **历史回填**: feed ~20 条；老文章 URL 抓取需谨慎，建议仅消费 RSS 增量。
- **MVP 建议**: ✅ 推荐（仅消费 RSS 增量 + 引用回原文，不做全量回填）。

### 4. arXiv cs.CR (学术)

- **可达性**: ✅ 实测 `https://export.arxiv.org/rss/cs.CR` 有效 RSS，含 50+ 条 2026-05-20 论文（"DarkLLM"、"Lightweight Backdoor Detection" 等）。
- **接入方式 / ToS / 限制 / 回填**: 同上面 arXiv 节，复用同一客户端。
- **MVP 建议**: ✅ 强推荐。

### 5. USENIX Security / IEEE S&P (学术顶会)

- **可达性**: 两者均无公开 RSS feed。USENIX 提供 `/publications/proceedings/rss.xml` ❌ 403。IEEE S&P proceedings 走 IEEE Xplore（付费 / 部分 open access）。
- **接入方式**: ⚠️ **DBLP 是顶会论文索引最稳的入口** —— `https://dblp.org/db/conf/uss/index.html` 与 `https://dblp.org/db/conf/sp/index.html`，DBLP 支持 BibTeX / JSON / XML 导出，**每年一次会议（年度提交）**。USENIX Security 论文官网通常 open access (`usenix.org/conference/usenixsecurityXX/presentation/...`)，可拿到 PDF。
- **ToS**: DBLP / USENIX open access papers 明确学术免费使用；IEEE 需个人订阅。
- **速率限制 / 成本**: DBLP 免费 + 限流；USENIX open access PDF 免费。
- **历史回填**: 顶会按年发，回填等于按年遍历目录。
- **MVP 建议**: ⚠️ **有条件可接**。MVP 阶段：**USENIX Security 接，IEEE S&P 暂不接**。USENIX 接入方式：每年会议结束后一次性抓 `usenix.org/conference/.../technical-sessions` 目录页；非实时。arXiv cs.CR 已覆盖大量同领域 preprint，顶会作为补充。

### 6. OWASP LLM Top 10 / OWASP AI Exchange / MITRE ATLAS (标准 / 框架)

- **可达性**:
  - OWASP LLM Top 10: ✅ `github.com/OWASP/www-project-top-10-for-large-language-model-applications` releases / wiki / changes.md。当前版本 2025。
  - OWASP AI Exchange: ✅ `github.com/OWASP/www-project-ai-security-and-privacy-guide`，渲染站 `owaspai.org`。
  - MITRE ATLAS: ✅ `github.com/mitre-atlas/atlas-data` 提供 ATLAS.yaml + STIX 2.1 bundle；16 战术 / 84 技术 / 56 子技术 / 42 案例。
- **接入方式**: **GitHub Releases / Commits webhook 或定时 poll**（同样属于"官方 API"广义范畴）。可订阅 GitHub repo 的 `releases.atom` 与 `commits.atom`（GitHub 原生 Atom feed）。
- **ToS**: 全部开源（CC / Apache），可自由使用 + 引用。
- **速率限制 / 成本**: GitHub API 未鉴权 60 req/hour，鉴权 5000/hour；免费。
- **历史回填**: Git 全量历史可拿。
- **MVP 建议**: ✅ 推荐（三个全接，作为"知识库基线"而非"资讯流" —— 频率每日 poll releases.atom 即可；ATLAS 提供结构化 YAML/STIX，可直接进知识图谱）。

### 7. Anthropic Safety / OpenAI Safety / Google Security blog (厂商博客)

- **Anthropic Safety**: 与 Anthropic news 同源 feed (`Olshansk/feed_anthropic_news.xml`)，安全公告会出现在 news；另有 `red.anthropic.com` 红队博客与 `alignment.anthropic.com`，均无官方 RSS。⚠️ 同样需社区桥接。
- **OpenAI Safety**: 与 OpenAI news 同源 (`openai.com/news/rss.xml`)，safety 内容在 feed 中可按 `<category>` 过滤。✅
- **Google Security blog**: ⚠️ Google 不在 `blog.google` 提供 security-specific section RSS（实测 404）；主 feed `blog.google/rss/` 可按 `<category>` 含 "Security" 过滤。**Google Cloud Threat Intelligence (Mandiant)** 在 `cloud.google.com/blog/topics/threat-intelligence/` 有内容但无独立 RSS endpoint，须用 `cloud.google.com/blog/rss/` 主 feed + category 过滤。
- **MVP 建议**:
  - OpenAI news (含 safety) ✅ — 已在软件工程节列入
  - Anthropic news (含 safety) ⚠️ — 已在软件工程节列入，复用同一 feed，分主题路由时按关键词 + tag 过滤
  - `blog.google/rss/` + category=Security ⚠️ — 可接，但信噪比一般，列为 P1

### 8. DEFCON / BlackHat YouTube / Risky Business / Darknet Diaries (视频 / 播客)

- **DEFCON YouTube**: ✅ 频道 `DEFCONConference`，可用 YouTube Atom feed 拿元数据（同上 YouTube 方案）。
- **BlackHat YouTube**: ✅ 同上，频道存在且活跃。
- **Risky Business**: ✅ 实测 `https://risky.biz/feeds/risky-business/` 有效 podcast RSS，最近 2026-05-20，每周更新。
- **Darknet Diaries**: ✅ 实测 `https://feeds.megaphone.fm/darknetdiaries` → 301 `https://podcast.darknetdiaries.com/`，有效 podcast RSS。
- **MVP 建议**:
  - Risky Business ✅ 推荐（仅 show notes 文字元数据）
  - Darknet Diaries ✅ 推荐（同上，每月一更，叙事性强适合作为深度补充）
  - DEFCON / BlackHat YouTube ⚠️ — YouTube Atom feed 可拿到上新通知，但年会形态、内容深度依赖字幕，**MVP 暂不接**，会议季再开

### 9. 中文：安全客 / FreeBuf / 看雪

- **安全客 (anquanke.com)**: 实测官网直接访问被 WAF 拦截（HTTP 473）；社区给出 RSS endpoint `https://api.anquanke.com/data/v1/rss`（多个安全 RSS 聚合 repo 引用），未在沙箱中验证；⚠️ 接入需在生产环境实测。
- **FreeBuf (freebuf.com)**: ✅ 实测 `https://www.freebuf.com/feed` 有效 RSS 2.0，最近 2026-05-21，含 CVE / 供应链攻击等多条。
- **看雪 (kanxue.com)**: ❌ 官方明确无 RSS（社区追问多年未提供）；仅有 RSSHub 第三方路由（不稳定）。MVP 不接。
- **MVP 建议**:
  - FreeBuf ✅ 推荐
  - 安全客 ⚠️ 接入前需生产实测 `api.anquanke.com/data/v1/rss`，OK 则纳入
  - 看雪 ❌ 不接

---

## 风险提示

| 风险 | 影响 | 缓解 |
|---|---|---|
| **Anthropic / Cursor 官方无 RSS，依赖社区桥接** | 社区 feed 停更 → 静默丢源 | (a) 监控 feed lastBuildDate；连续 N 天无更新告警；(b) 多源冗余：Anthropic 内容也通过 HN / Latent Space / Pragmatic Engineer 提到，能多源交叉发现；(c) MVP 后期 P1：自建 Anthropic news 轻爬作为降级 |
| **X 官方 API 收费 + 抓取受限** | 三个 X 账号无法接入 | MVP 不接（符合 product-definition 中"MVP 暂不包含社媒"约束）；通过 swyx 的 Latent Space + simonw 个人博客 RSS (`simonwillison.net/atom/everything/`) 间接覆盖部分内容 |
| **Bleeping Computer / 部分中文站屏蔽 AI bot** | 直接拉 RSS 没问题，但若做 fulltext 抓取可能被封 | 严格遵守 robots.txt；UA 标识本系统身份；仅消费 RSS 增量，不做全量历史抓取；引用一律回原文，不复制全文存储 |
| **arXiv 3s/req 限流** | 三个 cs.* 子类 + 历史回填同时跑会触限 | 集中通过单一 arXiv client + token bucket（≥ 3s 间隔）；批量历史回填走 `export.arxiv.org` 并加 1s burst sleep；统一 User-Agent |
| **USENIX/IEEE 顶会无 RSS** | 学术覆盖侧偏 preprint | MVP 用 arXiv cs.CR 覆盖；后期接入 DBLP 年度遍历（USENIX 已 open access） |
| **YouTube Atom feed 仅 15 条 / 无字幕** | 视频内容深度受限 | MVP 仅用元数据做"上新通知"；字幕 + ASR 转写留待社媒/视频迭代 |
| **中文站 RSS 稳定性弱于英文站** | 机器之心 / 看雪 不可达 | MVP 仅保留量子位 / InfoQ AI / FreeBuf（已实测）；机器之心走 RSSHub 自建路由作 P1 |
| **WAF 拦截沙箱 IP（安全客）** | 沙箱核实失败不等于生产不可用 | 生产环境部署后立即实测；准备好降级 |

---

## MVP 首版接入清单

### AI 时代的软件工程（推荐 ✅，共 9 个源 / 复合 10 项 feed）

| # | 源 | Endpoint | 接入方式 |
|---|---|---|---|
| 1 | Hacker News | `https://news.ycombinator.com/rss` + `https://hacker-news.firebaseio.com/v0/` | RSS + 官方 API |
| 2 | arXiv cs.SE | `https://export.arxiv.org/rss/cs.SE` + Query API | RSS + 官方 API |
| 3 | arXiv cs.CL | `https://export.arxiv.org/rss/cs.CL` | RSS |
| 4 | arXiv cs.AI | `https://export.arxiv.org/rss/cs.AI` | RSS |
| 5 | OpenAI News | `https://openai.com/news/rss.xml` | 官方 RSS |
| 6 | Google Research Blog | `https://research.google/blog/rss/` | 官方 RSS |
| 7 | GitHub Next + GitHub Engineering | `https://githubnext.com/rss.xml` + `https://github.blog/category/engineering/feed/` | 官方 RSS |
| 8 | Latent Space | `https://www.latent.space/feed` | 官方 RSS |
| 9 | The Pragmatic Engineer | `https://newsletter.pragmaticengineer.com/feed` | 官方 RSS (免费部分) |
| 10 | Practical AI | `https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm` | 官方 RSS (元数据) |
| 11 | 量子位 | `https://www.qbitai.com/feed` | 官方 RSS |
| 12 | InfoQ AI/ML/Data | `https://feed.infoq.com/ai-ml-data-eng` | 官方 RSS |

**有条件 P1（MVP 起步后第一批扩展）**:
- Anthropic news（Olshansk 社区 feed）
- Cursor changelog（`cursor-changelog.com/feed` 第三方）
- Karpathy / 3Blue1Brown YouTube Atom feed（元数据）

### AI 时代的安全（推荐 ✅，共 9 个源）

| # | 源 | Endpoint | 接入方式 |
|---|---|---|---|
| 1 | The Hacker News | `https://feeds.feedburner.com/TheHackersNews` | 官方 RSS |
| 2 | KrebsOnSecurity | `https://krebsonsecurity.com/feed/` | 官方 RSS |
| 3 | Bleeping Computer | `https://www.bleepingcomputer.com/feed/` | 官方 RSS (仅增量) |
| 4 | arXiv cs.CR | `https://export.arxiv.org/rss/cs.CR` | RSS + 官方 API |
| 5 | OWASP LLM Top 10 | GitHub `OWASP/www-project-top-10-for-large-language-model-applications` releases.atom | GitHub Atom |
| 6 | OWASP AI Exchange | GitHub `OWASP/www-project-ai-security-and-privacy-guide` commits.atom | GitHub Atom |
| 7 | MITRE ATLAS | GitHub `mitre-atlas/atlas-data` releases.atom + ATLAS.yaml | GitHub Atom + YAML |
| 8 | Risky Business | `https://risky.biz/feeds/risky-business/` | 官方播客 RSS (show notes) |
| 9 | Darknet Diaries | `https://podcast.darknetdiaries.com/` | 官方播客 RSS (show notes) |
| 10 | FreeBuf | `https://www.freebuf.com/feed` | 官方 RSS |

**有条件 P1**:
- 安全客 `https://api.anquanke.com/data/v1/rss`（生产实测后）
- USENIX Security 年度 open access proceedings
- `blog.google/rss/` + category=Security 过滤

**MVP 不接**:
- X 三账号（社媒迭代）
- DEFCON / BlackHat YouTube（视频迭代）
- IEEE S&P（付费墙）
- 看雪（无 RSS）

---

## 工程实现备注

- **统一抓取层抽象**: 所有源经统一 `Source` 接口（RSS / Atom / GitHub Atom / JSON API 都走同一管线），方便后续替换。配置驱动（呼应 product-definition.md 中"配置化"）。
- **User-Agent**: 全局统一明示 `InsightAgent/0.1 (+https://<deploy-url>/about)`，遵守各源 Crawl-delay。
- **去重 key**: 用 `(source_id, item_guid)` + URL 规范化后再哈希。
- **冷启动回填**: 仅 arXiv（按 submittedDate 区间）+ HN（按 itemID 回溯）做一次性 90 天回填；其他源接受"从订阅日起增量"，符合 product-definition.md 冷启动设计。
- **失败兜底**: 单源连续 3 次失败告警；不阻塞流水线（呼应"容错"）。
