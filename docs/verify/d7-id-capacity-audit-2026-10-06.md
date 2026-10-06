# D7 ID 审计与处置表

日期：2026-10-06。初审基线：`1d8925f7559bc648a2be288f2e9977336a4e0d17`；实施前对齐 `4855d0c3eec26a7bc5ac6a74dee684b5f2c051f7`，六处生产生成表达式及消费契约未被 D3 #418 改动。
只读代码与 Git/CI 元数据调查；没有读取生产或本地业务库，以下规模是容量设计假设，不是实测存量。
已确认 S1 范围见 [D7 spec](../plan/specs/d7-id-capacity.md)，验证阶段见 [收据](d7-id-capacity-2026-10-06.md)。

## 搜索边界及事实源

搜索 src、ops、evals、tests、schema/migrations 的 `randomUUID`、`randomBytes`、`randomblob`、`Math.random`、
hash/digest、id assignment、正则/length/slice/split/sort；再按生成函数追调用方、数据库写入和 reader。
不是只查 helper，也不读取依赖/产物/密钥或历史业务数据。
架构及实体/引用/报告/严格去重 spec、generation provenance、D1/C2a/C3/C2b/D2 与 ADR-0029/0038/0041/0042 是相关契约。

`UUID.slice(0,8)` 是 8 hex = 32 随机位；`slice(0,12)` 为 8 hex、固定连字符、3 hex = 44 随机位。
完整 UUID v4 去连字符有 32 hex 但 version/variant 6 位固定，有效随机量 122 位。
`randomBytes(2)` 为 16 位；随机 slug 前缀、时间戳或递增 index 不自动增加随机熵。
截断 SHA/UUIDv5/FNV 的输出宽度表示摘要空间，不是随机源熵；实际输入分布和碰撞后果须另看。

## 低熵随机应用对象：生成、规模与冲突

| 实体/字段 | 生成函数、调用方 | 当前来源/编码/有效位数 | 生命周期/假设与碰撞后果 | DB唯一/FK/冲突行为 | 候选处置 |
| --- | --- | --- | --- | --- | --- |
| Topic.id | validateTopicInput → admin/topics POST；PUT 经 existingId | `t_<slug≤30>_<randomBytes(2).hex>`，16 位/同 slug；显式配置或提交 ID 无随机性 | 长期配置；同 slug 100 次创建已非低碰撞风险，非 ASCII 名称会大量折叠成 `_` | topic TEXT PK；content topic JSON、source.topic_ids、batch/report/lead/direction 关联；POST 冲突409、PUT保留id | S2；同 slug 风险真实，但零付费 S1 不改 |
| Source.id | validateSourceInput → admin/sources POST/PUT | `src_<slug≤30>_<16位>`；显式/existingId不抽样 | 长期配置、同 slug 池；100/1000 次创建假设；PK冲突阻止创建 | source TEXT PK；content.source_id FK，采集/circuit/统计/provenance关联；冲突409 | S2；Source ID 进入模型 input |
| Run.id | runBudgetedJob ← runJob：collector.collectSource、pipeline.runAnalysis/runValidation/runReportGen；retryJob也调用runJob | `run_<UUID前8>`，32位；existingRunId不抽样；durable root在 provenance.claimGenerationDispatch 用完整UUID生成 | 累计 Run，多个阶段与失败重试共享PK；1千/1万/10万假设；插入冲突发生在fn前，业务不执行 | run TEXT PK，retry_of/run target/trace；usage与stage/review/funnel关联；insertRun抛错，不重试碰撞 | S1；只扩大短入口，不改 durable root |
| Analyzer candidate.id | analyzeChunk ← analyzeWithSplit ← analyze；filterByQuoteCoverage与onChunkComplete消费 | `ins_<UUID前12>`，44位；无id时citationCandidateId另用确定性fallback | 候选/coverage audit/checkpoint，1百万假设；候选映射冲突会混同审计 | display_coverage_candidate_audit 的 batch/candidate复合键；正式 Insight另重新派生 | S2，不能误当成唯一正式生成点 |
| AnalysisBatch.id | analyze（pipeline.runAnalysis、evals.run-a1/latency等） | `batch_<UUID前8>`，32位；在chunk/model调用前分配 | 批次长期积累，10万假设；batch冲突使整个分析落库失败；派生ins/event一同共享风险 | analysis_batch TEXT PK，Insight.batch_id、validation/cache/coverage/provenance/review绑定；saveAnalysisBatch事务失败 | S2；提升此根才提升正式 Insight/event 容量 |
| Report.id，成功 | buildReport ← pipeline.runReportGen | `rep_<UUID前8>`，32位，选择完成后分配 | 成功/失败报告共用PK空间；1万/10万累计假设；落库失败及产物发布必须仍拒绝 | report TEXT PK；prev_report_id、index、FTS、QA、effect/anchor/review/PPT；saveReport intent/publish协议 | S1；成功与失败同时覆盖 |
| Report.id，失败 | saveFailedReport ← pipeline.runReportGen 的不允许发布分支 | `input.id ?? rep_<32位>`；显式id原样，无抽样 | 保存失败尝试、重试追加；同report池；冲突不能覆盖已有报告或误发布 | 同PK；failed无artifact/index/FTS，普通reader不可见；afterSave同事务 | S1；保留显式ID与失败顺序 |
| FollowupQA.id/thread_id | reports/[id]/followup.POST 在 answerFollowup 成功后创建，saveFollowup | `fup_<UUID前8>`，32位；thread_id同id | 每问一条，1百万累计假设；answer已调用之后插入冲突500，不自动重复模型 | followup_qa TEXT PK，report_id FK；thread/turn关联；INSERT失败原样抛，route记录失败 | S1；不提前分配，不重试业务 |
| TechLead.id | upsertTechLeads ← pipeline.runTechLeadExtraction | `lead_<UUID前12>`，44位，仅 canonical_key 未存在时抽样 | 持久线索缓存+人工状态，1百万假设；PK冲突事务失败，无错误引用追加 | TEXT PK + UNIQUE(topic_id,canonical_key)；lead_evidence → citation复合FK，map/opportunity_lead；find→update保留id | S1；canonical_key不改 |
| TechnologyOpportunity.id | upsertTechnologyOpportunities ← pipeline.runTechLeadExtraction的机会阶段；reprojectTopicDirection | `opp_<UUID前12>`，44位；有lead的每个candidate（包括update）抽样，update覆盖为row.id | 持久机会/多方向，1百万假设；PK冲突回滚map与link | TEXT PK + UNIQUE(topic_id,canonical_key)，direction/topic FK，opportunity_lead复合关系；update不重新编号 | S1；保留既有多余抽样次数，避免夹带优化 |

## 上述对象的全部主要消费契约

| 对象 | URL/API/前端 | 文件/归档/通知/导出/恢复 | 格式/长度/排序 | 模型/引用/缓存/评测 |
| --- | --- | --- | --- | --- |
| Topic / Source | topics/[id]、topic brief/deep-dive、admin topics/sources GET/POST/PUT、settings/config | source IDs进入归档envelope、配置信息、源统计/provenance，Topic报告路径关联 | validate允许字母数字下划线连字符；未设ID长度上限（既有缺口，不在D7放宽/顺手改）；slug≤30，配置ID不必同格式 | renderItems 明确输出 source_id；topic.id 进入 analyze input/checkpoint/cache/hash，Topic数据也参与pipeline；需逐请求检查 |
| Run | admin Run列表/失败详情/retry、generation trace/graph/usage DTO；UI仅展示及透传 | logger/告警、cost/run targets、usage持久化、dispatch接管root复用；不作为报告文件名 | model_usage身份非空≤128；Run成本查询有ORDER BY id，不应把ID当时间；retry_of精确查询 | 不直接作为语义prompt字段；C3 AsyncLocal scope与C2b Map按runId；P1 stage投影含runId但不改fact算法 |
| Candidate / Batch / Insight / event | 复盘、图谱、报告引用、技术线索与validator batch | coverage与chunk checkpoints、analysis-cache rehydrate、report.insight_ids/event_ids、provenance/历史去重 | `ins_${batchId}_${i}`/`evt_${batchId}_${i}`派生；index不增加熵；report selection的insight.id tie-break；cache/PPT排序按insight.id；C4b只归一化旧格式 | event_id由renderHistory进入未来模型，历史白名单复用；candidate/batch不直接进入当前generation/coverage语义prompt；A1 insight ID hash及源码恢复身份受影响，不能笼统skip |
| Report | reports/[id]页面、reports列表/search、followup、pptx、admin review/redaction/retention；邻接报告链接 | `${id}.md/.html`，report_file:${id}，anchor `${id}-md/html`，通知href，PPT页脚report ID、ppt_polish_cache report_id，C1备份清单的body_path | report reader SQL精确绑定；safeTarget拒绝绝对/逃逸路径；anchor ID_RE拒绝slash/NUL/backslash/.与..；旧CLI /^rep_[a-z0-9]+$/无后缀固定长度；review显示cap128；没有需要统一为8字节的reader | Report生成是确定性渲染且不使用自身ID/prevReportId；邻接URL由app/reports/[id]/page.tsx生成；followup system包含同字节body_md与引用池而非report.id；PPT polish prompt/hash取Topic与Insight而非report.id，缓存以reportId绑定原公式 |
| Followup | POST/GET、followup-panel React key、markdown `cite-fup-${qa.id}`锚 | QA/thread JSON、answer_md及引用池编号，cost落库；无独立文件/恢复重编规则 | 主键/线程opaque string，排序created_at,rowid；question≤500、rate limit保留 | ID在模型完成后分配，不进入answer模型或judge；引用池content ID/[n]不改；未来多轮方案不在scope |
| Lead / Opportunity | leads/opportunities列表与[id]详情/status API、方向preview/reproject，React key/link | tech_lead_evidence复合引用、opportunity_lead、方向映射、provenance revision/edge、export-qualified/mapping/materialize/seal工具使用精确ID | status reader参数精确绑定；排序score/time，非ID顺序；方向输入id为显式字符串，不要求新随机格式 | derive函数确定性，canonical_key来自event/规范键不变；当前线索/opportunity流程无模型调用；导出/评测映射精确保留实例ID |

S1 已覆盖的真接线测试及未覆盖消费范围见专属收据；本表本身是审计证据，不单独证明运行兼容。

## 保留的完整随机对象

所有下列 UUID 均来自 Node `randomUUID`，完整保留或去连字符，122 位；不因32 hex误标为128位。
各表按 TEXT PK/tenant复合PK与业务unique/FK精确绑定，已有冲突拒绝或业务幂等投影保持不变。

| 生成模块及函数 | 字段/前缀与调用/消费 | 处置理由 |
| --- | --- | --- |
| db/provenance.ts 内部 id(prefix) | recordManualDecision、createDeepDiveTraceRequest、createScheduledTraceRequest、createSourceCollectTrace、createScheduledSourceCollectTrace、retryFailedTraceRequest 创建 trace/trace_req/dispatch/lease；claimSourceCollectTrace/claimGenerationDispatch 创建 owner，后者还创建完整root run | request幂等HMAC/scope与lease fencing是另一个协议；root Run格式已与短Run混用 |
| db/provenance-facts.appendGenerationEvent | evt_随机event row ID；stage wrapper/collector/manual trace调用；(trace,stage,attempt,type)重放复用原ID | 此evt_不是Analyzer语义event_id；generation ref/edge/checkpoint是精确键 |
| db/raw-archive.planRawArchive；db/reports.saveReport及两类effect/reconcile | effect_raw_、effect_、iae_；pipeline/startup调用，manifest/idempotency关联 | 已有122位；保留staging、失败恢复、每写guard |
| db/integrity-publication.id | integrity_maintenance owner、iae_ audit、anchor_effect_；anchor prepare/reconcile/daily root消费者 | 外部条件写/immutable signed binding与fencing不改 |
| db/integrity-checks内部persist | ic_；verifyArtifactIntegrity、runAutomaticIntegrityChecks | immutable artifact/version绑定，不改清单/哈希 |
| db/integrity-lifecycle 内audit与hold material记录 | ila_、ilh_；删除/hold/retention运维调用 | C1永久删除/复活拒绝及签名恢复契约保留 |
| db/deployment.recordDeployment | deploy_；record-deployment与生产入口读取 | 无容量改动需求；不执行部署 |
| db/source-credit-facts.appendSourceCredit / reconcileLateSourceCredit | scc_冲突、scr_调节记录；P1 pipeline/dashboard调用 | event/fact本身业务UUIDv5不是随机对象；append-only不改 |
| db/p1-metrics-facts 的appendFunnelEvent/appendCostLedger/appendValidatorResult/reconcileLateMetricEvent及内部conflict记录 | fec_、mfc_、mlr_；metrics pipeline/管理员调用 | 业务事实ID确定性，随机冲突/调节行独立；保留tenant/FK/唯一门 |
| runtime/model-usage.withUsageCall / beginUsageAttempt | 无前缀UUID logical_call_id / attempt_id；callStructured/实际SDK fetch | C3真实transport attempt身份与重放观测hash契约保留 |
| admin metrics页面与API/detail入口 | audit detail request_id无前缀UUID | 仅每请求审计标识；无需强制prefix |
| 客户端 deep-dive/topic-brief、lead/opportunity status、direction save/reproject | Web Crypto randomUUID 的 Idempotency-Key | 是请求的随机幂等token，服务端HMAC/租约重放决定幂等；不改header/API |
| db/repos.appendTranscriptAcquisitionFact | SQLite randomblob(16)生成 transcript_acquisition_conflict.id，128位输出 | 已足够宽；保留数据库随机协议，不迁入helper |

provider规范/运行环境未审计实际RNG内部实现；容量估算假设标准库输出符合其随机契约。
密码salt (`users.ts`) 与AES IV (`redaction-registry-writer.ts`) 是密码材料，不是对象ID；relay Math.random 是退避jitter，不改。

## 确定性、外部、派生及合成身份

| 分类/字段 | 实际构造与消费者 | 容量/稳定性与处置 |
| --- | --- | --- |
| ContentItem.id | normalize.contentItemId(normalizeUrl(url)) → SHA256前16hex = 64位摘要；rawToContentItem → rss/arxiv → collector/repository/citation | 同URL更新id不变，URL不同不等于hash绝不碰撞；1百万独立摘要假设p≈2.71e-8，但不是随机对象熵。若扩宽会改变内容身份和去重/引用/归档；本轮保留 |
| ContentItem.content_hash / raw digest / acquisition身份 | normalize.contentHash、podcast-evidence candidate/envelope hash、podcast-transcript-funnel fact key、podcast-screening身份、shadow-store | SHA256及规范输入；归档 target/quote projection/重复采集；同输入稳定，不引入随机 |
| citationCandidateId fallback / stableCitationRef | analyzer.ts 的 SHA256(statement + citation content_item_id/quote)前12hex摘要（48位空间），index在摘要外后缀，type不参与；content/locator/quote前20hex摘要（80位） | fallback候选与引用绑定，不是random ID；同内容稳定，位数不是输入熵；不得用新随机helper替换 |
| fingerprint / lead canonical / opportunity canonical | 严格statement/evidence规范化、event优先及词法key；opportunity key为 direction:${direction.id}:lead:${lead.id} 或 horizon:lead:${lead.id} | 公式不变；新lead自然派生不同实例key，已存在lead.id及其机会key不重新计算；人工状态复用保持 |
| cache IDs | analysis-cache(topicId/contentHash/version)、consistency-cache(statement/body/version)、ppt-cache(topic+sorted insights) 全SHA256 | 不改序列化、版本、排序和哈希；长随机report只改变新对象cache行归属，不改cache输入hash算法 |
| UUIDv5业务事实 | db/uuid.deterministicUuidV5：SHA1(namespace+name)截16bytes再设version/variant，122位摘要空间；P1 metric/source-credit producer | 同name稳定，不是随机122位；禁止用UUIDv4/hex随机替换 |
| idempotency / scope / effect key | HMAC(key)、topic/source/hour/window/period及 report_file:${report.id}、raw_archive:${contentId}:${sha} | 确定性协议，时间窗口不提供额外随机熵；公式不改，业务重放必须复用已有对象 |
| provenance refs / graph nodes/edges | type/entity_key/revision、citation(insight,index)、graphNUL复合串、rowid等 | 精确复合键与有界图，不是可统一改成随机ID的对象 |
| Controller replay/reconciler | event/evidence/ready/notification复合键 + FNV32 hash (`reconciler.ts`/replay) | 32位非加密摘要，已存在碰撞冲突fixture/拒绝协议；单独可靠性债，不能把hash宽度当random熵或顺手改 |
| historical Insight / semantic event | ins_${batchId}_${i}、evt_${batchId}_${i}；analysis-cache.rehydrate从batch/index重建；canonicalize复用历史event | 有效随机容量继承batch的32位，index只区分同批对象；保留历史event/ins原样与cache重建协议 |
| report派生artifact/anchor/QA anchor | report id + md/html/version、qa id + ref；index/FTS/FK用同值 | 无独立随机熵；路径字符门和字节签名保持现有算法 |
| provider/external ID | Responses response/item/call ID、Anthropic消息ID、S3 VersionId/key ID、Git SHA/digest/GitHub run/PR、runtime端口receipt task/lease identity、arxiv/RSS guid | provider语法与长度不同、有效熵未知；normalize用URL作为内部ci身份，不要求外部id匹配新格式 |
| auth/config静态ID | admin、user:${email}、source/topic YAML、default direction与人工 direction input | 业务/config自然键；无随机容量；不输出实际个人数据或配置内容 |
| INTEGER IDs | audit/metric/部分历史rowid；SQLite序号 | 不适用随机birthday估算；旧integer/query分页保留 |
| fixture IDs | src/*.test、tests/e2e/browser、eval合成fixture固定语义字符串 | 反例必须保留；不批量重新生成、不改成新格式掩盖兼容 |
| eval/probe文件对象 | a1-artifacts: a1-14位时间戳-UUID前8，临时pid+UUID前6（24位）；latency-ladder/stream-probe类似32位；ops/probe-alert Math.random 显示串 | scope由时间/目录/exclusive file协议划分，不能宣称时间增加随机熵；review-artifact-paths严格8hex，A1源码恢复绑定commit/dirty digest；本轮保留，不把诊断run当应用对象 |

## 容量假设与建议

对同一唯一键空间累计 n 个独立均匀随机值，birthday近似 `λ=n(n−1)/(2·2^b)`，`p≈1−exp(−λ)`。
当λ很小时p≈λ。不同prefix/slug池分开估算；Report成功/失败共享池；batch派生ID不能重复计额外随机位。
历史短ID与新32hex随机ID长度不同，候选格式本身不会命中合法旧短格式，但用户手动ID可以等于新值；PK仍必须存在。

| 位数/累计规模假设 | 至少一次碰撞概率（近似） | 用途 |
| --- | --- | --- |
| 16位，同slug 100个 | 7.27% | 自动Topic/Source |
| 16位，同slug 1000个 | 99.951% | 同slug批量配置上限例，不是当前存量 |
| 32位，1000个 | 0.0116% | Run/report/QA/batch池 |
| 32位，1万个 | 1.157% | 长期累计 |
| 32位，10万个 | 68.781% | 同池设计压力假设 |
| 44位，10万个 | 0.0284% | candidate/lead/opp |
| 44位，100万个 | 2.802% | 长生命周期风险 |
| 128位，100万个 | 1.47e-27 | S1新格式 |
| 128位，10亿个 | 1.47e-21 | S1保守设计规模，非增长预测 |
| 122位，10亿个 | 9.40e-20 | 保留完整UUID的空间参照 |

不以随机样本无重复证明容量安全，也不承诺绝不碰撞。此处没有生产量/保留期限实测。
如果要基于真实累计量设置阈值，另做仅脱敏聚合的只读容量测量授权；不为实施S1读取生产。

## 未处理风险与重启条件

- S2：自动Topic/Source和Analyzer的容量风险仍在。交接对应源码，明确模型输入长度、历史event白名单及A1身份保护后再实施；真实模型调用另确认范围/预算。
- ContentItem截断摘要与Controller FNV32：改动是身份/幂等协议设计，不能并入随机对象helper。
- eval run/temp：若未来并发规模形成可复现风险，先定义同目录/同时间桶容量及严格reader双格式，不以此PR代证。
- 既有输入未统一设置ID长度上限：本轮生成值严格有界，reader现有上限不放宽；另行输入治理不得破坏旧手工配置。
- 没有实测生产存量、全量provider格式、外部已下载报告/通知的第三方解析器；本地/CI只证明仓库可见消费方。
- 本审计不证明生产上线、完整恢复点或TD-20全部完成。

## 实施处置

用户已确认 S1 范围及共享表达式交接。上表“当前来源”保留审计时的旧实现：本次只将 Run、成功/失败 Report、FollowupQA、TechLead、Opportunity 六处默认随机生成改为固定前缀 + 16 bytes 小写 hex，128 位。其余生成点、确定性协议、reader、schema与历史 fixture 全部保留。TD-20 仍为切片完成，S2 未处理。
