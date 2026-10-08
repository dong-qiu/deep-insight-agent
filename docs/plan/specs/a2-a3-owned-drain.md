# A2/A3 owned-existing operation：hold-first 隔离接线最小方案

日期2026-10-08，PORT3150。状态仅方案；没有新Git源、DB/运行配置、fixture、测试执行、Eval、PR或CI签章。私有独立目录0700、材料0600。协调者授权准备此完整方案，尚需两位非作者独立方案审查与协调者最终冻结后才实施。SSM九路径和组合两路径保持冻结，不移交写入。

## 1. 可行性与现有真实代码事实

可在原用户授权的隔离工程范围交付一个显式 **hold-first** consumer；无需改变旧S0/S1/S2 API、DDL、历史business schema、policy、安全批准边界或模型语义。新增只减少该隔离operation的推进资格，最终不授任何执行许可。它不是部署/备份/恢复实现，也不关闭全writer工程。

实码冻结基线 `4433689f70588dc7a1143037dc9bbb29516eac83` / tree `bec6b0cfac324d8c0148a840205e494462ca6f47`。30份不可变Git字节在 `source-bindings-v1.json`；实施时必须重新fetch/sync协调者指定且精确main CI已验的基线，原接口源若改变先停止重核，不把此旧输入签新head。SSM 1f4声明修复与组合64内容均不改，本方案不补签其未来CI。

- `a2-consumer.mjs:227–275` 对完整token/binding/marker及before-writer-stop OPEN状态做真实只读消费。integrated=true不认证A2 receipt、不授许可；当前既有入口不调用hold/close/drain。
- `drain.mjs:138–141` 对任何事前已见的同operation只返回 `writer_drain_replay` / token null / polls0。不能从replay取得当前revision或让旧continuation继续。原S2语义必须保持。
- `ledger.mjs:141–168` 每次transaction做无SQL物理预检、BEGIN IMMEDIATE、完整audit/状态验证；strict owned比较全部identity和当前revision。`inspect`也自起事务，返回即释放。inspect结果不是持锁CAS，更不能另持S0连接锁再调inspect/hold制造self-busy。
- `ledger.mjs:246–252` 的 `hold(token,reason)` 是现API中适合pre_submit、无需新授权/提交/释放的strict CAS；确实持久held，第一次active→held+新reason使revision增加。现API没有“保持ACTIVE但只预留drain入口”的固定方法。
- `beginSubmit`只接受active pre_submit，`complete`也不能清held；authorize/release/takeover是独立签名协议，本新入口绝不调用。acquire既有对象会返回当前token，绝不能用它刷新或重新取得此operation。

因此本方案明确选“先持久unknown hold，再close，再有限观察，最后追加首原因hold”。如果未来要求直到drain结束仍ACTIVE，或要求S0当前owner与registry close跨库原子，原API不足；须另固定S0共享接口工程方案并重新审边界，不假装此片实现。当前hold-first不改变历史许可，不需要请求真实生产/模型预算。

## 2. 六NEW路径、归属、唯一入口

未来仅Agent A写以下六个NEW路径，协调者先核已知Session归属；目前基线无这些Git对象/物理文件。路径缺失不等于旧owner释放。

1. `ops/maintenance/owned-drain.mjs`：唯一业务组合导出 `consumeOwnedDrainIsolated`，内部固定调用原consumer/ledger/writers/lease源。
2. `ops/maintenance/owned-drain.d.mts`：readonly typed输入输出，复用原ConsumerResult/ConsumerBlocked/DrainToken/DrainLeaseSample；ambient const若有必须declare并跑wholelint。
3. `ops/maintenance/owned-drain.node-test.mjs`：真实native/CLI/并发/切点永久保护。
4. `ops/maintenance/owned-drain-cli.mjs`：唯一真实本地CLI消费入口，无transport/业务执行器。
5. `docs/plan/specs/a2-a3-owned-drain.md`：最终冻结本方案。
6. `docs/verify/a2-a3-owned-drain-2026-10-08.md`：实现/反例/原始证据绑定收据。

旧ledger/contract/writers/drain/consumer、旧tests/specs、staged/runtime/core、SSM、policy/workflow/allowlist和主台账全部只读。不通过重构共享模块扩大窗口；实现若不能在六NEW路径完成须报告具体差异。后续独立WT建议 `insight-agent-a2-owned-drain-20261008`、分支 `feat/a2-owned-operation-drain-20261008`，端口3150。只有实施获准后按AGENTS复制.env.local600并改独立DB/DATA；当前只读调查不复制配置、不开server。

## 3. 新版本、固定输入及输出事实

版本 `a2-a3-owned-drain-v1`，唯一profile `held-before-cooperative-drain`。本profile只支持固定isolated controller目标：region=`isolated`、instance=`fixture-controller-node`、volume=`fixture-controller-volume`、serviceSet=`[fixture-controller]`、executionIdentity=`fixture-controller-v1`、dataPath精确canonical root。原S0可以接受这组配置；新入口不改已有marker或target，不扩多个profile。

库签名拟冻结：

`consumeOwnedDrainIsolated({root, artifactRoot, inputJson, deadlineAt, pollEveryMs, signal?}) -> Promise<OwnedDrainResult>`

- inputJson是UTF8字节≤65536的普通JSON字符串，由模块私有JSON.parse生成隔离对象；不接受外部object/driver/leaseSource/callback/transport，避免caller在consumer读完后改token。允许合法JSON空白/键顺序，不要求raw JSON先canonical。
- wire严格只有 `{schema:'a2-a3-owned-drain-v1', consumer:<原ConsumerInput>}` 两键。consumer对象仍为原 `schema_version:a2-a3-isolated-consumer-v1`，其完整原schema由真实 `consumeA2Isolated`解析，不从wire制造观测。
- 必须 `consumer.a2.phase='before-writer-stop'`。完整token用原tokenSchema解析；binding用原bindingSchema。canonical/same比较 `tokenFor(actualOp)` 和 `bindingFor(actualOp)`，保留operationId/owner/fence/revision/全部target/executionIdentity/commandId/submitToken/requestHash，不drop字段、不coerce epoch、不改大小写或serviceSet顺序。token/binding本来没有kind；kind从实际op取并核原requestSchema，不能从wire新增kind冒充原合同。
- 原context的operation_id/maintenance_holder/operator、四数据hash、完整7字段release/rollback身份和全部role descriptor/claim必须由真实原consumer接受。operator只是声明，不认证实名角色。447公共compose字节/固定policy身份不证明新代码已在该镜像运行。
- deadlineAt必填safe integer，开始时未来窗口>0且≤60000ms；pollEveryMs 1–1000正整数，无全系统默认deadline。signal只能真实AbortSignal；没有任意reason或费用/模型设置。

输出新独立 `schema:'a2-a3-owned-drain-result-v1'` / 固定profile，最小字段：原实际 `consumer:ConsumerResult|null`、固定reason、token或null、sample或null、polls、entry_hold和final_hold各 `not_attempted|committed|unknown`、admission `open|closed|unknown`，以及原ConsumerBlocked全false/null/unknown事实。entry/final committed仅实际strict hold返回后才记；SQLite COMMIT抛错而无法判定之前/之后时是unknown，绝不自动inspect刷新/重试。token只可来自本次最后一次已确认strict hold；prereq失败/replay/重启/owner冲突/COMMIT unknown/cleanup异常均null，不暴露current token给旧continuation。

永久 `observation_atomic=false`、`controller_uniqueness=unknown`、`all_writer_coverage=false`、`commands_executed=false`、全部maintenance/production许可false、safe_rollback=null、process_termination unknown、phase_verified false。旧consumer成功只代表初始只读消费时点；不能重标为停止阶段已验证或最终全局snapshot。已有ConsumerInput/Result及旧DrainObservation形状完全不改。

非法outer/不可信token/profile抛固定sanitized错误、CLI非零/stdout空，无hold和伪造result；实际consumer返回失败可输出新blocked结果并保原failure，token null，不做控制副作用。owner/fence/revision冲突始终主错误，不被取消或采样catch降级。

## 4. 实际固定调用顺序与两次strict hold

1. 完整验证外层JSON、固定target/profile、deadline/poll/signal和全部物理/容量前置；deadline包括先前已消耗时间，不重置。预取消不hold/close。必须先真实 `consumeA2Isolated({root,artifactRoot,input:privateWire.consumer,now:Date.now()})` 得到integrated=true；即便其not-run/缺生产声明也只允许本地保守停止，不授操作许可。
2. 新私有容量/preflight后开真实 `openLedger` / `openWriters` 和本入口自建 `openDrainLeaseSource(root, root/fixture-business.sqlite)`；source constructor已经会真实sample，须在其前容量门。核完整同root marker、真实current token/binding、active operation、pre_submit+active、command/submit/hash全部null、admission OPEN。released/submitted/running/cancel/terminal/manual_takeover/held，包括同op已见owned_drain_started，一律拒接续，不能新acquire或从inspect恢复。新输入不是强身份凭证。
3. 注册首取消观察器，并同步读取已经aborted的signal以保留原S2映射的首原因；完成所有容量/物理重核及setup后，在首次真实 `ledger.hold(originalIngressToken,'owned_drain_started')` CAS调用前紧邻执行最终同步checkpoint，中间不再安排其他setup或await。先保已有firstCancellation，再直接核signal.aborted及原绝对墙钟/入站剩余单调窗口的最先remaining；timer callback尚queued也必须能发现expiry。setup末端abort或remaining≤0且尚无confirmed entry时立即blocked：保首原因，无先因的expiry为task_deadline_exceeded，token/sample null、entry_hold/final_hold均not_attempted、initialhold/close零、无新audit；不得为补记录而hold。须保护setup末端abort/expiry各零副作用及未取消/充足窗口正控。这一checkpoint不承诺中断后续同步SQLite调用。通过才执行一次初hold；它是显式起始unknown记录，非取消首因、非ready；仅实际COMMIT返回确认才是本次strict CAS赢得点。完整返回token仅存私有闭包，不inspect刷新revision。active→held+新reason必发生持久变化；同原ingress并发输家strict冲突且不得close/hold/retry/拿赢家token。若COMMIT结果未知立即blocked，token null、不close、不尝试第二次hold，可能已held的原账本保留。initialhold已confirmed之后才发生的取消/期限，仍按下述exact-owned守卫与首原因finalhold收尾，不倒签为not_attempted。
4. 在后续任何控制操作前重新核当前完整自有token和held pre_submit、相同binding/起始记录；调用一次实际 `writers.closeAdmission()`。close不重开、不删除任务。成功返回后再采样核registry closed；未知/失败只允许在仍exact-owned时最终strict记录 `owned_drain_close_failed`（已观察取消则保首取消reason），若ownership已丢失不写任何hold。缺证/close未知都不继续观察，不借其他token补救。
5. 有限等待用墙钟绝对deadline与启动剩余窗口单调上限中的最先到者；timer/listener清理。每poll先无SQL物理/容量门、真实S0 exact-owned和registry完整marker/closed，随后真实source.sample完整dispatch+全部active lease inventory，不JOIN遗漏orphan/其他entry。仅有未退出登记task时等待；空task/已完成也 `writer_drain_coverage_unknown`，永不quiet。queued保留不领取，claimedCurrent/claimedExpired/非法epochs/expiry/owner/缺lease/unknownchild不删除、抢占或强release。
6. 超时reason `writer_drain_timeout`；首取消按原S2有限映射固定为cancelled/task_deadline_exceeded/generation_fence_lost或writer_drain_cancelled。起始owned_drain_started属于持久未知阶段记录，不占用firstCancellation；最终cancel reason与result reason相同。采样失败立即停等待，sample=null，不复用last success当当前；已有首取消优先，否则writer_drain_observation_failed。旧owner/fence/revision最终守卫在观察catch之外。
7. 最终重核exact-owned held token、marker/binding、固定业务物理身份；仅一次真实 `ledger.hold(privateToken,finalReason)`，追加到原failures不清历史/改顺序，形成held的新confirmed token。无observe/cancel/submit/authorize/complete/release/acquire/续租/reopen。COMMIT未知不重试、不自动拿currenttoken；cleanup不得掩盖owner主因或把已知阶段事实变为成功，不能制造新的continuation。

S0 hold写持久未知门仅管该operation推进，不停止业务writer；registry close仅管已消费的S1/core准入。新入口不更改S3a closed语义、不替代S3b stage close/bind/revoke、不保证迟到业务提交拒写。未覆盖C3/usage/raw/report/API/cron仍工程待办。未知lease或unknownchild是观察阻断，不是释放资格。

## 5. partial-stop、合法并发和crash事实

两库没有共同事务，不持SQLite长锁跨await。initial hold成功后，到registry close/下次owner检查之间，合法外部签名release/takeover可能发生。旧controller仍可能保守持久close准入后才发现owner/revision失效；本片明确允许这类partial-stop，不声称“失效owner零close”或原子维护统一门。随后只拒继续，绝不能foreignhold、reopen、refresh、newop、token grant或据close成功授许可。此停止副作用是本用户已授权隔离工程的保守方向，不扩大生产权限；若未来要求消除该窗口，另冻结共享固定门，不能悄改历史S0。

原S0签名release/takeover可由独立负控actor在新合成fixture中调用来制造该合法race；入口代码从不调用。负控随机测试key/停止声明只表示原S0 fixture契约认可，不是人类批准/真实进程证明；不能借此继续生产或把新op作为正向绕行。

- initial hold前kill：原active可能仍在，admission OPEN；新旧token只按真实恢复事实分类，不自行补跑。
- initial COMMIT前/后kill：前可回滚active，后held/owned_drain_started持久但admission仍可能OPEN。无法证停止，readyfalse；旧continuation不自动恢复。
- close COMMIT前/后kill：可能held+OPEN或held+CLOSED；恢复只能读原事实，不强签close或重发控制动作。
- final hold COMMIT前/后kill：已有起始hold及closed保持；final reason可能未提交或持久，必须读实际audit分开，不凭planned完成签committed。
- 初/末hold抛错都不统一称rolled back，保unknown；晚completion/taskfinish/lease expiry不能取消任何hold或重开。已COMMIT entry、任何held input，以及当前调用已知初次COMMIT结果unknown时，均不得自动续接或重发旧continuation，需另独立工程恢复方案；本文输出规则和矩阵中‘重启拒续’均限于这些事实，不声称识别任意重启。首次CAS前kill或INSERT已执行但未COMMIT而回滚至active/OPEN时，旧账本无持久entry nonce，无法区分首次合法调用与曾有未提交尝试；恢复只分类实际active/OPEN/audit，controller_uniqueness始终unknown，不自动补跑、不新增tombstone/nonce协议。新的独立调用仍只能满足原完整fresh ingress/CAS条件，不能据此认证其首次来源或唯一控制器。R2原路径实证仅证明此旧S0限制：precas-child在真实hold INSERT events后COMMIT前SIGKILL；恢复前main8192 SHAffd4c588a9a503ed058a5ce9f1747d50068c5a71a5bf06c2a5d25934d0f719e6、journal4616 SHAe64ae4ec7851c8e8a8bbb80a7bc0142bf6e13f2ab1b8d0e81a088fc2fcded180保全且WAL/SHM absent；原openLedger恢复后仍active/revision1/failures[]、旧ingress exact-current。这不是新owned-drain运行或通过证据，原review/probe/child/log/observation/inventory均只读引用，不新probe或回填原索引。

## 6. 物理准入、artifact与读容量

固定root/artifactRoot是不同canonical绝对700/currentuid目录；database精确同root三个固定文件、普通600/currentuid/nlink1/无symlink、固定dev/ino、完整S0/S1 marker绑定。所有新connection/open/pragma/BEGIN和原API调用前先纯FS检查main/journal/WAL/SHM及marker，缓存handle每次同样核；unsafe journal不能先被SQLite恢复/删除。ledger/writers仅允许DELETE journal，不接受它们WAL/SHM；业务readonly允许原isolated owned WAL协调但不复制live sidecar、不repair或升级写开恢复。

原artifact8必需+2可缺省角色及上限 沿用原consumer：schema/data各1MiB、migrations256KiB、configuration/compose/每receipt64KiB、整批4MiB；目录固定basename，fd O_NOFOLLOW/fstat/inode/nlink/600、读取中cap+1增长检测、hash/size/canonical claim/fullbinding/日期及optional absence末检由真实原consumer执行，不从descriptor自签通过。原TEXT migration完整版本保留，不能trim/coerce；缺production/approval保blockers，假声明不认证。新入口不重新解释A2评测规则。

新私有metadata gate使用固定常量SQL，不接受caller表/列：完整physical门后readonly低投影COUNT/LIMIT+typeof/length/EXISTS/SUM先于完整materialize。沿原consumer门：ledger/writers main各16MiB，business64MiB，对应sidecar相同上限，markers16KiB；S0/S1 SQL对象≤32、单SQL64KiB/总SQL256KiB，ledger events≤512、单snapshot64KiB/总4MiB、safe seq与hash字段≤64bytes；S1 identity/admission各1行、workers/tasks/completions各1024及原固定列UTF8/null/integer限额。business schema/dispatch/lease/migration集合各≤1024、selected TEXT≤512bytes，numeric/null按原字段；原schema/data JSON预算各1MiB、migrations256KiB。保留全部lease分类和独立claim/fencing epochs，超限整次拒绝、不仅截前1024算通过。

entry还须为两次预期hold预留原capacity：用已核当前state的canonical固定投影计算新增initial/final reason与revision后的最大snapshot bytes，以及新增两events所需总snapshot预算（仍≤64KiB/4MiB/512）；不足在initial hold前阻断，不改变旧S0容量合同。各scalar门与新完整读取在同一new readonly snapshot；每次旧inspect/sample前重核已观察容量与物理身份，增长/替换/超限直接blocked。

**继承限制明确保留**：这些门与旧S0/S1/S2读在不同连接/快照；其原API仍全audit/全rows materialize。gate之后同uid并发可能先让原reader大分配/延迟，已观察变化最终被拒不等于防ABA/全局内存原子界。SQLite内部解析/页读及单个同步SQL耗时也不受此门硬实时中断。≤60s只界等待窗口与CLI可取消输入，不承诺任意DB大小下整个同步函数硬60s完成。若验收必须绝对约束旧reader allocation，先停并提出固定bounded-reader接口工程，不包装此门解决。

## 7. 真实CLI与stdin有限I/O

`node ops/maintenance/owned-drain-cli.mjs ROOT ARTIFACT_ROOT DEADLINE_AT POLL_EVERY_MS`，严格四args、两个数字只接受safe integer十进制，时间/poll在读stdin前验证；没有unlock/force/ready/recover/production/AWS参数或任意命令/callback。不读取.env、源凭据或ready环境变量。

实际streaming stdin累计UTF8原bytes≤65536，超限chunk到来即停止，不先readFile无限读，不等EOF才检查；fatal UTF8/JSON解析，严格外层键。fresh库调用的past/noninteger或其他非法deadline仍是invalid_drain_deadline且零I/O，不能借signal改成合法。CLI已在入站接受合法future deadline后，absolute deadline+原CLI入站monotonic cap覆盖整个stdin/EOF/解码/handoff：未EOF到限立即destroy/pause自己的stdin、fixed控制错误非零/stdout空；EOF/解码及全部handoff准备完成后、调用库前，必须同步保已有first control cause，再直接核signal与原abs/mono remaining。原窗口此时耗尽（包括timer callback仍queued）或已取消就不调用库：stdout空、hold/close零、无伪result/token，已有首原因保留，无先因expiry固定task_deadline_exceeded，不能错误归入fresh invalid_drain_deadline。必需负控是合法input不EOF到限、合法EOF却在解码/handoff耗尽含queued timer、fresh非法库deadline，以及先SIGINT/SIGTERM后deadline仍保首原因；这些均为原矩阵验收具体化，当前尚未执行。合法handoff后原timer/signal持续至step及cleanup结束，不重置timer/单调起点、不替换或补新deadline给库；墙钟回拨不延长。SIGINT/SIGTERM只取消此localcontroller，不证明任何writer/远端终止、不kill其他work/模型；若获初hold仍按exact-owned规则保首因finalheld，不执行真实stop。

合法blocked结构可stdout minimal JSON且始终exit1；非法outer/owner冲突没有result时stdout空、固定stderr非零。不得输出stdin原文、密钥、原SQLite异常/stack/巨大wire。stdout/cleanup错误不二次hold或改为成功。测试子进程有自身额外有限watchdog仅防fixture挂起，不放宽协议deadline或将杀测试进程算真实writer静默。

## 8. 必需真实保护与验收矩阵（尚未执行）

| 真实路径/切点 | 预期事实 |
| --- | --- |
| own fixedprofile真实openDb/provenance/createRequest、原8role字节、真实S0acquire OPEN → actualconsumer → newentry initialstrict hold → registryclose → finite sample → finalstrict hold；actualCLI同路径 | 同operation保留、fence不增、不acquire；audit两次实际hold；allready/permissionsfalse、safeRollbacknull、terminationunknown；原业务dispatch/lease/run/event不变。 |
| 原observeDrain在entry前/后同op | 原replay/null/polls0、不改变原语义；新positive不能借原replay token。 |
| 全token/target/executor/context/hash/nullable binding逐字段错配、fakephase/ready/profile/extra输入 | initialhold/close零调用、无协议/业务写；原真实consumer失败分列。 |
| 已HELD(同起始reason亦然)/released/submitted/unknown/terminal/manualtakeover、旧fence/revision、控制器重启 | 不重新close、resume、newop、获取currenttoken或追加hold；输出NULL authority或固定throw。 |
| actual cached native inspect-COMMIT后→initial hold前双进程同ingress；一方外部推进revision | winner仅一次初hold+控制路径，loser严格拒且不close/foreignhold/刷新；audit无重复mutation，不从返回current猜己赢。 |
| initial hold COMMIT后→close前合法fixture签名takeover/release→新foreignop | 可观察保守partial-stop CLOSED；最终owner优先拒，foreign audit/failures不增加、不reopen/token grant。签名负控不记人工授权。 |
| registered任务未完/本地全部done/空任务/未知subwork/未登记writer、真实queued/claimedCurrent/claimedExpired、source_collect orphan、非法owner/expiry/独立epochs | 各完整真实inventory保留unknown/阻断，无lease release/抢claim/删任务；late finish不解hold；claim/fence不误设相等。 |
| 先abort(cancelled)，后真实源/DB采样失败；无abort采样失败 | 首取消reason同时主返回与final hold；sample null；无先因generic observation_failed。 |
| 取消+最终旧owner/revision/foreignop，或finalhold cached native COMMIT前CAS race | owner冲突主因不被catch/cleanup吞，不写foreignhold、currenttoken不返给旧continuation。 |
| 相邻deadline/完成、墙钟前跳回拨、输入耗时到库调用、timer/listener清理 | 最早界停止，无deadline重置/无限重试/全系统默认budget，仍unknown。 |
| current/native unsafe hot journal在new open或cached BEGIN前出现、path/marker/inode/hardlink替换 | 在任何SQLite recovery前拒并保存原main/journal/WAL/SHM bytes；private cached Statement.run计数辅助证明拒前SQL零，完整actualmodule结果为主。 |
| 真实artifact/stdin FD成长cap+1、非UTF8、optional缺省角色late出现、row/单TEXT/SQL/audit/预测hold容量超限 | initialhold前已见错误无副作用；后续发现增长立即unknown，不签旧成功/sample、不repair或truncate；容量门不签旧reader跨连接原子。 |
| SIGKILL显切initialhold INSERT后COMMIT前/COMMIT返回后、close COMMIT前/后、finalhold INSERT后COMMIT前/返回后 | 原fullinventory BEFORE任何恢复；真实audit/admission/state分类与planned/committed/unknown不混；重启不能续原动作。 |
| 初hold/close/finalhold真实busy/native COMMIT失败及cleanup错误 | unknown/confirmed事实准确，无自动retry/refresh/fallbackhold、永不ready；现有hold/closed保留。 |
| actualCLI stdin超65536且管道不EOF、合法小input不EOF到deadline、extraargs/环境解锁/信号取消、stdout故障 | 有界读/自行关闭入站、fixed非零、原文不泄露，未可信ingress不hold；取消ACK与CLI结束不证明任务终止。 |

测试必须真实better-sqlite3、真实原consumer/S0/S1/leaseSQL、own fixture真实claim/expiry有限故障。cached native/prototype/子进程只私有切点，不新增公共faultCLI、callback/seam或替身ControllerResult。真实状态负控先诊断，module未存在的import失败只准备保护、不称行为red。当前方案没有新测试通过结论。

## 9. 证据、检查、交付条件

私有root先非覆盖archive最终六source/spec/receipt原字节；每native阶段三数据库main/journal/WAL/SHM+markers/八角色及optional presence/absence metadata和原bytes，unsafe或SIGKILL尤其BEFORE任何SQLite新open/inspect/recovery。副本600、dir700，原unsafe模式单记，不修原证据；recordactual输入/输出/logical回读/audit/boundedstderr、native切点/before-after hash。只保存新own fixture、保留root/tmp精确位置，不搜索个人目录、不复制live数据/未提交Session内容，不把新run回填历史索引。

风险相称定向newownedCLI/module、原consumer/实际S0 protocol+ledger-recovery/S1/S2 ops保护，相关A2契约保护；whole npm run lint、TS7/TS6 app/tools四检查、新声明TS6/TS7 readonly/nulltoken正负控。不把不存在file filter计入数量。没有src/routes/build/image路径变化时不凑HTTP/browser/Docker旧矩阵；正常requiredCI实际Linux/Docker仍由协调者核，不用本地skip签通过。最终diff决定Eval，不预签skip，不跑A1替代控制路径、不调用真实模型。

按冻结scope实施→实际raw与失败保全→稳定source head→两非作者独立FULL(共享维护高风险)→正常PR/tested merge/目标main关系/必需CI→条件合入→精确main CI/archive。实际CI未成功/源漂移时暂停依赖；不部署、blind revert或放宽门。

## 10. 退出与准确状态分类

本片可关闭的是“已真实acquired operation在明确hold-first profile下实际A2消费→停止已登记新准入→有限lease观测→held”工程接线，且限定fixedisolated入口。失败/未知/缺覆盖仍交持久hold或清晰unknown部分状态；不得把fullwriter/production分项关闭。

工程待办仍包括：外部显式恢复partial-stop生命周期（本片不自动恢复）、其他writer/提交consumer、staged实际阶段协调、真实部署/备份/恢复/覆盖/replay/startup与将来受控transport；预算/人类/外部事项另包括真实模型TD20质量、原人工裁决、可信生产来源/终态/全覆盖证据、合格回退批准、新镜像验收与实名生产窗口授权。旧性能/延期产品取舍不重开。

旧S0/S2 spec中历史“后续另授权/不合并”是原时点，不覆盖用户本轮限定工程和协调自主合并授权。但本方案若必须改历史schema/data/security批准边界，必须先准确报告并请求用户批准；现hold-first无此必要。#435部署exit1、policy blocked/safe_rollback=null、未知进程/continuation阻断、预算0全部原样。

本proposal只提交给协调者与两独立Reviewer判定，不代替他们的审查，不宣布执行/接口验收已通过。

## 冻结后的实施具体化（2026-10-08）

协调者批准六NEW内固定无参数 `runOwnedDrainCli():Promise<void>` 适配导出。实际 CLI 文件仅调用它；它只读真实 process argv/stdin，捕获原 abs/mono 窗口，并走模块私有 consume。公共 `consumeOwnedDrainIsolated` 原签名保持，仅 fresh 参数建立新合法窗口。没有 caller clock/window/callback/object/driver/seam，也不通过 signal 属性伪造计时预算；已接受 CLI 窗口直到库首次 CAS checkpoint 和 cleanup 都不重置。此导出是固定 process 适配，不是额外业务控制 API。

上文私有proposal文字及‘尚未执行/未来路径’保留原方案时点；本片实现与实际结果另见 `docs/verify/a2-a3-owned-drain-2026-10-08.md`，方案批准不替代最终源码review或PR/main CI。
