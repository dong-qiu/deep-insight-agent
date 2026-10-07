# Daily Brief 阶段 0：实时集成交接

> 2026-10-07 · 持续更新。阶段 0 工程准备已由 #432 合入；T03 人工金标与 T04 尚未完成，正式留出未打开，C1 首次提取尚未运行。C1/P/C/I shadow 准备正在串行集成。本文不代表软件工程试点、人评或生产准入已完成。

## 当前基线与环境

开始时重新执行 `git fetch origin main`、本地及远端 SHA 查询、全部 worktree 的 `git status --porcelain`、开放 PR 查询及精确 SHA 的 CI 查询。初始基线为 `473e2eeae119b600b63abd78ce886301bd882235`，当时本地 main 与 origin/main 一致；以下初始记录不是实时 main 声明。
[main CI 37562025600](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600) 已成功；[镜像发布 37562408396](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562408396) 是另一个工作流，不作为生产部署收据。

开始时实际存在 11 个 worktree，Git 工作区均干净；没有将旧交接记录中的 15 个当作当前值。开放 PR 为 #430、#429、#425、#424、#402、#400、#373；其中 #429/#430 属其他会话，保持不动。[#360](https://github.com/dong-qiu/deep-insight-agent/pull/360) 的实际 merge 为 `1bf16e4bb75e9fb04dcc70f9d15ccbdc14b5bb24`，只关闭诊断归档门。B1 保持 no-go，不能以此认定 S1 通过。

从已核实 main 新建四个 linked worktree：`insight-agent-rich-brief-integration`、`-data`、`-contract`、`-freshness`。每个仅复制 `.env.local`，权限 0600；重新绑定各自 `.data/rich-brief-stage0/isolated.db` 与 `data/`。未复制任何数据库、WAL、报告、旧 `.data/` 或 `.env.development.local`。新私有目录 0700。原有 worktree、配置及私有材料保留。配置指纹与状态保全收据写入集成树 gitignored 私有目录，不提交或发送给 reviewer。

## 试点读者与产品边界

首个主题固定为**软件工程**。读者是负责工具链和开发流程决策的技术负责人、资深开发者。每条消息支持三类判断：发生了什么技术变化；原文依据及适用条件是否足以支持试验；应该进一步验证什么。重要维度包括影响结论的方法、结果、比较条件、适用范围、限制或反例；具体重要性和事件归属仍需人工标注，不能用 AI 评分代签。

沿用已确认的产品方向、原事件标签和来源支持修订，不重复征求同一确认。未通过 I 门时，只呈现来源明确的影响；工作假设留在离线材料中。旧刊不回填。P 摘要不算全文，C show notes 不算嘉宾发言。`C1-extraction` 在本轮专指首次提取离线对照，和 `experiments/c1-recovery` 的备份恢复能力没有准入关系。

## 第一波所有权与完成门

| 负责人 | 独占文件与接口 | 依赖 | 交付及完成门 |
| --- | --- | --- | --- |
| 数据 Agent | `evals/rich-brief-stage0/data*.ts`；`daily-brief-stage0-data-protocol-2026-10-07.md` | 现有只读 exporter、旧探索分区和人工确认 | 可执行完整输入 worklist、事件/维度/限定/题目缺口、家族分区与未见前瞻声明、T04 fail-closed 检查；失败分母和 unknown 保留；针对性测试、typecheck、非作者审查 |
| 契约 Agent | `daily-brief-versioned-evidence-publication-v0.md`；`daily-brief-stage0-contract-audit-2026-10-07.md` | 真实 schema、analyzer、validator、report-gen 与现行 spec | 版本化来源/命题/证据/校验/artifact 契约及逐项现状；定义失败拒绝、切片顺序和回归门；非作者审查 |
| F Agent | `evals/rich-brief-stage0/freshness*.ts`；`daily-brief-stage0-freshness-baseline-2026-10-07.md` | 完整离线尝试、source/issue 时钟 | 双时钟及分段延迟、阶段损失的可执行离线基线；缺失时钟 unknown；合成测试与实际观察分开；针对性测试、typecheck、非作者审查 |
| 集成负责人 | 本交接；试点与统一完成门；私有环境/资源收据 | 三个独立交付 | 冻结公共 v0 接口、安排非作者轮换审查及串行合入；工程证据与人评/实验门分开记录 |

第一波任何 Agent 均不修改共享 schema、analyzer、validator 或 report-gen。集成负责人先核对共同契约；后续共享变更按来源证据身份 → 命题/校验绑定 → 历史发布与 artifact → 各展示面顺序安排，不能并行自行定口径。

## 冻结与实验停止点

188 个既有曝光版本只能用于探索；旧来源家族的未来复述也不能成为正式留出，未知家族关系不作负例。T03 的完整输入事件、重要维度、必要限定和固定题需要人工签认；三次尝试含失败，不只取已刊子集。T04 在正式留出开启前必须绑定有探索依据的数值、样本下限、阅读与成本预算、停止规则、全部模型/provider/prompt/缓存/来源版本和资源指纹。文件 hash 不证明实际运行模型身份。

私有 `resource-observation.json` 已记录基线八个实现/规格/锁文件指纹，状态为 `observed_not_T04_frozen`。它是资源核对起点，不是假冻结。正式留出尚未打开；新窗口必须从完成冻结之后开始，不能回填为已经前瞻预登记。

使用 `eval-gate` 为每个 diff 选择实际覆盖的门；本波只读工具/文档不以无关 A1 证明阅读效果或新 Brief 质量。准备 PR 时执行 `pre-pr-ai-review`，并由非作者复核最终 diff。未通过门的切片保持关闭。生产部署或开关启用须另有具体版本、验证与回退材料，并向用户确认。

## 波次证据与下一步

| 波次 | 已有证据 | 待完成/阻断 | 下一步 |
| --- | --- | --- | --- |
| 0A 实时核实与隔离 | main SHA/CI、11 既存干净 worktree、7 开放 PR、4 新隔离树、owner-only 配置/资源收据 | 不将历史生产镜像身份当实时生产状态；本轮无生产访问 | 三位 Agent 执行数据、契约、F 工具；完成后轮换独立审查 |
| 0B 数据与契约 | 三切片非作者审查通过；实际 3 run/3 attempt/45 occurrence/23 exact revision 工作表及首批 5 项待判材料已生成 | 23 个输入版本与原确认索引 exact refs 交集 0，完整人工金标、数值探索依据及正式冻结尚缺 | 用户已选对话每批 5 项；首批已发送，未答保持 pending。技术工具先过工程门，不宣称 T03/T04 完成 |
| 0C C1/P/C/I 准备 | 已建立独立环境，P/C/I 私有 inventory 与 C 元数据工具已落盘；C1 准备器收尾 | C1 尚未运行；P 无全文、C 无封存转写、I 人评 pending；各专用预登记仍未完成 | 工程完成门与质量/阅读门分开；先独立审查准备切片，再按依赖补缺，不启动正式阅读卡 |

每波结束追加实际命令、产物 hash、独立审查结论、失败与 unknown，以及下一波任务；不以计划代替收据。

## 0A 工程核对收据

集成树使用 Node `24.19.0`；新 worktree 默认 npm 初次安装曾报告 Node `25.9.0`，已按仓库 engine 切换到 24.19 并重新 `npm ci --no-audit --no-fund`。没有把不满足 engine 的首次安装当作测试依据。

- 两份集成 Markdown 用 `ops/ci-docs-check.mjs` 的真实 `checkDocuments` 检查格式、链接和收据结构：2/2 通过；`git diff --check` 通过。
- `npm run typecheck`：TS7/TS6，各 app/tools 均通过。
- `npx vitest run evals/brief-density/export.test.ts src/lib/agents/report-gen.test.ts src/lib/agents/pipeline-reportgen.integration.test.ts src/lib/db/reports.test.ts`：4 文件、200/200 通过。
- `npx vitest run src/lib/db/report-review.test.ts`：1 文件、4/4 通过。

上述 204 项只核对既有只读导出、真实管线报告接线和发布守卫回归；它们不执行 C1 新提取，不证明新版阅读卡收益、F 时效改善或 P/C/I 生产准入。工具切片新增测试及整合后的 typecheck 另记，不能用此基线核对替代。

## 0B 公共接口冻结与人评停止点

独立契约作者提交 `f89047d` 已按独占所有权纳入集成树 `6f73199`。非作者新上下文 reviewer 核对四份文档与真实代码，复现 `checkDocuments` 4/4、diff 检查通过，Blocking 0 / Warning 0。据此固定[共同接口 v0](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)的**设计基线** `rich-brief-evidence-publication-v0`：source config/content ref 与完整 evidence revision 分开，ClaimIdentity/EvidenceOccurrence/ValidationBinding/PublishedArtifact/ClaimLedger 各自绑定；首刊、深读更新与分析回访分类型。实现时仍须 ADR/架构/迁移及切片质量门，不把此冻结说成已有运行接口、完整资源冻结或 T04 通过。

数据作者实际重新核对三份 raw-verified 导出，得到 3 run、3 attempt、45 input occurrence、23 distinct exact revision；候选总数为 47 / `unknown` / 99，第二期失败不填零。23 版本全部为探索，raw/body 绑定检查无缺口；它们与已确认 30 事件索引的 exact refs 交集为 0，原 10 个软件工程事件确认原样保全，不能机械移植成这批输入的 gold。

私有完整审阅底稿 SHA-256 `18566a61` 前缀，由数据作者收据记录完整 hash；正文与用户资料不提交。用户已收到本地可点击材料和审阅方式问题，待判仅限本批输入的事件、重要维度、限定及固定理解题。人工状态保持 pending，正式留出仍为 0。数值协议不得借 AI 候选、旧重复阅读或本轮工具测试代签；C1 正式对照仍停在预检之前。

公共 v0 设计核对完成后可继续准备 P/C/I 专用 shadow 样本与评测资源，分别记录缺失来源、许可、归属、前提和人评门；未完成 T04 的 C1 不开跑，阅读卡正式评测/实现也不启动。

## 0B 工具合并验证与独立审查

数据切片 `8e86fda` + `2cb2c45`，F 切片 `8c6b4f1` + `5d0d075` 已按所有权串行纳入隔离集成分支。公共离线接口为 `rich-brief-stage0-input-v1`、`rich-brief-stage0-protocol-v1`、`rich-brief-freshness-v1`，与证据/发布 v0 设计各自版本化；运行时均未接到生产。

非作者新上下文 `stage0_independent_review` 分别审查集成文档、契约、数据、F：文档初轮 0/0；数据初轮资源不完整 1 Warning，补全七个 runtime operation、六类 policy、cache/thinking、模型分离、prompt/policy 资源及非提取角色配对后，第二轮已处理；F 初轮 2 Warning（未来 attempt 钟、误归因阶段损失），补 as-of 检查与可证明失败段映射后，第二轮已处理。最终未解决 Blocking/Warning 均为 0。review 不读取私有原文、环境或 DB，不签人工金标真实性、阅读效果或生产准入。

集成负责人复现两个新增工具测试 **29/29**（data 19、F 10），定向 `eslint evals/rich-brief-stage0 --max-warnings=0` 通过；合并后 TS7/TS6 app/tools 均通过。保留此前 204 项既有生产路径回归证据，不称它们覆盖 C1 新提取。工作表关于“所有生产开关”的遗漏文案另改为“本次未启用新模式；未访问生产，未核现场开关”，仅复跑相关 data 19/19，通过。

F 重新读取四份 sealed 导出、核对 manifest/pool hash，不打开 SQLite：旧窗口 12 次分析尝试（11 完成、1 失败）、180 input occurrence、64 已刊消息；以 `report.generated_at` 为**探索代理**的原发布时间年龄 P50 25.22h、P90 130.68h，≤24h 31/64、≤48h 47/64。10/3 与 10/5 软件主题各 4 消息，10/4 失败且无刊。首次可获取/首次采集/入选/版本更新/证据通过/publication commit/打开及首报续报分类仍 unknown，不能定位最大延迟段，也未形成前瞻 F 准入基线。细分、hash 与命令见[F 收据](daily-brief-stage0-freshness-baseline-2026-10-07.md)。

数据实际预检仍为 exit 2 / blocked，完整人工 gold、家族审阅及数值协议未齐；原金标和旧工作表版本保留。工具源码修订会改变准备包资源 hash，必须重新 `prepare` 到新私有目录；旧输入不能绕过资源变化直接 freeze。已有 v2/v3 工程包都是探索。首批用户材料在对话按 R01—R05 展示；发布说明的两个功能命题进一步分为 R03-D2a/D2b，研究方法与结果进一步分为 R04-D2/D3；它们都是待判候选，不算新 gold 或正式阅读卡。

本波工程 PR 仅交付准备工具、观察基线和契约。使用 eval-gate 的实际路径判断：A1 不执行上述离线工具，不运行无关 A1、不写可比 baseline 或质量 pass；scoped 工具回归不代替后续专用模型评测。准备 PR 使用 pre-pr-ai-review，精确 head CI 未通过前不合入。合入后另外核 main CI；部署/生产开关仍须独立版本、验证与回退材料和用户确认。

## 0B 合入收据与 0C 并行分工

期间其他会话合并 #430，origin/main 推进到 `eb2bd4d6a096331d888f938391749a42aa16625b`。只在自己的集成分支合并该基线，未改主 worktree；复跑新增工具、204 项既有生产路径和该上游的17项受影响测试，共9文件250/250，通过双TS。

[#432](https://github.com/dong-qiu/deep-insight-agent/pull/432) 精确 head `b3c9277` 的独立最终审查与 [PR CI 37576899707](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37576899707) 通过后，正常 squash 合并，无admin/force/hook跳过。merge 为 `afbe4a55f89957839a7ee619733f21c2736eb1af`，时间 `2026-10-07T05:41:55Z`；该精确 [main CI 37577603519](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37577603519) 已成功。此收据只证明工程切片合入，不是T03/T04、模型对照或生产部署收据。

以共同v0为基线再建 `-c1`、`-paper`、`-podcast` 三个隔离worktree，分别交原数据、契约、F作者。P交付后由契约作者在新 `-implications` 树做I；每波研究/实现并行数最多3。集成负责人另建 `-shadow-integration`，基于实际main `afbe4a5`，按P→C→I→C1串行cherry-pick，不修改共享schema/analyzer/validator/report-gen。每树独立DB/Data路径及owner-only配置；已确认配置不输出正文，不共享live DB。

| 作者与独占所有权 | 实际交付 | 完成门与依赖 |
| --- | --- | --- |
| 数据作者：`evals/rich-brief-c1/`、C1 preflight收据 | machine/scorer隔离、资源/操作账本与拒绝式预检 | T04未冻结禁止模型调用；真实运行输入/history/预算须精确；工具测试、类型、独立审查和CI通过才合入准备代码 |
| 契约作者：P收据；完成后I收据；各自私有准备目录 | P库存/全文覆盖与专用evaluator草案；I有界候选/人评工作表 | 原文版本/许可、I前提与来源观点分开；未知/人评pending保留；非作者文档审查通过，私有数据不冒充独立复现 |
| F作者：`evals/rich-brief-podcast/`、C收据 | 完整输入形态清点、配对/说话人缺口、专用分臂账本 | show_notes不得充发言；没有同集转写或可靠map不造样本；真实准备器及已有shadow路径回归、类型、非作者审查、CI |
| 集成负责人：本交接与集成分支 | 实时版本/CI、切片顺序及公共口径 | `stage0_independent_review`作为各切片非作者；任何准备通过不代签来源、语义、人评、阅读或发布门 |

## 0C 来源与启示准备结果

P作者 `999c3e2`、C作者 `a1ac1e4`、I作者 `09b37ee` 分别交付，已在本波隔离分支串行集成；每个切片非作者审查 Blocking 0 / Warning 0。P/C之后的小修去个人Node路径、现场开关未核实的绝对说法和生产row ID，另通过非作者文档审查。reviewer只读版本化工具/文档，不读私有来源正文或DB：本文实际库存数字是作者sealed收据的观察，非独立原文质量审查。

| 切片 | 实际观察与固定分母 | 阻断与下一波 |
| --- | --- | --- |
| [P论文](daily-brief-paper-shadow-preparation-2026-10-07.md) | v3完整45 occurrence/23 revision中5篇次、3论文v1；5/5仅摘要归档绑定；全文0，24核心section unknown，3许可unknown | 原摘要不计全文；补精确版本全文获取/解析/许可和章节quote，再准备人工覆盖/论点/限定与专用门 |
| [C播客](daily-brief-podcast-shadow-preparation-2026-10-07.md) | v2完整45/23中10 show_notes occurrence/4revision；封存transcript、同集pair、可靠map和真实C病例均0；采集失败/成本分母unknown | 先补同集/版本封存转写与来源许可，speaker verified/unknown分层；跨层归属fail-closed实现仍缺，字段/enum存在不算已执行 |
| [I有界启示](daily-brief-implications-shadow-preparation-2026-10-07.md) | 149可观察候选，38旧快照证据绑定合格/7revision，111排除；取首3不同source前提，3 typed假设私有封存 | 当前校验未rerun/v0图未实现；source-stated impact全部unknown；人评/score pending，publish/action false；独立证据、逻辑/适用性和读测分别补门 |
| [C1首次提取准备](daily-brief-c1-offline-preflight-2026-10-07.md) | 完整3run/3attempt/45occurrence/23revision、真实dispatcher cutoff与168h窗口；历史66/70/70为安全下界，排除后来4/0/4；machine/scorer分离，实际预检exit2 | T04未冻结、原可见history不精确、正式runtime预算未冻结、shadow prompt接口未实现四项阻断；model_calls_authorized=false，ledger not_executed；不能启动对照或阅读卡 |

P/I使用v3 worklist `bc44d0f3`，C使用v2 `b2b927a4`；来源exact refs/body相同，准备代码资源不同，因此各自分别记版本，不能当同一正式冻结T04。全部来自已曝光探索；正式留出仍未打开。本波新增原站/业务模型调用均未执行，没有真实模型成本或阅读收益评测；未知采集历史不记为零。

首批R01—R05尚未收到人工标注确认。用户要求先提供专业判断，再要求同时提供全文信息与建议；集成负责人已给初步建议，并安排契约作者完整阅读五份已存body、生成逐源信息梳理/建议及私有原文入口，补先前短候选漏掉的source-wide信息。show_notes、摘要或截断body的真实边界须标明。所有建议仍待人工确认，不把这些请求当作人工接受或阅读效果。只沿用已确认审阅方式及旧事件确认，不把等待状态填成人工gold。完整23项事件/重要维度/限定、来源家族、理解题与有探索依据的数值协议仍是阶段0停止点。正式同事件阅读卡评测/实现维持关闭；B1仍no-go。

## 0C 工程审查修复与环境保全

C1初轮独立审查发现2项Warning：closed DELETE快照漏拒绝rollback `-journal`；freeze payload比较误用只允许整数的provenance canonical hash，合法ratio/cost小数会被拒绝。作者追加 `8e44a01`、`de988c0`，分别补original/copy三类sidecar拒绝，有限小数且确定键序的payload比较；后者用真实stage0 `freezeData/checkReadiness` 的合成control证明0.1/0.25合法、篡改与非有限数拒绝，不给synthetic人评签真实gold。

修补后新建C1私有v3，旧v2原样保留；资源hash变化不能复用旧包。实际machine SHA前缀 `999d03f9`，预检仍exit2/blocked，四个阻断及完整分母不变。生成模板已版本化，生成的候选system精确字节仅private且未执行；不得宣称源码没有模板或候选已通过语义评测。非作者第二轮与最终精确head复核另记，未过前不合入。

重新核初始保全收据中的14份配置hash及权限（含首次4个新树），全部未变；详细收据仅私有。该次检查实际20个worktree，11个原有加9个本轮独立树，全部保留；其他会话推进的branch/PR未覆盖。主worktree仍保留原local main `473e2ee`；remote main单独重新查询，不以local过期head替代远端合入状态。本文不是生产版本核验；本轮没有生产访问、部署、开关修改或清理删除。

准备第二波PR时，重新fetch核实其他会话的证据归档合入将remote main推进到 `41270a7aa02d3880d96fcd6ba7f9a2cbb54a3b99`，其 [main CI 37578566493](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578566493) 成功。上游仅增加4份归档文档；在自己的shadow集成分支正常merge保留，不移动主worktree或覆盖作者资料。作者初始base、#432收据和旧包hash仍作为历史保留；PR使用新远端base，独立review按实际merge-base到最终head，不误包含上游文档删除。

集成负责人在最终修补代码上实际复现9文件117/117：C1 15、stage0数据19、F10、C准备6、既有podcast shadow/input路径44、analyzer窗口/选段23。`npm run typecheck`双TS各app/tools、两个新工具目录的定向eslint、五份收据的真实docs checker与diff检查通过。没有改构建/路由/部署，未重复本地build；PR CI仍须执行选中的完整应用/容器门。117项工程测试不代签真实来源、模型候选收益、人工gold或阅读效果；最终独立审查和精确PR/main CI在后续收据记录。

## 0C 第二波PR与再次同步

[#433](https://github.com/dong-qiu/deep-insight-agent/pull/433) 初始base `41270a7`、head `9554977` 的完整15文件diff先后通过pre-pr和GitHub最终非作者核对，Blocking 0 / 未解决Warning 0；独立复现工具50/50、analyzer纯函数10/10及双TS/docs5/5。[PR CI 37579025951](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37579025951) 成功后尝试正常合并，GitHub因main已推进而拒绝；未使用admin或绕过up-to-date要求。

实时fetch确认其他会话[#431](https://github.com/dong-qiu/deep-insight-agent/pull/431) 已将main推进到 `75c189d883a701943ad0308a07ba4f4542d878be`，含A1诊断与runtime观察接线。在自己的shadow分支正常merge，未改主worktree；复跑原117项和上游相关runner/runtime/usage/provider路径共19文件253/253，双TS各app/tools通过。更新精确head后须重新等待PR CI，旧head成功不用于新head合入。

C1作者私有v3绑定的是其原隔离树资源，仍是not-executable探索材料；同步的runtime observer/usage变化不悄然写入旧包。正式T04/runner必须在确切执行版本重新解析并封存全部operation/model/provider/policy/cache/thinking及观察/usage资源；不能把旧v3、源码hash或其他会话A1诊断收据当C1候选/新版Brief准入。

首批5份精确body和完整source-wide信息/建议已放入私有 `human-batch-01-expanded/`，包括R02截断/未验证speaker及R04仅摘要边界。非作者逐份读完原文并发现摘要忠实性问题，作者修正后定稿SHA前缀 `158dd92f`，第二轮资料复核进行中；其115个审阅候选组不是已确认事件/重要维度或得分。原文5份hash未变，全部human pending，不给C1执行器读取人工评判。材料、raw和专业草稿不提交Git。
