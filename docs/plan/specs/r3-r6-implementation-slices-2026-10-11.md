# R3–R6：分片、真实路径验收与限定提示词

本交接包依赖 [接口/归属提案](r3-r6-interface-preparation-2026-10-11.md)，
基线 `ff7820af9d6517a7543355fd58524fccac6bbc19`。下面 owner 是拟任角色，不是已授权 Agent。
每片启动重新 fetch/rebase 核集成差异、定向交接记录与未提交材料；不得复用旧结果给新候选盖章。
完成本准备不等于实现测试通过；所有下列测试均为**未来实现验收要求，尚未运行**。

## 分片与唯一写入 owner

| 片 | 唯一拟任 writer / 限定源窗口 | 前置 / 可并行性 / 退出 |
| --- | --- | --- |
| S0 接口冻结 | S；新专属接口 spec/证据 | 收逐文件 owner，D1–D3 分别冻结；只读与 U/A/P 保护反例设计可并行。不得改 ADR/主账 |
| S1 usage fixed bridge | S；writers.mjs/.d.mts、writer-admission.ts、新固定 usage driver/types/tests | D1 与精确 shared 移交；只 dispatch+usage 同连接严格消费，保护旧三个 profile。S 写窗期间 U/A/P 禁改 shared |
| U R3 | U；db/runtime model-usage 及专属测试 | S1 reviewed 接口冻结后；可与 A 的已移交 raw 片并行。jobs 只读，W 后接真实 Job，不拿 repo 绿代替 runtime 绿 |
| S2 raw/report fixed bridge | S；同一 shared 窗口、新域 driver/types/tests | 在 S1 收口后串行；D2 source/recovery 与域值参数冻结。S 不接管 raw/report repo，需 U/A/P 接收 exact 版本 |
| A R4 | A；raw-archive.ts/test、新固定 raw adapter/test | S2/D2；在 U 独占窗口无交叉时并行；collector Content 外层 txn 消费归 W，未接前只签限定 adapter |
| P1 R5 ordinary | P；reports.ts/test/cancellation、新固定 report adapter/test | A 的 raw/evidence 合同、S2；不与 P2 同文件并行。保留 legacy 默认路径但 opt-in 不降级 |
| P2 R5 anchored | 同一个 P；reports.ts + integrity-publication.ts/test、新专属反例 | P1 后串行；D3 未冻只交固定同步 DB/recovery 方案，不能签完整 async publication。ordinary 的通过不代签 P2 |
| W1 R6 startup | W；startup/connection/local-bootstrap/config/planning/seed 与本片测试 | D2 + A/P recovery；先于任何 HTTP 接线；迁移/schema只读，seed 的 explicit migration 若需改另报范围 |
| W2 R6 HTTP/dispatch/jobs | 同一个 W；精确 HTTP 切片、generation-dispatch/jobs/test；cancellation 默认只读 | W1 与 U；先 internal route，再 request/cron/manual/retry 各一片；claim/heartbeat/Run 建立是首效应，不能只改 terminal |
| W3 R6 consumers | 同一个 W；scheduler/collector/pipeline/report-gen/test 的固定消费 delta | W2、A/P；collector 外层 upsert+intent/revision、report review/final events、usage Job 原 ALS 真消费；不拆模块 |
| W4 R6 report recovery | 同一个 W；仅已移交 per-report recovery 消费窗口 | W1–W3、D3；新 fresh recovery身份，旧unknown保留；完整cron的维护lease/checks/daily-root仍未覆盖，须另冻窗口才能接，不自动扩大W4 |

S 在每个阶段独占共享 types/writers，固定 API 扩展串行；U/A/P 不自行加 shared type/gate。
P1→P2 同 writer 串行；W1→W2→W3→W4 始终同一个具体接收 owner，不分给并发 Agent。
U 与 A 只有交接+接口分别满足后才能并行；P1 依赖 A，不能用旁路 raw reader 替代。
未满足接口/归属的代码片不启动，但保护反例设计和资料盘点继续。资源密集测试、合入、必要 CI 排队。
R2 native、R7、R8、延期 TD12 reports/report-gen 拆分、性能/模型矩阵均不纳本轮。

## 真实路径验收矩阵

共同必验：实际 native SQLite、两个进程/connection 的 close/commit 竞争，首 SQL/文件效应之前
preflight，unsafe hot journal 新 open 与 cached handle 负控、合法恢复正控；错误根/marker/inode/
ATTACH/readonly/closed/业务反向事务；固定源码无 await/可执行函数参数；零 retry/fallback。
每个进程 kill/COMMIT 故障保全初始及终止文件、SQL状态、hash和调用计数，逐阶段分类，不把 fixture
空表/health/退出状态当全静默；原红、warning、unknown 独立存档。

| AC / 片 | 必须运行的真实路径与反例 | 可观察通过条件 |
| --- | --- | --- |
| AC-S / S | 真 openWriters 同 private connection→fixed factory→原 repo outer transaction；check-release 旧负控、双进程 close 先赢/commit 先赢；BEGIN前拒绝、COMMIT 前后、registry failure、kill | close 赢零受保护业务写；事务未开始→not_committed且无补偿SQL；BEGIN后rollback不明→unknown；commit 赢真实 COMMIT 后才释放锁；unknown 不再 failed；旧 default/S1/strict/staged 测试保持 |
| AC-U1 / U | createUsageJobScope→callStructured→实际 SDK 自定义 fetch + Responses parser→begin/observe；SDK500内部 retry、runtime retry、写前 busy、观测后 busy/close | 每实际 transport 独立 attempt；pre-dispatch 拒绝0发送；观测失败最多已有 transport，无下一次 SDK transport，固定 sticky 分类 |
| AC-U2 / U+W2 | runJob 取消后忽略取消的真实 reader.read迟到 chunk；有效 lease且维护未close、lease接管、close先赢、DB closed、Job已finished | 允许条件下已开始 attempt迟到观测落库且业务结果拒绝；其他条件原 unknown/partial/report 不变，不改收尾 Run，不重开 DB，无 unhandled rejection |
| AC-U3 / U | 真 repo 同 attempt/观测编号相同hash、冲突/stale、partial继承、真0/missing、reported重启读、未知模型/CodingPlan | replay不重复；价格快照不重算；NULL不变0；Run/P1/attempt不相加，原budget/首因保持 |
| AC-A1 / A+W3 | 实际 collectSource+合成 source adapter→真实 Content upsert/plan/revision；外层 rollback、同raw replay、原id保留、更新绑定变更 | intent/content/revision同 COMMIT；失败不留半intent；原内容字段保留；不得从现有txn取registry锁 |
| AC-A2 / A | 真 writePlannedRawArchive；在 staging/attempted/rename/finalize 各切点 close/lease takeover/kill；双进程完整锁区 | 失权后无新 publish/reader_eligible；已提交或已rename事实保留；hash坏不公开；catch unknown 也不绕门写；不删 orphan |
| AC-A3 / A+W1 | 真 reconcileRawArchiveEffects 的 final存在/staged存在/缺失/冲突；fresh恢复身份、旧cap重启/clone拒绝 | 幂等恢复相同 effect+bytes；许可缺失0rename/0SQL写；partial/unknown仍可诊断；不复活旧task |
| AC-P1 / P1+W3 | runReportGen→真实选择/render/bindings→saveReport；blocked/无check/reachability pass但consistency nonsupport、raw变更、review trace/event mismatch | 白名单精确为pass+reachability pass+support+真实raw；review绑定+rendered citation一致；不以URL可达代替一致性 |
| AC-P2 / P1 | ordinary intent/双rename/reader final的每个切点；saveFailedReport、legacy缺effect的opt-in、postcommit read/notify fault | reader done/index/FTS/review/effect/event同final txn；部分文件保持pending/unknown；失败报告无 reader；已commit后不再写failed或清文件，opt-in缺schema拒绝 |
| AC-P3 / P2 | 真 writePlannedAnchor/commitAnchoredPublications，以受控 fake signer/store deferredawait；key注册/签名/两artifact部分put、取消/撤销、provider ACK失踪 | 无SQLite锁跨await；exact candidate/key/retention/version保持；失权后reader0；在途put终态unknown，不称远端0写或撤回成功 |
| AC-P4 / P2+W4 | 真 reconcileAnchoredReportEffects：planned实际put分支、anchor_written实际get分支、仅一artifact存在、key revoked、bytes/version冲突、15min escalation | 新recovery准入每次SQL/外部开始实际消费；不造新idempotency/version；整报告不可半公开；unknown/审计保留；D3不满足不得声称验收 |
| AC-W1 / W1 | 独立子进程第一getDb/openDb/openConnection；strict/non-strict、cached命中、health/auth/read初触达、空库getEffectiveSources、真实seed CLI的合成隔离输入 | 准入拒绝先于mkdir/newDB/WAL/bootstrap/orphan/raw→report reconcile/seed；缓存也不绕门；失败不发布_db；不运行真实配置或业务数据 |
| AC-W2 / W2 | 真 internal HTTP POST→composition→getDb/core/claim→jobs；cron/manual/request/retry分别e2e；close在准入后claim前、heartbeat以及Run done/failed前 | claim/heartbeat/insertRun/finishRun均走指定固定边界；传cap却未消费负控必须红；六字段epoch/lease真实 guard；无第二次failed terminal |
| AC-W3 / W3 | 真 collector/scheduler/pipeline/report-gen 正常与取消/lease-loss、task-budget sticky、usage sticky、postcommit错误 | 成本及首因保持；外层Content/report transaction不反向锁；analysis/cache/diagnostics/telemetry等未覆盖逐项列明，不吞拒写成成功 |
| AC-W4 / W4 | startup raw→ordinary report次序、per-report anchored恢复、重启新generation；实际cron入口的周期orphan/维护lease/automatic checks/daily-root负覆盖 | per-report恢复通过不签完整cron；未冻结附带路径不得继续执行，实际入口拒绝须先于其首效应；其余unknown；全ready/quiescence/production仍false；不清lease/hold/epoch或自动恢复旧cap |

使用 mock transport/sign/store 只隔离外部调用；必须经过真实 SDK/parser/core/repo/FS/HTTP，
不能手填 state observations、绕 sources adapter、用纯 callback 测试代替生产外层 COMMIT。
未来代码最低：本片定向 tests + `npm run typecheck`；路由/运行包/部署内容变更再 build/e2e/实际必要CI。
原测试导航：`src/lib/db/{model-usage,raw-archive,reports,reports-cancellation,integrity-publication}.test.ts`、
`src/lib/runtime/model-usage.{test,integration.test}.ts`、`src/lib/runtime/jobs.cancellation.test.ts`、
`src/lib/agents/{generation-dispatch.maintenance,generation-dispatch.terminal,generation-dispatch.staged,collector.source-control.integration,pipeline-reportgen.integration,c2a-cancellation.integration,pipeline.task-budget}.test.ts`。
其中花括号记法只是导航组合，启动须按实际文件名选择命令；不把已有用例名称当覆盖证明。

涉及未来 runtime/provider/source/validator 或 report-gen 更改必须调用 eval-gate，再选择实际路径证据。
确定性 report选择/渲染/索引不使用不执行该代码的 A1；AI语义发生变化则停本slice，因模型预算0无法
自行跑付费eval。行为保持且真实回归支持时才由最终diff决定 skip/scoped，本准备不预盖实现章。

## 可直接派发的限定提示词

主控先填具体 owner 与逐文件移交证据。以下每段均依赖通用约束，不能删除前置后当授权使用。

```text
通用约束：读取 AGENTS/L2/L3、本接口spec与分片spec。重新fetch origin/main，核对交接
原件的source head/hash与未提交保全路径。仅在专属codex/分支、隔离worktree写明列文件，
不得使用r2-native、清理目标或其他owner目录。新工作区只复制必要0600配置并先隔离
DB_PATH/DATA_DIR；不复制数据。任何文件未移交只暂停依赖链，继续独立准备并报精确缺口。
不改模型/prompt/validator/业务选择，不跑真实模型、资格矩阵或生产，不解除hold/部署/清理。
不重开延期拆分或已用尽的R2旧review。高风险两位fresh非作者review最多两轮；仍未解
Blocking停止新审查，保原件交主控，不换reviewer规避。最终tests/typecheck及必要build/e2e/CI
绑定真实候选；Git/PR/合入须本片具体授权。没有授权停止在可评审交付。

S Agent：你是共享接口唯一writer，先承担S0，再经D1批准与逐文件移交后实施S1。
只写writers.mjs/.d.mts、writer-admission.ts、你专属固定usage driver/types/tests。
禁止通用gate/callback/custom-driver工厂，先交exact值签名、同connection绑定、锁序及
COMMIT三态、取消后observer生命周期。严格限制isolated dispatch usage；不更改旧三profile。
S2/source/startup/remote的新合同未冻结不能顺带实施。交U/A/P只读冻结接口与独立测试入口。

U Agent：你只承担R3，在S1 exact协议与db/runtime model-usage逐文件移交后实施。
jobs、llm、provider parser均先只读；需改它们报新增文件窗，不自扩。走真实SDK fetch与
Responses observer，按AC-U1/U2/U3保护实际attempt、迟到观测、sticky failure、费用unknown。
取消不归零，不绕lease，不重开DB，不增加transport retry；共享types/writers只由S改。
单独写新receipt；明确W2真实Job接线尚未覆盖。

A Agent：你只承担R4，须S2+D2/source-recovery身份合同与raw-archive逐文件移交。
collector/provenance/repos先只读。只写raw repo/test及已冻结专属fixed adapter。
先证明Content+intent/revision外层事务所需值接口，再按AC-A2/A3保护文件发布与reader
final COMMIT、重启恢复、unknown、幂等。未接collector只签adapter，不宣称采集全路径安全。
环境DATA_DIR不可变绑定，失权不能rename/finalize/catch补写，不删恢复依据。

P Agent：你是R5唯一writer，P1普通先做，P2 anchored后串行，不拆reports/report-gen。
前置S2/A与reports、integrity-publication各精确交接；保validator/raw/review绑定，
pending/unknown及相同effect/key/version。AC-P1/P2先通过；D3未冻不能宣布P2外部写安全。
按实际planned recovery会put的路径验AC-P4，不采信never put注释。任何await不得跨
SQLite写锁；外部已写而SQL未commit保原candidate/unknown，不写failed伪rollback。

W Agent：你是R6所有共享调用方的同一唯一writer；按W1→W2→W3→W4串行。
先拿startup/connection/local-bootstrap/config/planning/seed精确移交与D2合同。
准入必须先于getDb首次mkdir/write-open/reconcile/seed；cachedhandle也重新消费许可。
再分片接internal HTTP/core/jobs及cron/manual/retry；最后collector/scheduler/pipeline/
report-gen固定消费。保护Content外层intent与report review/event同txn，禁止事务反向锁。
明确claim/heartbeat、diagnostics/telemetry/notification等未覆盖；不只传cap即签完成。
D3未冻的integrity远端仍blocked；W4只交per-report recovery，完整cron的维护lease/checks/
daily-root合同未冻保持未覆盖，不自动运行这些阶段；不取得migration/schema/ADR/主台账写权。
```

## 主控最小下一步

先指定 S 和 W 的具体接收人，取得 shared writers/types 与 usage 的逐文件移交，冻结 D1，
即可启动 S1→U 的 dispatch usage 窄片。并行协调 raw owner、D2 的source/startup/recovery协议；
R4 不因已有collector guard而放行。随后 A→P1，D3另案解决后才 P2；W按统一串行链推进。
这一步需要归属/设计决定和后续实现授权，不需要模型预算、生产/矩阵次数或解除hold。
正式ADR/架构/主台账由原owner处理，本交接包不接管。未找到释放与设计缺口保留为待确认。
