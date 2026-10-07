# Daily Brief 阶段 0：实时集成交接

> 2026-10-07 · 持续更新。阶段 0 正在执行；T04 尚未冻结，正式留出未打开，C1 首次提取尚未启动。本文不代表软件工程试点、人评或生产准入已完成。

## 当前基线与环境

本轮重新执行 `git fetch origin main`、本地及远端 SHA 查询、全部 worktree 的 `git status --porcelain`、开放 PR 查询及精确 SHA 的 CI 查询。基线为 `473e2eeae119b600b63abd78ce886301bd882235`，本地 main 与 origin/main 一致。
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
| 0B 数据与契约 | 执行中 | 完整人工金标、数值探索依据及正式冻结尚缺 | 提交逐项审阅材料；技术工具可先通过工程门，不宣称 T03/T04 已完成 |
| 1 C1/P/C/I | 尚未启动 | 依赖公共 v0 口径与各自预登记；同事件阅读卡另依赖 C1 足量新增可刊维度和独立证据门 | C1 单独记输入/模型/预算/失败/成本；P/C/I 准备 shadow，保持各专用门 |

每波结束追加实际命令、产物 hash、独立审查结论、失败与 unknown，以及下一波任务；不以计划代替收据。

## 0A 工程核对收据

集成树使用 Node `24.19.0`；新 worktree 默认 npm 初次安装曾报告 Node `25.9.0`，已按仓库 engine 切换到 24.19 并重新 `npm ci --no-audit --no-fund`。没有把不满足 engine 的首次安装当作测试依据。

- 两份集成 Markdown 用 `ops/ci-docs-check.mjs` 的真实 `checkDocuments` 检查格式、链接和收据结构：2/2 通过；`git diff --check` 通过。
- `npm run typecheck`：TS7/TS6，各 app/tools 均通过。
- `npx vitest run evals/brief-density/export.test.ts src/lib/agents/report-gen.test.ts src/lib/agents/pipeline-reportgen.integration.test.ts src/lib/db/reports.test.ts`：4 文件、200/200 通过。
- `npx vitest run src/lib/db/report-review.test.ts`：1 文件、4/4 通过。

上述 204 项只核对既有只读导出、真实管线报告接线和发布守卫回归；它们不执行 C1 新提取，不证明新版阅读卡收益、F 时效改善或 P/C/I 生产准入。工具切片新增测试及整合后的 typecheck 另记，不能用此基线核对替代。
