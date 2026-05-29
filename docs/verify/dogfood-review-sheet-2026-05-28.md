# Dogfood 评审工作表（重生轮 · 双主题 · 2026-05-28）

> 配 `dogfood-feedback.md` 用。评审对象 = **HTML 治本后重生**的两主题报告：
> - **swe**（AI 软件工程）：`rep_8bdf3a13`（brief）/ `rep_a99a6530`（deep_dive，批 `batch_c6c53b51`，**30 条**）
> - **security**（AI 时代的安全）：`rep_34d35c18`（brief）/ `rep_af85ba6b`（deep_dive，**15 条**，analyzeWithSplit 拒答隔离后存活）
> ⚠️ 取代旧轮 `rep_0a6aea1b`/`rep_0f4607fc`——旧报告含 HTML 截断 bug（数字被 `<strong>`/`<a>` 标签从 quote 切掉），已由 `normalizeBody` 剥标签修复并重生。
> 打开报告：`open .data/reports/rep_8bdf3a13.html` / `rep_34d35c18.html`（自包含 HTML，可直接发同事）或 `npm run dev` → 报告库。
> 报告里引用只显示 `ci_xxxx` 代码、点不开——**用下表的「核验关键词」到对应原文链接 Ctrl-F**，几秒确认结论里的数字/实体是否属实。

## swe · 原文链接（10 文章 · 3 源）

| 代码 | 标题 | 链接 |
|---|---|---|
| `ci_bd6` | [AINews] Thinking Machines' Native Interaction（latent.space） | https://www.latent.space/p/ainews-thinking-machines-native-interaction |
| `ci_0ef` | [AINews] Google I/O 2026: Gemini 3.5 Flash, Antigravity 2.0（latent.space） | https://www.latent.space/p/ainews-google-io-2026-gemini-35-flash |
| `ci_fe5` | [AINews] How to land a job at a frontier lab（latent.space） | https://www.latent.space/p/ainews-how-to-land-a-job-at-a-frontier |
| `ci_c9a` | Railway: The Agent-Native Cloud — Jake Cooper（latent.space） | https://www.latent.space/p/railway |
| `ci_2d2` | Designing Data-Intensive Applications w/ Martin Kleppmann（Pragmatic） | https://newsletter.pragmaticengineer.com/p/designing-data-intensive-applications |
| `ci_068` | AI's impact on software engineers 2026 · Part 2（Pragmatic） | https://newsletter.pragmaticengineer.com/p/ai-impact-on-software-engineers-part-2 |
| `ci_1a6` | The impact of AI on software engineers 2026 · Part 1（Pragmatic） | https://newsletter.pragmaticengineer.com/p/the-impact-of-ai-on-software-engineers-2026 |
| `ci_753` | TypeScript, C# and Turbo Pascal w/ Anders Hejlsberg（Pragmatic） | https://newsletter.pragmaticengineer.com/p/typescript-c-and-turbo-pascal-with |
| `ci_dd5` | Hermes Agent: Agents that grow with you（Practical AI） | https://share.transistor.fm/s/451da102 |
| `ci_221` | Humility in the Age of Agentic Coding（Practical AI · Steve Klabnik） | https://share.transistor.fm/s/7e1ca2c8 |

## 怎么用

每条洞察判 4 件事，在「评审 A/B」栏写代码：**幻**(幻觉 Y/N) · **溯**(quote 在原文找得到、且覆盖结论里的数字 Y/◐/N) · **显**(非显然/跨源 Y/N) · **用**(有用 Y/N)。例：`幻N 溯Y 显N 用Y`。
- **幻觉判据**：到原文 Ctrl-F「核验关键词」——**查无 = 幻觉(🔴)**；查到、但不在报告所引那条 quote 里（在原文别处）= 覆盖不足(🟡 补引、非幻觉)。
- **重点抽核**（截断 quote / 数字不在片段 / 校验存疑）：**swe** #8·#13·#15·#19·#29（覆盖◐）+ #2·#25（〔待核实〕）；**security** #9·#10·#11（〔待核实〕= ATLAS v5.2.0、单引一条名+列举多项，请人工补判一致性）。

## swe · 逐条工作表（30 条已发布）

| #   | 结论关键词                                                                             | 源                         | 核验关键词（Ctrl-F 原文）                                                                  | AI 预判                                                             | 评审 A                                       | 评审 B                                       |
| --- | --------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 1   | Coding Agent Index 评测 模型+harness 组合，成本/token/缓存/时延数量级差异                           | ci_bd6                    | `Coding Agent Index` `(>30x)` `80–96%` `(>7x)`                                    | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 2   | Opus 4.7+Cursor 得分 61 居首，GPT-5.5 次之；GLM-5.1/Kimi K2.6/DeepSeek V4 Pro 开源仍有竞争力     | ci_bd6                    | `scored 61` `GPT-5.5` `GLM-5.1` `Kimi K2.6`                                       | 幻N 溯Y 显N 用Y · **〔待核实〕校验掉线**                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 3   | aggit 版本管理 / Claude agents 终端 / Cursor 进 MS Teams 自动开 PR                          | ci_bd6                    | `aggit` `Microsoft Teams` `opens a PR`                                            | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 4   | Kleppmann：LLM 产码使人工 review 成瓶颈；LLM 写形式化证明能力升 → 形式化验证或普及                           | ci_2d2                    | `human review becomes the bottleneck` `formal proofs`                             | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 5   | DeepSeek V4 Flash 高负载 agent 场景效率异常高、远低于 GPT/Gemini flash 成本                       | ci_bd6                    | `DeepSeek V4 Flash` `dramatically cheaper` `unusually efficient`                  | 幻N 溯Y 显N 用~                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 6   | Gemini 3.5 Flash 即日 GA，1M 上下文/65k 输出/4 级思考/跨轮思维保持                                 | ci_0ef                    | `GA today` `1M token` `65k max output` `4 thinking levels` `thought preservation` | 幻N 溯◐(4级/跨轮在原文未在 quote) 显N 用Y                                     | 幻N 溯◐ 显N 用Y                                | 幻N 溯◐ 显N 用Y                                |
| 7   | Antigravity 2.0；93 子代理 12 小时建 OS、2.6B token、<$1000 API；称 12× 更快                   | ci_0ef                    | `Antigravity 2.0` `93 parallel` `2.6B tokens` `< $1K` `12x faster`                | 幻N 溯◐(桌面/CLI/SDK 未在 quote) 显N 用Y                                  | 幻N 溯◐ 显N 用Y                                | 幻N 溯◐ 显N 用Y                                |
| 8   | Gemini 3.5 Flash：Arena Code 1507(+70)、TB2.1 76.2%；成本 5.5×Gemini3Flash、1.75×3.1Pro | ci_0ef                    | `1507` `Terminal-Bench 2.1: 76.2%` `5.5x costlier` `75% costlier`                 | 幻N 溯◐(1507/+70、"1.75"=75%costlier 换算 未在 quote) 显Y 用Y · **重点核**    | 幻N 溯Y(1507/+70未在quote, 1.75在，属于换算正确) 显N 用Y | 幻N 溯Y(1507/+70未在quote, 1.75在，属于换算正确) 显N 用Y |
| 9   | Google 处理量 480T→3.2 quadrillion（≈7×），Gemini app 月活 9 亿+                           | ci_0ef                    | `3.2 quadrillion` `480 trillion` `900M+ monthly`                                  | 幻N 溯Y 显N 用Y ·（HTML 修复铁证条）                                         | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 10  | coding agent 共识：质量靠可验证约束/分解/反馈而非提示技巧；Chollet 比作 blind squirrels                   | ci_fe5                    | `constrain, verify, decompose` `blind squirrel` `Chollet`                         | 幻N 溯◐(Chollet/blind squirrels 未在 quote) 显Y 用Y                     | 幻N 溯◐ 显N 用Y                                | 幻N 溯◐ 显N 用Y                                |
| 11  | Anthropic/OpenAI/MS coding agent 趋同：后台执行/远程监控/扇出                                  | ci_fe5                    | `background execution` `monorepos` `Copilot CLI`                                  | 幻N 溯◐(MS Copilot CLI GA 未在 quote) 显Y 用Y                           | 幻N 溯◐ 显Y 用Y                                | 幻N 溯◐ 显Y 用Y                                |
| 12  | agent 基建转可观测：LangSmith Engine=agent 的 CI/CD；Devin Auto-Triage 常驻 first responder  | ci_fe5                    | `LangSmith Engine` `CI/CD loop` `Devin Auto-Triage`                               | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 13  | Cursor Composer 2.5；与 "SpaceXAI" 合作从头训更大模型、用 10× 总算力                              | ci_fe5                    | `Composer 2.5` `SpaceXAI` `10× more total compute`                                | 幻N 溯◐(quote 截于 "with "；SpaceXAI 是**原文词**、10× 在原文) 显N 用Y · **重点核** | 幻N 溯◐ 显N 用Y                                | 幻N 溯Y◐ 显N 用Y                               |
| 14  | llama.cpp 为 Qwen3.6 加 MTP；27B dense 在 A10G 由 25→45 tok/s(+78%)                    | ci_fe5                    | `MTP` `Qwen3.6` `25 tok/s to 45 tok/s (+78%)`                                     | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 15  | Railway 35 人服务 300 万用户、每周新增 10 万、融资 1.24 亿美元，定位 agent 原生云                         | ci_c9a                    | `35-person` `3 million users` `100,000 signups` `$124m`                           | 幻N 溯Y(原文 $124m；"1.24 亿"=换算) 显N 用Y · **重点核(数字换算)**                 | 幻N 溯Y(换算) 显N 用Y                            | 幻N 溯Y(换算) 显N 用Y                            |
| 16  | Railway：agent 需版本控制/可观测/计算/存储/编排达千倍规模；CLI 或比 canvas 重要                            | ci_c9a                    | `1000x scale` `CLI may become more important than the canvas`                     | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 17  | Railway：Git/PR/CI-CD 部署循环面临重写，PR 正消亡，转向 feature flag/渐进发布                         | ci_c9a                    | `The Pull Request Is Dying` `Feature Flags` `heading for a rewrite`               | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 18  | Railway：关注 coding agent token 消耗/路线图加速，探索 SRE agent 与生产 fork                      | ci_c9a                    | `Token Spend` `SRE Agents` `Production Forks`                                     | 幻N 溯Y 显N 用~                                                       | 幻N 溯Y 显N 用N                                | 幻N 溯Y 显N 用N                                |
| 19  | Pragmatic 2026 调查(900+)：AI 效果取决于既有工程文化，好实践被放大、坏的也是                                | ci_068                    | `amplifier, not a fixer` `900`                                                    | 幻N 溯◐("900" 未在本条 quote) 显Y 用Y · **重点核**                           | 幻N 溯◐ 显Y 用Y                                | 幻N 溯◐ 显Y 用Y                                |
| 20  | AI 致代码质量降：冗余重复/抽象差/bug 入生产；维护落少数人；管理层重产出轻质量                                       | ci_068                    | `codebase quality is decreasing` `duplicated, verbose` `higher output`            | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 21  | 生产力增益因人而异；自选工具致团队级工具碎片化；规模化采纳未解                                                   | ci_068                    | `idiosyncratic` `10x more productivity` `little coherence`                        | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 22  | 经验少者获益更有限、却消耗更多 token；缺辨别力者用 AI 加剧质量隐患                                            | ci_068                    | `less helpful` `higher AI token bills`                                            | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 23  | Hejlsberg：AI 对语言的辅助取决于训练数据规模而非设计；写编译器仍受限                                          | ci_753                    | `best suited for AI` `training set` `compilers`                                   | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 24  | 部分企业因 AI 产码致生产事故/文档质量降而回滚 AI 工具，先治质量再推进                                           | ci_068                    | `rolled back some of our AI tools` `production incidents`                         | 幻N 溯Y 显Y 用Y                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                                |
| 25  | 部分工程师称 AI agent 体验像"老虎机"成瘾、鼓励反复提示；疑定价助长                                           | ci_068                    | `slot machine` `pricing of plans`                                                 | 幻N 溯◐(slot machine 未在 quote) 显N 用~ · **〔待核实〕校验掉线**                | 幻N 溯◐ 显N 用Y                                | 幻N 溯◐ 显N 用Y                                |
| 26  | 角色从写代码转向编排/审查 AI：Klabnik 从批评 AI 到用 agent 建 Rue 语言；Hermes/Nous 自改进 agent           | ci_dd5 / ci_221 (+ci_1a6) | `Steve Klabnik` `Rust` `Rue` `Hermes` `Nous` `self-improving`                     | 幻N 溯Y 显**Y(唯一跨源)** 用Y                                             | 幻N 溯Y 显Y(跨源) 用Y                            | 幻N 溯Y 显Y(跨源) 用Y                            |
| 27  | Pragmatic 900+ 调查：约 15% 提及成本；企业约 $200/人/月；多数认为 AI 工具会涨价                           | ci_1a6                    | `around 15% of respondents` `~$200/month` `price` `will have to rise`             | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 28  | 约 30% 受访者触及使用上限；耗尽 token/触发重置打断心流，新手与重度用户都受影响                                     | ci_1a6                    | `Hitting limits: ~30%` `Running out of tokens`                                    | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |
| 29  | 工程师分 Builder/Shipper/Coaster：各群体承受/产生 AI slop 不同，引发 Builder 不满                    | ci_1a6                    | `Builder` `Shipper` `Coaster` `slop`                                              | 幻N 溯◐(类名/slop 在原文，quote 截断) 显Y 用Y · **重点核**                       | 幻N 溯◐(quote 截断) 显Y 用Y                      | 幻N 溯◐(quote 截断) 显Y 用Y                      |
| 30  | 英国/欧盟企业 AI 预算比美国更谨慎，欧洲要先见明确价值增量才增支出                                               | ci_1a6                    | `UK and EU companies worry more about budgets` `clear value-add`                  | 幻N 溯Y 显N 用Y                                                       | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                                |

> AI 预判（grep 清洗后原文逐条核，详见 `hallucination-prereview-2026-05-28.md`）：**幻觉 0/30**；溯源 ~8 条覆盖◐（截断/换算/合成，#6/#7/#8/#10/#11/#13/#15/#19/#25/#29，**非幻觉、应补引**）；**非显然/跨源 1/30**（#26 跨 Practical AI×2 + Pragmatic），其余多为单源聚合/复述。请独立验证、勿照抄。

## security · 原文链接（8 文章 · 3 源）

| 代码 | 标题 | 链接 |
|---|---|---|
| `ci_0d1` | MITRE ATLAS v5.1.0（GitHub release） | https://github.com/mitre-atlas/atlas-data/releases/tag/v5.1.0 |
| `ci_3e7` | MITRE ATLAS v5.0.0（GitHub release） | https://github.com/mitre-atlas/atlas-data/releases/tag/v5.0.0 |
| `ci_f4f` | MITRE ATLAS v5.2.0（GitHub release） | https://github.com/mitre-atlas/atlas-data/releases/tag/v5.2.0 |
| `ci_c3d` | MITRE ATLAS v5.3.0（GitHub release） | https://github.com/mitre-atlas/atlas-data/releases/tag/v5.3.0 |
| `ci_2d5` | Risky Business #825（risky.biz） | https://risky.biz/RB825 |
| `ci_ef2` | Risky Business #818（risky.biz） | https://risky.biz/RB818 |
| `ci_d5d` | Risky Business #799（risky.biz） | https://risky.biz/RB799 |
| `ci_9d2` | Memory-Induced Tool-Drift in LLM Agents（arXiv 2605.24941） | https://arxiv.org/abs/2605.24941v1 |

## security · 逐条工作表（15 条已发布）

> ⚠️ 中性框定：以下均为**已公开报道**的威胁情报/防御框架摘录（MITRE ATLAS 公开技术名、Risky Business show notes、arXiv 论文）；quote 为公开技术名/标题逐字，**非操作指南**。评审重点 = 这些技术名/CVE/具名实体/数字是否真在原文，而非攻击细节。

| #   | 结论关键词                                                                               | 源      | 核验关键词（Ctrl-F 原文）                                                                                         | AI 预判                                      | 评审 A                          | 评审 B                          |
| --- | ----------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------- | ----------------------------- |
| 1   | ATLAS v5.1.0 新增攻击技术：Prompt Infiltration / Manipulate Chat History / Delay Execution | ci_0d1 | `Prompt Infiltration via Public-Facing Application` `Manipulate User LLM Chat History` `Delay Execution` | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 2   | ATLAS v5.1.0 新增缓解：特权权限配置 / 人机协同 / 限制不可信数据工具调用 / Memory Hardening                    | ci_0d1 | `Privileged AI Agent Permissions` `Human In-the-Loop` `Memory Hardening`                                 | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 3   | ATLAS v5.1.0 新案例：Slack AI/Copilot Studio 数据泄露、ChatGPT 记忆篡改、规则文件后门供应链                | ci_0d1 | `Data Exfiltration from Slack AI` `Copilot Studio` `Rules File Backdoor`                                 | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 4   | ATLAS v5.0.0 新增 Agent 攻击技术：上下文投毒 / RAG 凭证收割 / 工具调用窃取 / 触发式注入                        | ci_3e7 | `AI Agent Context Poisoning` `RAG Credential Harvesting` `LLM Prompt Injection: Triggered`               | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 5   | Proofpoint 收购 Acuvity、Cisco 扩展 AI Defense + AI-Aware SASE                           | ci_2d5 | `Proofpoint acquires Acuvity` `Cisco` `AI-Aware SASE`                                                    | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 6   | Google：国家支持黑客在攻击全周期使用 AI                                                            | ci_2d5 | `state-sponsored hackers use AI` `all stages`                                                            | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 7   | 英国网安机构：LLM 将始终易受 prompt injection                                                   | ci_ef2 | `always be vulnerable to prompt injection`                                                               | 幻N 溯Y 显N 用Y                                | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 8   | （ATLAS v5.3.0）更新 LLM Prompt Obfuscation + AI Supply Chain Compromise 描述             | ci_c3d | `LLM Prompt Obfuscation` `AI Supply Chain Compromise: AI Software`                                       | 幻N 溯Y 显N 用~ ·（"该版本"指代模糊=v5.3.0）            | 幻N 溯Y 显N 用Y（"该版本"指代模糊=v5.3.0） | 幻N 溯Y 显N 用Y（"该版本"指代模糊=v5.3.0） |
| 9   | ATLAS v5.2.0 新增 Agent 技术（Tool Credential Harvesting 等）+ 缓解（Segmentation 等）          | ci_f4f | `AI Agent Tool Credential Harvesting` `Segmentation of AI Agent Components`                              | 幻N 溯◐(仅引 1 名、claim 列举多项) 显N 用Y · **〔待核实〕** | 幻N 溯◐ 显N 用Y                   | 幻N 溯◐ 显N 用Y                   |
| 10  | ATLAS v5.2.0 更新注入技术 + Generative AI Guardrails 防护                                   | ci_f4f | `Prompt Infiltration` `LLM Prompt Obfuscation` `Generative AI Guardrails`                                | 幻N 溯Y 显N 用Y · **〔待核实〕**                    | 幻N 溯Y 显N 用Y                   | 幻N 溯Y 显N 用Y                   |
| 11  | ATLAS v5.2.0 武器化案例：SesameOp(C2)/嵌注入恶意软件原型/LAMEHUG 动态生成命令                            | ci_f4f | `SesameOp` `Embedded Prompt Injection` `LAMEHUG`                                                         | 幻N 溯Y 显Y 用Y · **〔待核实〕**                    | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 12  | Fortinet CVE-2025-25257 预认证 RCE / HPE 硬编码密码 / Citrix 在野利用 / SonicWall 后门            | ci_d5d | `CVE-2025-25257` `hardcoded passwords` `SonicWall`                                                       | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 13  | 中国关联：SharePoint 0day / Salt Typhoon 入侵国民警卫队 / 新加坡指控攻击关键基建                           | ci_d5d | `SharePoint Zero-Day` `Salt Typhoon` `Singapore`                                                         | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 14  | memory-induced tool-drift：偏转评分最高 +3.6（1-5）；288 MCP 上 6062 工具中 608 含易感参数             | ci_9d2 | `memory-induced tool-drift` `+3.6` `6{,}062` `288 verified MCP` `608`                                    | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |
| 15  | 有偏记忆=隐式引导向量；标准防御（提示相关性/记忆过滤）减轻但不能消除漂移                                               | ci_9d2 | `implicit steering vectors` `reduce drift but do not eliminate`                                          | 幻N 溯Y 显Y 用Y                                | 幻N 溯Y 显Y 用Y                   | 幻N 溯Y 显Y 用Y                   |

> AI 预判（grep 清洗后原文逐条核）：**幻觉 0/15**；引用覆盖 **0 未覆盖**（quote 多为公开技术名/标题逐字、短而精确，溯源体验好）；**跨源 0/15**（每条单文章，多为源内聚合：一个 ATLAS release / 一期 Risky Business 含多条目）。2 处词形差异（v5.2.0 / `6{,}062` LaTeX）非问题。请独立验证、勿照抄。

## 评完回填两处

1. **报告级勾选** → `dogfood-feedback.md`「评审记录」表的「评审人 A/B」行（有用/可信/非显然/多源去噪 + 问题）。
2. **汇总** → `dogfood-feedback.md`「汇总」段：评审人数、各率、**幻觉率(人核) X/45**（swe 30 + security 15）、🔴 数、高频问题。

**闭环成立 = ≥2 人填完 + 汇总确认无 🔴。** 🔴 判据：编造事实 / 不可达引用进报告 / 跑题 / 拒答空报告。截断 quote、单源、〔待核实〕均为 🟡（不阻断）。
