# C4b / TD-14：A1 恢复与耗时验证收据

日期：2026-10-05。分支 `perf/c4b-a1-low-risk`，独立 worktree `insight-agent-c4b`。
[实施 spec](../plan/specs/c4b-a1-recovery-performance.md)。本切片部分完成 TD-14，未关闭全部性能问题。

最终状态（2026-10-06）：**C4b 本轮零付费切片完成；TD-14 部分完成**。
以下保留实施及合并前验证记录，最终合入与主干 CI 见末尾“合入核验与本轮收口”。

## 隔离与现场证据

启动基线 `64f365682c2a6a4ffa6198f3bb4c57d1e1ab589c` 已包含 C4a、C2a、C3、C2b、D1、D4，
[main CI 37324076876](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37324076876) 成功。
交付前 fetch 复核 D2 #414 已合入，正常 rebase 至 `92d684bb5dd1428058e07b6c8341b67e3ec074a8`，
[main CI 37330189460](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330189460) 成功；无冲突、未整分支导入并行规划工作。
用户已确认 eval 文件没有其他 Session 占用并授权零付费顺序实施。

只复制 `.env.local`，权限 0600，DATA_DIR/DB_PATH 指向本 worktree 独立路径；未复制数据、SQLite/WAL、
原文、报告或 `.env.development.local`。未覆盖主 worktree 的 roadmap/ADR 未提交内容。
D2 的 alert/channel 文件与专属测试、runtime/agents、package/lock、CI、baseline/dataset 均无本切片 diff。
实施阶段没有生产访问、部署、迁移、历史修复、合并或分支/worktree 清理；后续获授权合并的记录在末尾单独追加。

已检查 AGENTS、技术债、C4a spec/收据、评测口径、C2a/C3/C2b spec/专属收据及并行计划。
已有 9 份本地 manifest 仅只读白名单聚合字段，均无 C4a timing/effective_config；历史 Opus 阶段诊断
观察过候选审计数量和重试尾部，不能推导当前 Responses 配置性能。
现场配置读取未发请求：analyzer deepseek-v4-flash、validator deepseek-v4-pro、coverage glm-5.2，
独立并发 1；该配置当前完整墙钟、模型服务延迟及付费重试成本均未测。

实际 A1：模块导入配置常量 → setup 解析 env/getter、输入/lock/基线、分块计划 → analyzer/覆盖双审及语言修复
→ validateBatch 引用可达性与一致性 → consistency 数据集 → 两类 coverage benchmark → 聚合/DCP/正式门
→ review/CSV/hash/manifest 原子发布。成功完整主题恢复跳过其 analyzer/validator；partial 只跳过已完整审计的
analyzer chunks，仍执行未完成 validator；后续基准、聚合和门不跳过。scoped safety 是另一个入口，不作为本改动证明。
本 A1 无 Job，C2b task budget 与 C3 Job 持久计费不会自动保护它；未调整 SDK、runtime 或外层 retry。

## 实施与有意行为变化

唯一性能优化：恢复源 `quality-checkpoint.json` 的 hash 验证和 JSON 解析使用同一 Buffer，source 读取 2→1。
发布新产物的写入、hash 和安全检查保留。验证后文件被替换也不会解析未绑定字节；安全两读备选仍在第二读验证同一 hash。

保护先于优化：v2 checkpoint 绑定原 EvalConfig/数据/分块输入、完整源码身份、有效配置和额外 runtime 条件摘要。
旧 v1、缺身份、输入/config/model/provider/prompt/评测判断变化拒绝复用；源码不可得的冷运行可执行，但其 checkpoint 不可恢复。
终态 failed manifest 必须绑定源字节；重复恢复不修改源产物。保守源码绑定可能因无关提交或文档变化拒绝恢复。

每份可复用 chunk/completed 必须有 `execution_complete`。引用 checks 与全部引用一一对应、verdict 合法、report 重算一致；
reachable judge 基础设施失败不能作为 completed。coverage/翻译源审计 unavailable、invalid、截断及嵌套错误拒绝；
真实 provider 的 max_tokens/max_output_tokens 即使 schema 合法或空结果也拒绝。
既有 analyzer 可能丢弃解析失败的单条 leaf；A1 使用已有 onStage 观测，在保存前拒绝这类不完整输出。
父批失败后全部子调用成功、成功的 EOF transport retry 仍允许完成。合法 uncertain/not_support/不可达阻断保持原判断。
这些是确定性失败关闭变化，不宣称所有失败行为与旧 main 等价，不自动付费重跑。

## 冻结测量与结果

测量源码为干净提交 `bd7519ab940e4cc621b37052bb5698d25e9d82ff`，基于上述 D2 后主干。
14 个实现/测试/spec 文件按路径排序，以 path+NUL+bytes+NUL 拼接的 SHA-256：
`d5f782384c15418303e35cc6f38a638737020eb0c754ec0f58a1d7ec1cb0a70c`，不含本收据。
该指纹绑定上述原实现候选；后续纯文档收口不替换或重算历史测量指纹。
环境 Node 24.19.0/npm 11.17.0/macOS；测量独立执行，无并行本地测试/构建，未 flush OS 页缓存。

同一源码的 test-only import hook 选择安全 v2 两读参照/实际单读接线，不是旧 main 的完整 before/after。
固定合成两 topic、每 topic 一 ContentItem、一 consistency pair、两类 coverage 各一例；provider Responses，
模型 synthetic-a/v/c，thinking off，concurrency=1，LLM timeout=120s、topic/judge/coverage=30s，
SDK/validator retry=0、EOF retry=1/backoff=0、prompt cache/backfill off。仅测试夹具采用这些值，未修改项目默认配置。
输入 SHA-256 `f982436748bd428b70aab7c75773e3bf56bd4eedeaae6057f371f1091aa4281c`；恢复源 SHA-256
`0680b1e3f7637f832e40f3cda091e11bfafddc8e68b479d9f869840bb19af264`。
每个样本启动新真实 A1 进程，两种策略交错；每种模式每臂 n=8。冷运行与恢复分别报告，均 completed/smoke、baseline incomparable、exit=0。

| 模式/策略 | 外层墙钟中位 ms（范围） | C4a 整体中位 ms | 源读取/字节 | 实际 mock 请求 | retry |
|---|---:|---:|---:|---:|---:|
| 冷/两读 | 516.696（510.657–539.808） | 285.451 | 0/0 | 4 | 0 |
| 冷/单读 | 491.264（487.943–494.790） | 284.138 | 0/0 | 4 | 0 |
| 恢复/两读 | 511.052（508.964–524.489） | 282.212 | 2/3292 | 3 | 0 |
| 恢复/单读 | 489.870（483.887–516.709） | 283.640 | 1/1646 | 3 | 0 |

| 模式/策略 | setup | quality | consistency | coverage benchmark | finalizing |
|---|---:|---:|---:|---:|---:|
| 冷/两读 | 37.542 | 12.549 | 1.578 | 2.528 | 231.054 |
| 冷/单读 | 37.515 | 12.678 | 1.470 | 2.444 | 230.233 |
| 恢复/两读 | 37.937 | 10.830 | 1.575 | 2.442 | 229.851 |
| 恢复/单读 | 37.124 | 10.891 | 1.601 | 2.704 | 230.102 |

阶段单位 ms，各列是分别取中位数，不要求相加等于整体。logical calls 冷 analyzer/validator/coverage=2/1/1，恢复=1/1/1；
传输请求计数由 fetch 边界直接记录。另有 EOF 反例 logical analyzer calls=2、实际 analysis 请求=3、retry=1，成功。
role latency 是含重试的逻辑调用耗时，旧 requests 不保证包含 Anthropic SDK attempt，未用 requests-calls 推算重试。
已有并行阶段测试继续按墙钟起止差计数，重复 progress 不累加子调用耗时。

另以相同 checkpoint 加合成 padding 至 1,049,708 字节，独立验证 SHA-256
`1e7d642efbba83fd240e9789accfec1faf4a7e893acf8204a26c4dc82336f709`；交错 32 对，前 2 对 warmup 不计，n=30/臂：
局部读取/hash/parse 两读中位 1.273 ms（1.151–2.597），单读 0.826 ms（0.771–1.929）。不是实际 checkpoint 大小或生产端到端收益。

**未证明整体提速**：两读夹具额外模块加载有成本，冷对照在没有源读取时已有约 25 ms 外层差异，不能把恢复约 21 ms 差额归功于 I/O。
C4a 恢复整体中位甚至单读略高；微测量只证明局部重复工作减少。mock finalizing 的占比不是当前真实模型 A1 的瓶颈占比。
外层墙钟覆盖 spawn→close 的模块加载、发布和退出；C4a 仍不含模块加载及末尾 progress/manifest/hash/发布 I/O。
不报告 P95、不作吞吐/费用/模型效果提升承诺。聚合观测留在 gitignored `evals/out/c4b-recovery-measurement.json`，其 SHA-256
`137f742e573fe7aeb8680e25f824f2ae062050c678304b9da9aa74c3e7e6b00c`；可用下述零付费命令重现。

## 确定性与真实路径验证

最终集成候选：`npm run test:coverage` 255 文件、2716 项全部通过，ops 150 项通过；覆盖率 statements 79.27%、
branches 71.81%、functions 79.38%、lines 83.10%，保留仓库既有下限。双编译器 typecheck（TS7/TS6 app+tools）、lint 零 warning 通过。
真实进程回归包含冷/完整及 partial 恢复、重复恢复、Git 不可用、损坏/部分 JSON、身份漂移零请求拒绝、质量失败/不可比、
30s 真实 deadline 和实际 SIGTERM；原 C2a 租约/取消、C3 用量、C2b 预算测试随全量门通过。

provider 夹具阻断 load-env，全局 fetch 全覆盖且绝不委托网络，子进程 env 不继承真实凭据。真实 Responses/Anthropic SDK、
analyzer/validator/coverage、A1 门与产物发布均执行；另有非空支持候选走实际引用 judge，对照两种恢复策略保留完成主题，
继续未完成主题及所有后续基准。两臂 requests 参数 hash 相等；结果/checks/coverage/checkpoint/review queue/CSV/门逐字段等价。
仅时戳、计时和有序双射的随机运行/batch/candidate ID 归一化；原始 insight digest 与全部产物 hash 先校验，源码/config/恢复身份不删除。

```sh
# 先把 Node24.19.0 bin 加入 PATH；无真实模型请求。
C4B_MEASURE=1 npx vitest run evals/c4b-recovery-measurement.test.ts
npm run test:coverage
npm run typecheck
npm run lint
```

本地未额外 build：没有应用/路由/依赖/构建入口变更；最终 PR full CI 须保留构建、浏览器和 Docker/质量/性能门。
最终 CI 的 head/merge SHA、run/attempt、scope 与 artifacts 在 PR 的交付记录中核验，不用旧 main CI 替代候选证据。

## Eval-Gate、评审与限制

已应用仓库 eval-gate，理由：确定性 A1 恢复设施；成功 AI judgment/config/dataset/阈值/baseline/人评/发布准入未变。
`Eval-Gate: skip (deterministic A1 recovery infrastructure; AI judgments/config/dataset/threshold unchanged; real-runner synthetic SDK regressions)`。
未运行真实模型 A1/scoped safety，实模型请求及费用为 0；这些 mock 是接线/反例证据，不能当真实模型质量通过、可比 baseline 或 DCP 准入。

独立方案 reviewer 要求补完整源码可得性、真实 provider 截断终态和非空实际 validator 接线，均已落实。
按 pre-pr-ai-review 最终新上下文审查，首轮发现单条解析失败被当空完成、语言修复 source_claims 漏检；修复后复查受影响路径，
代码候选风险中，Blocking=0、Warning=0。新反例已复现失败后通过，不保留失败作为通过证据。

未测/未优化：真实模型阶段延迟、SDK attempt P95、并发策略、当前完整 A1、真实数据准备/发布 I/O、跨运行新缓存、付费吞吐与额度。
未提高并发、减样本、关闭 thinking、降低 timeout/retry 或切换模型/provider；未重写 baseline 或改争议样本判断。
若以后需要真实模型诊断，需另行确认固定样本/次数/provider/model 和最多请求/重试/耗时范围，并先实现可靠硬限制。
Coding Plan 金额/额度未知，请求上限不等价于实际金额上限；本 PR 不运行也不实现付费实验。
实施阶段在完成 PR/最终候选 CI 后停止等待合并授权；后续授权与合入核验如下。合入不等于上线。

## 2026-10-06：合入核验与本轮收口

用户先明确授权合并，随后要求完成 C4b 收口所需的文档同步。本节补充交付状态，不扩大实现或付费验证范围。

- [代码 PR #415](https://github.com/dong-qiu/deep-insight-agent/pull/415) 已 squash 合入 main，
  提交 `5e90ff49a93c269ac801acbc4560b28ccb186e6c`。GitHub 合入时间为 `2026-10-05T16:01:30Z`，
  对应北京时间 2026-10-06 00:01:30。
- 获评审及候选 CI 验证的 head 为 `dc944d97c837414eed83ebff164e5f962d6eaa82`；
  squash 后的源码树与该候选一致，tree SHA 为 `b5b78fc1d32b792bdad3907eaf69217c723f15d0`，没有新增代码变化。
- [合并后主干 CI 37337558444 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37337558444)
  为 success，事件 push；scope 为 full，head/tested_commit 均为上述 main 提交，变更范围为原 C4b 的 15 个文件。
  scope、应用及 Docker 产物的 commit/tested_commit/run/attempt 已核对一致。
- 主干完整应用、类型检查、lint、覆盖率、构建、管理员 E2E、浏览器 smoke、供应链检查与 Docker 验证通过；
  主干按既有策略执行的 P1 完整性/容量门及 report-reader 门保留，Eval-Gate trailer 检查通过。
  独立评审的 Blocking=0、Warning=0 结论仍对应同一实现；性能观测 warning 单独保留如下。
- 主干 `report-reader-p0c-evidence`：gate_eligible=true、passed=true、warning=true。
  baseline P95 0.175014 ms，current P95 0.228866 ms，相对增加约 30.77%、绝对增加 0.053853 ms，
  未超过原策略允许的 current 0.275014 ms。该观察不归因于 C4b；未重写基线、放宽门或以重跑消除 warning。
  它与合并前 PR CI 的 0.021541 ms 增量是不同运行的观察，不混用数值。

本次收口仅更新 C4b 专属 spec/收据和 PR 交付记录，按独立文档 PR 流程验证；不修改 runtime、评测实现、
baseline/dataset、CI、package/lock 或主 worktree 的 roadmap/ADR 未提交内容。
文档 CI 不生成应用/Docker 发布证据，上述实现与主干 full CI 继续是代码交付证据。

收口结论：已完成本轮现场盘点、最小测量、安全保护、单次源读取优化、独立评审、PR 合入和主干 CI 核验。
只证明恢复源读取 2→1 及合成局部收益；当前实际模型配置的完整计时、整体提速、费用/吞吐和上线效果均未证明。
TD-14 保持部分完成，后续真实模型测量另需固定范围、次数、请求/重试上限、预算与停止条件授权。
真实模型调用为 0；未进行生产访问、部署、运维迁移、历史修复或本地分支/worktree 清理。本轮到此结束。
