# A3-S0：恢复前预检加固收据

基线 `81dac77cd27f82d7b554694bf0a12cd82cd0920b`；分支
`fix/a3-ledger-recovery-preflight-20261008`；独立worktree
`insight-agent-a3-ledger-preflight-20261008`，端口3115。
[spec](../plan/specs/a3-ledger-recovery-preflight.md)冻结检查顺序与反例。

## 已复现的缺陷与改动

S0新open本有journal权限检查；existing handle的BEGIN IMMEDIATE却在callback的read/pathCheck之前，
SQLite可先恢复并删除不安全0644 hot journal，随后检查无法看见原文件。
真实cache_size=1/BEGIN/写页/SIGKILL造hot journal；保护测试在原main上1失败、5通过，
existing-handle inspect没有抛出预期unsafe_maintenance_path，确实复现而非静态推测。

最小源码+4行：initialize在new Database前journalCheck；全部common transaction在SQLite BEGIN前
无SQL pathCheck。callback中的完整read/schema/marker/audit/owner/fence/revision检查保持。
不改S0历史schema或audit bytes格式，不修权限、不删证据、不改变签名授权、安全边界或生产硬阻断。

## 原证据与验证

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a3-ledger-preflight-20261008/`，0700/0600。
原源码失败 `pre-fix-v1.log` 保留；existing/new unsafe的DB与journal在调用前分别非覆盖复制成bin，
对应before.json记录原size/SHA256，复制后逐项核对。原测试生成的临时fixture在测试生命周期结束清理，
归档bin/日志/index全部保留，不是生产库/备份或历史证据。

| 项 | 实际结果 |
| --- | --- |
| 6项新真实恢复保护 | 全过；existing handle全部9个公开transaction入口0644拒绝、原DB/journal size/hash不变；新open拒绝；0600新/已有handle恢复held+submission_unknown及原audit；pathswap/marker变化拒绝 |
| S0协议+专属定向 | 58项通过，0skip，原所有权/竞争/签名/未知终态/重启与append-only回归保留 |
| 完整ops | 373项：370通过、0失败、3个既有Linux镜像门仅本地skip，CI必须实际执行 |
| typecheck | TS7与TS6 main/tools通过 |
| lint | 全仓通过，warnings=0 |

Node24.19.0/npm11.17.0。没有src/build路径变动，无额外build/Docker本地替身声明。
Eval不适用：仅运维持久化预检顺序，不改模型/prompt/validator/来源/评测口径。
独立双Reviewer、最终受审head、PR tested merge和精确main CI由协调者核验后记录。
本收据只证明所列源码路径，不宣称PR合入、镜像包含新代码、部署/上线或全writer静默。

当前 `safe_rollback=null`、deployment blocked与既有hold保持；新维护代码不在旧4477412冻结镜像内。
S1/S2消费方仍需真实接线与独立验收，未知子工作/终态、覆盖不足与过期证据继续阻断。
原分支/worktree及所有归档保留；无模型、生产AWS/SSM、部署、迁移、备份恢复或历史回填调用。
