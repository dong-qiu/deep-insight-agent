# C4a 确定性验证收据

日期：2026-10-03。基线 `origin/main` = `1c40eac4ebd018cce4874d75332ed3f8dc97cabf`。分支 `feat/c4a-eval-observability`，独立 worktree `insight-agent-c4a`。

## 范围与兼容

实施 [C4a spec](../plan/specs/c4a-eval-observability.md)：可选有效配置摘要、单调阶段/整体墙钟、独立执行/自动门/baseline 状态投影与只读 CLI。先读主仓库 AGENTS、规划 worktree 的并行计划/启动收据、最新主干技术债清单与评测规则；确认主干无 C4a 后创建隔离工作区。

只修改 evals 的观测接线/测试及本切片 spec/收据。未修改 package/lock、CI、Docker、vendor、decisions、roadmap；没有 C4b、C2/C3、新评测平台或性能调参。模型、prompt、调用参数、执行顺序、timeout/retry/concurrency、cache/恢复、正式门退出码保持原样。

`effective_config` / `timing` 为 manifest/progress 的可选加性字段，未进入 EvalConfig 或 checkpoint config hash。现有产物/receipt/baseline reader 继续读取原字段。缺失字段保留 unknown/null；不补造质量、可比性或阶段耗时。基础设施不完整仍由现有 runner 写 not_evaluated，即使编排 status=completed。

配置从 EvalConfig 已解析模块常量投影，runtime 数值从实际 getter 采样；不另写 parser。Anthropic SDK retry 与 Responses EOF-only transient retry 的适用性分开，预算取实际 getter；没有调整后者的默认 1/上限 2。新增观测无端点、密钥、原文、路径或环境全集。A1 自身异常边界改为固定类别，原错误仍用于既有执行/重试判断。

本地配置仅复制主 worktree 的 gitignored .env.local，mode=0600，并把 DB_PATH/DATA_DIR 指向新 worktree 隔离路径；未复制数据/SQLite/WAL/报告/.env.development.local。没有读取生产 DB、恢复、部署、合并或清理分支/worktree。

## 验证

环境：Node `24.19.0`，npm `11.17.0`。所有有效验证显式使用对应 Node bin PATH；干净 `npm ci` 成功，lockfile 无变更。

- 21 个受影响测试文件，393 项全部通过（最终代码候选）。
- `npm run typecheck`：TS7 + TS6，应用及 tools 配置均通过。
- `npm run lint`：通过，零 warning。
- `git diff --check`：通过。禁改文件 diff 为空。
- 新状态 CLI 使用独立进程验证旧产物、缺 timing、无参数、显式路径缺失及 literal null；不加载 env、模型或 DB。
- runner 夹具执行真实 `run-a1` 编排、进度/manifest/CSV/checkpoint 写入；仅替换 analyze/judge/coverage 模型边界，并设置 callStructured 意外调用失败哨兵。成功、quality/setup 失败、SIGTERM 回调、judge/coverage 不完整均有反例。SIGTERM 是确定性 handler 夹具，未对真实外部进程发送信号。
- 并行 mapper 两条请求的 synthetic latency 总和=80ms，阶段单调 wall=40ms，重复 progress 不重复开始阶段。旧产物缺新增字段时不造零值。
- 人造 key、endpoint、正文、异常消息及未知配置字段不进入新摘要、日志投影或观测产物；实际失败 runner 产物与捕获日志均核验敏感 sentinel 不出现。
- quality checkpoint / dataset lock / DCP / baseline promotion / review receipt / source identity / env / llm / analyzer / validator 既有测试全部通过。

定向命令（前缀为上述 Node bin PATH）：

```sh
npx vitest run evals/a1-status.test.ts evals/run-a1-observability.test.ts evals/a1-observability.test.ts evals/a1-artifacts.test.ts evals/a1-config.test.ts evals/a1-quality-checkpoint.test.ts evals/a1-baseline-promotion.test.ts evals/a1-dcp.test.ts evals/a1-run-control.test.ts evals/a1-coverage-execution.test.ts evals/a1-independent-call-concurrency.test.ts evals/run-a1-source-state.test.ts src/lib/runtime/env.test.ts src/lib/runtime/numeric-env.test.ts src/lib/runtime/llm.test.ts src/lib/runtime/llm-volcengine.test.ts src/lib/agents/analyzer.test.ts src/lib/agents/analyzer-window.test.ts src/lib/agents/validator.test.ts evals/a1-review-receipt.test.ts evals/a1-dataset-lock.test.ts
npm run typecheck
npm run lint
```

候选内容指纹（上述 7 个 evals 文件和 spec；路径字典序，以 path + NUL + bytes + NUL 拼接，不包含本收据）：`c570ecb69cefdb1d4899e59ff00abfa71bf3491dd23f52f5d420fb838f9a885a`。

本轮未跑 build：应用、路由、部署、构建入口或依赖未变，改动在 tools typecheck 覆盖的 evals 路径。没有运行完整 A1 或真实模型，模型预算=0，不产生新质量指标/基线。

## Eval-Gate

已使用仓库 eval-gate skill 并对照 L3/eval-criteria：diff 不命中生产 AI 语义面，未改评分、数据集、EvalConfig 键、阈值、baseline/DCP、人评与发布准入。新观测不参与模型输入或缓存/恢复身份。393 项确定性证据覆盖本切片，真实模型 scoped safety 与完整 A1 不执行此观测契约的确定性反例，也未获本阶段授权。

`Eval-Gate: skip (A1 observation only; deterministic runner/config/identity regressions; no AI or scoring changes)`。这不是 automatic pass、可比 baseline 或正式质量门通过的收据。

## Pre-PR AI Review

- 基线：origin/main @ 1c40eac；独立新上下文，按 pre-pr-ai-review 执行。
- 风险：中。Blocking=0；未解决 Warning=0。
- 已修复并复核：缺 auto_gate 不从 execution 推导；显式 JSON null 不能显示为未运行。
- 独立定向验证：第一轮三文件 20 项；修复复查 Node24 两文件15项通过。根会话最终21文件393项通过。
- reviewer 曾误用 npm test 触发全套测试；Node25 与 SQLite 原生模块 ABI 不兼容，未将失败当作本切片回归证据，已纠正执行环境并限定定向复查。

## 初始实施阶段的待办（历史记录）

D5 [PR #398](https://github.com/dong-qiu/deep-insight-agent/pull/398) 截至最终本地验证仍 OPEN / Draft，未合入。当前证据仅覆盖 1c40eac 基线；**不宣称 D5 后最终集成通过**。Draft PR 必须在 D5 合入后 fetch 最新 main、仅更新本分支、按新依赖重新 npm ci，并重跑上述测试/typecheck/lint；若合并引入新构建风险再补 build。合入 C4a 前再次提醒并补该收据，不由本会话合并任一 PR。

限制：main 起点不包含模块加载；finalizing 终态采样不包含最后 progress/manifest 原子发布 I/O。配置是启动采样，保留原调用时读取语义，不宣称动态 env 改变后每请求配置均被追踪。SIGKILL/断电只保留最后已写 running snapshot，不能据此推算终态。缺配置/计时为缺失；现有 role P95 为逻辑调用（含重试）延迟，逐 SDK attempt latency 未提供。

C4b 需另获固定输入、模型/provider/配置、预算与范围授权；测量完整 main wall、阶段 wall、role/by-operation call/request/failure/retry 与调用延迟，同时注明环境、冷启动、cache/恢复条件和成功/失败终态。当前没有真实模型完整配置计时样本，不承诺加速比例，不据此改变并发或阈值。

## 2026-10-04：D5 后最终集成与合入授权

用户明确授权「D5已经合入，请合入C4a的实现」，覆盖初始实施阶段不合并的限制；授权范围是 C4a #399 的集成、验证、正常 PR 合并与主干 CI 核验，不扩展至部署、真实模型或其他切片。

- fetch 后最新 `origin/main` 为 `6cdb3df331591fddc84cc3864128b4fb8562e85f`；已包含 D5 #398 的 `254aada6e72d90c736e3dde75378ceb9bf2ae27a` 和 D5 关闭收据 #403。
- 仅在本会话 C4a worktree 将上述 main 正常 merge 入本分支，无冲突；集成候选 `5dee26bea94519d04acacc9f0c0bf0d546dfb0a0`。未更新、删除或清理其他工作区。
- 与初始 C4a `32b3d8b` 逐文件比较，七个 evals 文件与 spec 均无变化；上述内容指纹仍有效。相对最新 main 的 diff 仅 C4a 九文件；D5 的 package/lock/Dependabot 变更只来自已合入主干，不由本切片修改。
- Node 24.19.0 / npm 11.17.0 下，按 D5 新 lockfile 重新 `npm ci` 成功，audit 0，lockfile 无漂移。
- 重跑上文相同 21 文件定向命令：393/393 通过。双版本 typecheck（四项 app/tools）、lint、diff-check 全通过。没有真实模型、完整 A1 或生产数据访问。
- 已重新应用 eval-gate 核对：C4a 仍只增加观测，不改变 AI、评分或 checkpoint/cache 语义；沿用有确定性证据的 skip 理由。
- 按 pre-pr-ai-review 在独立新上下文复查完整 C4a diff 与收据：基线 6cdb3df、候选 5dee26b，风险中，Blocking=0、Warning=0，结论通过；原审查结论在 D5 集成后仍成立。独立 diff-check 通过，不重复运行已证实的测试。
- 候选 CI / Docker 和最终合并前核验将按提交收据后的最新 head 完成；初始 #399 的旧 CI 不作为 D5 后最终证据。
