# R2 备份入口：共享合同待冻结

2026-10-10 增量：用户已授权 backup-only 共享接口设计和独立评审。
[条件合同](r2-backup-shared-interface-v1.md)及[设计收据](../../verify/r2-backup-shared-design-2026-10-10.md)
记录两轮评审和后置字段修正；**条件设计未签通过，共享源码实施窗口未授权**。
下文是上一阶段移交及准备记录，保留原停止点，不覆盖旧证据。

## 状态与范围

2026-10-10，接收基线 `22fc151ec5d452efc06527987b2a48af93d21524`。
本文仅是三文件移交后的合同准备，不是已通过的实现方案或发布许可。
两位独立非作者 Reviewer 的结论均为 `needs_interface_handoff`。

用户本轮恢复移交仅覆盖 `ops/backup-db.mjs`、`ops/backup-integrity.mjs`、
`ops/crontab`；原工作区及证据保留。共享维护、runtime、writer 源码未移交。
本轮没有修改上述三源；没有执行生产访问、部署、模型调用或清理。

## 不能直接实施的两项缺口

1. **合法的正向许可来源缺失。** 现有 owned-drain 持续保留 held、
   all-writer coverage/ready 为 false、termination 为 unknown；不能从
   inspect、测试 boolean、人工清 hold 或旧 operation 重放推导备份许可。
   必须先由共享负责人定义范围受控、真实可消费的正向准入生产者。
2. **固定文件副作用接口缺失。** 已有固定 driver 只提交 dispatch 终态，
   不授权备份发布或轮转。检查后释放锁，再 await/rename/rm 仍有竞争窗口；
   不能把任意 callback 或 sidecar 单次检查称为提交 fencing。

三文件的归属许可已经解决；以上仍是工程合同缺口，不是“只差授权”。
下一步只建议授权独立的 backup-only 共享合同设计窗口，先冻结精确新增文件、
必要既有文件交接、许可来源和副作用，再进行双独立方案评审。
不在本文预授权任何共享源码改动，也不扩为全 writer 覆盖工程。

## 必须冻结的设计问题

- 身份：operation/owner/fence/revision、任务与 attempt、marker/root、
  数据库及 reports/raw 物理对象绑定；不可变 primitive 输入与实时取消信号。
- 准入：在首个 mkdir、staging 创建或写入式 DB 打开之前完成；失败无业务副作用。
  合法隔离正例必须经过真实许可生产者，不能在测试中伪造 ready。
- 异步执行：先持久 reservation，再执行有界 staging；不持 SQLite 写事务跨 await。
  原生 backup 取消、同步复制/哈希的取消观察点和终止事实须分别定义。
- 固定提交：发布与每次精确目标删除均由固定同步适配器执行，和撤销/失权共用
  已审互斥及锁序；不能只让调用方在 rename 前再检查一次。
- 结果：未提交、文件已发布、协议最终确认失败/unknown 分开记录。
  rename 成功后不得因后续失败声称已回滚，或自动重复发布。
- 持久性：命名空间可见性不等于断电耐久性；若声称 crash durable，须冻结
  fsync 与目录同步要求及可用的 no-replace 语义。
- 重启/清理：unknown、缺 ACK、失权和崩溃不重建旧 capability，不清 hold、
  不删恢复依据、不默认重发或重试轮转；已证明可丢弃的私有 staging 另定窄合同。
- 保留：沿用 C1 完整性、引用事实、版本化备份及既有轮转边界；不改变内部原型
  已确认的保留规则，不用 manifest complete 证明全 writer 静默。

## 实现前必须转为测试的验收矩阵

以下均为**待实现/待验收**，不是本轮通过的测试。

| 编号 | 场景 | 必须验证 |
| --- | --- | --- |
| R2-01 | 缺失/损坏许可、held、unknown、身份错配 | 拒绝在 mkdir、写开 DB 和外部发送之前发生 |
| R2-02 | 真实许可生产者生成的合法隔离备份 | 发布后完整性验证通过；不签生产 ready |
| R2-03 | 可变输入、clone、旧 owner/task、重放 | 不能变更已绑定目标或恢复 capability |
| R2-04 | backup/复制/哈希期间取消或 deadline | 第一原因保持；不继续发布/轮转；费用或终止未知不归零 |
| R2-05 | 检查之后、提交之前发生撤销/失权 | 同锁固定提交拒绝，不存在检查—副作用竞争 |
| R2-06 | 发布成功、最终记录失败 | 保留已发布事实与 unknown，不回滚冒充或重复发布 |
| R2-07 | reservation ACK 丢失、崩溃、重启 | 持久 attempt 保留，不自动重发/释放 hold |
| R2-08 | 原生异步任务迟到完成 | 无有效 capability 不发布业务结果，不冒称任务已终止 |
| R2-09 | 单个轮转删除前取消/失权或删除结果未知 | 逐目标授权、已提交与 unknown 分列，不盲目重试 |
| R2-10 | staging/destination 漂移、symlink、名称占用 | 拒绝覆盖或删错对象；不以时间戳作为幂等身份 |
| R2-11 | 清理失败或恢复依据不确定 | 保留证据；不得自动删除未知恢复材料 |
| R2-12 | C1 引用缺口、hash/manifest/保留边界回归 | 原完整性判断与历史事实不退化 |

来源：[C1 备份合同](backup-recovery-integrity.md)、
[A3 提交 fencing](a3-commit-fencing.md)、
[R2 移交与限定证据](../../verify/r2-backup-handoff-2026-10-10.md)。

## 当前停止点

保留三源、hold、`safe_rollback=null` 和 #435 生产硬阻断。
等待 backup-only 共享合同设计窗口确认；合同与逐文件归属冻结且双独立评审
通过后，才进入隔离实现。R2、TD-09、TD-19 均不因本准备工作而关闭。
