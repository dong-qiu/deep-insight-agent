# S1→R3：isolated usage strict-close 精确合同

日期：2026-10-12（Asia/Shanghai）。本阶段接收 writer 为「Dev-Agent-R3–R6接口准备」，
先 S1 后 U 串行；沿用 bcba / `codex/r3-r6-interface-prep-20261011`。
用户通过主控委派选定 D1，并明确批准八文件限定恢复接管；原释放缺口保留为历史事实。
接管授权与当前源身份核验见移交收据，其他文件不因此取得写权。
本合同承接 [准备方案](r3-r6-interface-preparation-2026-10-11.md)、
[AC-S/U1/U2/U3](r3-r6-implementation-slices-2026-10-11.md#真实路径验收矩阵)、
[移交收据](../../verify/r3-usage-transfer-2026-10-12.md)。旧准备文档及旧双独审原件保持不变。
本文件是本阶段的 exact 合同。S1 v2与U v1现已实施、分别完成新候选双独审；实际验收和
候选身份见移交收据。早期未实现状态保留在原证据快照，不用本合同代签测试或生产接线。

## 执行单与授权

| 字段 | 精确边界 |
| --- | --- |
| 交付 | 同私有 registry 锁覆盖固定 usage repo 外层同步 COMMIT；runtime 实际 transport/observer 消费；费用未知与已提交事实保真 |
| 唯一 writer | 本聊天 S1 完整收口并冻结接口后，仍由本聊天承担 U；不并发写 shared |
| 源窗口 | writers.mjs/.d.mts、writer-admission.ts；db/runtime model-usage 和三个现有 usage 测试；逐文件状态见收据 |
| 新文件窗口 | 已授权并新增 `src/lib/runtime/usage-dispatch-driver.ts`、`.test.ts`、`usage-writer-admission.test.ts`、`model-usage.maintenance.integration.test.ts`；新专属证据。与 shared 写窗一起核定，不以新文件绕过依赖移交 |
| 已有授权 | 归属核对、D1冻结、前置满足后的 S1→U 实施/隔离验证/正常 feature 提交/双独审/PR/必要 CI；不推 main、不跳 hooks；无独立新增合入授权预签 |
| 前置 | 八文件用户恢复接管已生效、当前hash/无新delta实核；S1先收口，U后实施；独立Node24/native/dependency环境 |
| 只读依赖 | jobs、llm、model-call-observer、SDK/provider/parser、provenance/schema、terminal driver 及旧 profile 测试；必要新增 delta 先报主控 |
| 范围外 | S2、R4/R5/R6、D2/D3、新 schema/迁移、ADR/architecture/主台账；模型/资格矩阵/生产/环境清理；safe_rollback=null、#435与hold保持 |

## 冻结的关闭、取消与费用语义

仅 `scope=isolated`、`entryPoint=generation-dispatch`、`version=a3-usage-commit-v1`、
`profile=close-fences-usage-v1`。维护 `closeAdmission()` 与每个固定 usage 提交争用同一个
registry 写锁：close 先成功后拒绝所有新受保护业务写；业务 COMMIT 先返回则该事实保持。
不更改旧 default/S1、close-fences-terminal、cooperative-close-then-revoke-terminal 的语义。

单纯 signal 取消禁止新 bindRun/beginAttempt/transport、重试和业务结果接纳；已经 begin 成功的
attempt 可在原 lease 有效、维护仍 open、原 DB handle 有效时同步记录后续真实 usage。
Job.finished 只是诊断，不能抹掉实际观测；Job/Run 收尾不由此接口执行。
registry 的本地 finish 不能单独撤销已绑定 observer，但禁止新 begin；observe 仍要求
原 worker/generation/task 存在、完整 claim/lease 有效、DB 关联相同且维护 open。
dispatch finish 如已释放 lease，迟到 observe 必须拒绝，不能伪造 lease 或新登记来补账。

close、lease loss、DB closed 均保留原 started/unknown/partial/reported 和价格快照；
没有观测不发明零，真实零与 NULL 分开。拒写不能新增“取消退款”、Run.cost 归零或 attempt删除。
attempt 估价不与 Run/P1 累加；原 lease→首取消→C3 sticky→budget 优先级保持。

## 精确值接口

仅两个具名固定 repo 消费者，禁止 `commit(kind, work)`、callback、custom driver 注册或泛化 gate。
下面的 driver 参数仅为受审专属 factory 结果，与现 terminal 固定 bridge 一样核物理数据绑定；
不是允许调用方替换函数的插件口。类型品牌/冻结/Symbol 不认证恶意同 UID，必须核真实来源和源码。

```ts
openUsageDispatchDriver(root: string): FixedUsageDispatchDriver;

// 加到现 openWriters 的返回对象；同一个私有 registry connection。
usageAdmissionFor(worker: WriterGenerationToken, businessDb: DB,
  driver: FixedUsageDispatchDriver): UsageWriterAdmission;

interface UsageWriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  readonly version: "a3-usage-commit-v1";
  readonly profile: "close-fences-usage-v1";
  admit(): FreshUsageTaskCapability;
  bindClaim(cap: FreshUsageTaskCapability, claim: DispatchClaim): void;
  bindRun(cap: FreshUsageTaskCapability,
    run: { runId: string; traceId: string }, signal: AbortSignal): BoundUsageRun;
  finish(cap: FreshUsageTaskCapability, outcome: WriterOutcome): void;
}
interface BoundUsageRun {
  readonly db: DB;
  readonly runId: string;
  readonly traceId: string;
  beginAttempt(identity: UsageIdentity): UsageCommitResult;
  observeAttempt(attemptId: string, observation: UsageObservation): UsageCommitResult;
}
type UsageCommitResult =
  | { kind: "committed"; businessCommit: "committed"; replayed: boolean }
  | { kind: "not_committed"; businessCommit: "not_committed"; code: UsageDenyCode }
  | { kind: "unknown"; businessCommit: "committed" | "unknown";
      code: "writer_usage_business_commit_unknown" | "writer_usage_registry_commit_unknown";
      replayed?: boolean };
```

UsageIdentity/UsageObservation/UsageNumbers 直接复用 C3 值契约：全 identity 字段、四个可空计数、
observation_number/final；不接受函数或可变提供者配置。input/claim/run 读取时需严格核自己的
数据属性并保存 primitive 快照；signal保留原有效对象，不能用 aborted 的旧快照替代实时取消。
run.trace_id 必须等于绑定 trace；usage 子 Run 不强制等于 rootRunId。
begin还要求该Run实际为running；observe不要求Run仍running，仅写原attempt，不能改收尾Run。

UsageDenyCode 固定为 `writer_usage_closed`、`writer_usage_capability_invalid`、
`writer_usage_business_mismatch`、`writer_usage_reverse_transaction`、`writer_usage_busy`、
`writer_usage_claim_mismatch`、`writer_usage_cancelled`、`writer_usage_commit_failed`、
`generation_fence_lost`，以及原 C3 的 identity/schema/attempt/observation/count 校验错误。
不把任意异常文本、正文、端点或 SQL 私有信息透传为 code。

bindRun 只创建 factory-owned 本地绑定，不增加 schema 或新 entryPoint；多个实际子 Run 可分别绑定
同一 fresh task/claim。begin 在同一业务外层事务内验证 run/trace 与完整六字段 dispatch/lease：
dispatchId、traceId、ownerToken、claimEpoch、fencingEpoch、rootRunId；核 rootRun.trace_id。
每个 observer 只持有成功 begin 的精确 attempt identity；attemptId/DB 行本身不是写凭据。
不能用同一 cap 观测别 Job/别 logical call，或从重启、clone、JSON/旧 SQL 行恢复 capability。

## 同连接、锁序与提交收据

factory 只打开同隔离 root 内已存在 `fixture-business.sqlite`，不 bootstrap/seed/migrate。
先核 root/marker/init/完整 target、canonical path、dev/ino、UID/mode/nlink、sidecars，再允许
native open/首 SQL；每次使用重新核同一 open writable DB 对象、唯一 main、无 ATTACH/foreign root。
与 usage scope 的 db 必须是同一个对象，不能传同路径的新 connection。

每个操作：零 SQL 物理 preflight → registry `BEGIN IMMEDIATE`/完整身份及 open 状态核验 →
business `BEGIN IMMEDIATE`/完整 lease、run、attempt 关联 guard →固定 C3 repo 工作 →
**同步 business COMMIT 返回** → registry COMMIT/释放。锁序 registry→business，usage 不取 stage锁。
旧 repo 的 transaction 在 driver 外层只能作内部 savepoint，返回不能当外层提交收据。
进入前 business.inTransaction 必须 false；禁止反向取锁、await、retry/busy等待、重开DB或fallback。
sdk fetch/read/sign 等 await 全在锁外；runtime 不能只传 cap 却继续旁路调用原 repo。

事务未开始，或已开始且尚未尝试COMMIT并显式ROLLBACK成功，才是 not_committed；
preflight/BEGIN前拒绝不发补偿SQL。COMMIT尝试/rollback不明为unknown；business已返回COMMIT而
registry提交/收据读失败为 unknown+businessCommit=committed，保留已知replayed值。
unknown 不能写为失败回滚、自动再次提交、发送下一transport或重算费用。
repo replay只维持原幂等/价格语义；已存在attempt不能由 replay 结果自动再次发网络请求。

## observer 生命周期与真实验收

U在原 createUsageJobScope 加具名可选 BoundUsageRun；未配置沿用原 C3，配置时 db/run/trace严格
匹配，拒绝不退回旧 repo。beginUsageAttempt先实时控制检查，再固定 begin；只有 committed的新
attempt可进入本次transport。unknown或deny进入原 sticky失败传播，SDK包装或业务catch不能开启新请求。
observe先持原绑定完成同步数据库动作，后续SDK消费字节仍走原parser；signal取消不跳过已开始
observer的会计写入，lease/close/closed/绑定校验绝不跳过。原诊断observer仍是只读依赖。
自然到来的不同真实usage观测按原序号/幂等合同处理，不对失败观测添加重试或补偿。
unknown不能据本地Map或新cap再次发送/提交；catch不重开DB，不改已收尾Run，不造退款。

S1先用实际 openWriters/private registry+factory+repo验证AC-S，包含两个进程 close/COMMIT竞争、
check-release负控、COMMIT/registry ACK丢失、kill、错根/ATTACH/hot journal/反向事务。
S1双独审与受影响测试/typecheck收口后冻结接口，再实施U；不能用本合同或旧文档审查代签代码。
U走真实SDK custom fetch、Responses/Anthropic parser、runtime/repo，外部仅合成transport，验证
AC-U1/U2/U3的真实attempt/retry、sticky、迟到chunk、busy/lease/close/DB closed、replay/NULL/真零。
Job/W2新cap接线尚未实施；可只读走现runJob回归，不声称dispatch→真实Job已维护覆盖。
代码验证需绑定最终候选：定向tests、typecheck；运行包影响补build及必要e2e/CI；触eval-gate按实际
确定性路径回归，不使用不执行路径的A1或付费模型预算。新代码两位独立非作者，最多两轮。
