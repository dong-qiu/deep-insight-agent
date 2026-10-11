# Drain 测试握手与有界清理

日期：2026-10-11。仅测试设施修复，实施前独立方案审查；不签生产许可。

## 移交与交付边界

用户明确授权仅恢复移交 `ops/maintenance/owned-drain.node-test.mjs` 和
`ops/maintenance/drain.node-test.mjs`。基线 main 为
`22fc151ec5d452efc06527987b2a48af93d21524`；隔离工作区建立于 #471 的已审
`d3a04dba7395482a8456db752fa24da5d6a44934`。原 #471 三文件保持字节不变；
本切片新增专属 spec/收据，不接管历史 spec、源码、主台账或其他 worktree。

两份授权测试原 SHA256 分别为
`9171318cd40efe01421d13d5eb5daf1ba7838698522fe6313ad8566aacc57cba` 和
`dd0f8df528658d54d25a7021dbb4dd060b9bedf07dfb84bfc42df07ea239213d`。
正常审查通过后在 #471 追加独立测试修复提交；旧取消、失败及评审记录不覆盖。
完整最终 CI 通过之前不合入 #471，也不推进依赖 #470。

## 已证实与未知

取消的 CI `38074669162/1` 中 Vitest 3399 项已通过；ops 随后出现 drain 竞争
失败，未输出具体断言栈。owned-drain 上一个案例完成后长时无输出。
原 same-token 子进程先发 ready 再 SIGSTOP，父进程可能先 SIGCONT；受控实测在
原生路径证实两子进程均停住，额外 CONT 后才结束。此机制不证明原 CI 唯一根因。
drain 竞争原失败断言仍未知，必须保留，不能预先归因于 stdout 或 SQLite。

## 冻结方案与验收

1. owned-drain 的私有原生切点保持：第七次 metadata count 后、同库 readonly
   `COMMIT` 返回后，在 initial CAS 前。改用持久私有 release 文件等待，移除
   ready→SIGSTOP→SIGCONT 的丢信号协议。两个实际进程均到达该切点才正常放行；
   release 先出现亦不会丢失。不改变任何 SQL、CAS、原消费者或业务返回值。
2. 每个拥有的子进程在 spawn 后立即安装 error/exit/close 和输出监听；ready 有
   4 秒独立上限，完成另有测试 watchdog。准备界不放宽；owned-drain 原业务
   10 秒、drain 原业务 250ms/poll 5ms 均不变。watchdog 只让测试明确失败，
   不算业务停止、不将超时或杀死子进程算通过。
3. 输出冻结和解析必须在 `close` 后；错误、提前退出、错误 ready、缺失结果、
   malformed JSON、timeout 等设施错误均失败，不重试/补结果。不吞未处理 rejection。
   owned-drain 的真实业务 CAS loser 与设施错误分列：exit 2 仅允许精确
   `maintenance_revision_conflict`；原 runtime 也允许初始 COMMIT 未知/exit 0，
   必须精确 reason=`owned_drain_initial_commit_unknown`、entry=`unknown`、
   final=`not_attempted`、token=null 及全部 false/unknown。这些均非静默或许可成功，
   任意错误不得当合法 loser。原唯一 winner/token 及精确 failures 断言仍必需。
4. finally 仅清理本测试实际 spawn 的子进程：必要 CONT、TERM、有限等待、KILL、
   有限 close 确认。close 仍未知必须失败并保留诊断，不能签无残留或清理 fixture。
   不使用不验证目标的进程组信号，不杀其他会话。
   drain 仅本次竞争 fixture 加 retain 选项、记录路径并保留，不触发旧无条件删除
   callback；其余测试清理保持不变。收集 close 后的结果仍不等于全 writer 静默。
5. 保留唯一 initial winner、唯一 token、精确 failures 顺序，以及原 drain 的
   closed、held、业务事实不变、全 false/unknown 等所有断言。增加完整子输出和
   阶段诊断，不把所有失败简单归为合法竞争。原竞争失败须取得可定位证据；若需
   runtime 或业务断言变更才能处理，停止并重新申请范围。
6. 新反例覆盖提前 release、ready 前退出、假 ready、未 ready、放行后挂起、
   被 TERM 忽略的清理、close 前大输出、malformed 输出；真实进程与原路径正控
   不依赖外部救援。保留测试 fixture 及未知状态，不删除历史证据。
7. 同一授权 owned-drain 文件中其他三个异步 CLI 子进程也使用立即安装的监听、
   close 输出及 finally 有界清理；不改各自 stdin/信号/业务期限语义。
   两文件原同步子进程的测试 watchdog 统一显式 timeout 10 秒与 SIGKILL；
   此为 test-only 兜底，不作为业务终态证明。owned 保留原串行准备、双方 native
   ready 后一起 release，仅在原 initial CAS 阶段竞争，沿用各自
   入站 10 秒期限；ready/release 等待最多 4 秒，完成 watchdog 12 秒；
   drain 准备最多 4 秒、完成 watchdog 4 秒；TERM 500ms、KILL 后 close 2 秒。

实施诊断具体化：同时启动是最初方案的可选建议，并非原测试语义；首轮在准备阶段
出现真实提前返回、未达 barrier，严格设施断言失败。失败保留，不将它归为合法
CAS loser。恢复原串行准备以避免新增 setup 竞争，不重试、不延长期限，仍需
实际双进程正控与最终独立审查；不存在“避开原 initial CAS 竞争”的改动许可。

## 私有第二阶段握手（诊断后方案，已独立复核）

定向诊断又出现：真实初始 CAS winner 在后续 close 前的 ledger metadata/inspect
与 loser 的 strict CAS 失败事务竞争，得到 SQLITE_BUSY，原精确 failures 断言不满足。
该失败保存，不用删断言或重试来消除。将此测试收敛为其原目标“初始 strict CAS
竞争且 loser 不 refresh”，不得顺序执行初始 CAS：

- 第一阶段仍是双方第七次 readonly COMMIT 返回后同时 release，初始 CAS 实际竞争。
- winner 的初始 writable ledger `COMMIT` **实际返回之后**，在私有 native hook 发
  严格、绑定 PID/root/path 的 entry-commit 消息并等待第二个持久 release（最多4秒）。
  此时原事务已结束；不改变 run/COMMIT 语句、返回值或库实现，不发准备即假签提交。
  arm 仅来自本 operation 的原 INSERT 成功及精确 failures=`[owned_drain_started]`，
  绑定同一 writable Database 对象；正常 COMMIT 返回且 `inTransaction===false`
  才能单次发消息。ROLLBACK、原生异常或消费后清 arm，但永不清除历史成功 INSERT
  计数来伪装无写入。readonly、inspect、final COMMIT 均不能触发。
- parent 只有确认唯一 entry-commit 消息、另一 child 完整 close 及限定真实 CAS
  loser 结果，才能创建第二 release；随后 winner 正常走原 admission/final hold。
  no winner、两个 winner、假消息、loser 未 close 或设施错误必须有界失败。
  二阶段监听从 spawn 起安装；release2 前还需 winner 存活、双方无设施错误。
  unknown loser 除精确结果形状外，必须有同库 writable initial `BEGIN IMMEDIATE`
  抛 `SQLITE_BUSY` 的冻结原生证据、成功 initial INSERT=0、entry-ready=0，且无
  wait/IPC/其他设施或原生错误。generic unknown、COMMIT错误或成功 INSERT 后
  失真均失败，不用 runtime 的泛化 reason 代替证据。各阶段有界且不重置原期限。
- 第二 release 不能提前让 winner 越过 loser；仅“单 child 提前 release”反例可
  预建两个文件验证持久信号不会丢。实际双进程案例保双阶段顺序。
- 原唯一 entry/token 与精确 failures 断言必须保留；新首/次消息和等待反例覆盖
  握手设施，不声称全控制流程不发生业务竞争、控制器唯一或 runtime 安全提升。
  后续部署/runtime 的并发处理仍为原合同，不在本次范围。

新反例还须覆盖第二阶段错误/重复/缺失/错误顺序消息、两个 winner、提前release2、
loser 未close/挂起/非法unknown、winner提前退出、COMMIT异常不假签、非initial提交
不触发。原生竞争证据和设施故障严格分开；有限清理失败不能被成功结果覆盖。
unknown 分类还须逐一要求 `deployment_permitted`、`rollback_permitted`、
`database_restore_permitted`、`inverse_migration_permitted` 严格为 false，
不得把缺失当作 false；反例从真实 initial BEGIN/SQLITE_BUSY 的冻结结果派生。
原生 IPC 发送的 callback 属于测试设施事实：先结算 ready/entry 的所有 callback，
再生成并发送终态 facts，最后等待其 callback。晚到错误不能只修改已发送快照，
必须以固定 stderr 和非零退出明确失败；真实分类器及竞争路径都拒绝该设施错误。
不返回的 callback 仍受原阶段或 spawn watchdog 限制，不增设业务宽限或重置期限。
“winner 在 release2 前退出”设施反例使用单个实际 native child；父收到真实
entry-ready、阶段仍有效且 child 存活后，才用独立 `.exit` 文件触发退出。
始终不创建 release2、不标记 released2；完整 close 后核精确退出/断开错误、
exit=0、signal=null、事件顺序及账本仅 `owned_drain_started`、audit=3。
这仅保证退出注入命中目标切点，不改变正常双进程 initial CAS 正控。
两位非作者完成了新增方案的独立复核，Blocking 0；上述限定为必做验收条件。
该结论仅允许开始实施，不代表最终源码、反例、默认并发 ops 或远端 CI 已通过。

## 验证与不做

先跑 credential-free Node24 定向 TAP，再默认并发相关/全 ops、四路 typecheck、
scoped lint 和文档检查；CI 核实际 tested merge、Linux/HTTP/browser/Docker。
已有 #471 修复完整保持，新范围双独立评审最多两轮；不重开旧算法第三轮。
Eval-Gate 不适用：只改测试进程设施，无 AI 语义变化，A1 不执行此路径。
不改 runtime、SQL/CAS、CI timeout、业务期限、schema、policy、阈值、共享 runner；
不访问生产或调用模型，不清理旧环境。`safe_rollback=null`、hold/#435 和
deployment blocked 保持；此修复不关闭 TD-09/TD-19 整体。
