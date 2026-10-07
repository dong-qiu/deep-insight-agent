# A3-S0：SQLite恢复前的文件系统预检加固

基线 `origin/main` @ `81dac77cd27f82d7b554694bf0a12cd82cd0920b`。
承接[A3-S0](a3-maintenance-protocol.md)、S1独立候选与
[生产身份硬阻断](security-deploy-preconditions.md)。本片不依赖S1合入，且是S2消费S0的前置。

唯一负责人执行Agent A；新独立worktree `insight-agent-a3-ledger-preflight-20261008`，
分支 `fix/a3-ledger-recovery-preflight-20261008`、端口3115、配置0600、DB/DATA隔离。
仅最小修改 `ops/maintenance/ledger.mjs`，新增专属hot-journal node-test、本spec与收据。
S0历史schema、audit格式/校验、所有权/fence/revision、签名授权及生产边界不变。
不改S1、业务库、台账、SSM/API、policy/gate/workflow，不启用生产或付费调用。

## 缺陷与冻结顺序

S0 open已有new Database前journalCheck；但existing handle的transaction先BEGIN IMMEDIATE，
再callback中的read/pathCheck。BEGIN本身会触发SQLite热journal恢复、删除不安全journal，
导致随后权限检查看不到原文件。不能把事务内验证代替引擎操作前的证据保全检查。

在common transaction入口执行无SQL pathCheck之后才创建/执行SQLite事务；callback中的
完整read/schema/marker/audit/owner检查继续保持。初始化new Database前再做journalCheck。
不自动chmod、删除或重建现存证据，不允许修改owner/fence、放宽旧账本读取规则。
打开/持有handle每次事务先核root/marker/DB inode/侧车权限与类型，合法0600 hot journal
仍由SQLite恢复；恢复不得释放既有hold、重发submission_unknown或丢失audit。
同uid/root主动替换整套证据的既有边界不扩大为恶意管理员防篡改声明。

## 先反例、后修复与退出

合成0700隔离root、0600文件；真实子进程SQLite cache_size=1、BEGIN、足够写页后SIGKILL
产生真正hot journal（不是伪造header）。先保全DB/journal原size/hash与副本，再运行原代码复现。

- existing handle所有common transaction读写入口遇0644热journal，在任何BEGIN前拒绝；
  DB/journal大小、hash不变，hold/audit原证据保留。
- 新open同样拒绝不安全journal；合法0600新open/已有handle恢复后持久held+
  submission_unknown及完整audit不变，不能据恢复成功产生生产许可。
- 已打开handle的DB path swap、marker变更仍拒；旧owner/fence/revision守卫与原S0状态机回归保留。
- 定向S0协议/hot-journal测试、完整ops、typecheck与lint；未改src/build路径，无额外构建/镜像替身声明。
- 两位独立Reviewer原材料复核；实际CI、受审head/PR tested merge/main绑定由协调者核。

失败/损坏/不安全权限保留隔离证据并阻断，不自动修权限、解除hold、生产访问或清理原产物。
仅修复检查顺序，不宣称全writer静默、A3/TD-19整体关闭或已经上线。
