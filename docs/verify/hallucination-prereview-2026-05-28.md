# 幻觉率首轮人评（AI 预审）— 2026-05-28

> DCP-3 准入体检缺口①「幻觉率 ≤2% 未实测」的首轮证据。对 dogfood 已发布报告做**逐条事实核对**。
> 评测对象：`rep_0a6aea1b`（brief）/ `rep_0f4607fc`（deep_dive）——**同一组 15 条洞察**（深度版仅按重要性重新分节），引自 **5 个原文**。
> 评测层 = 发布报告（可达性已由 validator+report-gen 强制 100%，见 `dcp-3-readiness-2026-05-28.md` §2）。

## 方法与口径

- **幻觉 = 结论断言了原文不支持的事实**（编造数字 / 张冠李戴 / 夸大）。**注意：可达性 ≠ 无幻觉**——quote 逐字在原文，但结论仍可能过度断言截断 quote 之外的内容。
- **核法（客观、可复现）**：对每条洞察的**具体声明**（数字、金额、具名实体、技术名词），用 `grep` 在**被引原文全文 body**（`.data` 本地，不入仓）中核验是否真实存在。原文坐实 = 非幻觉；查无 = 幻觉。
- **独立区分两件事**：① 结论是否被原文支持（幻觉判定）；② 结论的具体声明是否被**所引 quote**覆盖（引用覆盖 / #14 类，截断 quote 常导致数字落在 quote 之外但仍在原文）。后者是**溯源体验**问题，非幻觉。

## 逐条核对（15 条）

| # | 结论关键声明 | 原文坐实? | 所引 quote 覆盖该声明? | 判定 |
|---|---|---|---|---|
| 1 | Google 月处理 3.2 quadrillion token、去年 480 trillion、增 7× | ✅ `3.2 quadrillion`/`480 trillion`/`7x` 均在原文 | ❌ quote 截断于 "processes " 前 | 忠实 · 覆盖✗ |
| 2 | DHH 约六个月转 agent-first、几乎不手写 | ✅（"barely writes any code"；六个月见同源语境） | ◐ 主句✓，"六个月"在源未在本 quote | 忠实 |
| 3 | tab→agent harness + Opus 4.5 是接受度转折 | ✅ | ✅（quote 含 "Opus 4.5"） | 忠实 |
| 4 | tmux 跑 Gemini 2.5 + Opus、NeoVim 审 diff | ✅ `tmux`×8/`NeoVim`/`Gemini 2.5` 均在原文 | ◐ Gemini/Opus/split✓；tmux/NeoVim 在源未在 quote | 忠实 · 覆盖◐ |
| 5 | Rails token 高效/测试内建/适配 agent | ✅ | ✅ | 忠实 |
| 6 | AI 放大资深、挑战初级（不均匀） | ✅ | ✅ | 忠实 |
| 7 | P1 延迟 4ms→<0.5ms | ✅ | ✅（quote 直含 "4 milliseconds to under half a millisecond"） | 忠实 |
| 8 | Anthropic+Blackstone/Goldman $1.5B JV；OpenAI Deployment Co. $10B 估值/募 $4B | ✅ `$1.5B`/`$10B`/`$4B`/`Blackstone`/`Goldman`/`Deployment Company` 均在原文（"等"概括 Hellman&Friedman） | ❌ 两条 quote 是 "knowledge work"，不含金额/公司名 | 忠实 · 覆盖✗ |
| 9 | 合资模式 = 定制集成而非通用 API（推断） | ✅（"develop Claude-powered systems tailored"） | ✅（分析性推断，合理） | 忠实 |
| 10 | kernel 级性能调优是 LLM 最大瓶颈/入行路径 | ✅（原文 "biggest bottleneck...performance work" + "tune the LLMs at [kernel]"） | ❌ 两条 quote 均截断于 substance 前 | 忠实 · 覆盖✗ |
| 11 | 900+ 订阅调查：质量下降/管理层不关注/维护落少数人 | ✅ `900`✓、"quality decreasing"✓、"maintenance...falling upon a shrinking number of engineers"✓ | ◐ 质量/管理层✓；"900"与"维护"子句未在 quote | 忠实 · 覆盖◐ |
| 12 | 组织级推广难、收益依赖既有工程文化 | ✅ | ✅ | 忠实 |
| 13 | 经验少者获益低但 token 花费更高 | ✅ | ✅ | 忠实 |
| 14 | 较 2024 负面减少、积极未显增、工具提信任 | ✅ `2024`✓ | ◐ 模型质量/信任✓；"2024"未在 quote | 忠实 · 覆盖◐ |
| 15 | 代码所有权弱化、团队协作重要性降低 | ✅ | ✅ | 忠实 |

## 结论

- **幻觉率（首轮 AI 预审）：0 / 15 = 0%** —— 每条洞察的每个具体声明（含所有金额、token 量、百分比、具名实体、技术名词）均在被引原文坐实，**零编造、零张冠李戴**。**远低于 ≤2% 红线。**
- **暴露的真实问题 = 引用覆盖不足（#14 类，非幻觉）**：约 **6/15**（#1/#4/#8/#10/#11/#14）的具体声明**真实但未被所引 quote 覆盖**——多因 analyzer 结构化输出**截断**了 quote（数字/实体落在被截掉的尾部）。后果：用户点击引用看到的是截断片段，**事实虽真，逐字溯源体验弱**。尤以 #8（重点条、$1.5B/$10B/$4B 均不在其 quote）最明显。
  - 这正是 `uncoveredClaims` 检测器的设计目标（dogfood 已标 3.2/1%/0.5 待补引）。
  - **处置 = 补引（让 analyzer 引含数字的那句）+ 截断 streaming 治本，非删除**（#14 负责人既有判定）。归 M3-6 余项 / M4 refinement。

## 喂 DCP-3 门评

- 幻觉率红线：**首轮 0%（provisional）成立 → 红线方向安全**。
- 但本结论是 **AI 预审**：事实核对部分客观（grep 原文逐条验，可复现），但仍**需团队 ≥2 人独立抽核**（建议至少抽 #8/#10/#11 三条截断 quote 条 + 随机 2 条）确认真值，再固化为门评数。
- 引用覆盖不足是**质量项**（非红线），列 M3-6/M4 refinement，不阻断门评。

## 待人确认

- [ ] 评审人 A：抽 ___ 条复核，幻觉 ___ / ___
- [ ] 评审人 B：抽 ___ 条复核，幻觉 ___ / ___
- [ ] 是否认可"幻觉 0%（首轮）+ 引用覆盖列质量 refinement"作为门评输入？
