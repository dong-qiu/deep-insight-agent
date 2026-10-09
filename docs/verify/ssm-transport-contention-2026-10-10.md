# SSM transport 竞争合同：测试切片交付收据

## 范围与身份

基线 `08511c458163f52315128efc7fe0cbb9a4d668b9`；分支 `fix/ssm-contention-contract-20261010`。
仅改 `ops/maintenance/ssm-isolated-transport.node-test.mjs` 与两个新文档；原 owner 交付版本
的单文件恢复交接由用户明确授权。原工作区、原件与其他源码归属均保留。
验收见 [spec](../plan/specs/ssm-transport-contention-test.md)。最终候选、tested merge、合入
身份和远端 CI 按仓库流程追加到 PR，不将提交前本收据签成远端已通过。

运行时 transport/controller/ledger/CLI 的 SHA256 分别为：

- `06622d3baf57bed4fd124b72c116f0c835d99f736b53e09df3013be130c75083`
- `852023a56842ad82f616bd095ad3027e5a90c2265c62a639a736e79511d0b8a0`
- `6429ce42260884ea0bcc7d698e2b68daff947fae011717a5cb205add92f18b79`
- `fca26196c0a62df4b423db7ce6b4352df7fc8a17e470245ed9b7fd78d0ee53c5`

均与基线相同；不增加 retry、busy timeout、token 刷新或生产测试钩子。

## 问题与取舍

[#468 原 CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37952541838)
attempt1 的双 CLI 测试 actual0/expected1 原失败永久保留。一方 revision_conflict，另一方
committed/not_started/transport_ledger_failed。原 CI 未披露底层异常，具体异常仍未知。

先前合成库探针复现一种可行锁交错，但仅模拟版本探针，不是 AWS 验收。新测试使用真实
固定 AWS CLI v2、原 Node CLI、SQLite 与 loopback HTTP；没有模拟 AWS/version 输出。
S0 明定零等待竞争拒绝，inspect 同样取得写预留锁。修正的是无条件至少一成功的验收假设，
不是 at-most-once 失守，也不是生产运行时修复。正常 CAS 正例仍严格要求恰一成功、HTTP1。

## 本地验证

Node `24.19.0`；全测试使用清空环境，未加载 `.env.local`。独立临时根 0700、原包 0600。

| 验收 | 实际证据 |
|---|---|
| 正常 CAS | 双方首次 inspect COMMIT 返回后暂停；A stage COMMIT 后，B 实际第二 BEGIN、CAS 拒绝和 ROLLBACK，随后 A 发送；exit0=1、HTTP1、submitted |
| 实际锁竞争 | B 实际 BEGIN IMMEDIATE 获锁；A 原 native Statement.run 抛 SQLITE_BUSY、同一异常重抛，committed/not_started；两 CLI exit1、HTTP0、unknown/active/null command |
| 重启 | 原 ingress 与 current unknown token 各重启一次，均 exit1/HTTP0，状态/revision/审计与 main/sidecar 字节 hash 不变 |
| 红证据 | 对上述实测两方结果施加原 exact1 断言，实际 ERR_ASSERTION actual0/expected1；不是模拟或盲重跑旧 CI |
| 收尾失败路径 | 故意缺失准备屏障仍返回准备错误，finally 放行屏障、终止自有 CLI 并观察 close 后才删除自有控制目录 |

每个 CLI 固定一次 30s 输入窗口；控制屏障单调 10s 上限，故意缺失屏障反例为 10ms。
收尾先 SIGTERM、2s 等待，再 SIGKILL、2s 等待；未观察 close 则失败并保留控制/账本根。
private preload 仅在 fixture 进程内包裹原 Statement.run，真实 COMMIT 返回后才暂停正例，
负例特意持锁；不替换事务、网络结果或异常。两方 close 后先归档原 bytes，再诊断读取。

定向三项、四路 typecheck、scoped lint、文档检查已通过。最终本地完整 ops 为 662 项、
658 pass、0 fail、4 项 Linux image 检查 skip；远端 Linux 验收待核对，结果在 PR 追加。
Darwin 不能把 Linux image skip 声明通过。原 no-EOF、hot journal、
redirect/429、取消、迟到响应、COMMIT ACK 与所有原测试断言保留。

## 独立审查与证据留存

双独立方案审查 B0/W0；CAS 原生 ROLLBACK 证据、真实 BUSY 重抛、收尾 close 和红证据措辞
建议已落实。最终实现双非作者第 1 轮均 B0/W0/S0；A 独立定向 3 pass，B 包含真实 AWS
能力检查共 4 pass，均 0 fail/0 skip，源码 hash 与候选相同。最终远端证据复核待完成。

私有工作区 `.private/ssm-contention/` 保留 narrow-01/02、ops-01/02、原始 JSON、原 DB/sidecar
备份与测试日志；ops-01 为新增收尾反例前的运行，不能替代最终源码验证。最终封存索引/hash
另存私有持久目录，原目录不覆盖或清理；敏感原文、数据库或日志不入 Git。

## 回退与边界

必要回退仅通过独立 feature PR revert 本切片；原失败历史与证据不删除。Eval 不适用：未改
AI 语义或质量口径，A1 不执行此测试路径，真实模型预算为 0；不补签 baseline/DCP。
R1 #468 仍须重新绑定主干及其实际 CI；本切片绿灯不等于 R1 已交付或 TD-20 整体关闭。
`safe_rollback=null`、deployment blocked、hold/#435 保持。未访问生产、部署、迁移恢复或
清理任何保留工作区、分支或历史原件；测试自行创建的临时 fixture 收尾不属于生产操作。
