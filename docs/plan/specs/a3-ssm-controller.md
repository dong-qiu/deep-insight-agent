# A3-S4a：隔离执行控制器与 SSM 响应消费（方案，尚未实现）

## 基线、授权与冻结对象

2026-10-08 重新 fetch 的 origin/main 为 `8d8ac91e699651c761e82cd82113db29823511b4`；
精确 push CI [37709253322 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37709253322/attempts/1)
已 completed/success、head 相同。本方案不把 S3 #453 候选或其 CI 中状态写成主干交付。
S0/S1/S2 已交付范围分别以其专属原收据和协调者精确主干索引为准；旧文档的未合入时点保留。
本轮只新增本 spec 和私有交接索引，交两位独立 Reviewer 审方案后再决定是否实施。

目标是一个真实隔离本地 CLI 消费 **AWS API 字段形状**，通过既有 S0 真实 ledger 持久化
submit unknown、command binding、plugin observation、cancel requested 与 hold。
不修改 S0 schema/方法/签名，不接 AWS SDK/CLI，不调 network transport，不发送任何命令。
没有任意 shell、AWS-RunShellScript payload、可插拔 execute callback 或可解锁生产的 transport。
它是逐事件、无后台 poll/自动重试的隔离控制器，不冒称原生产 SSM shell 已改造成受控入口。
fixture 的 deploy/backup/restore kind 是互斥标签，不执行备份、迁移、恢复或部署。

生产 #435 的 workflow/policy/gate、safe_rollback=null、hold 和恢复启动阻断逐字保留。
全 writer 未覆盖、静默/子工作终止未知、候选安全/生产数据及实名人员未核均保持阻断。
本阶段模型预算 0；没有 AWS/SSM 访问或 dispatch、生产维护、配置覆盖、历史回填授权。
不使用历史 spec 的旧授权文字覆盖当前用户允许的本地工程/正常 PR 合入范围。

## 文件归属与独立环境

执行 Agent A 唯一写入新文件窗口（实施前还须协调冻结）：

| 文件 | 职责 |
| --- | --- |
| `ops/maintenance/ssm-response.mjs` / `.d.mts` | 有界、纯解析固定 SSM profile，输出脱敏、typed 投影；零 I/O、零 ledger mutation |
| `ops/maintenance/controller.mjs` / `.d.mts` | S0 真实调用与固定动作编排；无外部 transport、无自动重试/解锁 |
| `ops/maintenance/controller-cli.mjs` | 唯一具体隔离入口；stdin 有界、动作白名单、脱敏输出与 fail-closed exit |
| `ops/maintenance/ssm-response.node-test.mjs` / `controller.node-test.mjs` | 纯协议及真实 CLI/双进程/SIGKILL/SQLite/CAS 反例 |
| 本 spec / `docs/verify/a3-ssm-controller-2026-10-08.md` | 冻结验收及逐 head 原始交付证据 |

现有 ledger/contract/cli/writers/drain/runtime/provenance/业务 schema、policy/gate/workflow、
所有 `ops/aws/*` 和 p0-forward-observation 均只读；主台账 root-only。
S3 十文件仍由原 owner 冻结，本片不得接手/复制其未提交内容。
worktree `/Users/dongqiu/Dev/code/insight-agent-a3-ssm-plan-20261008`、
branch `docs/a3-ssm-controller-plan-20261008`、PORT=3125；仅按 AGENTS 复制所需 `.env.local` owner0600，
DB_PATH/DATA_DIR 改为本 worktree `.isolated-a3-controller/` 自有路径（根/data0700）。
不复制 .data/live DB/WAL/报告/.env.development.local，不输出配置值；测试用 env-i 不加载本地密钥。
私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a3-ssm-controller-plan-20261008/` 0700，
raw/source/index0600，O_EXCL 非覆盖；方案阶段不创建或运行业务库/服务器。

## 原始调用链与实际缺口

1. `ops/maintenance/cli.mjs` → `openLedger(root)` → 真实 append-only snapshot transaction。
   `beginSubmit` 先持久 state=submission_unknown、submitToken、requestHash，然后现有
   `submitFixtureOnce` 才调用 mock transport；本片不调用/改该 mock helper。
2. `bindCommand` 绑定 command UUID 与完整 local binding；`observe` 保存观测并处理冲突终态；
   `cancel` 只记取消请求；`hold` 粘性阻断；owned/current revision/target/fence 检查与 pre-BEGIN
   filesystem/marker/inode/hot-journal 顺序由既有 S0 真方法负责，不在 adapter 旁路复制持久状态机。
3. `.github/workflows/deploy.yml` → security-release-gate → always() 非零退出，无 AWS 配置/SSM。
   `ops/aws/deploy.sh` exit2；不能在本片恢复旧生产动作。历史 SSM 包装在 seed/probe/setup 脚本中，
   不共同消费维护账本，且有生产写入副作用。本轮盘点不运行它们。
4. `ops/p0-forward-observation.mjs:invokeAggregate` 实际旧链为 aws send-command 后轮询
   get-command-invocation，有限失败/timeout；没有 S0 持久提交屏障。它是独立原工具，不修改、不调用，
   本方案不会把其旧成功/timeout当新的 controller 验收。

AWS 响应没有本地 owner/fence/revision/volume/executionIdentity/requestHash 字段；不能
把 response 的 CommandId 相同推成完整维护关联或云身份真实性。S0 target 固定 isolated/fixture-，
实际 AWS i-/mi- 节点不能直接变成 S0 生产 target。下述合成 wire profile 是显式桥接，
不是偷偷扩展 targetSchema 或生产允许范围。

## 固定隔离 profile 与公共 v1 接口提案

版本 `a3-ssm-controller-v1`，scope=`isolated-response-consumer`。
只接受初始化完整 S0 根与 profile target：region=isolated，instanceId=`fixture-controller-node`，
volumeId=`fixture-controller-volume`，dataPath=root，serviceSet=[`fixture-controller`]；
executionIdentity=`fixture-controller-v1`。operationId/ownerId/kind 沿 S0 原 schema。

wire profile 固定、深冻结于新模块，不能由 stdin/env 覆盖：
`InstanceId=i-00000000000000000`、`DocumentName=InsightA3FixtureRecordOnly`、
`DocumentVersion=1`、`PluginName=fixtureRecordOnly`。节点 ID 仅符合 AWS 字段语法的合成占位，
没有对应节点/自定义 document 存在或实际调用的声明。本片任何地方都不将 descriptor 送到 AWS。
不使用 AWS-RunShellScript，也不生成 commands 参数。fixed payload 为 JSON record-only 描述，
commandHash=SHA256(canonical({schema:"a3-fixture-controller-payload-v1",execution:"record-only"}))；
这是 S0 原 beginSubmit 输入，不新增历史持久字段或改变其 hash 算法。
Comment 固定 `a3:<submitToken>:<requestHash 前 56 hex>`（96 字符），由原 operation 推导，
不接受 caller 指定 Comment。它是离线关联提示，不是服务器认证或不可伪造 credential。

类型只服务新未发布接口，复用 S0 token/binding 的实际字段，不反向依赖 app/runtime：

```ts
type ControllerAction = "stage-submit" | "receive-send" | "receive-invocation"
  | "stage-cancel" | "receive-cancel" | "interrupt" | "resume";
type ControllerInput = {
  schema: "a3-ssm-controller-v1";
  token: MaintenanceToken; // immutable ingress copy: owner/fence/revision/full target/executor
  event?: { outcome: "response"; body: unknown }
        | { outcome: "unavailable" }; // parse/network/error/response-loss never fabricated Pending
};
type ControllerResult = {
  schema: "a3-ssm-controller-v1";
  production_permitted: false;
  ready: false;
  termination: "unknown";
  outcome: "recorded" | "accepted_or_replay" | "blocked";
  token: MaintenanceToken | null; // allowStale methods never export a current token
  hold: "recorded" | "unconfirmed" | "not_attempted"; // this step only; not future-state proof
  commandId: string | null;
  observedStatus: MaintenanceStatus | null;
  reason: string | null; // fixed sanitized code; never native/remote message, output or input
};
// Pure parser functions return typed, minimal facts; full local Binding passed by controller.
parseSendResponse(body: unknown, expected: FixedSubmitContext): { commandId: string };
parseInvocationResponse(body: unknown, expected: FixedCommandContext):
  { commandId: string; status: MaintenanceStatus; responseCode: number };
parseCancelResponse(body: unknown): { acknowledgement: true };
// Controller owns the handle; no supplied callback, transport, arbitrary ledger or native DB.
runControllerStep(root: string, action: ControllerAction, input: ControllerInput): ControllerResult;
```

具体入口 `node ops/maintenance/controller-cli.mjs <canonical-isolated-root> <action>`，
stdin JSON 单事件、最多 65536 bytes；读取期间按 chunk 累加bytes，达到超限立即停止并固定throw，
不先readFileSync(0)无限分配再检查。JSON/field/type/extra top-level input/动作错均拒绝。
纯 parser 验证普通 JSON 对象与有界深度/字段长度，AWS 文档范围外附加字段不用于身份/状态；
不得保存/输出 StandardOutputContent/StandardErrorContent/URLs/Comment 原文或远端 error message。
APIResponse body 可允许 AWS 已文档化非消费字段，但 projection 只返回上述最小 typed facts；
不把未知 status/错 expected 核心字段忽略。parser 不从 body 构造 local owner/fence/requestHash。

每次 action openLedger 后 inspect 复核完整 marker/profile；取 immutable ingress token，
核 state.active/op/未 released、完整身份与当前 revision，禁止从 inspect 自动刷新失联旧 owner。
任何 ledger 方法变更仍以该精确 token 做原事务内 CAS；pre-inspect 不是原子执行许可。
新 controller 不接入 acquire/init/authorize/complete/release/takeover，既有 S0 CLI 初始化/登记为前置。
新 controller 的 callable surface 与 CLI 均无生产 transport，也不返回可执行命令字符串或 ready。

## 真实 API 形状消费与严格边界

SendCommand 的成功 JSON 在 Command 对象中给出 CommandId，可含节点列表、document/version/comment；
请求支持多个节点及 tag Targets。首片只消费 singleton InstanceIds 精确固定 wire 节点、Targets 空/不存在、
正确 document/version/comment、合法 UUID 的响应；聚合 Status 绝不送入 ledger.observe。
此为保守单节点 profile，不承诺接受 AWS 所有合法多节点/tag 返回。
[SendCommand API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_SendCommand.html)。

GetCommandInvocation 的 response 是插件级，按 CommandId/InstanceId/DocumentName/DocumentVersion/
PluginName/Comment 全部精确绑定。ResponseCode 为安全整数；Success 必须 0，未运行 -1 不能算成功。
API 存在最终一致性，InvocationDoesNotExist/读取失败记 unavailable，不能伪造 Pending 或未发送。
Status 和 StatusDetails 不等价，不能把 aggregate success 当单插件成功。
[GetCommandInvocation API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetCommandInvocation.html)。

仅允许下列明确 conservative pair（不是新的 AWS 全量状态定义）：

| Status | StatusDetails | 原 S0 observation |
| --- | --- | --- |
| Pending | Pending | Pending |
| InProgress | In Progress | InProgress |
| Delayed | Delayed | Delayed |
| Cancelling | Cancelling | Cancelling（非终态） |
| Success | Success，ResponseCode=0 | Success（仅 terminal_pending） |
| Failed | Failed，ResponseCode 非0 | Failed |
| Cancelled | Cancelled | Cancelled |
| TimedOut | Delivery Timed Out | DeliveryTimedOut |
| TimedOut | Execution Timed Out | ExecutionTimedOut |

其余/缺 details/错配/新状态，包括 InvalidPlatform/AccessDenied/Undeliverable/Terminated 若不在该
保守配对内，一律 observation unknown+hold，不猜 Status 与 details 的 AWS 未明确配对关系。
S0 原 enum 仍存在，不修改；未来必要的新 pair 须独立精确来源与验收冻结，不放宽当前许可。
Status terminal 只是特定插件观测，不证明派生进程/本地控制器/暂停 continuation 停止。
[AWS 状态层级](https://docs.aws.amazon.com/systems-manager/latest/userguide/monitor-commands.html)。

CancelCommand 成功 HTTP body 为空；AWS CLI/SDK 的 normalized body 可为 `{}`。
首片 event.body 只接受 null 或无 own keys 普通对象，代表已规范化空响应，不消费 status 字段。
它只给 acknowledgement，不调用 observe、不写 terminal、不清 hold。取消可能不终止底层进程。
[CancelCommand API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_CancelCommand.html)。

上述 doc 字段/状态只验证协议形状；合成实例、document 与离线 body 没有真实 AWS 凭据/资源/响应签名。
Comment/requestHash 关联也不证明云读取来源。不得将本测试写为真实 SSM 执行、终止验收或生产就绪。

## 固定动作与失败持久语义

| 动作 | 实际 S0 调用及事实 | 退出/保持阻断 |
| --- | --- | --- |
| stage-submit | 仅 active pre_submit + fresh token；fixed commandHash → beginSubmit，先持久 unknown；返回 token/关联摘要 | 不发送；重复/restart/unknown 不再 beginSubmit，不返回重新发送资格 |
| receive-send | unknown + fresh token，纯 parser 核 fixed wire/full local context → bindCommand一次 | 输出accepted_or_replay/token=null，不消费method返回revision；wire失败一次strict hold，unknown不补造、不重发 |
| receive-invocation | 已知command；非终态仅observe一次；终态先strict ingress hold(ssm_terminal_unverified)，成功token仅用于一次observe | observe返回token一律丢弃，不再hold，不导出新authority；终态pending/held，无authorize/complete |
| stage-cancel | submitted/running + fresh token → cancel | 只记 cancel_requested，不发送；后续取消响应不证明停止 |
| receive-cancel | cancel_requested + fresh token，验证空 acknowledgement | hold(ssm_cancel_not_termination)，不调用 observe；仍允许 fresh 同 op 后续纯观测 |
| interrupt | fresh token → hold(controller_interrupted) | state/command/submit facts 原样保留；不 abort remote、不自动释放 |
| resume | fresh token，inspect 后 hold(controller_restart_unknown) | 无发送/重新开始/自动核终态；已 held 精确 replay 可只读退出 |

每次唯一同步 step，无 await/后台任务/持长 SQLite 锁/自动 poll；新事件显式带 fresh revision。
成功 CLI exit 只表示本地记录动作通过，所有结果 ready=false/termination=unknown/production=false。
held 后拒 stage-submit/stage-cancel；可以 fresh 精确身份 receive-invocation 仅登记补充观测，
原 hold 永不清除。旧 token 的任何新 mutation 拒绝，不自动从当前状态生成新 token 给旧 continuation。
S0 bindCommand/observe 是 allowStale 方法，精确重复不变 audit/revision却**返回currenttoken**。
controller不能从preinspect、returnedrevision>ingress或postinspect推己赢：同event两调用都过precheck，
赢家推进而输家replay也拿一样newrevision。两方法成功统一输出accepted_or_replay/token=null，
不得返回其token，也不得内部以该token作后续hold/任何mutation；observedStatus只表示accepted观测或
精确已有观测，不冒称该调用新写。该action结束，没有后台continuation或自动next action。

终态固定顺序为 pure parse → strict **ingress** hold(ssm_terminal_unverified) →仅这次strict成功返回token
用于同step一次observe。hold即使reason已存在no-op也先原strictowned/currentrevision，因此返回token来源
是确实通过本步strictCAS，非allowStale的返回；observe返回结果丢弃，最终输出token=null/accepted_or_replay。
hold之后observe失败保持已记录hold；任何observe异常都不再hold/refresh/retry。不同terminal冲突由原observe
持久 terminal_conflict，原primaryreason保持，不能把失败变成功。动作不提供管理员解除；现有S0签名人工
协议不是本片自动路径。两个成功步骤非crashatomic：hold已提交而observe没提交可留原观测，始终阻断。

其他仅strictCAS单方法动作(stage-submit/stage-cancel/interrupt/resume/receive-cancel、wirefailure hold)
可输出已知本调用strict成功返回token；只读no-op replay使用immutable ingress，不用inspect/currenttoken。
收到receive-send/receive-invocation的token=null后，下个合法事件须独立显式operator读取S0当前状态，
核owner/phase并另给fresh token；controller不向旧continuation提供自动inspect/refresh接口。这样不会区分
S0无法表达的winner/replay身份，不改变原ledger方法或历史schema。

错误分区冻结：
- outer JSON/schema/action/token（包含未知字段）、root/marker/open失败，或ingress目标/owner/fence/revision
  无可信fresh关联：module固定脱敏throw，CLI非零，仅errorcode，无ControllerResult、无token、无hold。
  绝不从inspect或body补造token让无效输入满足返回类型。
- 合法outer+已核fresh输入，仅wirebody解析/不可达/缺response失败：最多一次strict ingress hold(固定reason)。
  hold COMMIT返回则blocked/token=该strict返回token/hold=recorded；CLI非零。hold若CAS丢失/文件或handle
  失败，blocked/token=null/hold=unconfirmed，保原wireprimaryreason，不二次hold/刷新/foreignhold。
- 实际S0动作已开始后其CAS/handle/terminal_conflict异常：保持该方法fixed primarycode，blocked/token=null；
  不泛化catch再hold。此前本stepstrict hold确认成功时hold=recorded，否则unconfirmed/not_attempted，
  只表示本步已知COMMIT事实，不能由diagnostic inspect填已持久。诊断再失败也不覆盖primaryreason。
- 没有错误的strict动作recorded，allowStale动作accepted_or_replay；所有blocked/throw为CLI非零。

原S0事务CAS在实际mutation再核。并发revision/owner/fence丢失或ledger文件/marker/handle失败不能
catch后刷新token/改写他人hold；原材料保全，diagnostic读不是后续mutation的authority。
observe 的 terminal-conflict 可能已持久新 revision/hold 后抛错，不能泛化 catch 用旧 revision 再 hold
或重试；primary maintenance_terminal_conflict 保留，必要只读诊断失败也不遮蔽，不返回其currenttoken。任何无法持久 hold 的情况仍阻断，
不得伪报 durable hold 已成功。beginSubmit 成功→response/hold 失败是非跨步原子，原 unknown 保留。

本地输入/进程等待没有远端 timeout 语义。fixture driver 在独立测试可暂停/stdin 延迟或 SIGKILL
来模拟 response-loss/continuation；生产/外部 transport timeout 与独立停止证明仍缺。
未来若添加 transport，先持久 unknown→发送边界暂停→人工释放→迟到发送的 race 无法由 S0 CAS
撤销：本片不发送，因此只验迟到本地 mutation 被 CAS 拒绝，明确不声称已 fencing 真实 SSM 提交。

## 验收矩阵（未运行，必须先红后绿）

1. 真实 CLI 调用新增 controller→原 openLedger/beginSubmit/bind/observe/cancel/hold；不用替身状态机。
   原 enum、schema/version/audit、#435 三文件、deploy拒绝入口 hash 与 base 对照不变。
2. stage-submit 持久 unknown 后 SIGKILL/重启：command=null、operation/audit 保留，resume hold，
   重新 stage-submit 非零；独立子进程同 fresh token竞争只一次 unknown mutation，另一个 CAS拒绝。
   同 operation 同 owner acquire replay不冒称唯一 controller；S0 beginSubmit事务胜者才有新事实。
3. lost/malformed send response、错 CommandId/多节点/Targets/document/version/comment/local token，
   保持 unknown/held，绝不绑定外来 command；没有生产请求/副作用计数器。
4. actual API 字段形状逐一支持正控与保守 pair：正确 instance/plugin/document/UUID/ResponseCode；
   aggregate Success/错误 plugin/unknown details/非法 status/missing字段/非整数 responsecode/Success -1
   均拒；不可达/InvocationDoesNotExist 不当 Pending。cancel null/{}正控，status Success假 body拒。
5. true terminal Success仍 terminal_pending+held；Failed/TimedOut/Cancelled仍hold，never verified/released。
   迟到非终态不倒退；冲突终态原 observe保留持久 terminal_conflict，异常后不写第二hold/刷新token。
6. cancel-request→ack→后续 InProgress/Success 只观测，termination永远unknown；不删除旧取消事实。
   controller退出、unknown时间过去、API200、health、没有tasks均不授予后续备份/迁移/切换。
7. 两真实独立controller同token同send/同InProgress都先过precheck，再赢家bind/observe→输家exactreplay：
   原S0audit只推进一次，两个allowStale返回无法辨winner，controller结果均token=null；输家不能借结果继续
   stage-cancel/hold。terminalSuccess首次新增reason的strict前置hold只有一方推进，输家holdCAS拒；
   既有held同reason/no-op时两个freshstrict检查可能都通过，随后observe仍只有一次auditmutation/
   另一方可能replay；两方均丢弃observe token、无后置hold。旧heldtoken不获新revision。
   切点用独立fixture子进程/实际原S0双handle，不加publiccallback/test生产fault参数。
8. 双进程旧 owner/fence/revision、延迟stdin continuation、已held/released/另一 operation：
   fresh合法观测正控；旧token新mutations拒绝，原/audit无修改且不得foreignhold；重启不重发。
9. S0自身 pre-BEGIN热journal0644/inode/pathswap/marker/半初始化：新增真实controller入口也拒绝，
   DB/journal size/hash保持；合法0600热恢复保原unknown/held；调用实际ledger，无自动chmod修复。
10. 嵌套深度/超65536输入/原文输出/恶意error/未知动作/env override/生产 target拒绝；CLI/module均没有
   AWS/shell/network/任意execute/complete/authorize入口。新增错误partition实际module/CLI反例：
   invalidouter无token/nohold，freshwireparsefail只一次strictCAS hold+blocked/nonzero；parsefail在hold前
   并发revision推进保primarycode/tokennull/no foreignhold。terminalconflict先持久再抛＋诊断失败/旧hold
   失败不得遮蔽原reason/二次hold。stream超限在累计阶段中断，不先无限read。
   原S1/S2/C2a/b/validator契约定向回归保持。
11. Node24 env-i umask077/raw0700/0600；定向 native、必要完整 ops、双 TS 与 `.d.mts` 消费验收/lint/doc。
    无路由/构建/Docker接线不重复无目的HTTP/browser/build，最终实际 CI按最终diff gate不skip。
    两位独立完整方案及最终源码/反例审查，正常hooks/PR/finalhead/testedmerge/mainCI分别绑定。
    eval只在最终diff判断，不预签skip，无模型调用；fixture不证明真实模型质量/SSM或全writer静默。

## 依赖、退出与回退

实施依赖：两位独立方案冻结、唯一新文件归属、精确base CI、原S0真实方法不需修改。
本片不依赖未合 S3 runtime 源，不消费 S2 ready（恒false）；A2资格/回退批准不由本片提供。
需要额外真实 command/transport、共享ledger/schema/safety边界、生产目标、批量profile/新语义pair、
停止证据自动签发或全writer-ready时，停止实施并将具体差异交协调者，不自行扩大。
已完成的原技术债切片不重开，延期/性能/Brief/P1保持，恢复覆盖缺口不搜索/补造。

不通过验收则不创建/合并实现 PR；源码可停止引用新 module，但任何已持久 S0 unknown/hold/audit
必须原样保留，不能删账本、reinit、complete/release或回退 schema制造通过。
所有CLI失败/exit/SIGKILL只保留隔离状态，不自动生产revert/部署。
合入新代码不等于进入旧冻结4477412镜像、上线或获得批准；新候选镜像需要独立冻结/验收。

剩余工程：全writer实际登记/提交封闭、部署/备份/恢复隔离消费适配、A2实际typedconsumer，
及未来受控AWS transport实现。是否能实际生产验证transport另属授权，不把工程整体归external，
离线consumer交付不构成停止可执行工程的理由。staged提交片现另编号A3-S3b，串行归属/独立审。
缺证/人工：端到端response provenance、host身份/provision/独立账本锚、未知本地/远端continuation停止、
真实镜像/数据兼容、可信历史恢复覆盖、实名operator/on-call/reviewer/approver与TD14人工裁决。
预算：真实模型0，TD20旧head质量不能由本协议mock/新CI补签。
延期：TD12保留模块、TD14/15追加性能、P1/Brief、无新线索历史搜索原样保留。
生产授权：AWS/SSM/dispatch/维护和额外付费仍须工程前置满足后统一专项申请具体目标/命令/窗口/
副作用/失败处置；生产维护串行避16:50–17:30UTC。本方案不批准该阶段执行。

## 2026-10-08 三项独立方案 Warning delta

原38fa/19707bytes/hash94608478 保留；R1完整方案B0/W3、R2原v1与完整v2 B0/W3各自时点保留。
作者亲读两份完整review、R1真实replay-probe输入/450byte输出/index、R2 nativev3 witness与环境失败v2
索引。原S0同send2→3与同observe3→4 replay不变audit却返回currenttoken；R2证明用该token继续hold
会推进新revision。terminalconflict会先持久held6再throw，旧hold5 CAS失败不变audit。
这些真实原方法probe不是新controller已实施/测试，不覆写审查意见，不签AWS执行或生产。
本delta精确收紧tokennullable/allowStale无后续authority、terminal前strict hold、错误partition/stream限界、
工程缺证预算授权分类；不改S0源码/历史schema。新candidate供两位独立delta审冻结，未实施/未预签eval。
