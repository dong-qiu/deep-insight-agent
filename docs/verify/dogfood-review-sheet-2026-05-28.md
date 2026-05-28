# Dogfood 评审工作表（首轮 · 2026-05-28）

> 配 `dogfood-feedback.md` 用。评审对象 = swe 的 15 条洞察（`rep_0a6aea1b` brief / `rep_0f4607fc` deep_dive，同组）。
> 打开报告：`open .data/reports/rep_0a6aea1b.html`（自包含 HTML，可直接发同事）或 `npm run dev` → 报告库。
> 报告里引用只显示 `ci_xxxx` 代码、点不开——**用下表的「核验关键词」到对应原文链接 Ctrl-F**，几秒确认结论里的数字/实体是否属实。

## 原文链接（5 源）

| 代码 | 标题 | 链接 |
|---|---|---|
| `ci_0ef…` | Google I/O 2026（latent.space） | https://www.latent.space/p/ainews-google-io-2026-gemini-35-flash |
| `ci_232…` | DHH's new way of writing code（Pragmatic） | https://newsletter.pragmaticengineer.com/p/dhhs-new-way-of-writing-code |
| `ci_7ad…` | Silicon Valley gets Serious about Services（latent.space） | https://www.latent.space/p/ainews-silicon-valley-gets-serious |
| `ci_fe5…` | How to land a job at a frontier lab（latent.space） | https://www.latent.space/p/ainews-how-to-land-a-job-at-a-frontier |
| `ci_068…` | AI's impact on software engineers 2026 Pt.2（Pragmatic） | https://newsletter.pragmaticengineer.com/p/ai-impact-on-software-engineers-part-2 |

## 怎么用

每条洞察判 4 件事，在「评审 A/B」栏写代码：**幻**(幻觉 Y/N) · **溯**(quote 在原文找得到 Y/N) · **显**(非显然/跨源 Y/N) · **用**(有用 Y/N)。例：`幻N 溯Y 显N 用Y`。
- **幻觉判据**：到原文 Ctrl-F「核验关键词」——**查无 = 幻觉(🔴)**；查到、但不在报告所引那条 quote 里（在原文别处）= 覆盖不足(🟡 补引、非幻觉)。
- **重点抽核**（截断 quote、数字不在片段）：**#8 / #10 / #11**。

## 逐条工作表

| # | 结论关键词 | 源 | 核验关键词（Ctrl-F 原文） | AI 预判 | 评审 A | 评审 B |
|---|---|---|---|---|---|---|
| 1 | Google 月处理 3.2 quadrillion token、增 7× | ci_0ef | `3.2 quadrillion` `480 trillion` `7x` | 幻N 溯N(截断) 显N 用~ | | |
| 2 | DHH 约六个月转 agent-first、几乎不手写 | ci_232 | `barely writes any code` `six months` | 幻N 溯Y 显N 用Y | | |
| 3 | tab→agent harness + Opus 4.5 是转折 | ci_232 | `Opus 4.5` `tab-completion` | 幻N 溯Y 显N 用Y | | |
| 4 | tmux 跑 Gemini2.5+Opus、NeoVim 审 diff | ci_232 | `tmux` `NeoVim` `Gemini 2.5` | 幻N 溯◐(缺 tmux/nvim) 显N 用Y | | |
| 5 | Rails token 高效/测试内建/适配 agent | ci_232 | `token-efficient` `Testing is part` | 幻N 溯Y 显N 用Y | | |
| 6 | AI 放大资深、挑战初级 | ci_232 | `amplifies senior` `junior` | 幻N 溯Y 显N 用Y | | |
| 7 | P1 延迟 4ms→<0.5ms | ci_232 | `4 milliseconds` `half a millisecond` | 幻N 溯Y 显N 用Y | | |
| **8** | Anthropic $1.5B JV(Blackstone/Goldman)；OpenAI $10B 估值/募 $4B | ci_7ad | `$1.5B` `$10B` `$4B` `Blackstone` `Deployment Company` | 幻N 溯N(数字全不在 quote) 显N 用Y · **重点核** | | |
| 9 | 合资=定制集成而非通用 API（推断） | ci_7ad | `tailored to each organization` | 幻N 溯Y 显◐(推断) 用Y | | |
| **10** | kernel 级性能调优=LLM 最大瓶颈/入行路径 | ci_fe5 | `biggest bottleneck` `kernel` | 幻N 溯N(quote 截断) 显N 用~ · **重点核** | | |
| **11** | 900+ 调查：质量降/管理层不关注/维护落少数人 | ci_068 | `900` `does not care` `maintenance duty is falling` | 幻N 溯◐(缺 900/维护句) 显N 用Y · **重点核** | | |
| 12 | 组织级推广难、收益依赖既有工程文化 | ci_068 | `struggling to achieve adoption` `engineering culture` | 幻N 溯Y 显N 用Y | | |
| 13 | 经验少者获益低但 token 花费更高 | ci_068 | `less helpful` `higher AI token bills` | 幻N 溯Y 显N 用Y | | |
| 14 | 较 2024 负面减少、积极未增、工具提信任 | ci_068 | `2024` `improves trust` | 幻N 溯◐(缺 2024) 显N 用Y | | |
| 15 | 代码所有权弱化、团队协作降低 | ci_068 | `code ownership` `collaboration within teams` | 幻N 溯Y 显N 用Y | | |

> AI 预判：**幻觉 0/15**；溯源 6 条覆盖不足（截断，#1/#4/#8/#10/#11/#14，非幻觉）；**非显然 0/15**（全单源忠实复述）。请独立验证、勿照抄。

## 评完回填两处

1. **报告级勾选** → `dogfood-feedback.md`「评审记录」表的「评审人 A/B」行（有用/可信/非显然/多源去噪 + 问题）。
2. **汇总** → `dogfood-feedback.md`「汇总」段：评审人数、各率、**幻觉率(人核) X/15**、🔴 数、高频问题。

**闭环成立 = ≥2 人填完 + 汇总确认无 🔴。** 🔴 判据：编造事实 / 不可达引用进报告 / 跑题 / 拒答空报告。
