# D1 下一步交接核对与边界修复设计收据

> 历史时点收据：下文保留实施前失败与当时待确认状态。用户后续协调确认和修复后的实际结果见 [最终实施收据](d1-database-lifecycle-2026-10-05.md)。

日期：2026-10-05。承接 [前置收据](d1-database-lifecycle-preflight-2026-10-04.md)。
具体方案见 [交接与修复设计](../plan/specs/d1-file-handoff-and-boundary-fixes.md)。
本次完成可核对的文件范围调查、修复设计、反例补充和独立评审；**C1 交接及只读范围决定仍未确认，尚未修改共享实现，D1 未完成。** 用户后续合入授权已记录，不重复要求合入批准。

## 文件归属调查

再次 fetch 后 main 仍为 c7648986d96e040dcad8c7e6dd01e75759c2bbee，精确 main CI 37213415190 success；没有新的 D1 实现 PR。

- C2b 专属 spec 明确不改 D1 四个入口/拟新增模块，D1 保持不改 repos/runtime，可避免当前文本范围重叠。
- 独立 reviewer 只读核对 C1 backup d14c589、identity-audit f3753d8、restore-rehearsal 8177ff7 的 status、merge-base 和分支自身差异：均未修改 index.ts、provenance-migrations.ts、auth-reader.ts、local-bootstrap.ts；当前未提交列表均空。
- C1 的历史差异缺少 v47/v48 等来自旧基线；不得把旧文件复制进 D1，也不得把无改动当作会话结束。恢复契约仍保留未来生产 CLI/startup 接线，必须明确当前/下一切片交接。
- 当前没有工具能够直接向其他独立 Session 的 C1 负责人请求确认；已向用户请求缺失确认。用户回复“请给出你的专业意见”，本会话提供建议，不将其误写为已交接或已批准验收调整。
- 主 worktree 两个已修改共享文档和四个未跟踪日报文档保持原样。其他工作区只读，不接触生产或清理分支。

建议短时交给 D1 四入口及新增 connection/startup/migration 模块；C1 保留 schema、恢复/删除、ops 接线，待 D1 稳定后再交接其后续生产职责。仓库共享 tracked 实现相对基线仍零差异。

## 修复范围和反例

| 范围 | 已固化的最小方案 | 新证据 |
| --- | --- | --- |
| migration 生命周期 | BEGIN/FK 切换进入恢复保护范围；只回滚本次成功 BEGIN 的事务；保留原错/历史 SQL/hash/每版本原子性 | v39→v40 两连接真实抢锁后 FK=0；caller 原事务 sentinel 保留，防止 naive catch 回滚调用方 |
| local bootstrap | openDb 成功后拥有连接；runner/meta 全部成功才转交，任一步失败关闭且保留原错 | 真实 v47 升级后的 provenance_meta INSERT trigger 故障，连接仍 open；补齐原迁移故障反例 |
| readonly | 保留严格物理零写反例，不偷偷 immutable/exclusive，不放宽期望 | 实际 live WAL reader 看到尚未 checkpoint 的密码/角色更新；主 .db 字节不变，sessionVersion 正确改变 |

新测试 [d1-boundary-design.test.ts](../../src/lib/db/d1-boundary-design.test.ts) 4 项：2 通过/2 失败；与原 63 项一起执行，总计 61 通过/6 失败/67，exit 1。没有新增缺口类别：新增失败补充原 FK 和资源泄漏类别。全部是隔离临时文件和合成数据，故障注入只捕获真实连接生命周期；teardown 关闭其自有连接。

只读替代方案的离线 probe 结果明确区分证据等级：

- 实际 better-sqlite3：普通 readonly 关闭 WAL 库可创建 sidecar；live WAL reader 的共享内存 hash 改变。
- 实际 better-sqlite3：exclusive 静止库返回 SQLITE_IOERR_LOCK；已有 writer 返回 SQLITE_BUSY。不能把此 pragma 当作保持行为的解决方案。
- stdlib SQLite 3.53.2 URI probe：主文件 checkpoint 值 viewer，WAL 已提交 revoked；普通 readonly 读 revoked，immutable 读 viewer。该 probe 只证明被试 URI 策略不安全，不是当前 Node 驱动的接线证据。
- 未改 journal mode、文件权限、平台/VFS 或数据库服务；没有为使反例通过建立新平台。

参考 [SQLite WAL](https://www.sqlite.org/wal.html) 和 [URI immutable](https://www.sqlite.org/uri.html) 官方文档。未验证一种同时满足当前实时 WAL 契约与严格物理零写入的驱动方案，不宣称所有 SQLite 实现都不可能。

## 本地与独立验证

Node 24.19.0 / npm 11.17.0，不加载真实模型，不调用付费 transport。

| 验证 | 本次结果 |
| --- | --- |
| 新边界四测试 | 2/4，两个基线失败，exit 1 |
| 原 63 + 新 4 合跑 | 61/67，六个基线失败，exit 1 |
| npm run typecheck | TS7/TS6 app/tools 全部通过 |
| npm run lint | 通过 |
| 历史 fixture SHA256 | 与原冻结值 8db5364ae12c3f451edb68946bb1168a2dc26ea4a7d6294e9d77372975aa8290 一致 |
| 文档链接及 diff 格式 | 本地检查通过 |
| build/HTTP/D4/coverage/ops/PR CI | 本次未重跑；未改共享实现，不拿前置运行冒充修复后验证 |

独立 C1 范围 reviewer 未运行测试，范围核对不等于负责人交接。独立设计 reviewer 使用新的任务材料，只读核对修复方案，并用 Node24 独立复跑新四项，得到相同 2/4；事务所有权、runner+meta 关闭、WAL/URI 证据边界无新增 Blocking/Warning。其唯一建议是明确 PR CI 后合入、合入后再核验 main CI，已修订，避免时序歧义。三个已知边界缺口仍未修复，不将方案评审通过写成实现验收通过。

当前只修改 D1 专属文档/新增测试，未改模型、prompt、provider、引用、预算或评测语义。未跑无关 A1、未盖实现 Eval-Gate pass/skip；未来实现按最终 diff 与生产路径回归再判断。

## 下一步所需决定

1. C1 明确四个入口及新模块交给 D1；不需要释放整个 src/lib/db 目录。
2. 用户明确实时 WAL 的只读验收范围。专业建议允许引擎 WAL 协调作为例外，同时保持应用层 DDL/迁移/修复/业务写零操作，严格文件不变用于停写 DELETE 离线快照；这是验收调整，当前未授权。若保持原严格范围，先做专门可行性设计，不擅自实现不安全替代。
3. 取得上述决定后执行两项资源边界修复、分阶段职责拆分，完成最终评审/验证/PR 后按既有授权合入，再核验精确 main CI。

未合并、部署、执行生产迁移/恢复/历史修复或清理工作区。文件交接不凭干净状态替代；范围决定不凭用户要求提供专业意见替代。
