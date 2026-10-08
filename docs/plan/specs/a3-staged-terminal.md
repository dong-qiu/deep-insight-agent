# A3-S3b：合作关闭、观测绑定与独立持久 terminal revoke（方案）

## 范围、前置与原材料

本片编号 A3-S3b；另行 SSM response consumer 为 A3-S4a。原 B 提案阶段命名保留原时点。
只方案，尚未实现或验收。2026-10-08 fetch origin/main / 精确实施前基线：
`3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`（S3 #453 合入），
[main CI37710999247 / attempt1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37710999247/attempts/1)
已 completed/success。协调者原包 archive-index size5433 / SHA256
`960d4604f13100ed0033f57dc6ca00bf78dbe1b0e8fdd0a8857aa26146b17440`；作者另核 API exact head 相同。
原 S3 两位最终 review、PR/tested merge/CI 与原 ATTACH 红例各时点保留，不用本方案补签旧状态。

作者完整读取 Agent B 的 remaining-engineering-proposal-v1（15420 bytes / SHA256
`0ab5714bc126c277ce6f571cf3ceeffa6d227e2394fe25cac55666bdf629b1af`），
与 Reviewer2 remaining-engineering-freeze-supplement-v2（9518 bytes / SHA256
`0a64a8bbf5dea273a78c15a99188058c84f03f4e85b91858a79930eb6205d757`）。
两者是待冻结建议，不是实现签通过；下述唯一 owner 接口供协调者与两位独立方案 reviewer 审。
本次现授权允许新隔离 sidecar 与显式 opt-in 工程，不改变历史 schema/契约或安全边界，
不因原历史 spec 的“后续先授权”文字停止当前允许的工程。

目标：首个真实 runGenerationDispatchOnce 同步终态写入支持“合作 close →有界观测/hold→独立 revoke”。
仅 generation-dispatch done/failed 的原固定终态事务；不接第一轮全部 API/cron/CLI/startup。
Default、S1 cooperative、S3 close-fences-terminal 的 version/profile/语义各自不变；
旧 close 仍立即拒 S3 terminal，新 profile 的 close 仅停新准入，在独立 revoke 前允许已登记 fresh
cap 保有原有效 business lease 时合作 terminal。三者不能混称同一许可。

生产 #435 恒 block、safe_rollback=null、hold、恢复启动阻断与冻结4477412镜像保持。
本阶段真实模型预算0，无生产/AWS/SSM/dispatch/backup/migrate/restore/config/history访问或动作。
本片代码不在旧安全镜像内，不继承旧矩阵/CI为新候选镜像批准。

## 原始真实路径与同步边界

`runGenerationDispatchOnce` → 可选 port admit →原 claimNextGenerationDispatch（原 DB事务，可能新建 rootRun）
→port bindClaim(actualClaim)（execute前）→原 heartbeat/取消/withTaskBudget/execute
→原 assertWrite/cancellation/task/budget guards →固定同步 driver commitOutcome
→driver 自己 BEGIN IMMEDIATE→assertGenerationDispatchClaim + trace.root_run_id/Run.trace_id关联
→finishGenerationDispatch（同连接 nested savepoint，false拒绝）→business COMMIT返回
→core post-read与local finish。任何 done denial/unknown/已提交后读异常都不得普通catch再 failed提交。

原 assertGenerationDispatchClaim 要求 dispatch owner/claimEpoch/expiry 与 lease owner/fencingEpoch/expiry
分别成立；两种 epoch不能混用。原 finish 在有效 owner下可写 Run/事件/trace/request、终态dispatch并释放
自己 owned lease；本片复用它，不直接释放/重设 lease。validator 发布白名单及 planned/committed/failed
原 effect 路径不变，模型/prompt/来源/评测口径不变。

原 S3 terminalClaims 只是 connection Set、cap只是 WeakMap。本片新 sidecar 的六tuple UNIQUE与 durable
reservation负责防进程重启 remint；不能把旧 task/S3cap升级为新 permit，不能只在未提交外层 gate事务里
写 attempted 后 businessCOMMIT：SIGKILL 会回滚attempt，故严格先独立 reservation COMMIT。

## 唯一文件归属与环境

执行 Agent A 唯一串行 writer；方案阶段只新增本 spec与私有index，无源码修改。
未来实现窗口：

| 文件 | 限定内容 |
| --- | --- |
| `ops/maintenance/writers.mjs` / `.d.mts` | 在原同一 private registry connection 内新 staged factory/control 方法；旧方法、DDL不改 |
| `src/lib/runtime/writer-admission.ts` | 新版本独立 pure types；旧类型/profile不改 |
| `src/lib/agents/generation-dispatch.ts` | 新互斥 runtime opt-in、fresh claim消费、独立诊断；旧默认/S1/S3路径保护 |
| 新 `ops/maintenance/staged-terminal.mjs` / `.d.mts` | 一次初始化、新sidecar固定schema/纯物理与记录校验；无外部transport或任意driver/callback入口 |
| 新 `ops/maintenance/staged-terminal.node-test.mjs`、`src/lib/agents/generation-dispatch.staged.test.ts` | 真实native/双进程/core/切点/模式等价专属测试 |
| 本spec、新 `docs/verify/a3-staged-terminal-2026-10-08.md` | 版本、验收、退出、真实原始证据 |

`terminal-dispatch-driver.ts` 与其types实际固定factory预计逐字复用，不写；若必须扩factory先给具体
接口差异/归属供冻结，不擅改。ledger/contract/drain/S0/S1历史tests/jobs/provenance/迁移/schema、
raw/report/SSM/policy/workflow/Docker allowlist/A2/主台账均只读。不得复制其他Session未提交内容。
SSM38fa方案另冻结；本片不修改它，不并发实现两个task。

WT `/Users/dongqiu/Dev/code/insight-agent-a3-staged-plan-20261008`；
branch `docs/a3-staged-terminal-plan-20261008`，PORT3126，自有 `.isolated-a3-staged/` DB/DATA根0700；
AGENTS要求.env.local仅复制必要配置并600，DB_PATH/DATA_DIR已改绝对独立路径，不输出密钥。
测试只 env-i / synthetic fixture；不复制 .data/live SQLite/WAL/raw/reports/.env.development.local。
私有 `/Users/dongqiu/.local/share/insight-agent/evidence/a3-staged-terminal-plan-20261008/`0700，
原材料/source/raw/index0600、非覆盖O_EXCL，WT/branch/evidence不清理。

## 新 gate 物理身份与生命周期

新持久目录为完整S0/S1隔离根的 `staged-terminal-v1/`，0700/currentuid/canonical。
该子目录必须由显式 initializeStagedTerminal(root) 原子 mkdir首次创建；已存在（即使空/缺文件）就拒绝
init，不复用中断目录，不自动修复。父root可有已验收S0/S1和exactfixture-business.sqlite，
新子目录最初为空。先O_EXCL/fsync marker+目录，再O_EXCL/fsync gate.sqlite，后完整schema/genesis
同一个 native IMMEDIATE事务；中断留下永久tombstone，缺schema/genesis不能open/再init。

文件：`stage-isolation.json` 与 `gate.sqlite`，普通0600/owner/nlink1/no symlink；
marker schema=`a3-staged-terminal-isolation-v1`，完整不可变内容：
`stageId(UUID),stageInitId(UUID),s0Marker(完整原marker),s0MarkerSha256(canonical原marker),
profile/version,entryPoint,registryDev/registryIno,businessDev/businessIno,businessPath`。
businessPath只能同父root `fixture-business.sqlite`。新sidecar APPID=`0x41335434`、user_version=1，
DELETE journal/FULL synchronous/foreign_keys ON/busytimeout0；实际 sqlite_master必须精确DDL集合。
不改 ledger.sqlite/writers.sqlite/业务库历史DDL/user_version、不加入旧exactschema对象、不迁移旧记录。

所有受影响open/事务/pragma/query前，零SQL检查父root/子root/marker普通文件权限+原始UTF8/hash/
identity绑定、各nativefile inode/dev/nlink/权限、相关sidecars。gate/registry只接受安全600 DELETE
journal，WAL/SHM拒绝；business合法自有WAL/SHM600可沿原factory，但所有侧车必须先检查。
已有handle的BEGIN同样可恢复/删journal，故preflight必须先于BEGIN，txn内再完整validate。
真正0644hot journal必须拒且原DB/journalsizehash不变；0600由SQLite合法恢复，未知事实不得自动消失。

现有 fixed driver data bridge/actual DB reference/name/open/readonly/inTransaction、fullS0marker、
actualPRAGMA database_list唯一main、dev/ino、trace/Run关联全保留；admit前也核 ATTACH/memory/foreign
等scope，不以caller声明隔离代替原验收。Symbol/shape/freeze只绑定受控factory实际composition，
不认证OS或恶意同uid，不允许任意 callback/可插拔factory，也不暴露native stage/registry连接或锁句柄。

每个gate只允许一次owner-generation生命周期：未登记→精确一个新generation(epoch=1)→永久closed→
可记录一次drain binding→永久revoked；不reopen、不新epoch复用、不重置records、无TTL自动释放。
stageId/stageInitId绑定本生命周期，不用复制旧gate来生成新许可。整目录+S0+业务全部旧副本回滚
仍缺外部单调锚，ownerprivateSQLite不是防恶意同uid/整集回滚认证；所有全writerready仍false。
已open的inode/marker替换拒绝，freshopen损坏/半初始化拒绝；不能声称freshopen能识别完好全部旧副本。

## 持久记录与新 schema 精确逻辑冻结

固定实体及唯一性（实现时DDL常量与tests核逐字sqlite_master，不允宽泛任意event绕字段）：

| 表/记录 | 不可变字段和约束 |
| --- | --- |
| identity | 唯一canonical完整stage marker；UPDATE/DELETE拒绝 |
| stage | singleton id=1；epoch=0无owner或1有owner，workerId/generationToken once-set；revision非负safeint；admission=open/closed、terminal=live/revoked；首revoke reason/null与完整drainRecord/null |
| tasks | taskId UUID PRIMARY KEY、workerId/generationToken、epoch=1；对应真实S1 task；不可UPDATE/DELETE |
| claims | taskId PRIMARY KEY REFERENCES tasks；dispatchId/traceId/ownerToken/rootRunId非空、claimEpoch/fencingEpoch正safeint；**UNIQUE(dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId)**；不可UPDATE/DELETE |
| attempts | taskId PRIMARY KEY REFERENCES claims、attemptId UUID UNIQUE、绑定同stage/owner/epoch；无UPDATE/DELETE；一个claim最多一条reservation |
| attempt_outcomes | taskId PRIMARY KEY REFERENCES attempts、canonical精确三态结果；不可UPDATE/DELETE；缺row投影为unknown，绝不推not_committed |
| completions | taskId PRIMARY KEY REFERENCES tasks、no_claim/done/failed/threw；只localexecutor事实；不可UPDATE/DELETE |
| events | seq INTEGER PRIMARY KEY、previous_hash/hash/snapshot；逐mutation append-only完整canonical状态snapshot/hashchain；不可UPDATE/DELETE |

stage触发器阻止已closed变open、已revoked变live、任何清除/rebindowner/epoch/revokeReason/drainRecord，
禁止删除stage；stage.revision按事务事件严格+1（no-op完全无变化）。完整read核genesis、audit链、所有
行字段、FK/唯一性、rows与最新snapshot一致；mutation与audit同gate事务，不只验证应用填写字段。
第一次owner登记可0→1 once-set；后续不能以新epoch/takeover恢复旧任务。不同controller身份不是OS认证。

claims UNIQUE贯穿finish/deny/unknown/重启，任何删除以“释放容量”均禁止；cap不可从持久记录恢复。
即使某attempt从未持久成功，已有claim绑定也阻止同six tuple换另task/cap重发。不同rootRunId伪tuple
在bind时必须核真实关系拒绝，不能借UNIQUE组成错误root来绕正确claim的唯一性。

## 公共接口、真实消费与新 port

新字面version=`a3-staged-terminal-v1`，profile=`cooperative-close-then-revoke-terminal`；
scope=isolated、entryPoint=generation-dispatch、coreCoverage=runGenerationDispatchOnce。
新增runtime唯一字段 `stagedTerminalWriterAdmission?: StagedTerminalWriterAdmission`，
与writerAdmission/terminalWriterAdmission任意同时配置在admit前failclosed；默认/S1/S3返回形状不变。
固定factory消费原openTerminalDispatchDriver(root)结果，native businessDb必须===driver.db===本次core db。
新桥 `Symbol.for('insight-agent.a3-staged-terminal-admission-v1')` frozen{businessDb}，不deepFreeze DB；
core先核完整literal及exactbridge，再admit；无桥/错db/错profile/ATTACH直接拒，零claim/execute。

```ts
interface StagedStageToken {
  stageId: string; stageInitId: string; workerId: string; generationToken: string;
  epoch: 1; revision: number;
}
interface StagedTerminalWriterAdmission {
  scope: "isolated"; entryPoint: "generation-dispatch";
  version: "a3-staged-terminal-v1"; profile: "cooperative-close-then-revoke-terminal";
  admit(): FreshStagedTaskCapability;
  bindClaim(cap: FreshStagedTaskCapability, actualClaim: DispatchClaim): void;
  commitOutcome(cap: FreshStagedTaskCapability, actualClaim: DispatchClaim,
                outcome: DispatchOutcome): StagedTerminalCommitResult;
  finish(cap: FreshStagedTaskCapability, outcome: WriterOutcome): void;
}
initializeStagedTerminal(root: string): void; // only new subdir; no business/old schema initialization
// New methods on the actual openWriters private connection. No custom native driver/callback factory.
writers.registerStagedTerminal(workerId: string, businessDb: DB,
  driver: FixedTerminalDispatchDriver): { worker: WriterGenerationToken; admission: StagedTerminalWriterAdmission };
writers.stagedTerminalControl(): {
  inspect(): StagedSnapshot;
  closeAdmission(expected: StagedStageToken): StagedStageToken;
  bindDrain(expected: StagedStageToken, heldMaintenance: MaintenanceToken): StagedStageToken;
  revoke(expected: StagedStageToken, heldMaintenance: MaintenanceToken,
         reason: StableStagedRevokeReason): StagedStageToken;
};
```

新registerStagedTerminal内部直接在原private registry connection登记**新workerId/generationToken**并记录
gate唯一owner；不接受已有worker token/task/S3cap，不改旧register/admissionFor/terminalAdmissionFor。
必须核registry=open、gate=open/live/owner空与fixeddriver物理scope后才登记；两库非atomic，gate或registry
任一提交不明不能返回usableport，不重建已有owner。只有该次成功register返回的privateclosure可mintcap；
freshcap为opaque frozen object+privateWeakMap，clone/JSON/旧task/另一factory/另一connection无效。
重启只允许inspect/control已登记generation，不允许从persisted worker重新mint任务/terminalcap。

admit同锁链核registry和gate都open、ownerepochexact，再原S1 task与新stage task登记、mintfreshcap；
mint只在两库COMMIT都确认后；gap失败cap不返回，已有task/未知事实保留，不能回滚另库后伪称未登记。
bindClaim只一次、在实际claim返回后execute前固定消费；六字段immutable snapshot与真实dispatch字段、
lease owner/两个独立epoch和原trace.root_run_id/Run.trace_id关联作native一致读核对，再INSERT UNIQUE。
不能caller capA搭actualclaimB、wrongroot、或同claim换cap。bind不允许新admit，故close后的已freshcap可
继续bind自己已真实claimed结果；revoke后bind拒，原claim/rootRun留作unknown，不能无保护failed写。

bindClaim验证真实行的只读SQL是本新固定内部消费者，按现真实provenance字段事实写出，不改原函数；
同步业务快照在registry→stage→business顺序，无业务mutation。terminal阶段仍由原driver在同business
事务完整原assertClaim+rootRun关联。若精确校验必须改fixeddriver publicAPI，先停并冻结差异，不自己扩窗。

no_claim/pre-cancel仍localfinish，不生成claim或attempt权限。cap.finished/attempted只能单向；
commitOutcome开始即消费进程内attempt（含deny/busy），任何retry/fallback均禁止；同tuple的durable行更
禁止重启重发。finish仅原S1本地completion+新sidecar本地completion，不删除claim/attempt，不证明子树结束。

新返回optional `stagedTerminalCommit?: StagedTerminalCommitResult` 仅实际stagedterminal尝试后；
不复用/改义旧terminalCommit字段。三态：committed/businessCommit=committed；not_committed/businessCommit=
not_committed+fixeddenycode；unknown/businessCommit=not_committed|committed|unknown+fixedunknowncode。
unknown允许businessCommit=not_committed只表示reservationCOMMIT不明而businessdriver尚未调用；
不能据此重新提交。新类型不扩旧TerminalCommitResult union，不存新业务schema/Run/usage/history字段。
新类型独立 literal 冻结：
- StagedDenyCode = 原固定driver TerminalDenyCode | staged_terminal_capability_invalid |
  staged_terminal_claim_mismatch | staged_terminal_business_mismatch | staged_terminal_owner_lost |
  staged_terminal_closed | staged_terminal_revoked | staged_terminal_busy。
- StagedUnknownCode = 原 TerminalUnknownCode | staged_terminal_reservation_unknown |
  staged_terminal_gate_commit_unknown；reservation不明仅表示是否持久不可确认，绝非retry资格。
- StableStagedRevokeReason = writer_drain_timeout | writer_drain_cancelled | cancelled |
  task_deadline_exceeded | generation_fence_lost | writer_drain_coverage_unknown |
  writer_drain_observation_failed | staged_terminal_manual_block。首原因不可覆盖；不是停止证据。
禁止原error、SQL、路径、模型内容或任意string当reason，原S3类型union不改。

core保留原 owner/lease>C2a首reason>C3>budget顺序、原失败classifier、timers cleanup，只有staged branch
选定固定terminal写口；denied done不能ordinarycatch再failed。businessCOMMIT后post-read抛错、gate收尾unknown
或localfinish失败时，返回statusfailed保原三态/业务事实，task仍unfinished/unknown，不重试或删除。
无terminaldiagnostic的pre-admit/preclaim/no_claim失败原异常，不吞成已完成；旧Default/S1/S3回归保持。

## 同 connection 锁顺序与两个事务

registry与stage连接都由实际openWriters闭包私有持有，staged module不export db/lock/通用callback。
固定次序 **registry BEGIN IMMEDIATE →stage BEGIN IMMEDIATE →短S0 inspect（只核身份）→
必要business事务**，S0读取返回即close，不持S0事务到stage/business/registry验证。
每次registry validate内部ledgerMarker自己openLedger.inspect；禁止外部先持S0锁调用writers，避免同库selfbusy。
任何锁不跨await；fixed同步方法不接任意async function、不靠thenable检测做安全保证。

阶段一（reservation）：
1. 全零SQL preflight，再同registryprivateBEGIN+validate/taskowner，随后same stageconnBEGIN+validate。
2. sixfields完全匹配、claim唯一、未completion、terminal live、owner/epoch exact；closed可合作terminal。
3. INSERT attempts唯一task/tuple、追加snapshot与revision，**stage COMMIT必须实际返回成功**；
   registry无新事实则其COMMIT结束短读锁。确认两者都退出后才进入阶段二，绝不业务先提交。
4. reservation COMMIT抛错/registry结束异常：businessdriver零调用，unknown+known not_committed，
   cap已消费、相关行保留；不查询后重发、不将未知当rollback。不公开resume reservation权限。

阶段一→二间隙无锁，也没有执行callback或await；OS调度、SIGKILL/revoke可发生，因此重新核全身份/阶段。
revoker在gap先赢会持久revoked，terminal留reservation但不写业务。死亡时reservation不可rollback/remint。
phase1失败如busy且没有持久reservation也不重试，该cap已消费且durableclaim UNIQUE仍封同claim。

阶段二（同步真实business terminal）：
1. 再完整零SQL preflight，再registry→**同stageconnection**BEGIN；完整marker/audit/schema/task/owner/epoch/tuple/
   reservation/terminal/live检查。不能用先check→释放stage锁→driver业务写冒称fencing。
2. registry closed在新profile此时不拒既有cap；stage admission closed允许合作终态，terminal revoked拒。
   使用当前stage revision在该事务内append，新mutation不信phase1保存的旧revision；slot必须同attemptId。
3. 固定factory driver.commit在registry+stage锁内同步执行原businessIMMEDIATE/COMMIT，锁保持直到COMMIT事实。
4. 记录attempt_outcomes对应实际三态并gateaudit，stageCOMMIT→registryCOMMIT。cap一次attempt结束。
   gate/registry收尾失败不逆改已businessCOMMIT事实，不failedfallback；durablereservation始终在phase1保留。

revoker/close/bindDrain都同registry→stage链，无另一registryhandle包裹公开S1方法造成busy。
close用同private registry SQL执行原open→closed，再stage同txn永久closed；跨两库部分失败就保持blocked，
不能自动reopen另库。实际两库提交不是crashatomic：gateclosed/registry仍open等gap拒本newportadmit，
不能声明其他默认writer被关闭。原S2能另用existingwriters.closeAdmission，newportadmit同步核registry。

revoke更新terminal仅在同stage锁内exact expectedStageToken CAS成功、firstreason稳定后COMMIT；
revocation先于phase2取锁则业务零写；terminal持锁先取得且COMMIT返回，revokerbusy或之后CAS新revision
再显式独立调用，原business已提交事实保留。attempt/gate mutations都会推进revision，不自动刷新旧controller
token；no-op exactreplay只返回immutable输入token/readonlysnapshot，不向旧continuation传新revision权限。
公开control没有acquire/release/authorize/resume/complete/生产permit。

## close、观测绑定、revoke 与 lease 事实

close与revoke为独立explicitcontrol方法；**不得把 close 字段双重解释为 staged terminal 撤销**。
阶段：registry/gateopen→cooperative_closed（原在途可完成）→drain_bound（只是观测关联）→revoked。
执行有限drain复用原S2：openDrainLeaseSource真实全inventory、observeDrain<=60000ms→S0永久hold。
S2的ready/quiescence恒false、不更改lease。此处不是在原drainloop内新增跨await锁。

bindDrain/revoke都接受caller提供的完整heldMaintenance token，按同root actualopenLedger.inspect核：
active operationId/full owner/fence/currentrevision/target/executionIdentity精确、state=pre_submit、disposition=held、
s0marker匹配；不是仅看输入ready或持有旧S2result。对released/manualtakeover/错owner/revision/target都拒。
实际S0 hold不认证唯一控制器，不证明这个hold一定由S2生成；只记录所观察持久事实，绝不签drain成功。
原tokenhash不是授权，也不新写S0记录。两库读不是对S0后续变化的原子锁；本片安全只可使terminal更严
（永久revoke），不执行任何依赖S0允许维护的业务动作，读后release/变化不会复活stage。

bindDrain在registry→stage锁内核两admission已closed、真实worker/generation/task，读取固定业务readonly
fullinventory（全部dispatch+全部activelease，禁止innerJOIN漏orphan），计算canonical snapshot SHA256。
记录完整heldtoken/operationkind、S0snapshotHash、registrysnapshotHash、leaseSampleHash、sampledAt、
exactroot/businessDevIno/stageowner身份；其hash由本方法实际读取生成，不接受caller填写hash当验收。
sample=null、来源不可用/错物理身份/非法采样时点拒绑定，不输出新permit；真实inventory将非法epochs/expiry
mismatch/orphan计unknown，不删掉它们；正常sample含unknown/expired/
queued仍可记录分类并保持readyfalse，不据数量0推静默。记录是immutable观测点，不是永远有效的当前证据。

revoke重新核currentheldtoken相同binding、registryclosed、stageclosed/bound、owner/epoch/expectedstageRevision；
再取本轮真实sample并同样计算摘要，记录本轮时间/观测（不能把旧lastsample当当前充分证据）。
sample未来/源不可用或marker/inode/旧S0revision失配均拒，不自动续租/刷新hold；stage若已revoke保持阻断。
本轮观测有效期只属于一个同步方法调用，跨await/重启不重用；无需新增TTL/自动恢复/全系统deadline。
若新代码内部采样不能安全复用原readonlysource而必须复制或改drain公共协议，先报告具体接口差异再冻结。

lease分类事实：queued保留不领取；claimedCurrent仍在途不签停止；expired owner仍unknown；owner/两个epochs/
两侧expiry不一致、orphanactive/未登记entry/未知subwork一直blocked。可以记录current generation的claim关联与
late-terminal拒写，不能强release、删queue/Run、修改owner/epochs/expiry制造静默。
真正合作任务按原C2a首取消原因、实际await join和原owner fencedfinish处理，未join子Promise/模型仍unknown；
本片不新增取消所有任务功能，不把SIGTERM/health/localcompletion当全静默。

## 崩溃窗口与返回事实

| 切点 | 保留事实与确定退出 |
| --- | --- |
| init marker后/schema前 | permanent incomplete tombstone；拒open/reinit，保原文件 |
| S1worker/task先或stageowner/task先commit但另一库失败 | partial/unknown，no usablecap，既有行保留；不补造认领 |
| claimCOMMIT后/bind持久前 | claimed/rootRun保留，execute0；no failedfallback、unknown未登记claim不能重建cap |
| claim UNIQUE写入后/attempt前 | claim永存阻same tuple新task；重启不mintcap |
| reservation未COMMIT SIGKILL |无业务调用；本地cap死亡，claim UNIQUE不删，不能换cap再次attempt |
| reservation已COMMIT/gap/phase2 BEGIN前 SIGKILL或revoke | attempt保留unknown，第二cap/重启无恢复API；revoke先赢则业务0 |
| phase2内业务COMMIT前SIGKILL |业务native恢复，attempt仍在phase1持久，outcome缺则unknown、不重发 |
| businessCOMMIT尝试抛错 |businessCommitunknown；nativecleanup不降为rolledback，unknown/hold |
| businessCOMMIT返回后/stageoutcomeCOMMIT前SIGKILL |fresh读business原提交事实，reservation+缺outcomeunknown，禁止再次failed写 |
| stageoutcomeCOMMIT后/registryCOMMIT失败 |business已知committed保留，outerunknown；不伪rollback或改firstoutcome |
| localfinish/postread/diagnostic出口失败 |taskunfinished/remoteunknown，能返回时保存stageddiagnostic/statusfailed，不补写/retry |
| close跨库部分COMMIT/revokebusy/CAS冲突 |保持阻断，不自动reopen/刷新token或修另一库；既有business行不假rollback |

任何不确定终态不自动消失，unknown不等于未提交。stage记录已知结果不能认证远端子工作停止。
progress、task完成、lease过期、SQLite合法恢复或0计数都不会给production/drainready。

## 实际反例与验收（未执行，先保护红再实施）

1. 真实core+原claim/固定driver/nativeSQLite的正常sameDB/profile正控；default/S1/S3返回/close/取消/预算/白名单
   对照保持；3port混配、缺brand、wrongroot/memory/readonly/ATTACH后creation beforecore都execute0/claim0。
2. 新 staged close停新admit0，但已freshcap/有效lease执行完合作terminal可COMMIT；S3旧strict同close拒。
   真实S2有限drain→actualheldS0→bindDrain→explicitrevoke，全部readyfalse；不得fixture0tasks签静默。
3. 同process两cap两claim交换、wrongrootRun/真实trace关系错、两个epochs独立、同six tuple另task/connection/
   重启/JSON/旧worker/S3cap不能mint；UNIQUE与attempt PK直接native冲突断言，原行不能删除重发。
4. 真双进程：revoke在phase1reservationCOMMIT后gap先赢→terminalbusiness0；terminalphase2先持锁→revokerbusy，
   businessCOMMIT后explicitfreshCASrevoke保原终态。无锁check-release负控证明原driver可穿门，勿冒称安全。
5. reservation phase1 COMMIT前/后、phase2 BEGIN前、businessCOMMIT前/后、gateoutcome前后SIGKILL native切点。
   unsafe设计负控在未提交outertxn写attempt后bizCOMMIT→kill确实能回滚attempt；新设计fresh连接保reservation。
   切点只在测试childinstrument原nativeCOMMIT/OSsignal，不新增publiccallback、productionfault参数或await锁。
6. nativeSQLite COMMIT/foreign-key/锁busy与真实registry/stagehandle失效：先known businessCOMMIT→outerfailure的
   actualcore保stageddiagnostic；postreadthrow不再failed；所有unknown/denied全attempt计数1、no retry/rebuild。
7. 真hotjournal0644（newopen及existinghandle）、journal/WAL/SHM权限、pathswap/marker/DBinode/半初始化、旧APPID/
   DDL/audithash损坏：preSQL拒且unsafe证据原sizehash保留；0600合法恢复仍unknown/closed/revoked持久。
8. 两控制器sameidentity/同S0heldtoken/旧stageRev/owner/epoch/target/fence/released/manualtakeover：事务CAS只胜者
   mutation；no自动刷新/foreignhold，不称OS唯一controller。replay返回输入token，不能借赢家newrev续动作。
9. live/orphan/source_collect/expired/未知子Promise与Run/usage/raw/report负coverage：newterminal拒写后，既有未覆盖
   writer仍可能按原lease写，必须实际证据列unknown，不把覆盖warning清零。lease字段/queue和业务历史不强改。
10. C2a firstreason/C2b owner>C2a>C3>budget保护，lease-loss不写failed；validator publication whitelist、原Run/
    planned/committed/failed回归。真实模型SDK0次，mock只能证明控制协议，不宣称模型质量。
11. Node24 env-i、0700/0600非覆盖原红/绿/raw/source/hash；定向新native/core+S0/S1/S2/S3/取消预算/发布、风险相称
    fullops、TS7+TS6 app/tools+声明、lint/build；app type-only接线不importops到Docker运行包，实际Docker/CI必需门
    不skip。路由未改不冒称HTTP/startup已覆盖；有变化另按风险加对应测试。
12. 两独立完整方案/最终diff/原材料review，正常hooks/pre-pr/eval最终diff判断、不预签skip，PRfinalhead/testedmerge/
    latestmain关系/精确CI/mainCI逐一绑定。失败先查明，不无限重跑或以新head成功补旧状态。

## 退出、回退与剩余分类

方案冻结前不实施。sourceownership/精确S3mainCI/两独立方案B0及Warnings处置齐后方可进入保护反例。
如实现必须改S0/S1/business历史schema、安全target、公钥/批准policy、模型/validator语义、公开任意callback、
扩大entrypoint或新增生产解锁，停并提交精确差异，不能以sidecar名字遮住边界变更。
shareddriver/drain必要API差异先交协调者冻结，不能擅自拷替身校验/弱化原真实assertWrite路径。

验收失败不合并。code-only可停止新profile引用，但所有新/旧task、claim、reservation、unknown、hold和audit
保留；不得删除sidecar/reinit/release/clearlease或逆migration作为回退。永不自动生产deploy/revert。

剩余**工程**：HTTP/startup/Job/usage/raw/report/cron/CLI实际覆盖；全部writer提交封闭、lease处置后续小片；
真实A2消费、SSM离线controller+response准备、部署/备份/恢复隔离适配。全writer未覆盖不等于生产授权阻塞，
能做隔离工程继续按slice调度，不能把本局部片完成写为A3整体闭合。
剩余**缺证/人工**：生产真实运行/新镜像与数据兼容、可信覆盖基线/独立账本锚、所有continuation终止、
实名责任人、TD14人工裁决；fixture/hash/CI不能补造历史或人工通过。
剩余**预算/生产授权**：TD20旧head真实质量预算0；任何真实模型/付费/生产AWS/SSM/维护须专项。
**延期**：TD12保留模块、TD14/15追加性能、P1/Brief和无新线索历史搜索保持，不扩大本片。
下一必要动作仅双独立方案审查冻结后实施本terminal小片；不先申请生产或全部入口改造。
