# R2 备份接口：限定移交及最小实施窗口

## 授权与签收

承接 [共享条件合同](r2-backup-shared-interface-v1.md)和
[两轮评审收据](../../verify/r2-backup-shared-design-2026-10-10.md)。
用户随后回复“确认”，本轮落实为：接收该修正版用于实施准备、限定移交三个共享文件、
冻结窄片窗口。**不是第三轮 AI 审查通过，不是实际备份许可或立即实施/切换批准。**

用户确认的修正版 SHA-256 为
`73c551e0964a3885c4587dcb5e40b3db030f1502d20859306d75e35bf1dd44d1`。
已逐项对照真实 S0 核实：target.dataPath 与 DATA_DIR 是 canonical isolationRoot 目录；
DB_PATH 是该目录下的 fixture-business.sqlite 普通文件。旧 marker/schema/source 未改。
两轮 Reviewer 的 B0/W1 原件保持不变；原件中的字段关注点有后置修正及用户确认，
不登记为原 Reviewer 补签 B0/W0，也不据此签完整 R2 可实施。

本轮基线与 fetch 后 origin/main：`22fc151ec5d452efc06527987b2a48af93d21524`。
主工作区不移动，当前接收树已有四份专属草案保留，新增本文及签收收据。
下一实施批次须重新核对最新 main、差异和占用，不用本快照覆盖后续改动。

## 三个共享文件的限定移交

用户作为协调方确认移交；接收 owner 为本 R2 协调 Agent，限定用途为 backup-only 接口。
这是用户授权的移交，不冒称旧 owner/Session 已单独签收。其他 Session 文件权限未转移。

| 既有文件 | 接收源 SHA-256 | 限定职责 |
| --- | --- | --- |
| `ops/maintenance/ledger.mjs` | `6429ce42260884ea0bcc7d698e2b68daff947fae011717a5cb205add92f18b79` | 固定 backup 动作在真实 S0 私有 owned/CAS 锁域内校验 |
| `ops/maintenance/writers.mjs` | `2e369995a070c36266a386336e9243b4cfa6159da2830eb3eee62f771c5c8615` | 固定组合复用同一 registry closure，不嵌套第二次 S0 BEGIN |
| `ops/maintenance/writers.d.mts` | `628cc5a5b0ea779ab2628e1ac46f3625deb1436f9b4d6c890736fb28d640529d` | 仅对齐上述 backup-only 扩展声明 |

定向检查 77 个已登记 worktree，仅查询三文件的 Git 状态及 hash；没有缺失工作区，
三文件均无未提交修改，存在六组历史源码组合。历史不同不等于未交付内容；原源全部保留。
该检查不证明所有工作区干净，也不证明所有活跃 Session 都已停止。
真正开始共享修改前，接收 owner 仍须重核这三个文件并确认无新的并发写占用。

不移交 `contract.mjs`、owned-drain、staged-terminal、runtime/HTTP/startup、业务 schema、
Docker/npm/CI、主台账、architecture、ADR、其他 tests 或私有证据。
不存在的 ledger.d.mts 不作为既有文件登记。此前 C1 三文件移交保留，当前也不改。

## 窗口 K：attempt/拒绝状态内核

目标：先交可独立验证的隔离状态及拒绝片，不制造合法 backup capability。
下列 NEW 文件仅为后续实施批次的精确候选；当前均未创建。

| 文件 | 职责 |
| --- | --- |
| `ops/maintenance/backup-store.mjs` | 显式初始化、固定 intent/attempt 事实、物理预检、未知阻断及只读诊断 |
| `ops/maintenance/backup-store.node-test.mjs` | 独立合成控制目录的状态、并发、崩溃/半初始化反例 |
| `ops/maintenance/backup-entry.mjs` | 不可变配置/原始窗口与信号、固定拒绝入口；生产者缺失始终拒绝 |
| `ops/maintenance/backup-entry.d.mts` | 声明当前实际交付方法；不假装未实现 stage/publish 可用 |
| `ops/maintenance/backup-entry.node-test.mjs` | clone/可变输入/错误路径/窗口及原 signal 拒绝反例 |

验收：实际入口没有 test-ready、proof JSON、公共授许可构造器或 legacy fallback；
没有实际覆盖生产者时，业务 DB 不写开、无 staging/backups 创建或删除、无外发。
控制账本初始化必须显式针对新合成隔离目录，不自动创建缺失/损坏环境。
状态内核用合成控制事实验证协议行为，不将其转换成真实备份许可或 A02/A14 正例。
intent/目录同步及 reservation unknown 反例按真实模块保存事实；重启不补写或解锁。

停止：若窄片不得不修改共享源、运行模型、引入运行时原语、业务 schema 或真实入口，
先停下交接，不把窗口 K 扩为完整 R2。未授权开始此源码批次。

## 窗口 N：同进程 no-replace 原语资格

可与 K 解耦开展，但须使用另一独占分支/worktree，不共享 SQLite 或测试输出目录。
仅冻结以下 NEW 原语资格文件，不取得现有构建系统权限：

| 文件 | 职责 |
| --- | --- |
| `ops/maintenance/backup-native/rename-noreplace.c` | 窄 C Node-API、固定 FD/basename 的 Linux no-replace 原语，无任意命令 |
| `ops/maintenance/backup-native/build.mjs` | 显式隔离构建，产物仅放本 worktree gitignored 目录 |
| `ops/maintenance/backup-native/loader.mjs` | 固定产物/平台加载；不支持时拒绝，不 fallback |
| `ops/maintenance/backup-native/rename-noreplace.node-test.mjs` | 空目标冲突、EXDEV、父 FD/名称错配及控制器退出资格反例 |

验收：资格绑定精确 Node ABI、Linux 架构、工具链、头文件和文件系统；实际 syscall 正例
与 no-overwrite 反例均须来自真实 Linux。Mac 拒绝用例不能补签 Linux 资格。
不得锁内 shell helper、普通 rename/copy fallback、任意 FFI 或运行模型。
使用 pinned 已核工具链/头文件；若需要新增下载、Docker/npm/CI 文件改动或原生依赖，
先冻结它们的精确来源、归属与许可，不能把“原语资格”当任意构建扩展授权。

这是原语资格，不是持锁发布、C1 正例、支持所有 Linux 或镜像运行时闭包证明。
重大原生选型在实际源码采用前仍须由 ADR/架构归属方登记，不接管这些文件。
未授权开始此源码批次，也未运行原生编译或 Linux 试验。

## 窗口 S：共享组合与实际覆盖（后置、串行）

前置为 K/N 独立验收、最终修正版责任签收、相应 ADR/架构记录及再次确认实施占用。
仅一位共享 owner 处理上述三个既有文件；禁止两个 Agent 同时改 ledger/writers。
`backup-fs.mjs`、`backup-fs.node-test.mjs` 的实际固定适配器交付在这个后置批次
另行冻结，不通过 N 原语模块直接提供备份许可或绕过 attempt 锁域。

A3/R6 必须交付真实准入/提交 guards、全入口覆盖清单、有界 drain/lease/continuation 证据
及私有 ClosedBackupSource 生产者。其源码、合同与验收归属不在本次三文件移交中。
当前该工程仍未完成；不得从固定拒绝片、状态 fixture 或原语正例补签正向准入。

本阶段固定保持 positive_admission_ready=false。前置齐备后再做 producer→真实隔离
CLI→发布→精确轮转组合反例、双非作者实现 review、风险相称验证和正常 PR/CI 流程。
C1 CLI/cron、Docker 运行闭包及生产切换另批确认，未具备许可时不静默停坏每日备份。

## 不变的边界

本轮仅落盘签收、归属和窗口文档，源码未改；没有新实现/PR/应用 CI 或原语资格证据。
独立审查历史及性能 warning 保留；用户确认不补签实际技术行为或旧评审结论。
safe_rollback=null、deployment blocked、hold、#435 不变。
无生产访问、部署、恢复、迁移、模型、分支/worktree/证据清理授权。
R2、TD-09、TD-19 整体保持开放；详见
[本轮签收收据](../../verify/r2-backup-window-handoff-2026-10-10.md)。
