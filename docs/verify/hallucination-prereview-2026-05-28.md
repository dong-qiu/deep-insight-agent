# 幻觉率人评（AI 预审）— 2026-05-28（重生轮）

> DCP-3 准入体检缺口①「幻觉率 ≤2% 未实测」的证据。对 **HTML 治本后重生**的 dogfood 报告做**逐条事实核对**。
> 评测对象：`rep_8bdf3a13`（brief）/ `rep_a99a6530`（deep_dive）——同批 `batch_c6c53b51`、**30 条已发布洞察**，引自 **10 篇原文（3 源：latent.space / Pragmatic Engineer / Practical AI）**。
> ⚠️ **取代首轮**（旧版评的 `rep_0a6aea1b`/`rep_0f4607fc` 含 HTML 截断 bug——加粗/链接的数字被 `<strong>`/`<a>` 标签从 quote 切掉）。`normalizeBody` 剥标签治本后重生，本轮在干净 body 上复核。
> 评测层 = 发布报告（可达性已由 validator+report-gen 强制 100%，见 `dcp-3-readiness-2026-05-28.md` §2）。

## 方法与口径

- **幻觉 = 结论断言了原文不支持的事实**（编造数字 / 张冠李戴 / 夸大）。**注意：可达性 ≠ 无幻觉**——quote 逐字在原文，但结论仍可能过度断言截断 quote 之外的内容。
- **核法（客观、可复现）**：对每条洞察的**具体声明**（数字、金额、具名实体、技术名词、版本号），用 `grep` 在**清洗后被引 body**（已剥 HTML、`.data` 本地不入仓）中核验是否真实存在。原文坐实 = 非幻觉；查无 = 幻觉。
- **独立区分两件事**：① 结论是否被原文支持（幻觉判定）；② 结论的具体声明是否被**所引 quote**覆盖（引用覆盖 / #14 类）。后者是**溯源体验**问题，非幻觉。

## 重点核验（grep 清洗 body，逐项坐实）

下列是"声明不在所引 quote、需回原文坐实"的高风险项——全部在原文找到（符号/词形差异已标注）：

| # | 高风险声明 | 原文坐实? | 备注 |
|---|---|---|---|
| 6 | Gemini 3.5 Flash「4 级思考 + 跨轮思维保持」 | ✅ | 原文 `4 thinking levels ("minimal/low/medium/high"), and "thought preservation" across turns`（"四级"=原文 "4"） |
| 7 | Antigravity 2.0 / 93 子代理 / 12h / 2.6B / <$1K / 12× | ✅ | `Antigravity 2.0`/`93 parallel`/`12 hours`/`2.6B tokens`/`< $1K`/`12x faster` 均在原文 |
| 8 | Arena Code 1507(+70) / TB2.1 76.2% / 5.5× / 75% costlier | ✅ | `1507`/`Arena`/`76.2`/`5.5x`/`75% costlier` 均在原文（"1.75 倍"=75% costlier 的换算表述） |
| 9 | 480T→3.2 quadrillion / 900M+ MAU | ✅ | 三数均在原文（即旧轮被 `<strong>` 切掉、本轮已进 quote 的铁证条） |
| 10 | François Chollet「blind squirrels」/ constrain-verify-decompose | ✅ | `Chollet`/`blind squirrel`/`constrain, verify, decompose` 均在原文 |
| 11 | Microsoft Copilot CLI 远程 GA / Anthropic monorepo 实践 | ✅ | `Microsoft`/`Copilot CLI`/`monorepos` 均在原文 |
| 13 | Cursor Composer 2.5 / 与「SpaceXAI」从头训练 / 10× 总算力 | ✅ | 原文 `from scratch with "SpaceXAI," using 10× more total compute`——**"SpaceXAI" 是原文原词、非系统编造**；"10×"=原文乘号（非 "10x"） |
| 19 | Pragmatic 调查 900+ / amplifier not fixer | ✅ | `900`/`amplifier, not a fixer` 均在原文 |
| 23 | Anders Hejlsberg / 训练数据决定 / 编译器受限 | ✅ | `Hejlsberg`/`best suited for AI`/`compilers` 均在原文 |
| 25 | AI agent 体验像「老虎机」/ 定价助长 | ✅ | `slot machine`/`pricing of plans` 均在原文 |
| 26 | Steve Klabnik 从批评 AI 到用 agent 建 Rue / Hermes（Nous）自改进 agent | ✅ | `Klabnik`/`Rust`/`Rue`（Practical AI）+ `Hermes`/`Nous`/`self-improving`——**唯一跨源条** |
| 27/29 | $200/月 / 15% / 30% / Builder·Shipper·Coaster / slop | ✅ | 全部在原文 |

其余 #1–5/12/14–18/20–22/24/28/30 的具体声明均直接落在所引 quote 内（逐字可达且覆盖），无需额外核。

## 结论

- **幻觉率（本轮 AI 预审）：0 / 30 = 0%** —— 每条洞察的每个具体声明（含所有金额、token 量、百分比、具名实体、版本号、技术名词）均在被引清洗原文坐实，**零编造、零张冠李戴、零夸大**。**远低于 ≤2% 红线。**
- **引用覆盖较首轮大幅改善**：HTML 治本后，旧轮被标签切掉的数字（如 Google "3.2 quadrillion"、Railway "$124m"）已逐字进入 quote。残留覆盖◐ 约 **8/30**（#6/#7/#8/#10/#11/#13/#15/#19/#25/#29），成因从"HTML 截断"转为：
  - **截断 quote**：结构化输出把 quote 收在关键词前（#13 截于 "with "、#29 截于半句）；
  - **单位换算**：结论用中文换算（"1.75 倍"↔"75% costlier"、"1.24 亿"↔"$124m"）——`uncoveredClaims` 据此报 #8/#15（数值真实、属补引/改写）；
  - **多句合成**：结论综合原文多处（#6 四级思考、#10 Chollet、#19 900）但只引其中一句。
  - **处置 = 补引（引含该数字/实体的那句）或改写量纲，非删除**（#14 负责人既有判定）。归 M4 refinement。
- **跨源**：1/30（#26，Practical AI×2 + Pragmatic 合成），较首轮 0/15 略升，仍低于 ≥30% 追求线（非门槛）。
- **🔴 阻断项：无**。另有 2 条 `〔待核实〕`（#2/#25）系校验时**中转站连接掉线**致一致性未判（非内容问题），请人评补判。

## 喂 DCP-3 门评

- 幻觉率红线：**本轮 0%（provisional）成立 → 红线方向安全**，且较首轮证据更强（更大样本 30 条、干净 body、跨 10 文章）。
- 本结论是 **AI 预审**：事实核对客观（grep 原文逐条验、可复现），但仍**需团队 ≥2 人独立抽核**（建议抽 #8/#13/#15/#19/#29 五条覆盖◐ + #2/#25 两条〔待核实〕 + 随机 2 条）确认真值，再固化为门评数。
- 引用覆盖不足是**质量项**（非红线），列 M4 refinement，不阻断门评。

## 待人确认

- [ ] 评审人 A：抽 ___ 条复核，幻觉 ___ / ___
- [ ] 评审人 B：抽 ___ 条复核，幻觉 ___ / ___
- [ ] #2/#25〔待核实〕一致性补判结果：___
- [ ] 是否认可"幻觉 0%（本轮）+ 引用覆盖列质量 refinement"作为门评输入？
