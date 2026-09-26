# Legacy Coverage WIP 收口验证

## 实现与取舍

基线 `aed210e6c6ebd9637a716ee6c41b2719a13c0fa3`；实现提交 `10a509c`、`6b08c17`。
验收见 [spec](../plan/specs/wip-coverage-closeout.md)。本次只提取反例修正和确定性读路径版本门。

| WIP 内容 | 处置 |
|---|---|
| `d5fbfde`、`e6afc93` 的 podcast shadow 部分 | 主干 #347 已吸收并补强入口双熔断、URL 脱敏和诊断故障隔离，不再移植 |
| `dfdfe87` 三角色 canary | 主干 #349 已吸收并强化错误白名单，不再移植 |
| `cabd415` 的原始 claim 审查意图 | 主干在投影和中文改写前已审原 claim，不搬旧数据结构 |
| `38262c0`、`50a727a` 的 synthetic 范围反例 | 修正预期为 reject，增加三个支持正例；不搬词面正则，真实模型四例均通过 |
| `e6afc93` 的 reader 版本边界 | 在主干共享工具落实显式 v6 兼容表，覆盖报告、图谱和技术线索读入口 |
| `7d71aa7` 双 claim 独立审查 | 不移植：会向 quote-only Coverage 注入 claim，违反当前独立输入契约 |
| `2eb6bc7`、`7ce6468` 的 v9 fixtures 和 `bd8be23` 旧评测盖章 | 不移植，不作为本次质量证据 |

不改模型/prompt/thinking/token，不迁移或删除历史审计，不重写历史报告，不恢复 WIP 的旧
Responses 重试路径；独立 Coverage 仍只有 quote+locator。保留 #351/#352 的生产修复。

## 确定性验证

- `npm test`：200 个文件、1,832 项 Vitest 测试通过，另 14 项 Node 脚本测试通过。
- `npm run test:coverage`：通过；statements 76.41%、branches 68.58%、functions 76.52%、lines 80.17%。
- `npm run typecheck`（TS7 + TS6）、`npm run lint`、`npm run build`、`git diff --check`：通过。
- 版本门反例：缺失/空/v5/v9/未知未来版本，即便 decision/hash/validator 形状合法也拒绝。
- 真实 `runReportGen → DB 读回审计 → buildReport → report/index/selection ledger` 路径验证
  高重要性旧版本不能挤掉合法 v6；原始两条记录仍在。图谱共现计数、实体/边侧栏、技术线索列表/
  规划列表/详情同步拒绝；v6 中文 reader_statement 和原文展示保持通过。
- 单测 mock 仅证明 primary 拒绝不会被 quote-only 通过覆盖，不作为语义效果证明。

## 真实模型评测

命令：`DB_PATH=<隔离临时目录>/insight.db DATA_DIR=<隔离临时目录> npm run eval:a1:prototype-safety`。
从本地配置读取 provider/model，不输出密钥、不连接 live SQLite。

- provider=`volcengine-responses`；analyzer=`deepseek-v4-flash`；validator=`deepseek-v4-pro`、thinking=0；
  coverage=`glm-5.2`、thinking=1、maxTokens=2048，independent calls=1。
- run：`a1-20260926071509-2b900c4e`，完整完成；source=`6b08c1715439bad14aa99612f659237e0c0081b5`，
  dirty fingerprint 为 null。后续仅增加本文档/评审证据，不改变被测代码。
- 1 主题、12 一致性对（3 support / 2 uncertain / 7 not_support，覆盖三类负例）、14 display、8 quote-only。
- 约 171 秒，38 calls / 38 requests / 0 failures；成本保守估算 $0.5631（模型无本地核实价目，非账单）。

| 指标 | 基线 | 本次 | 变化 | 阈值 / 结论 |
|---|---|---|---|---|
| reachability_pass | 98.3%，旧配置 | 100%，1 引用 | 不可比 | 子集观察 |
| consistency_ok | 51.7%，旧配置 | 100%，1 引用 | 不可比 | 子集观察 |
| consistency_failure | 29.3%，旧配置 | 0% | 不可比 | 子集观察 |
| flagged_rate | 17.2%，旧配置 | 0% | 不可比 | 子集观察 |
| judge_accuracy | 82.1%，旧配置 | 100%，12/12 | 不可比 | 子集观察 |
| judge_neg_recall | 100%，旧配置 | 100% | 不可比 | 子集观察 |
| display unsafe_accept / false_reject | 无同配置基线 | 0/9、0/5 | 不适用 | unsafe_accept=0，通过 |
| quote-only unsafe_accept / false_reject | 无同配置基线 | 0/4、0/4 | 不适用 | unsafe_accept=0，通过 |
| projection_violation | 无同配置基线 | 0/14 | 不适用 | 通过 |

synthetic 负例 reject；synthetic data、artificially generated data、中文原文三个正例 accept，
四例无执行错误。fixture 的更正及新增样本使数据指纹变化，不更新 `evals/baseline.json`。
multisource/human 指标本次未运行，不填造 Δpp；不声明完整 A1、DCP、人评、来源许可或生产验收通过。

评测产物：本地 `evals/out/prototype-safety/a1-20260926071509-2b900c4e/{manifest.json,a1-run.json}`；
聚合收据 `evals/out/prototype-safety-receipts/a1-20260926071509-2b900c4e.json`。
manifest SHA256=`7ae747a75cbdeb9ec7c37559254076c813bcacf81c8409d31386a11b855d376e`；
a1-run SHA256=`a0135701f7f6bf16501950d568f9a186e064731c9611037d278a89b65a9a3694`。
不提交原文、完整模型输出或本地数据库。

评测例外：读路径版本门不由 A1 执行；其证据为上述真实 DB→报告/图谱/技术线索回归。
真实模型子集用于验证评测反例与现有审查链路，按 L3/ADR-0032 作为 scoped prototype safety evidence。

## Pre-PR AI Review

- 基线：`origin/main` @ `aed210e6c6ebd9637a716ee6c41b2719a13c0fa3`
- 范围：评测范围反例、共享 reader audit 版本门及全部消费者。
- 风险级别：高
- 结论：通过（确定性代码与真实模型收据均经独立核验；PR 最终 diff 复核单独留痕）。

### Blocking

- 无代码阻塞项；质量收据不作正式基线/DCP 背书。

### Warning

- 无。

独立 reviewer 亲跑 9 文件 271 测试、TS7/TS6，核验全仓消费者及 fixture hash。
随后独立核对 run SHA、dirty fingerprint、manifest/a1-run/model/fixture 哈希，并调用收据认证函数
重建收据确认完全一致；四条 scope 案例与 display/quote-only 均完整且无错误放行。

### PR 交接

Blocking: 0; Warning: 0

合入与上线分开记录。需 PR CI 和 main CI 成功后才清理本次 feature 分支。
原 WIP 未完整合并，不使用常规“已合并”清理假定；归档/删除须另行明确确认。
