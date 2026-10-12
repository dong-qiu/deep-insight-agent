# Observer registry：inactive 与 ordinal0 activation 候选合同

日期：2026-10-12。基线 `2fa99df0a560065bb5ff9585ea618c679929af05`。
状态：**新 registry-only 设计候选，未正式架构发布、未实施。真实 begin 证明生产方、业务 fingerprint、runtime activation、usage-observe、final/failed 均 unsupported。**

## 1. 范围、来源及唯一 owner

本合同只描述独立 observer operation 的持久预登记意图、激活存储形状及否定门。不运行 SQL、构造 registry 或业务 DB，不授模型调用、业务结果发布、源码接线或生产许可。[ADR-0047](../../develop/decisions.md#adr-0047-具名迟到账务与独立-usage-observer-operation) 的已接受方向不等于下面的新格式或实施批准。

原 ADR0045/46/47 architecture owner 的私有裁定 `806a9938d98ab729552fa42335e244e049986af807fa2430e64bc3efb90e2a8b` 接受 fresh root/header4/catalog、三处 storage 增量、严格七 fact、inactive 与独立 activation 方向；exact producer/业务断言/终态仍 deferred。裁定仅 private direction，不是正式 ADR。原 DB semantic writer 认领 receipt 仍为 null。

本两文档设计 author 唯一为 R3 S；架构旧文件仍 Dev owner，业务 schema/provenance/model-usage/terminal 与 caller W 不移交。本片不预留任何新源码/API 文件。后续源窗须主控另冻。新两文档归属及前置见[专属收据](../../verify/r3-r6-observer-registry-design-receipt-2026-10-12.md)。

必要实际源码小窗：`ops/maintenance/writers-v2.mjs` 10–32、65–84、109–129、134–189、203–257、280–289；`.d.mts` 1–44；`writer-control-v2.mjs` **1–10**；[S2b](r3-r6-s2b-fixed-domain-contract-2026-10-12.md) 35–60、91–105，SHA `5ba890fa20a4b8cb64934b757381ef5ff85ef09fbab9f0ec599a6091486a7196`。旧私有 source-index 对 control 的 11/12 越界引用不能作证；原 sealed18 不改。现有 finish 只结束传入 operation，没有 parent cascade；本合同保留该独立性，不声称修复不存在的 cascade。

## 2. 精确新 root 与拒绝兼容

提议 schema 字面量 `a3-writers-isolation-v4-usage-observer-v1`，catalog 字面量 `dispatch-usage-observer-v1`，registry `application_id=1093883698 (0x41335732)`、`user_version=4`。仅新的 exclusive root。default v2/header2 与 ADR0046 bind-header3 保持各自原格式；不自动识别 observer。没有 ALTER、原地升级/迁移、自动协商或 legacy fallback。

Marker 必须 canonical JSON、exact 八键（无 optional/额外键）：

```text
{schema,initId,ledgerMarkerHash,root,registry,targets,catalog,fixtureFingerprint}
schema = "a3-writers-isolation-v4-usage-observer-v1"
catalog = "dispatch-usage-observer-v1"
initId = canonical UUID
ledgerMarkerHash = original S0 nonzero lower-case 64-hex digest
root = exact {path,dev,ino}; path absolute real root, dev/ino canonical decimal strings
registry = exact {name,dev,ino}; name = "writers.sqlite"
targets = exact {business:"d2-business.sqlite",raw:"raw",report:"report"}
fixtureFingerprint = canonical JSON null (explicit unresolved slot) OR nonzero lower-case 64-hex digest
```

`fixtureFingerprint:null` **不是可初始化/打开的 runtime marker**。它只在文本候选/否定样例表达未决；任何 opener/initializer 在 SQLite constructor 前必须拒绝。即使填 digest，也必须有原 DB/schema owner 对 exact canonical business schema 的认领与绑定来源；否则同样 unsupported，不能凭字符串哈希放行。真实 fingerprint 来源尚未冻结，不能借七表 F、registry hash 或 schema48 版本号替代。root/registry 的所有物理 UID/mode/link/inode/S0 检查继续适用；本片不打开 root。

旧2/3 reader 必须在任何 SQLite constructor 前拒绝新 schema/header/catalog/键集。未来新 named reader 只读 explicit profile，先 marker/物理/header 资格，再 exact objects/FK/rows。不能将当前 openWritersV2 静默扩 parse。新 marker 的 NULL slot 拒绝要求也适用于 control；没有诊断读取旁路。

## 3. Literal proposed storage manifest

以下是完整 **文本设计**，不是已执行的 native identity。10 tables、20 triggers、12 autoindices 是逻辑预期；真实 sqlite_schema SQL、自动索引列、FK、headers 的逐对象 identity/hash 仍 UNKNOWN，实施后须绑定新 candidate 的独立 native 验证。没有 SQL 执行或旧 root 迁移。manifest UTF-8 JSON 文件 SHA256 `6e68d8306c8063e911ec79d5a07d31b23c7105c0d9307eb61fd5805266bc1503`；表/trigger SQL 字符串完全如下，数组顺序是文本 manifest 顺序；autoindex 的 `sql` 必须 native NULL，独立 `index_info/index_list` exact unique/partial/origin 检查，不能把下面列映射当 CREATE INDEX 语句。

```json
{
  "application_id": 1093883698,
  "user_version": 4,
  "tables": [
    "CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
    "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('open','closed')))",
    "CREATE TABLE workers (worker_id TEXT PRIMARY KEY, generation_token TEXT UNIQUE NOT NULL, entry_point TEXT NOT NULL CHECK(entry_point IN ('generation-dispatch','source-collect','startup','local-seed','raw-recovery','report-recovery')))",
    "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(worker_id))",
    "CREATE TABLE operations (operation_id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL REFERENCES tasks(task_id), invocation_id TEXT UNIQUE NOT NULL, scope_json TEXT NOT NULL, input_hash TEXT NOT NULL, recovery_of TEXT)",
    "CREATE TABLE steps (step_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(operation_id), step_key TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), input_hash TEXT NOT NULL, input_json TEXT NOT NULL, UNIQUE(operation_id,ordinal))",
    "CREATE TABLE bindings (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), target_kind TEXT NOT NULL CHECK(target_kind IN ('business','raw','report')), identity_json TEXT NOT NULL)",
    "CREATE TABLE step_results (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), business_commit TEXT NOT NULL CHECK(business_commit IN ('not_committed','committed','unknown','not_applicable')), filesystem_json TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('completed','denied','cancelled','unsupported','unknown')), reason TEXT NOT NULL, result_json TEXT NOT NULL)",
    "CREATE TABLE terminals (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), outcome TEXT NOT NULL CHECK(outcome IN ('completed','completed_with_diagnostics','denied','cancelled','interrupted_unknown','binding_completed','observer_settled','observer_failed')), first_reason TEXT NOT NULL)",
    "CREATE TABLE audit_facts (seq INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, fact_json TEXT NOT NULL)"
  ],
  "triggers": [
    "CREATE TRIGGER identity_no_update BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER identity_no_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER workers_no_update BEFORE UPDATE ON workers BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER workers_no_delete BEFORE DELETE ON workers BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER tasks_no_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER steps_no_update BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER steps_no_delete BEFORE DELETE ON steps BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER bindings_no_update BEFORE UPDATE ON bindings BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER bindings_no_delete BEFORE DELETE ON bindings BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER step_results_no_update BEFORE UPDATE ON step_results BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER step_results_no_delete BEFORE DELETE ON step_results BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER terminals_no_update BEFORE UPDATE ON terminals BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER terminals_no_delete BEFORE DELETE ON terminals BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER audit_facts_no_update BEFORE UPDATE ON audit_facts BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER audit_facts_no_delete BEFORE DELETE ON audit_facts BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END",
    "CREATE TRIGGER admission_no_reopen BEFORE UPDATE ON admission WHEN OLD.mode='closed' BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END"
  ],
  "autoindex_columns": {
    "sqlite_autoindex_workers_1": [
      "worker_id"
    ],
    "sqlite_autoindex_workers_2": [
      "generation_token"
    ],
    "sqlite_autoindex_tasks_1": [
      "task_id"
    ],
    "sqlite_autoindex_operations_1": [
      "operation_id"
    ],
    "sqlite_autoindex_operations_2": [
      "task_id"
    ],
    "sqlite_autoindex_operations_3": [
      "invocation_id"
    ],
    "sqlite_autoindex_steps_1": [
      "step_id"
    ],
    "sqlite_autoindex_steps_2": [
      "operation_id",
      "ordinal"
    ],
    "sqlite_autoindex_bindings_1": [
      "step_id"
    ],
    "sqlite_autoindex_step_results_1": [
      "step_id"
    ],
    "sqlite_autoindex_terminals_1": [
      "operation_id"
    ],
    "sqlite_autoindex_audit_facts_1": [
      "hash"
    ]
  }
}
```

相对 defaultv2 仅 steps 新 `input_json TEXT NOT NULL`、step_results 新 `result_json TEXT NOT NULL`、terminals CHECK8；其余七表/20 trigger 文本/12 PK-UNIQUE 定义不变。保留 `writer_v2_*` trigger 错误串不是格式 fallback。

SQL NULL 永远拒绝上述两个 NOT NULL 列。**canonical JSON 文本 `"null"`**（数据库中四个 ASCII 字符 `null`（UTF-8 `6e 75 6c 6c`））只用于明确给出的 per-step 占位，不是 SQL NULL，也不是缺键。Hash 定义沿现有 canonical：递归对象键排序、数组保序、无空白 JSON UTF-8 SHA256；不引入另一泛化框架。任何不认识的 step/key/fact/额外字段拒绝。

## 4. 私有原对象与 inactive preregistration

Exact observer scope：

```text
{kind:"usage-observer",parentInvocationId,attemptId,runId,traceId,claim}
claim = {dispatchId,traceId,ownerToken,claimEpoch,fencingEpoch,rootRunId}
```

parentInvocationId 使用原 registry admitted parent invocation UUID。attemptId/runId/traceId 必须是原合法 identity 原值；非空、有界的 JSON 值检查仅语法，不是业务资格。claim 两 epoch 正 safe integer，四 id 原字符串；traceId 与 scope/原父绑定一致。dispatch6、source-prelude7/source-bound7 不可互 cast。

建议具名 preregister path 从 **原 same-handle private parent operation cap + 原 bound target cap** 派生 owner/worker/generation/entry、原 AbortSignal、原 invocation/scope、真实 parent relationship。原 signal 使用 native brand/private mapping，Proxy/clone/新 Signal/不同 handle/DB getter/caller-provided path/hash/inspect 输出均拒绝。caller 不能自行指定 parent worker/epoch 代替原对象。此具名 path/API 尚未实现，真实 parent bind/begin producer 当前 unsupported。

child 使用同 worker/entry/generation 但独立 task_id/operation_id/invocation_id，各 UUID；recovery_of 为 SQL NULL（仅 operations 既有 nullable 列）。scope_json exact canonical，input_hash=SHA256(scope_json)。同一 owner worker + parentInvocationId + attemptId 只能有一个 child；换 runId/traceId/claim/新 invocationId 不能刷新同一 attempt。不同合法 attempt 仅经 canonical producer 独立身份来源才可另外登记，不是本合同的新重试权。

preregister 在 model initiation 前，以原 signal strict、registry open/physical/S0/generation/task/target/真实 claim/run/attempt 前置为门。业务身份检查缺口不得用 synthetic fixture 填空；业务 owner 未签时实际 preregister 也 unsupported。本合同可独立描述 **inactive 库存形状**，不签它已可执行。

确定登记事务只插入 child task/operation 与 `admitted` fact，同步 registry COMMIT，**0 observation cap/0 fetch permission**；未知 COMMIT 停止，库存可能有意图但不得重建 cap/调用模型/重复登记。第一次 admitted fact 必须引用先前真实 admitted parent（同 worker/entry/generation、原 dispatch usage 关系）；父后续 terminal 不删除关系或 child。

## 5. ordinal0 activation：严格存储形状与 unsupported 门

生命周期：`inactive → activation-eligible → active`；只有原 parent **nonreplayed begin 业务外层 COMMIT 与 registry ACK 均确定**，再独立 child activation registry COMMIT/ACK 确定才可能发 fresh observer cap。跨这两边界不是原子提交。begin replay/拒绝、preregister/begin/activation unknown 均 0 新 fetch/cap。

**真正 begin proof producer/receipt 的可执行格式尚未冻结，任何 activation 调用当前 unsupported。** 不接受 caller boolean、`replayed:false` 参数、复制 row/hash、注入 SQL/callback、七表 fixture 或旧 inspect 作为 proof。只有未来已签 producer 的原本地 proof object（同 handle 私有 brand、关联真实 begin/ACK/target）可进入实际 reservation；persisted hashes/下面字段是必要审计材料，永远不是足够的凭证。producer 不存在或不可鉴定，必须在 child step reservation 前拒绝，0 activation 行/0 cap。

提议 activation `steps` 行：

```text
step_key = "usage-observer-activate"; ordinal = 0
input_json = canonical exact {
  stepKey:"usage-observer-activate", scopeHash,
  parentInvocationId, parentBeginStepId, parentBeginInputHash,
  parentBeginResultHash, attemptIdentityHash, targetIdentityHash
}
input_hash = SHA256(input_json)
```

UUID/digest 非 optional；实际生成必须由未来真实 producer/core 从先前 ACK records/原 identity 内部导出。没有 placeholder hash、零 hash、字符串 false 可放行。**attemptIdentityHash、targetIdentityHash 的 canonical business semantic 格式 deferred；缺乏 owner 来源意味着该行不可实际写入。** 合同只冻结 registry storage 字段集合与否定门，不冻结业务 hash oracle。

提议 activation `step_results` 行：

```text
business_commit = "not_applicable"
filesystem_json = canonical [] (UTF-8 text "[]")
disposition = "completed"; reason = "observer_activation_acknowledged"
result_json = canonical exact {
  kind:"observer-activation",operationId,stepId,
  parentBeginStepId,parentBeginResultHash,
  businessCommit:"not_applicable",coordination:"acknowledged"
}
```

这是 **registry-only activation ACK**，不是 business COMMIT、actual paid network execution、模型调用或 costs 已知证明。result tag 为 core 写入的结果，不能接受 caller 把这段 JSON 传入制造 proof。binding 行与 step_result fact 在 **同一 registry 事务** 写入，COMMIT 成功后才可能产生原对象 fresh observer cap；SQLite COMMIT 抛错或进程死亡为 coordination_unknown，0 cap。ROLLBACK 清理不抹去可能已提交事实。

binding 提议 exact：`target_kind='business'`，identity_json=canonical `{kind:"observer-activation-binding",physical,parentInvocationId,parentBeginStepId,parentBeginResultHash,scopeHash,attemptIdentityHash,targetIdentityHash}`；physical exact `{path,dev,ino,parent}`，parent exact原root `{path,dev,ino}`。全部由原 target/private bound relationship 派生，`creation` 不伪称创建业务文件。原 preopen binding 的 creation 字段保持原协议，不套进 activation。原 domain business binding 断言缺口 deferred；physical identity alone 不能放行。

normal registry COMMIT 前须重验原 signal strict、registry open/physical/S0/generation/childtask+worker/原 target；真实 claim/current Run/attempt 断言缺 owner 时直接 unsupported。activation 即便具有正确存储形状，也不绕过这些门。

## 6. 每一 step 的 canonical NULL 与 FS 边界

| step / 状态 | input_json | result_json | 当前可执行性 |
|---|---|---|---|
| inactive，无 step | **没有 steps/step_results 行**；不写 SQL NULL 占位 | 无行 | 登记 producer 与业务前置未签，runtime unsupported |
| proposed open-business | canonical exact `{stepKey:"open-business",scopeJson}`，scopeJson 是原 canonical scope 文本 | canonical JSON `null` text；已有 typed FS list/result/binding 完整覆盖 | 新 profile opener/initializer 未实现；不改 oldv2 行 |
| proposed dispatch-bind | canonical JSON `null` text 只作为 **拒绝用 sentinel**；不可 hash 后 reservation | canonical JSON `null` text；不准 completed | input/proof/result 新profile映射未冻结，unsupported，0行 |
| proposed usage-observer-activate | 第5节 exact 输入；无 producer/hash oracle 拒绝 | 第5节 exact结果，只有 ACK 成功才记录 | 当前实际 activation unsupported，0行/cap |
| usage-begin/usage-observe/final/failed/其它 step | 不提供可写 payload；拒绝未知 key | 不提供可写 payload | unsupported，不创建 reserve/result/terminal 行 |

不能从 storage 增加字段推导已冻结全部 domain 语义。只有上表 dispatch-bind 的 **input_json null sentinel** 为否定样例，永远不发该 bind reservation；它与 open-business 合法 completed 结果的 result_json canonical null-text 是不同字段及不同具名规则。open-business 的真实 FS/result/creation binding 仍完整保真，activation completed 必须第5节非null exact object；已登记未知状态也不能伪造 completed result。真实 FS effects 仅既有 create/open/configure 的 actual occurred/not_occurred/unknown，activation 不执行 FS，因此固定 `[]`，禁止拿 FS json 保存 domain metadata。

## 7. 七 fact 的 exact payload 与双向覆盖

所有 audit records 沿现有 `seq,previous_hash,hash,fact_json`，seq 连续、初始 previous_hash 全零，hash=SHA256(canonical `{seq,previousHash,fact}`)。除下面所有字段外任何额外/缺失键拒绝；canonical 字符串还须 parse 后再 exact 校验。`cover(table,primarykey,完整行)` 必须唯一、未重复、整行等于 fact；遍历完成时，cover 集合严格为 identity、workers、tasks、operations、steps、bindings、step_results、terminals 八张表，每行恰好一次。admission 单独核 singleton id=1、mode open/closed 与唯一 closed fact 的永久状态机一致性；audit_facts 单独逐 seq/hashchain 及 exact payload 全遍历，不要求递归 cover 自身或为 admission 虚构新 fact。正确 hashchain 不接受孤儿/多行/遗漏/重排。

| kind | exact 字段（均含 kind） | 完整覆盖与顺序 |
|---|---|---|
| initialized | marker | seq1；完整 identity 行；marker exact匹配捕获root/registry |
| registered | workerId,generationToken,entryPoint | workers fullrow，open且已init；固定六entry不增加observer worker类型 |
| admitted | taskId,workerId,operationId,invocationId,scopeJson,inputHash,recoveryOf | tasks/operations fullrow；registered先于admitted；parent relation先存在，原对象派生；child recoveryOf JSON null映射 operations SQL NULL |
| step_reserved | stepId,operationId,stepKey,ordinal,inputHash,inputJson | steps fullrow含input_json；admitted先于reserve且未terminal/open；preopenordinal0或本合同具名activationordinal0；usage域unsupported拒绝 |
| step_result | stepId,businessCommit,filesystemJson,disposition,reason,resultJson,binding | step_results fullrow含result_json；reserve先于result且operation未terminal；binding为JSON null或 exact `{targetKind,identityJson}`，映射 bindings fullrow；一次结果/绑定 |
| terminal | operationId,outcome,firstReason | terminals fullrow；operation与所需step/results先存在；不能由父finish/取消/缺final伪造final |
| closed | previousMode,nextMode | 原 admission open→closed，永久；closed fact与mode一致，禁止重复reopen |

对 proposed activation，validator 必须校验第5节 exact inputs/result/binding、scopeHash/claim/run/trace/attempt 相同、parent begin step/result 在 child reserve 前已 ACK、非replayed、真实已commit且同worker/owner/target。不存在 genuine producer 即拒绝，不用 hashchain 当 producer。result `not_applicable/completed` 只对该具名 registry activation可用；preopen completed必须business committed+原真实creation binding。`binding:null` 只用于明确拒绝/unknown的结果，不让 completed activation无绑定。

诊断 result schema沿本表 exact字段：denied/cancelled/unsupported/unknown 且没有已确认 domain result 时，`resultJson` 固定 canonical `null` text。这项诊断规则不排除第6节明确允许的 open-business completed/committed 结果使用 null-text；后者靠完整 typed FS/result/creation binding 覆盖事实。activation completed 只可第5节 exact object，不可 null-text；unsupported bind sentinel 仍0行。filesystemJson 为 actual list，businessCommit必须保真，不能把 committed改成unknown或not_committed来符合parse。任何 activation completion之前的 ambiguous reservation/ACK不得写虚假 completed；真实步骤 unknown 可存 interrupted_unknown或缺terminal库存，但必须有合法诊断write权限，不能为填写终态穿过closed/loss。

parent begin 的可执行 `step_key` 和业务 result格式仍unsupported：七fact validator不因为引用parentBeginStepId就接受任何填得像begin的行。现有profile4候选不能实际产出一个真实begin链，因此runtimeactivation仍禁止。将来须新scope/producer合同精确扩展，不能直接以本表开放usage-begin。

## 8. terminal namespace、库存与失权

CHECK8 为 storage namespace。**observer_settled/observer_failed 当前没有可执行终态谓词，禁止写入**；不能用cancelled/denied代替缺final。binding_completed同样依赖尚unsupported bind映射；completed/completed_with_diagnostics只适用于明确完整的preopen规则，不表示dispatch完成。

inactive 确定拒绝可建议 denied/cancelled，但只能写真实第一首因/有权安全诊断，不能由caller任意finish伪造。缺step的 interrupted_unknown只有明确原登记/证明协调未知证据且未来专属谓词已签才写；现在缺对应终态契约时保留无terminal的unknown库存。任何缺pendingresult或dispositionunknown只能保留interrupted_unknown/unknown，不能completed/observer_failed。

父 `finish` 只给父 operation terminal。child scope关系不要求parent未finished；inactive/active/unsettled child保持独立，Job取消及时返回，不await child、不后台SQLinterval。父terminal不证明真实claim仍owned：close/leaseclaim/generation/task/targetphysical失权仍阻断futureconsumer，缺final及真实已报cost保留known/partial/unknown，freshrecovery另鉴定不恢复旧cap。

建议 future control snapshot exact top-level：`{schema,scope,admission,workers,operations,steps,bindings,observerInventory,writer_quiescence,drain_ready,production_permitted}`，schema字面量 `a3-writer-admission-v4-observer-candidate`，scope isolated，后三flags始终false。行投影无cap，exact键如下，字段值须与已验证 storage fullrow 一致：

```text
workers[] = {worker_id,generation_token,entry_point}
operations[] = {operation_id,task_id,invocation_id,scope_json,input_hash,recovery_of,terminal}
terminal = JSON null (无 terminals 行) OR exact {operation_id,outcome,first_reason}
steps[] = {step_id,operation_id,step_key,ordinal,input_hash,input_json,result,observed}
result = JSON null (无 step_results 行) OR exact {step_id,business_commit,filesystem_json,disposition,reason,result_json}
observed = "recorded" (存在 result 行) OR "unknown" (不存在 result 行)
bindings[] = {step_id,target_kind,identity_json}
```

terminal.operation_id必须匹配所属operation；result.step_id必须匹配所属step；recovery_of投影为原nullable列对应JSONnull或原字符串。无行的投影 JSON null 不表示数据库存有 SQL NULL 行，也不同于存在 result 行中 `result_json` 字段保存 canonical `null` **文本**。这些投影只导出事实，不发cap；unknown result即便observed=recorded也不意味着业务完成。

observerInventory每项 exact `{operationId,parentInvocationId,attemptId,state,pendingStepId,reason}`；state `inactive|active|settled|failed|unknown`，pendingStepId为实际未ACK UUID或JSONnull，reason为明确boundedcode或JSONnull。

active仅具名activation ACK known且无terminal/pendingunknown；无genuinebeginproducer时不得出现可执行active。settled/failed只在未来精确终态谓词签后可由合法terminal导出，目前unsupported；不识别/未ACK/死亡缺证据只能unknown。无step且有合法admitted intent可显示inactive，但不是authenticated cap。control读取仍须新profileexactreader、open→closed永久事实，物理失权不能diagnostic-open旧DB补读；closed/unknowninventory不签quiescence/drain/production。当前所有新control行为未实施。

## 9. M1 窄取消、锁序与事实保全

preregister、activation、preopen、usage-begin、terminal及其它普通消费者一直严格原 AbortSignal；换新signal/clone私有cap拒绝。具名usage-observe只有原confirmed-started attempt+fresh原observer可在取消或父localfinish后记真实迟到账务；这是ADR0047方向，**本片usage-observe仍unsupported**。激活ACK单独不证明真实模型已开始，不授新fetch/retry/结果publish/claimrevive/repricing/费用归零。

原取消首因与非取消stickyfailure不得互相覆盖。提议私有cancelCause/failureCause分列，immutable result reasons保真；其未来业务结果字段尚未冻结，不将旧firstReason宣称已实现新分列。maintenanceopen、physical、generation、实际task/leaseclaim/currentRuntraceattempt始终强制；begin.running与七表SELECT绿灯不等lateobserveRun政策。

registry→S0→business固定锁序；S0同步txn结束后才businessBEGIN，业务用原同连接outerCOMMIT再registryACK。真实fetch只在锁外，返回后重验；所有写txn不跨await，反向业务txn拒绝，不新增genericgate/callback/SQL框架。不承诺两个operation或多库全局原子。begin COMMITknown但ACKunknown、activationACKunknown都0newfetch/cap，保真实committed与coordinationunknown；清理rollback/父finish/inspect不能改成未提交或已激活。若close已胜而无诊断写权，只留既有事实/unknown库存，不为完成收据再开旧writer。

## 10. 验收与后续最小片

本合同文档验收：两fresh非作者新合同最多两轮；冻结2SHA/fullmanifest，核格式/相对链接/来源小窗，0native/SQL/模型/CI。不可用旧S2a/S2b评审第三轮补签。本文不是真实activation可实施收据。

未来 registry-only候选实施需另外正式architecture决定与core/source/control exactsoleowner窗口、完整native新schema identity和否定路径。业务observer实施另需原DBsemanticowner实名认领、businessfingerprint/model_usage schema、genuineparentbind/beginproducer私有proof接口、UsageIdentity9、observationnumber/final/pricing/currentRun及sameconnection断言。未齐备只可验证否定门或明确typedsynthetictext形状，不能签真实usage/activation/observer系统完成。

| 路线（本片均未执行） | 正/反要求 |
|---|---|
| 兼容 | old2/3对newmarker/schema/catalog在constructor前拒绝；nullFingerprint拒绝；0ALTER/fallback |
| identity/preregister | clone/newSignal/foreignworker/parent/hash/target拒绝；duplicate parentattempt换ID不刷新；inactive0cap0fetch |
| 激活 | 未来genuine非replayedbeginCOMMITACK之后，独立not_applicableactivationACK才cap；当前无producer0行/0cap |
| 两个unknown边界 | begincommitted+ACKunknown保committed；activationCOMMITunknown保unknown；0fetch/SQLreplay/inspectrestore |
| audit/schema | 完整10/20/12newnative逐对象；canonicalJSONnull-text vsSQLNULL；hashcorrect orphan/extra/reordered/inputresultbinding差异拒绝 |
| 生命周期 | parentfinish不childsettled；真实close/leaseclaim/death拒绝futureconsume保partialunknown；无final不failed/settled |
| 业务观察 | reported原价格/幂等conflictstale、真实number/final/currentRun未来DBowner及新CI；本片unsupported |
| 并发 | 原Signal取消前/激活前strict；确认开始后late账务M1保首因/费用；逆锁/await写txn拒绝，0新fetch权限 |

下一片由主控决定是否发布本两新候选文档/正式architecture增量，或精确补未决producer/DBowner；不自行改旧ADR/源码。所有hold435、safe_rollback=null、deployment blocked、全writer/drain/productionfalse继续。
