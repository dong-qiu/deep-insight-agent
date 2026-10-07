# A3-S1：登记与停止新准入交付收据

工程基线：`81dac77cd27f82d7b554694bf0a12cd82cd0920b`；独立分支
`feat/a3-writer-admission-20261008`、worktree `insight-agent-a3-writer-20261008`。
[spec](../plan/specs/a3-writer-admission.md) 冻结范围与反例。

交付新独立 `writers-isolation.json`/`writers.sqlite` 隔离登记协议，真实
`runGenerationDispatchOnce` 的 opt-in 接线先登记再claim/root Run。
`closeAdmission` 与 `admit` 同一registry的 BEGIN IMMEDIATE 原子排序，close永久持久，
不含TTL、reopen、force、自动解锁或生产适配。原S0 schema/审计完全不改。
调用者声明的workerId是独立代际，不是经过认证的OS身份；新代际不能凭旧ID接管旧task。
每事务调用真实 `openLedger.inspect` 核完整S0 schema/genesis/audit和marker身份。

任务收尾只记录本地core退出，所有任务的remote_subwork仍为unknown；
`writer_quiescence=false` 与 `production_permitted=false` 始终保留。
HTTP/worker组合根尚未注入；route先调用getDb的startup派生写尚未覆盖。
S0获取维护操作与registry关闭之间没有跨DB原子事务，不能称全writer维护门。
未改lease、取消/预算原因优先级、validator白名单或planned/committed/failed发布契约。

## 原始验证

本地 Node `24.19.0`、npm `11.17.0`，零模型/生产访问。
私有原始日志根：`/Users/dongqiu/.local/share/insight-agent/evidence/a3-writer-admission-20261008/`。
目录0700、文件0600；归档索引绑定源码hash、最终commit及各文件size/SHA256。
原始失败日志保留；不存在旧证据重跑冒签。公共收据不包含原文、账号或密钥。

| 验证 | 实际路径与结果 |
| --- | --- |
| writer专属node测试 | 15项：新open及全部existing-handle事务的真实SIGKILL hot journal不安全权限拒绝且原hash保全、合法恢复保留closed/unfinished，以及两个独立进程close/admit、SQLite锁、旧代际/错误token、持久unfinished/closed、缺DB永久marker、symlink/坏权限/未知schema/损坏/半初始化、append-only事实与禁止reopen |
| 10个受影响vitest文件 | 134项全通过：真实dispatch接线8项，既有dispatch/C2a/C2b/usage/报告取消/锚提交/生产report-gen接线回归 |
| ops自动发现 | 最近完整run380项，377通过、0失败、3项既有Linux Docker/GHCR本地skip；第二轮修正后定向S0/S1合计67项通过，未改其他ops路径；CI仍须实际执行，不把本地mock或skip当镜像通过 |
| typecheck | TS7与TS6主程序/tools均通过 |
| lint | 全仓lint通过，warnings=0 |
| build | 无.env加载、清空ambient凭据、显式隔离DB/DATA；Next生产构建通过，实际internal dispatch route bundle含writerAdmission；ops只为type import并被擦除，不增加runtime文件依赖；不访问模型/生产 |

独立最终review真实复现hot journal权限检查时机缺陷：SQLite pragma在检查前触发恢复/删除。
已将journal/WAL/SHM检查移到new Database之前；第二位Reviewer进一步复现existing handle的
BEGIN也会先恢复，现对所有事务在BEGIN之前做无SQL path/marker/inode/journal检查，callback内仍完整validate。
所有pragma/初验失败关handle。原始Reviewer2合成复现日志非覆盖保全为reviewer-two-existing-handle-repro.log。
`writers-v2.log`保存修正后13项通过，原v1及index-v1仍保留；后续索引绑定新修正head。`ops-v2.log`保留380项结果；第二轮`writers-v3.log`为真实S0/S1共67项通过（其中writer15项）。
`core-v4.log`8项接线复核与`lint-v4.log`通过。
TS7/TS6及build复用未修改typed API与dispatch源码的有效v2/v1结果，type-only ops导入已擦除。

专属dispatch反例执行真实业务queue/claim/lease/Run/trace失败收尾；execute为受控回调。
受控done路径使用合成Run/appendGenerationEvent终态事实，真实finishDispatch/lease释放，
不冒称新增真实AI报告生成。首次只改trace投影的测试被真实finish重新投影判失败，已按真实事实链
修正；`targeted-v1.log`保留失败，`targeted-v2.log`为修正后的134项成功。
未配置writerAdmission的路径不出覆盖收据；pre-cancel确定记录no_claim、close保留已claim任务并拒新claim，
expired接管后旧执行者拒写而记录remote unknown。首取消reason仍cancelled；完整既有优先级回归保留。

A1未运行：它不执行本次登记接线路径。本片不改变模型、prompt、语义校验或来源；
最终diff和真实控制路径回归作为Eval-Gate判断材料，提交盖章不代表模型质量验收。

## 评审、版本和未完成项

独立方案review：Blocking 0；两项Warning已冻结并实现（声明代际身份、每事务完整S0验证）。
最终完整diff须两位独立Reviewer；最终受审head、PR tested merge、精确main CI由协调者核验记录。
此收据的本地结果只证明所列源码路径；新的维护代码不在旧4477412冻结镜像内，不能复用旧镜像矩阵
作为新镜像接线通过，也不宣称合入、上线或A3/TD-19整体关闭。

S1结束后依序推进有限drain、lease处置、迟到commit fencing；仍缺全writer覆盖、未知子工作终止、
生产执行状态适配和专属授权。`safe_rollback=null`、deployment blocked与现有hold保持。
S2若使用registry持锁commit permit，必须覆盖每个实际同步提交，不能只先读sidecar后写业务库，
不能锁跨await或把两库提交当成崩溃原子事务。无上述覆盖证据继续阻断所有维护。
原worktree/分支/证据全部保留，无生产/AWS/SSM/部署/付费调用或清理。
