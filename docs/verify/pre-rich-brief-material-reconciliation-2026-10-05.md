# 新版 Brief 收口：材料对账（2026-10-05）

按 [收口计划](../plan/pre-rich-brief-closeout.md) 第 1 项执行。主工作区 6 份原件与 S0 未提交进展均保存，未 reset/clean；独立试验原件留在原分支。全部 SHA-256 是执行时文件字节，Git SHA 为当时所在分支 HEAD，不把未提交文件称提交产物。owner-only 备份和完整路径清单位于 gitignored `.data/brief-density-s0/closeout-20261005/`。

| 原件（worktree / 分支） | 路径 | 状态 / HEAD | SHA-256 | 去向 |
|---|---|---|---|---|
| insight-agent / `docs/brief-information-density-plan` | `docs/develop/decisions.md` | M docs/develop/decisions.md / `21414ab` | `75bbcc3e15ac0a96b53a2d9b072007755df3c12cbadd20cedf6a547508394bea` | ADR-0036：S0 已有较新版本；保留旧工作区原件 |
| insight-agent / `docs/brief-information-density-plan` | `docs/plan/roadmap.md` | M docs/plan/roadmap.md / `21414ab` | `77b258ff97d7ebad0815cb2189ce8032d23472adf0a76b3513f510867a31bf9f` | 路线图：S0 已有入口及较新阶段状态 |
| insight-agent / `docs/brief-information-density-plan` | `docs/plan/daily-brief-information-density-execution.md` | ?? docs/plan/daily-brief-information-density-execution.md / `21414ab` | `9a29ee44ef064516c46bdc05c487b1bb6c9b23fd88b46f7300f531a589576363` | 执行清单：S0 T02 已更新；P/I/C 分流由可行性及新版规格承接 |
| insight-agent / `docs/brief-information-density-plan` | `docs/plan/specs/daily-brief-information-density.md` | ?? docs/plan/specs/daily-brief-information-density.md / `21414ab` | `da317590192d46314dce94bd4140616e0cccff3d0e69b557fe0536a5f936b0ca` | 规格：保留 S0 较新快路径；旧版解析/选段结论转可行性记录 |
| insight-agent / `docs/brief-information-density-plan` | `docs/verify/daily-brief-extraction-feasibility-2026-10-01.md` | ?? docs/verify/daily-brief-extraction-feasibility-2026-10-01.md / `21414ab` | `1ce9801377aaa21111a9fd496274018e9bcbdfb0004ff16f279b74a2b370cbc1` | 独有来源形态/输入可见性聚合；收入 S0（原件逐字备份；仅补回标签防泄漏约束） |
| insight-agent / `docs/brief-information-density-plan` | `docs/verify/daily-brief-information-density-plan-review-2026-09-27.md` | ?? docs/verify/daily-brief-information-density-plan-review-2026-09-27.md / `21414ab` | `b02884ff9ea42d7a2a75d05cd0c622e40d5e2d3187265d4a577ec05d1078e725` | 与 S0 同名逐字一致 |
| insight-agent-brief-density / `feat/brief-density-s0` | `docs/verify/daily-brief-density-s0-progress.md` | M docs/verify/daily-brief-density-s0-progress.md / `9d69c6f` | `4756ce37724d18359e9ee805c4a5f6d64f9c100d0b242e103394d0e5ee0e3b78` | 独有首轮运行进展；核验私有 hash 后单独提交 |
| insight-agent-brief-extraction-probe / `feat/brief-density-extraction-probe` | `docs/verify/daily-brief-extraction-pilot-2026-10-01.md` | tracked clean / `752cefd` | `9b2c0e7bfb44f6ba4203e1a5f18e19e260b3033cd76c34d2af3f04582256b375` | 独有小样本真实失败/超时；原样收入 S0 |

## 同名语义对账

逐段比较旧规格与 S0：旧规格的 P/I/C 分流、31 份来源形态、历史模型输入不可重建、标签只能评分及工具定位不能代替语义支持，由 [10 月 1 日可行性](daily-brief-extraction-feasibility-2026-10-01.md)及 [新版规格](../plan/specs/daily-brief-rich-insight-freshness.md)承接；保留历史 39 个配置源等旧分布在原件中，不将其升为当前生产统计。S0 新刊快路径、真实备份区间与已批准 T02 边界优先；旧 T02 的全量历史供给门已由明确决定替换，不搬回旧门。两个计划评审文件逐字相同。ADR/roadmap 的旧入口已被 S0 较新版本覆盖。无待决语义冲突。

独立试验 [752cefd](https://github.com/dong-qiu/deep-insight-agent/commit/752cefd98696e9c4a7397d8290459c1de5bbd942) 的 [小样本记录](daily-brief-extraction-pilot-2026-10-01.md)收入 S0；先前可行性是机械来源/片段核查，试跑是其后模型/工具可调用性探索，二者保留各自方法，不累加为独立质量样本。失败的零片段调用、E24 超时、usage unknown、非留出与非语义校验限定原样保留。私有脚本、正文和输出不入仓。

本次整理没有改动生产 prompt、模型、来源、校验或评测数据；Eval-Gate 不适用，A1 不执行文档整理/只读导出。检查与独立审阅将在分支证据记录，T03/T04 未完成前不单独合入。

## 本项检查与独立检视

2026-10-05 固定 Node 24.19.0 / npm 11.17.0 后，`npx vitest run evals/brief-density/export.test.ts` 15/15、`npm run typecheck`（TS7/TS6、app/tools）、`npx eslint evals/brief-density --max-warnings=0`、`git diff --check` 通过。首次测试因 npm 子进程使用了不同 Node ABI 而 14/15 无法加载 SQLite；固定 PATH 后通过，未改断言或超时。

独立新上下文审阅：八条原件 hash、同名 diff、本地链接及探索边界核对通过。发现的标签防泄漏迁移 Warning 已补在可行性记录“对照顺序”末段，定向复核 Blocking 0 / Warning 0。审阅没有接触私有原文/DB，不作为其语义验收。执行者重算首轮 DB/清单/15 份 raw/2 份已刊报告字节 hash，全匹配既有收据；人工确认沿用原记录，不重复提问。第 1 项完成门通过，作为同一 S0 PR 的前置成果保存；不独立合入，也不宣称 S0 总门通过。
