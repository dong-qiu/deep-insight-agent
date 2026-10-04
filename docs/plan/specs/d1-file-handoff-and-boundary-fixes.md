# D1 下一步：文件交接核对与边界修复设计

日期：2026-10-05。后续用户已“按照你的建议继续”，确认协调交接和实时 WAL 引擎协调例外。下文的待确认状态/反例结果保留为方案时点证据；当前已进入实施。基线 `origin/main` @ `c7648986d96e040dcad8c7e6dd01e75759c2bbee`。
承接 [D1 主 spec](d1-database-lifecycle.md) 与 [前置收据](../../verify/d1-database-lifecycle-preflight-2026-10-04.md)。
范围是交接核对、修复设计和专属反例，不是生产实现或 D1 完成。用户已授权后续合入；仍需先完成文件交接、实现、独立评审和绿灯 PR/main CI。不部署、不操作生产数据、不清理工作区。

## 已核对与仍缺的交接

| 参与方 | 当前可核对事实 | 是否构成文件交接 |
| --- | --- | --- |
| C2b | 专属 spec 明确不改 D1 connection/index、migration、startup/legacy、auth-reader；只申请 repos.ts 的单个 trace Run Cost 只读接口 | 已有文本范围声明；D1 不改 repos/runtime，当前范围可避免重叠；不替其承诺进度 |
| C1 backup @ d14c589 | 未提交列表空；分支自身改动为 backup/完整性工具与文档 | 未发现 D1 四入口改动，不等于释放 |
| C1 identity-audit @ f3753d8 | 未提交列表空；候选工具/测试/历史处置文档 | 未发现 D1 四入口改动，不等于释放 |
| C1 restore-rehearsal @ 8177ff7 | 未提交列表空；合成 recovery 实验、schema 实验常量、测试和契约文档 | 生产 CLI/startup 仍列后续，需要明确当前/下一切片交接 |

独立 reviewer 已核对三个 C1 分支相对各自 merge-base 的自身差异。旧分支相对最新 main 缺 v47/v48 等是旧基线差异，不复制旧文件，不据此认定 C1 正在改它们。实验测试继续导入原 openDb/runner 并验证实验表不进入生产 bootstrap。

仍缺 C1 负责人或协调者明确确认：D1 独占以下四个现有入口及拟新增模块；C1 后续生产启动/迁移接线待 D1 稳定再交接。没有可调用的跨 Session 通信入口，已向用户请求缺失确认；独立 reviewer 只作证据核对，不冒充 C1 负责人。

| 文件范围 | D1 接手内容 | 保留给其他切片 |
| --- | --- | --- |
| index.ts / 新 connection、startup、legacy-bootstrap | 兼容 API、连接/协调/cache 职责拆分 | 不改业务 repository 和 runtime |
| provenance-migrations.ts / 新 contents、runner、ledger | 冻结 SQL 原文提取，runner 事务失败边界修复 | schema.ts 不变，不追加/降级迁移，不强化现有 latest-only startup gate |
| local-bootstrap.ts | runner 与 meta 任一步失败关闭其自有连接 | local-only/production 拒绝条件及显式迁移流程不变 |
| auth-reader.ts / 新只读连接入口 | 待只读边界决定后接线 | 不改用户/密码/角色语义或 session 撤销规则 |
| schema、redaction/recovery、ops replay/backup、repos、runtime | D1 不修改 | 分别保持 C1/C2b 归属；不修改 package/lock/CI/Docker/共享 ADR/roadmap |

## 修复一：显式 runner 失败生命周期

现有 runner 在 v2（仅需要 report rebuild 时）、v13、v40 先 foreign_keys=OFF，再在 try 外 BEGIN EXCLUSIVE。锁错误不会进入恢复 finally。真实 v12→v13 和 v39→v40 文件反例均得到 FK=0。

候选修复只移动事务保护边界，不改 SQL、版本、hash、顺序或每版本事务：

1. BEGIN 及关闭外键位于恢复保护范围内。
2. 用本次 runner 的 transactionStarted 标记；只有本次 BEGIN 成功后才允许 ROLLBACK。禁止因为嵌套 BEGIN 失败而回滚调用方已有事务。
3. BEGIN 抢锁失败、DDL/ledger 失败都恢复当前 runner 已切换的 FK；正常成功路径保持现有 FK=ON 契约。
4. 恢复错误不能遮蔽原迁移错误；若没有原错误，则恢复失败显式拒绝。不得自动重跑迁移或使用业务连接继续提供服务。
5. 历史 MIGRATIONS 内容及特殊分支逐字保留；只将外层生命周期保护作为可见的边界修复列在 PR，不能称为全部纯搬移。

专属新反例证明调用方 BEGIN 内存在未提交 sentinel；runner 嵌套 BEGIN 被拒绝后原事务仍 active、sentinel 仍在，调用方自己 ROLLBACK 后消失。这在基线通过，防止简单把 BEGIN 放进旧 catch 后无条件 ROLLBACK 的错误修复。

## 修复二：local bootstrap 连接所有权

openLocalBootstrapDb 在 openDb 成功后取得一条自有独立连接；只有 runner 和 initializeProvenanceMeta 全部成功才转交调用方。两者任一失败，关闭该连接并抛原错误；关闭失败不遮蔽原错误。不自动重开，不迁移生产，不发布全局缓存。

保持原生产/strict 模式拒绝条件、bootstrap 和 meta 顺序。复用 connection 模块的失败关闭工具即可，不新增通用事务框架。失败前已经提交的迁移前缀保持原逐版本原子性；不会为关闭连接回滚已提交版本，也不声称将所有 migration/meta 变成一个全局事务。

既有 migration INSERT 失败反例保持；另补 meta INSERT trigger 故障，明确不能只包 runner 而遗漏 meta。两者在基线均泄漏，被测试 teardown 关闭自有捕获连接。

## 修复三：只读边界需要范围决定

用户要求严格文件零写入、只读不迁移/修复，同时要求真实认证及 HTTP 路径保持可用。标准 readonly WAL 连接会参与 -shm 协调；静止且 sidecar 缺失时可创建 -wal/-shm。这是已复现行为，不通过重新定义期望盖绿。

[SQLite WAL 官方说明](https://www.sqlite.org/wal.html)说明 readonly WAL 的 sidecar 条件与共享内存协调；[URI 官方说明](https://www.sqlite.org/uri.html)说明 immutable 会跳过锁和变化检测，数据库实际改变时结果可能不正确。

已执行的替代方案反例（不是修复实现）：

| 候选 | 合成结果 | D1 判定 |
| --- | --- | --- |
| readonly + query_only（实际 better-sqlite3） | 静止 WAL 读成功但创建 sidecar；live WAL 读到最新事实且共享内存文件发生变化 | 不能证明严格文件零变更；应用内容/schema/ledger 不写入仍可单独验证 |
| readonly + locking_mode=EXCLUSIVE（实际 better-sqlite3） | 静止 WAL 首读 SQLITE_IOERR_LOCK；已有 writer 时 SQLITE_BUSY | 当前支持的连接路径不可作为保持行为的修复 |
| immutable（stdlib SQLite 3.53.2 的 URI probe） | checkpoint 后值 viewer，WAL 已提交 revoked；普通 readonly 读 revoked，immutable 读 viewer | 不能用于实时认证；不是当前 better-sqlite3 接线证明 |
| 改 journal mode / chmod / 预建 sidecar | 未实施 | 会写入/改变共享环境，不能在 reader 中作为零写入实现 |
| 自建 VFS / WAL parser / 新 snapshot 服务 | 未实施 | 扩大数据库平台，超出行为保持型 D1，不能未经新设计接入 |

仓库专属测试进一步证明真实 readCurrentSessionUser 能看到未 checkpoint 的 password/role 更新，而主 .db 文件字节不变；任何 reader 替换必须保留这条认证正确性反例。

当前没有证明一种方案能在本驱动/部署契约下同时满足严格物理零写入和实时 WAL 兼容。不是声称 SQLite 所有实现均不可能，也不把旧结果改成通过。后续必须由用户明确只读验收范围：

- 保持原严格范围：继续保留两个失败反例，不宣布 D1 完成；先做专门可行性/平台范围设计，不偷换实时 reader。
- 允许引擎 WAL 协调作为明示例外：应用层 DDL/迁移/修复/数据写入仍零写；主 DB/schema/ledger/user_version 不改，实时 WAL 与认证撤销保持。严格文件不变仅针对停写并规范化 DELETE 的离线快照。这是验收调整，当前未获授权，不能自行采取。

建议将只读范围决定与文件交接一起明确，再推进共享实现。若用户选择保留原严格范围，D1 不应把只完成两项资源修复写成全部完成。

## 下一阶段验证与回退

继续保留原 63 项及 4 项新反例，不修改历史 fixture、不 skip/xfail。新反例当前 2/4，两个失败为 v40 FK 和 meta 泄漏，两个通过为调用方事务保护与实时 WAL 认证。

取得交接和范围决定后：先两项资源边界修复，再迁移内容/runner/ledger 提取，再连接/协调/cache 拆分；每阶段跑受影响真实文件测试、独立复核。最终 coverage/ops、typecheck、lint、build、HTTP、D4 和 PR/full CI 全部通过后，按已有授权正常合入；合入后再核验精确 main CI 才能收口。

回退只 revert 代码，不恢复数据库、降级 ledger、删除表或修改生产文件。只读范围未决及 C1 交接未确认时，继续专属设计/测试，不修改共享实现。

## 后续协调确认与当前验收

用户按建议继续，作为协调者确认 D1 四入口及新增模块的临时独占范围，并采纳实时 WAL 协调例外。C1 不交出 schema/恢复/删除/ops；未来 CLI/startup 改动需在 D1 稳定后串行交接。没有直接 C1 Session 回复，不虚构会话确认。

只读明确允许 SQLite 自身的 WAL sidecar 协调，仍禁止应用层建表/迁移/修复/业务写、missing DB 创建或 mkdir。主 DB/schema/ledger/user_version 不变，停写 DELETE 离线快照文件不变。保留实时 WAL 最新密码/角色可见性，不用 immutable/exclusive。原严格反例的失败记录保留在两份前置收据；当前测试按已确认的新验收核对主 DB/state 和查询路径，不 skip/xfail。
