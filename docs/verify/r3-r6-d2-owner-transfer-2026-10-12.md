# D2 / S2 / W1 归属准备收据

## 当前范围与身份

本片作者 `Dev-Agent-R3–R6接口准备`，专属 worktree `/Users/dongqiu/.codex/worktrees/bcba/insight-agent`，新分支 `codex/r3-r6-d2-contract-20261012`，基线 `086c30268391335b66f72239220985676d04b065`。旧分支 `codex/r3-r6-interface-prep-20261011` 的受审 head `d57538ee244f8d487607c813aa282f791f8aab12` 保留，未清理工作区/证据/依赖。只新增本文件和 [D2 spec](../plan/specs/r3-r6-d2-entrypoint-contract-2026-10-12.md)，其他源码只读。

用户于本聊天直接授权六小时自主协作、完成自动回报主控并持续派工、必要授权同意，固定截止北京时间 2026-10-12 09:26:40。主控核实原人类消息后指定本片及 PR #475 唯一 merge owner。正常 squash/expected-head 成功，GitHub connector 与 fetch origin/main 确认实际 merge `086c30268391335b66f72239220985676d04b065`，2026-10-11T19:31:56Z；13源码对先前受审源码候选逐字节一致。精确main push CI `38168419054 / attempt 1` full/success，三required与应用/ops/Docker通过；三JSON原件head/tested_commit/run一致。旧候选tested merge/CI不充当main结果；未部署/解除hold。新D2候选是两新文档的轮次SHA256，见coord/d2-candidate-v*.json，独立于旧源码head。

本片私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-d2-20261012/`：`coord/input-index-v1.json`逐文件 blob/SHA256/bytes/last commit 与不可变 `inputs/`；`coord/pr475-merge-v1.json`记录合入/两个GraphQL连接超时，后续查询失败另保全。证据目录0700、原件0600。旧usage/prep/private原件未修改或清理。未输出配置、读取数据库或运行模型/资格矩阵。

main原件 `coord/main-run-38168419054-v1.json`、`main-jobs-38168419054-v1.json`、`pr475-main-ci-v1.json`及`main-artifact-identity-v1.json`保全。全artifact下载遇 `.dockerbuild` 非zip解包失败，已保存 failure-v1 与此前成功JSON；另下载scope/Docker JSON完成，未因此重跑CI或清理部分证据。原件hash、run/attempt与expiration分别记录，不把下载失败写成测试失败。D2第一轮A为B0/W1/S2、B为B0/W2/S0，原报告保留；目标排他、seed前缀与recovery诊断/中断合同修订后第二轮只复核增量，未预签通过。

## 移交事实的三个层级

已确认：主控委派本轮**两新文档**及私有根唯一作者；旧八文件 usage 限定接管仍有效，S1/U write window 当前仍本线持有。新增 spec并不自行扩大这个窗口。历史：原协调收据声明 all_owners_retained，meta/Git/clean/合入/聊天结束均非源码释放。待确认：S2新增接口消费者、W1各文件当前具体owner和精确释放；本轮未收到这些新文件释放收据，不能写成“无人正在使用”。

本轮按 Git 对象和本 worktree 冻结实际文件，没有进入 r2-native 或清理作业目录；其他 worktree/进程未做全机扫描，因此“当前活跃写占用”除本线明确写域外为待主控定向确认，不能由未见dirty推导空闲。主控现知 N08/r2-native及 dirty ADR/architecture 活跃保留，继续保护。

历史原件沿 [10-09 收据](refactor-remaining-coordination-2026-10-09.md)、[10-08 收据](refactor-coordination-2026-10-08.md)和 [准备包](../plan/specs/r3-r6-interface-preparation-2026-10-11.md)既有明确索引引用；它们的 commit/PR/owner均为历史身份。本轮 input-index 的 last commit 只定位变更，**不等于当前owner授权**，不重跑历史资格或旧方案第三轮。

## 精确最小候选写域与依赖

下表每个文件在本片 `coord/input-index-v1.json`均有独立 Git blob、SHA256、字节数及快照；实际 merge 对这些文件与 candidate 相同。表中的未来 S/W 是待主控指名的唯一具体接收人，不是已发出的源码接管。

| 精确文件 | 已确认/历史归属 | 当前写占用/移交 | 后续唯一owner与依赖 |
| --- | --- | --- | --- |
| `ops/maintenance/writers.mjs` | 旧A3 Agent A；现八文件usage限定接管到本线 | 已确认仅S1/U；S2新扩大未冻 | S，v1/v2兼容、close和pre-open |
| `ops/maintenance/writers.d.mts` | 同上 | 同上 | 同 S，固定入口/版本类型 |
| `src/lib/runtime/writer-admission.ts` | 同上 | 同上 | 同 S，保持旧profile与dispatch |
| 新 v2 registry/driver/types/test 文件（具体名字尚未冻结） | 尚不存在；相邻新文件也需写窗 | 待主控冻结精确文件名，不可按目录接管 | 同 S，controller/drain/ledger版本消费另精确列窗 |
| `src/lib/db/connection.ts` | D1 #411历史；last commit仅溯源 | 当前owner/释放/写占用待确认 | W，pre-open fixed port、返回handle身份 |
| `src/lib/db/startup.ts` | D1/C1 raw/report恢复共享历史 | 未释放 | 同 W，cache与raw→report→seed顺序 |
| `src/lib/db/local-bootstrap.ts` | D1/local seed历史 | 未释放；迁移/meta依赖仍只读 | 同 W，显式local-seed，禁止production/strict |
| `src/lib/config/index.ts` | seed/config历史，具体原owner缺 | 未释放 | 同 W，只seedDefaults/getEffectiveSources，配置模型语义不改 |
| `src/lib/db/planning.ts` | seed/planning历史，具体原owner缺 | 未释放；其他机会投影逻辑保留 | 同 W，仅seedDefaultDirections所需窗口 |
| `evals/seed.ts` | 本地seed历史，具体原owner缺 | 未释放；运行CLI本片未授权/未执行 | 同 W，合成配置路径、首效应前登记 |
| `src/lib/db/d1-connection.test.ts` | D1历史 | 未释放 | 同 W，connection/startup真实子进程反例 |
| `src/lib/db/local-bootstrap.test.ts` | local bootstrap历史 | 未释放 | 同 W，本地迁移实际首效应与禁止路径 |
| `src/lib/config/index.test.ts` | config历史 | 未释放 | 同 W，仅隐式seed控制，不改模型fallback |
| `src/lib/db/planning.test.ts` | planning历史 | 未释放 | 同 W，仅方向seed，不接管完整planning重构 |
| `evals/seed.test.ts` | local CLI历史 | 未释放 | 同 W，实际entry、合成env/no credentials |
| `src/lib/db/legacy-bootstrap.ts` | D1 schema bootstrap历史 | 本片只读；确需改另列窗 | 原owner，不能因open先门而偷偷扩DDL |
| `src/lib/db/provenance.ts` | C2f/source lease及多provenance历史 | 本片只读；source prelude依赖固定现函数 | 原owner；要改根Run/request事务需后续精确窗 |
| `src/lib/agents/collector.ts` | C2d/C2f多owner历史 | 本片只读；W3未来串行，未移交 | 同 W后续片，不能S2抢接 |
| `src/lib/db/raw-archive.ts` | DB commit历史保留，确切owner缺 | 本片只读，A未指定/未释放 | A独占，S2+D2，W1等待实际恢复接口 |
| `src/lib/db/reports.ts` | C1/Brief/D3共享历史 | 本片只读，P未指定/未释放 | P ordinary/anchored同writer；W1依赖，D3另冻 |

main Git commit/fresh origin不证明其他worktree文件未改。正式接管收据需：原owner或精确人类接管→具体S/W/A/P；逐文件base/head/blob/hash；未提交内容保全入口；扩大写窗与仍保留窗口；当前实际写占用；接口依赖版本和是否结束使用原路径。本片不以新六小时授权替代这个事实核对。

## 并行、验收与下一最小行动

可并行：等待 PR475 精确 main CI、本专属D2文档核验、主控定向归属协调；未来A/P各自独占repo可以依接口顺序实施。必须串行：S2共享窗口、同一W的W1→W2→W3→W4，ordinary/anchored同P，所有改同文件的Agent不得重叠。S2不能在W1外层业务txn中反向申请锁，不得持写txn跨await。

本片按高风险设计要求使用 `pre-pr-ai-review`：两名fresh独立非作者，只给两新文件/冻结源码/AGENTS/L2/L3及对应spec；每人独占私有review目录，最多两轮。旧S1/U/准备包审查仅解释既有不变契约，不批准D2新方案。只验证事实/格式/链接和合同反例完整性，不运行应用/模型/eval或真实恢复，不把设计审查签runtime资格。review结论与精确候选hash存私有加性索引。

下一最小行动：主控冻结D2推荐版本方案及正式ADR delta的原owner；取得上表S2新增接口/消费版本文件名与W1十一文件的精确接管（六源码+五tests）；A/P恢复契约缺口单列，W1 open/cache窄片可先冻结，但不能跳raw/report recovery签完整startup。源码/DDL/运行资格前置未满足时只阻断对应实施，继续专属准备。D3异步外部恢复、生产/hold/清理/延期模块维持边界。

推荐初始v2只面向新root内独占 `d2-business.sqlite`/raw/report，v1不原地升级、同rootwriter marker/file O_EXCL与exact版本拒绝，跨root不得alias同target；原handle/未知consumer存在则前置失败。实际app-path/旧target没有共同ownership协议，仍不可接生产或默认.data，需另冻S0/contract/drain/controller等delta；这些文件未因本spec被释放。auth-reader direct readonly保持D1 WAL协调例外，不列W1新增写窗。seedDefaults逐条固定消费与committed-prefix、recovery confirmed diagnostic unknown可继续与admission-denied/commit-unknown中断已在新spec明确，后续真实路径验收仍未执行。
