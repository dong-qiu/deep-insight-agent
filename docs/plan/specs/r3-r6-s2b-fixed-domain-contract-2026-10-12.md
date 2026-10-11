# S2b：固定 domain 消费合同与首期切片提案

## 执行单与实际基线

主控明确委派本线为唯一作者；只新增本文件、[归属收据](../../verify/r3-r6-s2b-owner-transfer-2026-10-12.md)与exclusive私有证据，不创建domain源码/DDL，不运行模型、资格、业务测试或生产。PR477已由主控指定本线唯一merge owner正常squash，actual `fb7e3c845bef5d7a310ea5017f71bf905beedf49`、2026-10-11T20:31:30Z，main push CI38172573309/1 docs success；三文档blob与受审head8868d090一致。旧S2a108索引不修改，本片加性证据独立。

主控已冻结 [S2a](r3-r6-s2a-v2-format-2026-10-12.md) APP_ID0x41335732/version2/marker、10表20trigger12autoindex、双向行/fact/binding、原cap/原signal、同registrycontrol/open-business-only方向。真实SQLite验证、正式ADR原owner落账、当前具体冲突门仍是源码实施前置；主控已据600定向观察前瞻指派八新名字唯一S为本线，reserved=true/implementation_enabled=false，不是补造历史release；冻结格式方向不是签运行资格。本片是**新增domain增量**，不重审S2a/D2。下面新名字、domainstep/scope与取消窄政策均为待主控冻结的提案。

复用33来源在actualmerge逐blob核一致，另冻结runtime/model-usage、db/model-usage、jobs、db/repos、report-gen五文件与retry route一文件，共39。Run真实insert/finish在repos.ts；首次猜runs.ts路径不存在的只读查找失败已保全，不当成业务故障。八S2a路径的600定向观察只证明Git登记75WT中当时无文件/HEADblob，不证明所有历史计划不存在；主控据此作新增窗口reservation（决定SHA95545228386da70a370f124c4c3bf9628454a6869f4c42c111a6c07a20deaa2e），解决新接收责任，具体竞争仍回主控，详见收据。

## 拟议精确新文件与现有 imports 保留

| 新路径（全部未创建、未取得source写窗） | 固定职责/后续唯一owner |
| --- | --- |
| `src/lib/runtime/domain-v2-types.ts` | strict值union/结果，不运行环境或通用gate；同S |
| `src/lib/runtime/dispatch-domain-v2.ts`、`dispatch-domain-v2.test.ts` | generation-dispatch usage begin/observe与terminal固定消费者；同S，首期候选 |
| `src/lib/runtime/source-domain-v2.ts`、`source-domain-v2.test.ts` | request/claim/root Run绑定/heartbeat固定同步消费者；同S，第二片 |
| `src/lib/runtime/startup-domain-v2.ts`、`startup-domain-v2.test.ts` | explicit schema assertion、local-only初始化/逐条seed/directions值消费者；同S，W1接线另owner |
| `src/lib/runtime/artifact-domain-v2.ts`、`artifact-domain-v2.test.ts` | A/P提供的固定同步intent/FS/finalize/recovery值接口组合；A/P未移交时unsupported，不复制repo |

S2a候选writers-v2.mjs/d.mts及writer-admission-v2.ts需要同S在其后续实际base/head上增加**具名固定domain factory**与step/schema验证；这是对未来核心八窗的精确扩大，不默认有权改已有旧三shared文件。没有export任意reserve/SQL/driver/callback API，不用step名字字符串签任意动作；运行层factory依赖runtime→db，ops核心不反向导入runtime业务，通过原private固定factory绑定保持方向。

| 现有导入/consumer | 保留与新增接线界限 |
| --- | --- |
| jobs.ts → repos、model-usage、budget/cancellation | 本片保持字节；实际Job创建Run、usageScope、finishRun与catch写入仍未接v2；不能把新driver单测签jobs已准入 |
| model-usage.ts → db/model-usage、现usageWriter port | 保留旧可选v1及默认路径；新v2只由未来W2显式注入原factory cap，未注入不会自动受保护 |
| 旧usage/terminal-dispatch-driver + writers v1 | 固定fixture-business.sqlite/profile；保持字节，新d2 target绝不cast/open旧driver |
| provenance.ts、repos.ts、collector.ts | 只读，source三字段claim不够bound identity；固定domain仅调用或明确原owner提取窄值函数，不能在本片接runJob/collector |
| connection/startup/local-bootstrap/config/planning/evals seed | W1十一文件未移交；现getDb/open/seed路径不会因本合同自动受控，真实接线同W串行 |
| raw-archive.ts/reports.ts/report-gen.ts | A/P原owner与接口待移交；旧DATA_DIR/dir/callback/catch写未知路径不直接套入固定adapter，不启动大拆分 |
| S0 ledger/CLI/controller/drain/staged及A2/owned-drain | S2a既有字节/能力边界保持；新同registry control是实际consumer，不把旧consumer拒绝签全writer |

## 共同固定消费与三态

`bindDispatchDomainV2(operation, openedTarget)`等具名factory只接受原WeakMap operation与`openV2Business`产生的原opaque target binding；不是caller DB/driver。target内实际同一native connection与canonicalroot/dev/ino/registry/ledger身份重查；返回的public DB或inspect值不能重建target。register/admit原worker、entry、scope/信号及generation全核，原signal不可换成新未取消signal。value参数strict own primitive/数组，accessor/Proxy拒绝，input_hash绑定完整canonical值；late env/path/Date对象/DB/SQL不作为输入。

每次同步consumer：持久单次step reservation确定COMMIT后，重新registry写锁核open/原cap/step未消费；S0身份inspect同步事务立即结束；business BEGIN IMMEDIATE→同连接claim/schema/identity→固定SQL→该具名step的同连接后置断言/取消→同步COMMIT→registry ACK+result/fact。旧repo内部transaction是外层的savepoint，不能将其返回当外层COMMIT。反向已有业务txn拒绝；registry/S0/business锁均不跨await；外部fetch只在锁外、返回后重验。busy/拒绝/unknown消耗该尝试，不自动重试或legacy fallback。多阶段不承诺全局原子。

结果strict union：`{kind:'committed',businessCommit:'committed',coordination:'acknowledged',replayed:boolean}`；`{kind:'not_committed',businessCommit:'not_committed',coordination:'acknowledged'|'unknown',code}`；`{kind:'unknown',businessCommit:'committed'|'unknown'|'not_committed',coordination:'unknown',code}`。no-op另为`{kind:'completed_noop',businessCommit:'not_applicable',coordination:'acknowledged'}`，不能称COMMIT。business正常COMMIT后ACK失败是kind unknown/businessCommit committed；COMMIT本身抛错或死亡无法证明是business unknown；确定写前拒绝才not_committed。清理ROLLBACK不证明COMMIT未生效；FS事实单列，不改rollback。coordination unknown全部停止后续阶段并保留首因，inspect见旧行也不签cap。

以下catalog只允许各具名factory消费自身step，ordinal单调、inputHash和前序已ACK结果匹配，未知step/entry/domain schema拒绝；S2a实际未实现domain之前明确unsupported。新的fact载荷沿S2a逐整行双向覆盖，domain scope/input/FS action需要本片冻结后核心validator增量，旧v2 reader面对不认识的domain记录拒绝，不放宽parse。

## generation-dispatch：首期 domain 提案

operation.scope exact：`{kind:'dispatch',purpose:'usage'|'terminal',claim:{dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId}}`，六字段沿真实DispatchClaim类型；run binding另strict `{runId,traceId}`，必须实际run与trace/root join匹配。UUID/string/positive safe整数沿既有库契约，不仅看类型。factory在真实同连接assertGenerationDispatchClaim及run联结核验；不是SQLtoken认证。

| 固定step/API | 输入与前序/实际副作用 |
| --- | --- |
| dispatch-bind / bindDispatchDomainV2 | 原operation+target，scope六字段；核owned lease、generation、trace/root；仅绑定事实，不创造新claim、不代表Run已准入 |
| usage-begin / beginUsageV2 | 已bind、原signal未取消、run running；完整UsageIdentity九字段（attempt_id/logical_call_id/attempt_number/run_id/trace_id/role/provider/model/started_at）固定值；beginModelUsageAttempt同外层txn。replayed只保留事实，0新fetch/0observer凭证 |
| usage-observe / observeUsageV2 | 确定非replayed begin COMMIT+ACK才发本地observer；strict observation_number/final/四token可null safe整数，与原attempt/run/trace同连接核；每条单独ordinal/COMMIT。保留reported价格快照、partial/unknown、不退款 |
| terminal-commit / commitTerminalV2 | terminal专用operation，只一次；outcome是现finishGenerationDispatch值union，实际同连接claim/run状态核验；禁止先改owner或forcefinish，结果保留原strict意义；成功后用下述terminal后置断言，不再要求owned |

提交前后断言按真实step区分：usage-begin/observe在SQL前后均核原owned claim与Run/trace绑定；terminal在SQL前核原claimed dispatch/owned lease及六字段claim、root/Run。`finishGenerationDispatch`返回true后，在同一连接、外层COMMIT之前断言dispatch已按实际`projectTrace`投影为done或failed（不能直接把outcome.status当最终state）、trace_request已terminal、原trace的lease已released且expiry为NULL，dispatch owner_token/claim_epoch和lease owner_token/fencing_epoch仍匹配原身份、trace/root/Run关联未替换；同验原signal/registry/generation。terminal自身释放lease后不调用要求claimed/owned的assertGenerationDispatchClaim；返回false按未获terminal许可处理，不签新terminal效果。后置断言不允许重获claim或接受其他owner的终态。实际SQL内trace summary、失败Run/event与投影仍由原函数完成，内层savepoint成功不替代外层COMMIT。

usage与terminal不同operation，不能观察usage cap冒充terminal；一次attempt原始begin后每观察独立消耗fresh step，observer原对象只能引出该attempt的下一顺序step。未ACKbegin、replayed begin或clone/重启从SQL值不发observer；reported observation幂等原价格，改号/冲突按旧repo拒绝。terminal提交后claim若不再owned，则lateusage会被真实fence拒绝，保留已有unknown/partial，不能为补账重建claim。

**待主控冻结的domain窄增量 M1**：现v1 observe明确“忽略signal/local finish，绝不忽略maintenance/physical/task/lease”，S2a通用消费规则则执行前/COMMIT前检查原signal。为保持迟到真实账务，本片建议：begin/terminal严格拒绝原signal取消；usage-observe仅对原已确定开始且fresh observer的attempt，实时读取并记录原取消首因，但accounting可继续；registryopen/物理/generation/claim/currentrun绑定仍强制，禁止新模型调用、业务结果发布、claim复活或改已报成本。它是具名accounting政策增量，**不是本spec合入即生效的S2a例外**；未冻结M1不实施observe，不能用新signal旁路或把已有费用归零。

与immutable terminal兼容建议M2：begin在调用模型前预先登记独立usage-observer operation（同worker/entry、scope含parentInvocationId/attemptId及原signal私有binding），只有begin COMMIT+ACK才激活其fresh观察cap；Job/父operation finish不终结尚未settled观察operation。该operation只接受usage-observe，不open/terminal，不保留registry锁跨await；final确定或sticky失败收尾terminal，取消及时返回Job而不等待它，不新增后台SQL interval。无final/lease失权/close/进程死亡留unknown与已有attempt事实，fresh recovery另鉴定。M2 scope exact为`{kind:'usage-observer',parentInvocationId,attemptId,runId,traceId,claim}`；generation/claim仍与原owner一致，不能用它脱离失效claim补写。两operation不是跨库原子完成证明，begin前预登记失败0模型调用，begin成功但observer activation ACK unknown也0新fetch。M1/M2均需新domain增量冻结，不能引用S2a双审补签。

## source prelude → 七字段 root binding

source-request strict input与prelude scope均冻结`{kind:'source-prelude',sourceId,triggerKind,scopeKey,retryOfTraceId,retryOfRunId,requestTimeIso}`；triggerKind只允许实际cron/api/retry/probe，两个retry字段在retry均必填，其余trigger均null。requestTimeIso由可信固定factory在登记scope之前一次采样并规范为ISO，不接受caller Date/clock/callback；canonical/input_hash覆盖全部字段，后续消费不得追加或修改。该快照仅派生请求幂等身份，实际lease有效期/COMMIT前权限使用当前时钟检查。activeKey恒为`source_collect:${sourceId}`；scopeKey按现函数重算：cron为`source_collect:${sourceId}:${requestTimeIso.slice(0,13)}`，retry为`source_collect_retry:${sourceId}:${retryOfRunId}`，api/probe为`source_collect:${triggerKind}:${sourceId}:${requestTimeIso}`。无独立periodKey输入，不从caller scopeKey反解缺失值。

retry实际caller是`src/app/api/admin/runs/[id]/retry/route.ts`：先getDb、查原Run为failed且kind ingest、target.source_id/现source存在、原trace_id存在，再传retryOfTraceId与retryOfRunId。固定consumer须在同连接重核原Run/trace/source绑定及上述状态，真实parentRun.id=retryOfRunId、trace_id=retryOfTraceId、target.source_id=sourceId；缺失/错配拒绝，不以输入字符串当事实。现route先getDb的隐式写仍归W HTTP接线，本片不签受控。请求SQL将固定requestTimeIso转换为内部Date供现函数使用，后续claim/heartbeat单独使用实际当前时钟；无需UPDATE原prelude scope或伪造root。

| 顺序step / API | 固定结果/准入先于哪些真实写 |
| --- | --- |
| source-request / createSourceRequestV2 | 在任何createSourceCollectTrace（含expired lease终结/request sequence）前reservation+registry准入；accepted/replayed/conflict/busy以实际结果保留。返回replay/conflict即便SQL有诊断写也不能说零效应；只有accepted且COMMIT+ACK发下一cap |
| source-claim / claimSourceV2 | 同target对accepted真实trace/lease执行claimSourceCollectTrace，同外层COMMIT；null/no_claim无根Run许可，三字段claim仅持久事实 |
| source-root-bind / createBoundSourceRunV2 | 核真实trace/source/scopeKey/activeKey/claim/lease，固定insertRun(kind ingest,target source,trace_id,retry_of=retryOfRunId或null)与bindSourceCollectRootRun在**同一外层业务事务**，取真实新RunId；重查返回七字段traceId/sourceId/scopeKey/activeKey/ownerToken/fencingEpoch/rootRunId。不可变追加，不UPDATE原prelude scope，不用别Run占位；ACK后才bound cap |
| source-heartbeat / heartbeatSourceV2 | bound原cap、实际lease/Run/trace七字段；每次单独同步step/COMMIT，close后0heartbeat，不新增后台绕门interval |

root绑定事务成功后W2/3未来只能以已有Run身份组合runJob，不再让runJob先insertRun再申请准入。Job预算/usage enrollment、finishRun/catch、Content外层txn仍需要W接线，S2b source port测试不签实际collector已覆盖。raw intent许可须来自bound source，request/claim成功不允许原文发布。source失权/busy/unknown不重走legacy create/claim/Run，不伪造scope或root，不将前两步已提交改成root步rollback。

## startup/local-seed 与 A/P同步值接口

startup scope `{kind:'startup',configHash,runtimeVersion,mode:'initialize-existing'}`；local-seed scope `{kind:'local-seed',configHash,runtimeVersion,mode:'local-create'}`，local-only/production-strict拒绝由可信固定factory验证，不通过caller声称环境来放行。startup顺序：S2a open-business→assert-existing-schema/provenance→raw-reconcile effect steps→ordinary-report-reconcile effect steps→seed topic/source items→seed-directions→publish-db（仅本地singleton动作、0SQL，仍重验代际）。空库bootstrap/meta/migration为local-only独立步骤/owner，不能initialize-existing偷跑。W1缺依赖即unsupported/不发布_db。

seed item input exact `{kind:'topic'|'source',key,payloadHash}`，payload为冻结现config对应完整值；每条读已存在则completed_noop，需要insert各自同步COMMIT，失败停止后续并输出committed-prefix/noops/current三态。directions保持现单事务，不改逐条。现seed函数整体不得作为callback包进固定锁，否则只见一个结果会丢前缀。

raw/report/recovery operation scope exact `{kind:'raw-recovery'|'report-recovery',effectId,idempotencyKey,manifestHash,payloadHash}`，fresh invocation不复活旧cap。A/P需交strict值输出：`{effectId,kind,idempotencyKey,manifestHash,payloadHash,phase,diagnostic}`及真实entity/trace/review/source绑定，路径仅从原target受控raw/report派生，0caller任意dir/DB/env。A/P未来API分别具名planRawIntentV2/publishRawFilesV2/finalizeRawV2/diagnoseRawEffectV2，planOrdinaryReportV2/publishOrdinaryFilesV2/finalizeOrdinaryReportV2/diagnoseOrdinaryReportV2；本模块不能注入任意repository driver或复制其SQL/validator。

raw合法顺序Content upsert+pending readereligible0+revision+intent同外层业务txn→文件staging/hash→attemptedSQL→每次rename当前准入→finalize同连接readereligible/effect。普通report metadata generating+审核/白名单+intent→两body staging/hash→attempted→每rename→finalize report/index/FTS/event/审核reader投影同事务。FS阶段不持business写txn，仅registry保护同步发布窗口；COMMIT三态与逐文件occurred/unknown分开。失权后不能rename/finalize/unknown-diagnostic写；已有intent/部分文件保留。现repo的catch markUnknown/failed不得当permit旁路，合法新诊断须freshcap。普通/anchored保持validator白名单、review绑定、idempotency/pending/unknown；anchored外部await write/read不属于本同步合同，D3未冻一律unsupported。

recovery只在全部遍历完成且合法诊断SQL确定committed时completed-with-diagnostics（保留unknown业务终态）可继续下一个恢复/seed；admission-denied/businessCOMMITunknown/ACKunknown返回interrupted并停止effect/report/seed、不发布_db。旧{committed,failed}无法代新合同。recovery是否可以执行写仍由当前registryopen/owner决定，closed永久不通过重启解除。

## 首期实施顺序、真实验收和限定提示词

首期只做**dispatch usage/terminal fixed domain**（三个新文件：domain-v2-types.ts、dispatch-domain-v2.ts/test.ts及同S核心具名增量），先拿S2a八窗/实际格式测试/正式ADR与本三新窗，冻结M1/M2。业务schema/合成dispatch+run fixture须由schema原owner给精确版本或授权test fixture窄使用，不运行legacybootstrap/defaultDATA_DIR。S2a空DB不能直接宣称repo可用。未具备schema或M1/M2，停在begin/terminal限定准备，不默默省略observe签首期完成。

| 真实路径验收（后续实施执行，本片未跑） | 观察事实 |
| --- | --- |
| 同一d2 handle真实lease/dispatch/run/model_usage表，独立childprocessclose与begin/observe/terminal竞争 | 实际repoSQL和最外层COMMIT；close胜0写，consumer胜COMMIT保真；0旧fixture open；实际control看到六entry/child observer未ACK库存 |
| 原signal取消前begin、调用已开始后取消、父Jobfinish后lateobserve、close/lease loss后lateobserve | M1/M2freeze后实际known/partial/unknown费用不归零；cancel0新fetch；late账务只在仍有真正权限时写；拒绝保持旧事实/sticky首因，不能借父finish复活cap |
| begin replay/changed identity/count stale、reported repricing、cap clone/SQL replay/restart | replay0新observer/fetch；价格快照与reported保真；真实同连接校验拒绝，0callback/driver注入 |
| terminal实际成功done/failed投影、错误owner/lease loss、businessCOMMIT throw/SIGKILL、ACKthrow、observer activation failure | terminal成功真实释放lease且外层COMMIT保真；错误owner/失权拒绝，unknown与committed+coordunknown分别观测，0后续模型/terminal/fallback；清理不改先前COMMIT；fresh恢复不重建旧cap |
| source真实request含stale lease、合法retry及错parentRun/trace/source/scope、claimnull、root插入/绑定故障、heartbeat close | 准入早于所有隐式SQL；前缀提交保留；三字段不足/七字段错拒绝；无root前0raw，source端口不签collector W接线 |
| startup真实首次open/cache、逐seed第二条故障、raw/report诊断unknown vs commitunknown | 首效应先门、前缀保真、raw→report顺序、confirmed诊断可完成；中断不发布_db；authdirectreadonly D1例外不冒签全reader |
| raw/report实际intent→单/双文件publish→finalize→reconcile；review/validator/effect冲突；anchored await | 失权0rename/0可读；pending/unknown/幂等保真；body部分FS不rollback；anchored明确unsupported等待D3 |

S2a→首期dispatch S2b→source S2b→startup值接口均同S串行；A/P可各独占repo准备，W1同W待S2/A/P真实接口后接线，HTTP/jobs/collector后续W逐片；同文件不多owner并行。D3/app-path共同ownership另案，不启动延期模块。

给后续S Agent：只在主控交精确source窗、格式/ADR/schema与M1/M2决定后实施首期三新domain文件和已持有的v2核心窄delta；保持旧imports/source字节，实际d2同连接固定消费者，不任意driver/SQL/callback，不接jobs/collector/W1/raw/report repo。用真实fixture+nativechildprocess反例，不模型/生产；新的两位独立非作者最多两轮，docs方案不签源码。提交exactsteps/scope/API类型/hash/COMMIT与ACK证据、尚unsupported入口及首期唯一owner收据。任何真实SQLite对象差异回主控精确增量，不放宽schema、不重审旧S2a补签。
