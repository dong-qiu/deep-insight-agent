# D2：入口登记、兼容与首效应合同提案

## 执行单与事实基线

本片唯一作者为 `Dev-Agent-R3–R6接口准备`。主控于 2026-10-12 明确委派本片，用户六小时持续协作授权截止北京时间 09:26:40。交付为本 spec、[逐文件归属收据](../../verify/r3-r6-d2-owner-transfer-2026-10-12.md)及专属私有证据；仅新增文档，不实现注册、DDL、业务接线，不接管 ADR/architecture/主台账。必要正常授权已同意，归属事实与技术前置不能由概括授权补造。

本轮实际 main 为 `086c30268391335b66f72239220985676d04b065`：PR #475 的正常 squash，父提交 `ff7820af9d6517a7543355fd58524fccac6bbc19`；先前源码受审 candidate 为 `d57538ee244f8d487607c813aa282f791f8aab12`。13 文件逐字节相同。main push CI `38168419054 / attempt 1` 已独立核验 full/success，旧 PR 的 tested merge 不充当 main SHA。新 D2 candidate 则是本 spec 与专属收据的两份冻结文档 SHA256，按轮次存私有 `coord/d2-candidate-v*.json`，不借先前源码 candidate 身份。

现有 [A3 登记](a3-writer-admission.md)、[strict terminal](a3-commit-fencing.md)、[staged terminal](a3-staged-terminal.md)、[usage](r3-usage-strict-close-2026-10-12.md)及 [C2f source](c2f-collector-source-control.md)继续生效。下面所有新增名字和 schema 均为**待主控冻结的设计提案**，不是存在的 API、已生效许可或运行资格。D1 已冻结，不重选。D3 anchored 外部异步恢复另片冻结。

## 实际调用与首次副作用

| 真实路径 | 首效应与现有边界 | D2 必须补齐的位置 |
| --- | --- | --- |
| `openWriters.register` → `admit` | `entrySchema` 只接受 `generation-dispatch`；exact sqlite_master、application_id、user_version=1；关闭永久，facts append-only | 不把 source/startup 伪装成 dispatch；新版本显式拒绝未知登记 |
| `createSourceCollectTrace` → `claimSourceCollectTrace` → `collectSource` → `runJob` → `bindSourceCollectRootRun` | request/trace/lease 已先持久写；traceClaim 只有 traceId/ownerToken/fencingEpoch；rootRun 创建后绑定；cron/API/retry/probe 有不同 scopeKey | 维护准入必须先于 request/过期 lease 终结/claim/Run，不能到 raw 才补门 |
| collector Content 外层 transaction → `planRawArchive` → `writePlannedRawArchive` | upsert、pending raw_ref/reader_eligible=0、revision 同事务；文件 write/rename 和 finalize 在其后 | 每个固定同步提交及文件发布重验当前绑定；不能在现有业务事务中反向申请 registry 锁 |
| `getDb` → `openDb` → `openConnection` | mkdir → SQLite writable constructor → WAL pragma 在 provenance/deployment assertions 之前；bootstrap 非 strict 时可写 schema/orphan；strict 也已打开 writer | pre-open 固定消费者在 mkdir、constructor、hot-journal/WAL 恢复前准入；缺 schema 不能初始化后才称拒绝 |
| `getDb` 已开连接 → raw reconcile → ordinary report reconcile → direction seed → `_db` | raw 必须先于 report；初始化失败关闭且不发布 singleton；cached getDb 目前不重新登记 | cache 命中仍须验证代际与本地连接身份；拒绝不得返回旧 writer |
| `getEffectiveSources` 空库 | seedDefaults（topic/source）→ seedDefaultDirections → sources | 读名 API 有隐式写；empty-only 路径必须消费 seed permit |
| `npm run seed` → `evals/seed.ts` → `openLocalBootstrapDb` | 读配置前已 writable open/bootstrap；local migration/meta 初始化明确不准 production/strict；seedDefaults 后 close | 在全部首效应前登记独立 local-seed；不要借启动 recovery 权限执行显式迁移 |

当前没有共同 startup/source maintenance permit；三个旧 profile 是默认 cooperative、`close-fences-terminal`、`cooperative-close-then-revoke-terminal`；#475 另加 `close-fences-usage-v1`。这些 profile 与源 lease 本身均不证明全 writer 覆盖。

## 推荐：显式 v2 隔离 registry，保留 v1

比较过三个选择：只扩 TypeScript union/entrySchema 不解决初始化身份和固定消费；原地扩 v1 schema 会破坏 exact-schema 与旧 reader，并把旧拒绝行为偷偷改成接受；推荐新增**显式 v2 格式/入口**，在新、独占的隔离 root 初始化，沿用现有 A3 登记、永久 close、固定 factory 与同步提交模式。

1. v1 initializer/openWriters、marker、DDL、inspect、三 legacy profile 和 usage v1 的运行语义保持；旧 tests 必须逐项回归。v2 使用新的明确 schema/version/marker，不探测失败后降级 v1，不迁移/拷贝 live registry，不用 v1 worker/task 重建 v2 cap。v1 与 v2 不得同时控制同一 business target；root/target 绑定的排他与混用拒绝必须在 init/open 前验收。
2. v2 只接受固定白名单 `generation-dispatch`、`source-collect`、`startup`、`local-seed`、`raw-recovery`、`report-recovery`。每类固定 factory/值参数，拒绝任意 callback、driver 注入和通用 gate 框架。复用现有 dispatch 身份与既有固定 driver，不改变旧 profile 的结果意义；v2 组合适配不是旧 v1 自动接受新 schema。
3. 保留 worker/generation/task 的 append-only 事实，新增固定 operation/step 事实所需 exact DDL 是**S2 单独新增写域**。该 DDL 只属于隔离 registry；不能在 application `schema.ts` 自动补列。operation 保存入口、目标物理身份摘要、fresh invocation、固定 scope 和版本；step 保存固定阶段、输入摘要及观测终态。尝试许可及阶段事实不是跨库原子提交证明，业务 effect 与业务 COMMIT 仍是各自事实。
4. 尚不存在 v2 initializer、types、controller consumer 或 stage consumer。它们必须由 S 唯一 owner 串行实现，并与现有 drain/controller/ledger exact version consumers 给出精确适配 delta；未适配消费者拒绝 v2。新入口一律保持 isolated、writer_quiescence=false、production_permitted=false。不能只改 writers 就声称其他控制方已经关闭全部 writer。

初始 v2 明确选择**新 root 内独占目标**，不承诺 app-path 排他协议。business 固定为新 canonical root 内 `d2-business.sqlite`（提案名，主控冻结），raw/report固定为该 root 的受控子目录，禁止 caller 传任意 path/DB或晚改 DATA_DIR。初始化要求新 root 的受控目标无既存文件/handle/consumer，registry/marker与 business创建使用 exclusive，不允许复用现 v1 root、旧业务DB或live数据；根和父目录 dev/ino、无symlink、普通单链接文件及每次身份重查作为后续必验合同。新schema marker使用固定writer隔离命名并显式v2版本，使同root后来的v1 initializer O_EXCL拒绝、v1 reader exact marker/version拒绝；同root前有v1时v2 initializer同样拒绝，不存在两个registry并行锁域。

跨root只允许各自受控 descendants，v1 fixed terminal/usage现绑定自己root的 `fixture-business.sqlite`，不能绑定另root的 `d2-business.sqlite`；两个v2 root不能接受同一个canonical path/dev/ino，hardlink（nlink不为1）/父目录alias/移入替换拒绝。初始化前如存在已打开旧handle、普通unregistered writer/未知consumer关系，独占前置不成立，拒绝本目标；不能用仅“v2看不到v1 marker”签排他。此机制只约束已登记可信fixed consumers，不能阻止恶意same-UID直接SQL或未接线旧raw/report writer；那些仍阻断全writer资格。接实际application路径、旧target或现有v1handle需要共同target ownership及S0/contract/drain/controller等精确delta另冻另审，不属于本初始v2兼容承诺，W1初期也只能使用上述新隔离target。

正式 ADR/architecture 最小 delta：确认“v2 新隔离 root + v1 不原地升级”、固定入口白名单、shared close 的唯一 registry 与物理 target 排他、首效应/恢复新身份、跨库 unknown 和未覆盖消费者。原文由现有 owner 落账；本 spec 不替代该记录。若主控选择不同兼容方式，先检查受影响范围，不借旧 S1/U 双审补签。

## 身份与 capability

所有绑定冻结 primitive/数组的自有 descriptor，不接受 Proxy/accessor/动态 environment 重读；原 AbortSignal 保留对象 identity 和实时取消语义。fixed factory 的 freeze/Symbol 仅用于可信代码组合，不认证恶意 same-UID 进程。目标绑定包含 canonical root、ledger marker、root dev/ino、registry file dev/ino、business canonical path/dev/ino（打开后）、同一实际 DB handle；DATA_DIR 的 raw/report 路径另绑定，不能由晚改 env 换目标。

| 身份 | 取得与允许消费 | 不允许的替代 |
| --- | --- | --- |
| dispatch | 现六字段 dispatchId/traceId/ownerToken/claimEpoch/fencingEpoch/rootRunId，同连接重查实际 claim | source lease 冒充 dispatch claim；usage cap 变 raw permit |
| source-request prelude | fresh registry task，冻结 sourceId、triggerKind、retry provenance/period scope；固定同步 request+claim 消费 | caller 提供 callback；在登记前调用 createSourceCollectTrace（其中也会终结 stale lease） |
| bound source run | prelude committed 后取得真实 SourceCollectClaim；固定同步创建 root Run 与不可替换绑定后，冻结 traceId/sourceId/scopeKey/activeKey/ownerToken/fencingEpoch/rootRunId | 只有三字段 claim 就授权任意 source/run；replayed request 生成新工作 cap |
| startup | 每次进程启动新的 worker/generation/task/invocation；固定 path/config/version 与 initialize-existing 步骤 | PID/时间戳或缓存 DB 作为所有权；继承旧 dispatch/source task |
| local-seed | fresh local-only invocation，静态 config 摘要与固定 seed 步骤；production/strict 禁止 | startup permit 隐式授权 migration runner；动态默认 config 改写旧冻结计划 |
| recovery | 新登记 recovery invocation + 精确 effectId/kind/idempotency/manifest/input binding + 目标身份；每 effect 新 cap | 复活旧 cap/task/rootRun、SQL replay 或 inspect/clone 签 permit；把旧 unknown 擦掉 |

source 根 Run 还没有时使用窄 prelude，不能伪造 rootRunId 占位值。prelude 只授权精确 create-request/claim 和 root Run 的固定同步步骤，**不授权原始正文/文件发布**；bind 成功后另有只属于该对象的阶段 cap。现 `runJob` 的 root Run 创建需要 W2/W3 后续固定消费接线，S2 不复制 jobs 或向异步 runJob 传通用事务 callback。replayed/conflict 没有新工作权限。

cap 位于所属 factory 的 WeakMap，只能原对象消费；原始 task 是持久事实，单靠其值无法重建权限。每阶段单次消费，拒绝、busy、取消、unknown 都消耗对应尝试；next-stage 仅在确认前阶段 committed 且仍 owned 时发放。finish/close/重启不复活任何 cap。原完成/unknown facts 保留，新 recovery 产生新事实链接原 effect，不覆盖历史失败。

## pre-open、锁序与 COMMIT

pre-open 不能做“检查后释放 registry 再 openConnection”：同样存在 close 竞争窗口。固定 open 消费者在 registry 写锁内完成 filesystem preflight、mkdir/受控创建、constructor/SQLite recovery、必要同步配置及身份核验；不持业务 SQLite 写事务跨 await。已有 business write txn 的调用直接拒绝反向获取 registry；锁序固定 registry → stage（仅显式适用的 profile）→ business，所有 close/消费使用同一个 registry 连接/协议。

现有目标按 fileMustExist、不跟随 symlink、owner/mode/link/sidecar/root identity 等真实 preflight 后打开；新 local DB 需显式 creation mode 与已核 parent 身份、exclusive 创建和打开后的 inode 绑定，拒绝碰撞或替换。不得把“还不存在 inode”伪造为已绑定；创建失败残留记录为 incomplete，不能删除后无痕重试。v2 的隔离 fixture 与实际应用路径模式是不同资格，未完成 app-path 消费不能默认允许 `.data/insight.db`。

打开许可只覆盖 fixed open 步骤，不能作为返回 DB 后所有 SQL 的无限许可。后续 schema assertion、bootstrap/orphan、raw recovery、ordinary report recovery、direction seed 分别固定同步消费并重查维护 open/原 generation/DB 身份；strict 已有库必须在读取/写业务事实前确认 provenance 与 deployment。local bootstrap 的明确 migration/meta 是另步骤/另写窗，不能纳入 initialize-existing。业务初始化各步不承诺全局原子：第 n 步失败保留 1..n-1 已提交事实，关闭未发布 DB，`_db` 只在全部要求满足后发布。

seed 固定保持现 `seedDefaults` 逐条提交行为，不改成整批原子。冻结config与原topic→source顺序，每个候选insert是独立固定step：同锁窗口读真实已有行，已存在则 no-op并记录阶段完成（不冒称业务COMMIT）；需要insert则固定SQL事务返回该条COMMIT三态。W必须拆出值参数窄消费，不能直接调用整个legacy seedDefaults后只给一个三态。第 k 条失败返回明确 committed-prefix、各条no-op与第k条三态，停止其余source及directions；第一条已提交不能归进第k条rollback。seedDefaultDirections现为一个事务，保持该边界，不能套用逐行提交。CLI与getEffectiveSources都不得catch后重走legacy loop。

recovery 固定区分三类：①所有effect遍历完成、损坏/missing/review冲突已通过合法permit把对应effect诊断为unknown且诊断SQL确定committed，返回 completed-with-diagnostics（含committed/diagnosed计数），保持当前允许继续raw→report→seed并发布_db的可用性语义；该诊断unknown不等于COMMIT unknown，不放开reader白名单。②维护closed/代际/身份拒绝返回 admission-denied；③业务COMMIT unknown或已committed但registry ACK不确定返回 interrupted-unknown。②③立即停止后续effect/下一recovery/seed，关闭未发布连接、不发布_db。诊断SQL自身出现②③也按中断处理，不能统计为普通failed后继续。

future repo内部catch必须传递②③的结构化结果，不得调用legacy markUnknown/failed旁路再次写；首因保留。旧 `{committed,failed}` 只有①的业务计数，不足以代表上述新合同；W/A/P需实际固定consumer结果后才能组合，不能单纯把所有failed>0都拒绝或全当完成。cache首次发布后的每次取用仍重验许可，关闭竞争不能被既有singleton遮蔽。

auth readonly属于另一真实路径：`auth-reader.ts`直接openReadonlyDb，readonly/fileMustExist/query_only以及live WAL协调保留 [D1](d1-database-lifecycle.md)例外，不改auth行为，不纳入当前W1写域；W1 health/application-read验收仅指实际调用getDb的入口。只读constructor的SQLite sidecar协调不声称零FS副作用，也不因本提案签全reader维护覆盖。新增readonly维护政策须另明确scope与owner。

| 实际边界 | 返回事实 | 后续动作 |
| --- | --- | --- |
| guard/BEGIN/写入前拒绝，且可确定没有业务提交 | not_committed | 保留首因，不自动 fallback 或绕回旧初始化；future 新 task 须诊断并重新准入 |
| 同步 business COMMIT 已正常返回，之后 registry ACK/finish 失败 | committed + coordination unknown | 已提交不称 rollback；停止后续阶段，保留对应 task/effect 与数据库事实 |
| COMMIT 抛错/进程中断，无法证明是否生效 | unknown | 不退款、不自动重发；新 fresh recovery 根据真实行/manifest/hash诊断 |
| open/mkdir/rename 完成，之后 SQL 或身份核失败 | 已发生 filesystem effect + 对应 SQL 三态 | open/file effect 不能写成零效应或跨库 rollback；不能伪称所有阶段撤销 |

每个固定文件发布的权限在 rename 和 reader eligibility/finalize 前分别重查。raw 现同步 write/rename 可在固定同步消费者的保护窗口执行，业务 txn 只包 SQL，FS 不变成 SQLite rollback。close 后旧 owner 不再 rename/finalize/unknown SQL 写；已提交 intent/文件保留，fresh recovery 才能继续诊断。文件 write 的耗时/系统调用资格须真实验收，不在本设计证明硬时限。

取消/lease loss 优先保持原 C2a/C2b/C2f 首因与 sticky failure；不把真实已开始调用/unknown/partial 成本改零。heartbeat 也是 SQL 写，必须由登记的固定 consumer 单独消费，不用后台 interval 绕维护 close。重启的新 initialize/recovery 不默认清 hold/closed、清旧 lease、重置 epoch或抹失败；仅在新 root/新明确合法登记与实际恢复条件满足时推进。

## 最小后续写域与串行顺序

S2a（唯一 S）：新 registry v2/明确 initializer+types+版本拒绝+固定 pre-open/登记消费者，及兼容回归；必须先处理 controller/drain/ledger 的版本依赖和 root/target 排他。现 shared 三文件已限定归本线 S1/U，但扩大到 S2 与相邻 consumer 仍由主控逐文件冻结。

S2b（同 S 串行）：固定 source prelude/binding、raw/recovery 值接口及三态；不接管 collector/jobs/raw repo。W1（唯一 W）先 open/cache/startup，再 local-seed/implicit config seed；只有 A/P 对应固定 recovery 合同稳定后组合 raw→report，未完成 recovery 时拒绝发布 `_db`，不能跳过步骤后宣称 startup 完成。W2/W3 后续才能组合 source request/claim/Run 与 heartbeat/collector。A/P 可以各自独占 repo 边界实现，shared 与 W 源码始终串行。同 W 从 W1 到 W4 接线，不并行分派同一文件。

D3 仅保留边界：`reconcileAnchoredReportEffects` 是 async，可能条件外部写后再验证并提交；不能持 registry/SQLite lock 跨 await，不能把 before-check 视为全阶段 fence，也不能复用本同步 ordinary recovery 许可。A/P/D3 新方案另审，不启动 reports/report-gen 大拆分。

## 真实路径反例验收矩阵（后续实现必须执行，本片未执行）

| 编号 | 实际入口/反例 | 必须观察的事实 |
| --- | --- | --- |
| D2-01 | v1 initializer/open/三个 legacy profile/usage profile；未知entry、混marker、clone；v1-first/v2-later、v2-first/v1-later、既有handle、双v2 root alias | 原接受/拒绝与类型保持；新入口不能走v1；同root O_EXCL/version拒绝，跨root受控path/dev/ino/no-link拒绝；已有/未知consumer前置不成立不启动business消费，不签全机排他 |
| D2-02 | 新子进程第一 openConnection/openDb/getDb；strict/non-strict、热journal/WAL、closed registry | 拒绝先于 mkdir/constructor/sidecar恢复/DDL/orphan/reconcile/seed；不能只 spy getDb |
| D2-03 | 空路径合法创建/父目录替换/symlink/碰撞/close 与 open 两进程竞争 | 精确 inode/parent绑定；固定锁窗口胜败；失败残留与已发生 effect 保留 |
| D2-04 | cached getDb、实际走getDb的health/application-read、close后缓存取用、中段失败；auth direct readonly另保留D1例外 | 不返回失权旧DB；failed connection不发布_db；先前committed不改rollback；不把readonly例外签成W1维护覆盖 |
| D2-05 | 真实 createSourceCollectTrace/claim/runJob/bindRoot/collector，cron/API/retry/probe及 replay/conflict | registry准入在所有 request/过期lease/claim/Run SQL前；root/source/scope不匹配拒绝，0 raw发布 |
| D2-06 | source expired/替换owner、heartbeat竞争、Run/root替换；外层Content txn调用adapter | 正向同连接原claim；错身份/已有事务逆序拒绝；heartbeat不绕close，无跨await锁 |
| D2-07 | 真实empty getEffectiveSources/directions/合成seed CLI；第二topic/source insert故障、先前no-op与committed前缀 | 每条实际SQL固定消费；失败保留committed-prefix/当前三态，后续sources/directions不继续，不开legacy旁路；directions仍单事务；local migration明示，strict/production 0首效应 |
| D2-08 | raw planned/attempted/unknown final或staged存在/缺失/hash冲突；新 recovery身份 | intent/bytes/idempotency/raw_ref/revision保持；旧cap不恢复；失权0rename/0reader_eligible |
| D2-09 | COMMIT故障、ACK故障、SIGKILL、重启/clone、未知schema、取消迟到 | 业务三态和FS事实分开；committed不改rollback；unknown不自动重复/退款/fallback |
| D2-10 | startup真实raw→ordinary报告；真实repo failed>0诊断、close/ACK/COMMITunknown被catch；anchored未接/未移交DDL | confirmed diagnostic unknown且completed允许继续发布（白名单不变）；admission-denied/interrupted-unknown不继续effect/report/seed、不发布_db，catch无failure写旁路；skipped未接不签完成，生产许可false |

## 给后续实现 Agent 的限定提示词

S2a Agent：只在主控冻结本 D2 推荐选项、正式 ADR delta 与精确写窗后实施新 v2 隔离 registry，复用 A3 协议。保持 v1 源字节或解释必要兼容 delta，拒绝混 root/target/未知版本及 fallback。实现固定 pre-open/登记步骤，不引入 callback/gate 平台，不进入 jobs/collector/raw/report/startup repo。提交 source freeze、实际新格式/物理身份/COMMIT与旧 profile反例，新增两位独立非作者最多两轮；不引用旧 S1/U/R2评审批准新范围。

W1 Agent：你是 W1→W4 唯一共享调用方 writer；先拿逐文件移交及 S2/A/P 固定版本。只接 open/cache/startup、显式local-seed与空库implicit seed。首效应前登记、每步同步fixed消费、raw→report顺序、失败不发布_db；已有提交保真。seed migration超出冻结写域即回主控；不先接 HTTP/jobs或anchored async，不以跳 recovery取得绿。用真实独立子进程与合成隔离数据执行 D2-02/03/04/07/10。

必须由主控完成：选项冻结与 ADR/architecture 原owner落账；S2/依赖consumer/W1逐文件接管及当前活跃写占用协调；app-path与隔离fixture资格区分；D3单独设计。尚缺上述前置的实现保持阻断，但本专属设计、事实核对和新独审可以继续。
