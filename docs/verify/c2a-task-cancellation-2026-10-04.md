# C2a 任务取消验证收据

日期：2026-10-04。实施提交 `c6f7dc5ff952da4a9b45ff9db934c54b6e6c5399`，C2a 专属代码/测试提交 `2162a609913c13db2e627a9796d48ddf6afb4a3b`；启动 fetch 基线 `065dd0cf7a8f06d4becd093da2f133fc552ce201`，最终主干基线 `f390343df6ce604f5e8cbc2b79879b151c11410d`。本收据只归档 C2a，不关闭整个 TD-10，也不证明已上线。

## 起点与隔离

先读取主工作区 AGENTS、独立规划 worktree 的并行计划及 preflight、最新主干技术债清单、架构 Run 与 generation-provenance spec、L0/L2/L3、eval-gate 与 pre-pr-ai-review。现场 main 已包含 C5 #396/#397、D5 #398/#403、C4a #399，旧规划待办已滞后；main CI [37137081561](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37137081561) 成功，镜像发布成功不作生产上线证明。主干未有 C2a；没有重复这些已完成切片。

从该 main 新建 `insight-agent-c2a` / `feat/c2a-task-cancellation`。仅复制主工作区 gitignored `.env.local`，mode=0600，DB_PATH/DATA_DIR 改为本 worktree 自有路径；未复制 `.data`、SQLite/WAL、报告或 `.env.development.local`。测试使用内存/临时合成 DB 和受控 SDK/fetch，不读生产数据、不发真实模型请求、不触发生产服务。原主工作区日报规划和其他 worktree 未修改或清理。drain 回归只启动未修改的真实 worker 子进程和受控 localhost HTTP，显式环境排除 ambient 配置；仅清理测试自有进程与临时 marker。

## 实现与反例

见 [C2a spec](../plan/specs/c2a-task-cancellation.md)。JobSpec/GenerationExecutionOptions 新增可选 signal/deadlineAt；deadline 是绝对时间，不设生产默认数值。scheduler 与 Job 各自拥有并清理 scope；同一任务期限跨阶段不重置。现有单请求 timeout 仍独立。

signal 经真实 dispatch → scheduler → pipeline → JobCtx → Analyzer/Validator/coverage/judge → callStructured → SDK/fetch；LLM、coverage、validator、relay 退避也接线取消。调用前检查、返回后检查、同步提交 checkpoint 阻止新批次/重试/派生与迟到业务结果。Anthropic SDK 同时收到 signal 与 stream.abort；Responses fetch 实际收到 signal。后台迟到 resolve/reject 有 handler，不能复活阶段。

租约 heartbeat CAS false/throw 及 assertWrite 检测失去 claim 时 abort；原 fencing 仍逐写事务执行。失去租约不写失败 Run/trace 或业务结果，claimed/running 状态交给已有接管恢复。持有租约时外部取消/任务 deadline 使用已有 failed Run 和稳定脱敏错误，trace 用已有 cancellation 映射/event；dispatch 保持已有 failed 容器状态。没有 schema/Run status 变更。

报告异步锚路径新增可选 guard，签名前后、远端锚返回后、本地 publication 都检查所有权与取消；错误清理只使用 ownership，租约丢失时不能越权清理。独立审查复现了“同步 signer 跨过 deadline、timer 尚未执行仍新发锚 I/O”的 Warning；补入 Job 的同步 checkpoint 后反例转绿。真实 runPipelineForTopic → runReportGen → saveReport 的 managed signer 替身也覆盖该接线，未只测试辅助函数。

测试先行收据：Job 新取消测试先 5 项失败；报告迟到锚记录与 cleanup 反例在接线前失败；同步 deadline 锚反例修复前实际签名 4 次、修复后只签名 1 次且零锚请求/记录。夹具开发中原文归档的 FK 顺序与 SDK 静态错误类型不完整曾导致无效测试失败，均已修正；不把夹具失败或中间实现状态作为生产证据。

## 最终验证

环境 Node 24.19.0 / npm 11.17.0，所有命令显式使用其 bin PATH；干净 npm ci 成功，lockfile 无漂移。核心回归与实施提交字节一致；补充 drain 测试后运维全套和 lint 再次通过。最终 20 个 C2a 源码/测试/spec 文件与专属代码/测试提交字节一致；按路径字典序拼接 `path + NUL + bytes + NUL` 的 SHA-256 为 `1c8903d71f40529aa085a985b1f8931328ed1fd5137967f1e08459f34786fb15`，不包含本收据。

| 验证 | 结果 |
| --- | --- |
| 受影响 agents/runtime/report/integrity/provenance 回归 | 66 文件 / 1,098 项通过（开发候选） |
| 最终 C2a 四个专属测试文件 | 36 项通过；包含零请求、实际底层 signal、各级退避、lease false/throw/真实接管、迟到 resolve/reject、同时取消、正常完成、timer/listener 清理、异常日志脱敏、同步 deadline |
| `npx vitest run --coverage --maxWorkers=2` | 238 文件 / 2,402 项通过，覆盖率门通过：statements 78.45%、branches 70.87%、functions 78.62%、lines 82.39% |
| `npm run test:ops` | 最终主干 148/148 通过（初轮 110/110；#405 新增 38 项）；真实 worker SIGTERM drain 与既有 fencing/入口保护全部通过 |
| `npm run typecheck` | TS7 + TS6 的 app/tools 四项通过 |
| `npm run lint`、`git diff --check` | 通过 |
| 初轮 `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | build 通过；单次 build_ms=27138 / builds=1 |
| 初轮相同环境 `npm run test:e2e:built` | 收据身份核验通过，现有 E2E 6/6，additional_builds=0 |
| 禁改文件 / spec 链接 | package/lock、CI、Docker、浏览器基础设施、roadmap/ADR 无 diff；本地文档链接可定位 |

首次默认并行全套 coverage 有一项既有 501 条导出测试触发 5 秒 timeout，2,398 项通过；该文件单独复跑 10/10，通过后以较低本地 worker 并行度完整重跑得到上表全绿。没有修改测试超时、全局 Vitest 配置、CI 或性能策略。首次 E2E verify 未传与 build 相同的 NEXT_TELEMETRY_DISABLED，C5 正确拒绝 environment 身份不匹配；相同环境重跑通过，没有绕过身份校验。计时仅单次功能观察，不作性能提升证明。

Draft PR 创建时主干刚合入 #405（CI 交付调整），从 `065dd0c` 推进至 `f390343`。仅本 feature branch 无冲突 merge；#405 的 9 个文件与 C2a 零交集，C2a 内容指纹保持不变，最终 PR 不包含 CI/基础设施 diff。最新基线重跑完整 coverage、运维、双编译器 typecheck 与 lint；合并候选为 `0dc6bf791960684e14f63dffe22b452d9e20b99d`。本次收据更新为 docs-only；最终候选 HEAD 的 build/E2E、CI 与独立 PR 复核绑定见 [Draft PR #406](https://github.com/dong-qiu/deep-insight-agent/pull/406)。

## Eval-Gate 与独立审查

已应用 eval-gate，检查最终 AI 面 diff：prompt、模型/provider/thinking、Zod 契约、引用白名单、判定规则、合法未取消请求参数、重试次数/退避值/并发/cache 与评测口径不变。变化仅可选取消控制和取消失败路径。上述确定性测试执行真实生产接线；不调用真实模型，A1/scoped safety 未运行，不造质量指标、baseline 比较或正式准入证据。

实施提交 trailer：`Eval-Gate: skip (C2a cancellation control only; production-path regressions prove uncancelled AI semantics unchanged)`。该结论在审查后确认，不是预先假定 skip，也不是取消能撤销 provider 工作/费用的声明。

pre-pr-ai-review 在新独立上下文审查最终 diff/spec/反例，风险中；Blocking=0、未解决 Warning=0。同步 deadline Warning 已修复并复查；独立 reviewer 复跑四个 C2a 专属文件 36/36 与 diff-check 通过，认可上述 Eval-Gate 选择。最终增量含 drain 测试与此收据，也交由同一独立 reviewer 复查。审查不代替人工 approval。

## 交接与限制

用户已确认 reports.ts 与 integrity-publication.ts 最小 guard/测试交给 C2a。D4 仍负责浏览器 smoke；本切片未改 package/lock、CI、Docker、浏览器基础设施或其工作区，不修改共享 roadmap/ADR。

不合并、不部署、不修改生产配置/数据库、不清理其他分支/worktree。Draft PR、最终候选重新 build/E2E 与 CI 的精确 SHA/链接在 PR 记录；本收据的本地结果绑定上述代码/测试提交与内容指纹，新增收据不改变实现字节。C5 构建身份包含 HEAD；初轮构建不作为最终 HEAD 的身份凭证，最终提交后重新构建、核验并运行 E2E。

- 默认调用仍没有整任务 deadline；生产只自动接线 lease loss，显式外部取消/deadline 由调用方提供。不隐式绑定 HTTP 断开或把 drain 变成强制中止。
- 任务范围为 generation 与显式 Job/pipeline 阶段；collection 和独立 followup HTTP 入口没有新增端到端 deadline，见 spec 接线边界。锚 signer/store 接口未新增 transport signal；靠前后提交守卫拒绝迟到本地结果，不能撤销已提交的远端锚/费用。
- 同步 CPU 工作不能被 AbortSignal 抢占，必须在边界 checkpoint 检查；未被 provider 返回的用量无法由取消推断。取消前已提交事实保留；租约丢失后的状态由已有接管流程负责。
- C3 需另定义真实调用/attempt、幂等持久化与迟到用量处理，不将本切片 Run.cost 当完整账单。C2b 依赖 C3 口径，再经本取消契约停止新调用；预算阈值和错误分类另获确认。C4b 不在此 PR。
