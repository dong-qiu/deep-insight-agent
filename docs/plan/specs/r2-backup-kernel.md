# R2 / K：隔离拒绝事实内核

2026-10-11，基线 `22fc151ec5d452efc06527987b2a48af93d21524`。
用户在窗口签收后要求按顺序继续，本轮只实施
[窗口 K](r2-backup-implementation-windows.md#窗口-kattempt拒绝状态内核)。
不改旧条件合同和两轮设计评审原件，不把本轮实现评审作为第三轮设计补签。

## 精确范围与实际接口

只新增窗口 K 的五个源码/测试文件及专属 spec/收据。
不修改 ledger/writers、C1 CLI/cron、runtime、业务 schema、模型、构建设施或主台账。

- `initializeBackupStore(root)`：仅显式初始化已经存在且为空的
  `root/backup-attempt-v1` 控制目录。root 必须已有真实隔离 S0 marker、ledger 文件和
  `fixture-business.sqlite`；只作普通文件预检，不打开业务数据库。
- `openBackupStore(root)`：只提供 `inspect()`、`recordCoverageUnavailable(request)` 和
  `close()`。后者只追加**未执行业务副作用的拒绝事实**，不是 reservation 许可 API。
  request 的 owner/fence/revision 是合成协议绑定，未认证实际 S0 owner。
  没有 reserved/staged/published 终态、完成/解锁/重试或 capability 构造方法。
- `createBackupEntry(root).prepare(input, signal)`：仅消费既有安全控制事实，始终拒绝。
  配置 snapshot、原真实 signal、绝对截止时间与单调余额绑定在本次调用；锁外让出一次
  事件循环后再检查停止条件和原物理绑定。无生产者时不写 intent/attempt，不关闭 writer，
  不创建或操作 staging/backups/reports/raw，不写开业务 DB，不外发。
  `close()` 不释放任何持久状态。没有 stage/publish/prune 或替换 signal 的入口。

控制初始化有永久 init marker、独立物理身份记录、DELETE/FULL SQLite 和追加拒绝事实。
所有控制 SQL/open 之前拒绝任何已存在的 journal/WAL/SHM；本切片不自动恢复 hot journal。
拒绝事实写入前先 O_EXCL 写固定 UUID intent，fsync 文件及父目录；intent 永久保留。
初始预约 SQL 的 ACK 未返回则不写拒绝终态；最终拒绝提交的 ACK 未知也不能解锁。
K 刻意为一次性内核：**只要有任何 intent（包括已确认拒绝），target 始终 blocked**。
inspect 分列已确认拒绝与未解释 intent，重启/换 operation 不补写、不清理、不构造许可。
正常后续 attempt 的准入/终结解除必须由后置窗口 S 另交付，K 不实现或证明它。
确认完成的拒绝事实仅说明 K 路径未执行业务副作用，不是完整 R2 的异步终态证明。

## 必须验收

| 编号 | 实际路径与反例 |
| --- | --- |
| K01 | 显式新控制目录初始化；缺失、非空、半初始化、损坏及重入拒绝，不修复原件 |
| K02 | canonical root、0700/0600/current UID、普通文件 nlink=1；symlink/hardlink/替换及不安全 sidecar 在 SQL 前拒绝 |
| K03 | intent 文件/目录同步先于 SQL；真实 SQL 失败/占锁，以及初始和最终 COMMIT ACK 未知后 intent 保留，重启继续 blocked，无新 attempt |
| K04 | 真多进程并发和崩溃；同 operation 及不同 operation 交错均最多一条 reservation/拒绝事实，孤立/部分 intent 不被重试掩盖 |
| K05 | 精确 schema、追加触发器、完整 intent/事实集合校验；inspect clone 不具执行权 |
| K06 | 真实入口缺生产者始终拒绝；业务 DB、目录及控制账本原字节保持，无创建/删除/网络调用 |
| K07 | 可变/未知配置、错误目录/DB 映射、原 signal 取消、过期/超限窗口、物理对象替换及 close 反例 |

依赖受信且稳定的控制命名空间；没有同进程 dir-FD 相对创建原语。
不认证恶意同 UID/特权进程整集搬移、删除、回滚后还原控制目录；路径预检测试不证明
此类跨 syscall 攻击下 intent 会写入原父 inode。窗口 N/S 的原语资格不在 K 中补签。

测试仅使用自己的临时合成 S0/控制目录及子进程，不使用现有 `.data` 或模型。
测试 fault injection 仅位于子进程测试中；生产模块不接受任意 driver/callback 或 test-ready。
适用模块测试、类型检查和 lint 后，以新上下文双非作者评审核对完整交付。

## 仍不证明

K 不交付全 writer 覆盖生产者、共享锁域组合、异步 backup、原生 no-replace、发布/轮转、
真实备份入口或生产许可；完整合同 A01–A14 继续 pending。
窗口 N 的 Linux 原语资格及 ADR/构建归属、窗口 S 的真实覆盖与串行组合仍是后续工程。
positive_admission_ready=false、safe_rollback=null、deployment blocked、hold 和 #435 不变。
