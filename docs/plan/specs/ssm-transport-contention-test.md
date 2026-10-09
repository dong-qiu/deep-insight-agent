# SSM transport：CAS 正例与锁竞争拒绝的隔离验收

基线 `08511c458163f52315128efc7fe0cbb9a4d668b9`。本轮用户授权单独诊断并修复 SSM 竞争路径；
只恢复接收已交付的 `ops/maintenance/ssm-isolated-transport.node-test.mjs` 的本窄增量写入，
及本 spec / `docs/verify/ssm-transport-contention-2026-10-10.md` 两个新文档。
接收者为当前协调者，历史作者为 continuation A / #464 与 no-EOF / #465；原两个工作区及其
提交、原包均保留。本授权不从 clean/merged 推定其他文件释放；运行时 transport、CLI、
controller、ledger、schema、签名、hold、workflow、三主台账和 R1 五文件零修改。

## 证据及问题范围

[#468 CI 37952541838 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37952541838)
有 660 native / 659 pass / 1 fail / 0 skip。双 CLI 成功数量 actual 0 / expected 1，一方
`maintenance_revision_conflict`，另一方 `stage=committed / child=not_started / transport_ledger_failed`。
完整 REST log SHA256 `cd104d5b6a3c118b918003e7a7f61cdf1efab666d5092d73b6d2e9d96ee7cda9`。
通用码不提供底层异常；不将随后复现的 SQLite_BUSY 补签为 CI 当时的实际异常。

原 [S0](a3-maintenance-protocol.md) 明确 `busy_timeout=0` / `BEGIN IMMEDIATE` / 竞争立即拒绝。
`ledger.inspect()` 也使用 IMMEDIATE transaction。因此“两个前检交错必有一个最终成功”
不是已承诺的 liveness。既有 [controller 收据](../../verify/a3-ssm-controller-2026-10-08.md)
已记暂停事务内和同时零等待 open 的 busy，以及 COMMIT 后屏障；本片沿用实际 SQLite 切点。

单次合成库诊断已复现：A stage COMMIT 后，B inspect 持有 BEGIN IMMEDIATE；A 的发送前 inspect
真实 SQLite_BUSY，B inspect 返回后因旧 revision 拒绝；unknown 持久、无业务子进程。
该诊断仅模拟版本探针，不等同本片要求的真实 AWS CLI 测试。不是发现并修复生产 retry 的任务。

## 冻结验收

1. **正常 CAS 正例不降低原断言**：两个真实 Node CLI、真实 AWS CLI v2、原 transport/controller/
   ledger 与 loopback server。A 首次 inspect 的 COMMIT 返回后暂停，再启动 B 完成其首次 inspect
   COMMIT 返回后暂停；两者均尚未 stage mutation。先允许 A 完成 stage COMMIT 后暂停，随后放 B
   执行真实 CAS 并拒绝退出，最后恢复 A 发送与绑定。恰一 exit0、HTTP1、submitted，输家明确
   revision_conflict；无运行时 retry、token 刷新、私有资格结果或模拟 SDK。
2. **锁竞争负例独立加强**：A 实际 stage COMMIT 后暂停，B 实际 inspect BEGIN IMMEDIATE 获锁
   后、读取前暂停。恢复 A，读取原 Statement.run 抛出的真实 native `SQLITE_BUSY` 后重新抛出，
   不改变错误处理。A exit1/committed/child not_started/transport_ledger_failed；再恢复 B，B
   exit1/revision_conflict。HTTP0、unknown/active/commandId=null，恰一次 stage 的 revision 增量。
3. **停止重发**：负例释放所有自有测试屏障并等待两 CLI close 后，保全真实 main/sidecar/审计
   字节；再用同一原 ingress token 和已持久的 current unknown token 分别重启真实 CLI，均非零、
   HTTP0，原状态与审计 hash/revision 不变。诊断读取不能给新发送许可。
4. **测试屏障仅 fixture 内**：切点来自原 SQLite COMMIT 返回或原 BEGIN IMMEDIATE 成功返回，
   不替代 SQL/COMMIT/CAS/网络结果，不暂停持锁事务作正例。private child preload 不进入生产
   adapter，不给任何生产 hook/callback/env 控制入口。真实 native 错误只记固定 statement/code。
5. **有界且失败仍收尾**：每个 fixture 新建 0700 根与独立 0600 控制文件；测试设置一次不超过
   原运行时 60s 输入上限的固定窗口，屏障等待有单调期限、不重新充值。finally 放行自有屏障，
   终止自有 fixture child 并等待 close 后才清理自有临时控制目录。失败必须返回失败，不 catch 成功。
6. 保留 no-EOF 真实 body、hot journal SQL0/HTTP0/原 bytes、429/redirect、取消/迟到/unknown/
   COMMIT ACK 等所有原回归；新增 case 不修改 runtime、timer、SQLite timeout 或断言门槛。
7. 新 case 有真实红证据：同一强制交错对旧“无条件 exactly1”验收／liveness 假设实际失败，保留原件；
   新正常正例和 busy/重启负例通过。说明红是旧验收假设被证伪，不冒充生产源码修复。

## 门禁和交付

先双独立方案审查，再实现和实际反例。受影响 transport/controller/protocol/recovery 回归，
完整 ops（本地 Linux image skip 必须分列）、四路 typecheck、scoped lint/文档检查；完整精确
PR / main CI 验证最终对象，不用旧 main 绿灯替代。高风险最终双非作者审查按
`pre-pr-ai-review` 最多两轮；存在 Blocking 不合入。不盲重跑原失败 CI 或放宽断言获绿。

未改 AI prompt/model/validator/source/dataset/评分或发布白名单，A1 不执行本测试路径；
`eval-gate` 判定不适用，不运行 A1 或真实模型、不预签 skip 或 baseline/DCP。
正常 PR/CI/满足既有授权门禁后的合入与证据保全不代表部署；后续 R1 重新绑定主干和 CI，
旧失败永久保留。`safe_rollback=null`、deployment blocked、hold/#435 及整体未完成项保持。
不访问生产、执行部署/维护/迁移恢复、调用付费模型或清理原 worktree、分支、原件。
