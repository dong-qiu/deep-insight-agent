# R2 / K 隔离内核：实现与待验收收据

## 范围与身份

基线 `22fc151ec5d452efc06527987b2a48af93d21524`；
worktree `/Users/dongqiu/Dev/code/insight-agent-r2-backup-20261010`，
分支 `refactor/r2-backup-contract-20261010`。
承接用户窗口签收后的“按建议的顺序继续”，只实施
[K 专属 AC](../plan/specs/r2-backup-kernel.md)。
五个新源码/测试文件；此前六份历史设计/移交文档原样保留。
未改 C1 三源、ledger/writers 三源、业务 schema、模型、runtime、构建或主台账。

最终源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| backup-store.mjs | `f4dff3e7578b0520bda1c9661742d37252ea0d79ba90cea6e66a82c63e36d5d6` |
| backup-store.node-test.mjs | `4a1c708b08e97557ea60d617738be0664b5f51679a7107b909d8bab542be3f19` |
| backup-entry.mjs | `e030cf4d57e01babedc2137a1d9bca3429ffb4e4e50998a00a134385eaaea054` |
| backup-entry.d.mts | `6abad2f6051e44a1eff5effa8c73544edfe67a80a3222bc065de43bec5d34b7a` |
| backup-entry.node-test.mjs | `d19495b1d42f22489d51677a4cfb4210ad53237aa0d36fa2ff6a1ac07c18b8f4` |

## 实际实现

- 显式空控制目录初始化、永久 tombstone、物理预检和独立追加 SQLite 事实。
- intent 文件与目录同步后才允许预约 SQL；预约与固定拒绝终态分列。
- K 是一次性拒绝内核：任何 intent 均保持 blocked，已确认拒绝也不释放；
  unknown、崩溃、重启、新 operation、inspect clone 均无新执行权。
- 入口只提供 prepare/close，原配置快照、真实 signal、较短绝对及单调预算；
  未接生产者时拒绝且不写 intent，不写开业务 DB、创建/复制/删除业务文件或外发。
- 没有 capability、stage/publish/prune、任意 driver/callback、自动修复或 ready 开关。

## 本地验证

精确 Node24.19.0，credential-free 环境，仅自建临时合成目录/子进程。

| 验证 | 结果与证据身份 |
| --- | --- |
| 最终 K 专属测试 | 45 pass / 0 fail / 0 skip；日志 SHA-256 `fc74b175b0cc922651ca090b9313e1f161bbafd0f95f8f30f2600f9c389484c7` |
| TS7/TS6，各应用与 tools | 四项通过；日志 SHA-256 `4576ccb2819cc20836f7a61bb82deb02ab9b14fa92983ef552b0098d4e9425a1` |
| 最终四个 mjs ESLint | 通过、0 warning；空日志 SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 第二轮输入的扩大回归 | 397/397通过；不代签最终并发修正 |
| 最终默认并发扩大回归 | 397 pass / 1 fail / 0 skip，总398；日志 `693ba76a68d87bb2a6452b06ddd45376871f8538ad7ee20ab33f7ef4cfbb03d4` |
| SSM 文件独立诊断复跑 | 35/35通过；日志 `77505dc44376da207664b97ea8b8da0125707bc8d56e5fe3421b02f530e24636` |
| 最终串行扩大回归 | 398/398通过、0 skip；日志 `79d84401a4a037bb552360aa3b00a922ff511a3233aa0d9a579add64ea41b23a` |
| 8 份专属/历史文档检查 | links/anchors/format通过；本地构造子范围，非远端文档CI |

默认并发失败定位既有 `ssm-isolated-transport.node-test.mjs:157/347`：
ready 文件存在后立即 JSON.parse，读到未完整 JSON。该路径不调用新 K 模块；
本轮未接管或修正它。单独复跑通过不消除该失败，不签默认并发回归全绿或根因完整证明。
串行扩大回归、文档检查及远端 CI 的后续结果只追加，不覆盖这些原件。
串行回归耗时89.51秒；调度条件不同，既有默认并发失败仍保留为待跟踪项。

首轮测试曾35 pass/3 fail：两个测试注入器碰到只读 `.immediate` 属性，另一个把模块
加载的只读 open 当作业务 open；修正测试注入器后38/38，再补反例44/44、45/45。
首轮失败保留在本会话工具输出，未伪造该输出为本地原始日志。

Eval 不适用：未改 AI 语义/来源/引用校验，不运行不消费本路径的 A1 作证明。
不声明应用构建、Docker、Linux原语资格、性能/模型质量或生产验收。

## 两轮独立实现审查

按 pre-pr-ai-review，新上下文、双非作者，只读审查实际未跟踪文件与专属 AC。
与旧两轮设计审查分开，不补签其后置修正。

| 轮次 | Reviewer A | Reviewer B | 处置 |
| --- | --- | --- | --- |
| 1 | B0/W2/S0 | B0/W1/S0 | 原较短绝对预算及最终 ACK 持久边界已修，第二轮核实 |
| 2 | B0/W1/S0 | B0/W1/S0 | 新发现不同 operation 沿用旧空预检，仍可登记第二次；两位均实证，不签通过 |

第二轮审查的 store hash 为
`c106a60ffe90a89d98dd47daae8d61737a9de4b567381915964534dfa93f41b7`，
store-test hash 为 `444651836f1cef693a535079ae4ae22c7193d9deb3eb8712a5e7a6b983b4d0a6`。
后置修正为锁内同时要求 reservation 集合为空且只存在 own unresolved intent；
新增确定性不同 operation 子进程交错用例，最终测试通过。
**该最终 diff 没有独立补签；两轮已用完，本轮不再自动发第三轮、不宣称 Review 通过。**
交付保持待验收/Draft，不转 ready、不合入；CI 绿灯亦不替代该决定。
下一承接者保留两轮原结论，单独确认后置修正的验收处置，不能重绑旧 review SHA。

## 证据与限制

原始过程日志及协调者转录的四份 review 摘要在 `.cache/r2-kernel/`。
永久保全路径及完整索引在下方追加；旧三份封存包不覆盖。
本轮独立封存目录：
`/Users/dongqiu/.local/share/insight-agent/evidence/r2-kernel-20261011-PDARRr/`。
其中 index.json 逐文件登记 size/hash；仅本地保全，不等于异地备份。
Reviewer A 合成诊断夹具保留，未把它当真实覆盖或 backup 正例。
受信命名空间仍是前提，K 不证明恶意同 UID 整集控制目录搬移/回滚攻击安全。

R2 的合法正向准入、窗口 N/S、全 writer producer、真实 CLI、异步备份、
发布/轮转及完整 A01–A14 仍待工程交付。safe_rollback=null、deployment blocked、
positive_admission_ready=false、hold/#435 均保持。
未访问/操作生产，未调用模型、迁移、恢复或清理任何保留分支/worktree/原证据。
