# S2a v2 隔离代码候选实施收据

## 身份、授权与基线

唯一 S owner：Dev-Agent-R3–R6接口准备；复用 bcba，branch `codex/r3-r6-s2a-implementation-20261012`。主控根据本线人类六小时授权下发新的精确代码任务，固定截止 2026-10-12T01:26:40Z。新决定 SHA256 `7967e8bf9f9564c9b62bed2851e5f819e7eb9b36e2a373c116b813024a922150` 加性激活原八新文件 reservation；原决定 `95545228386da70a370f124c4c3bf9628454a6869f4c42c111a6c07a20deaa2e` 不改。

主控另指定本线唯一 PR478 merge owner；fresh exact head/base/CLEAN/required rules 核后正常 squash，actual `3a911134efbebaed497e67accc59feb03d9e30a5`，2026-10-11T21:18:40Z。两 docs blob 与受审 head `a91ae57e298fdc5f7eca7a407576ab2a58d427ad` 相同；main push CI38175833484/1 docs success、actual tested SHA 为 actual merge，不能用候选 tested merge 替代。此 actual merge 是本代码基线。

原架构 owner 的 ADR0045 仅 D2/S2a 最小设计接受已由主控核验；86 成员索引 SHA `f843481da4c76dc45bda5b31c060bcebbea8af6e23833b87255c0937bf20126c`，两原 dirty 前缀与另六字节保全。主控允许先编写隔离候选，正式 ADR 主干发布与新代码门仍是代码合入前置；原 owner 正办理独立干净文档 PR，本线不编辑 ADR/architecture。M1/M2 已被主控按 S2b exact reviewed SHA 接受供未来具名消费，但不改变本片普通 pre-open 严格取消，也不启用九 domain 文件。

## 唯一写窗与保全

| 新路径 | 唯一 owner / 范围 |
| --- | --- |
| `ops/maintenance/writers-v2.mjs` / `writers-v2.d.mts` | 本线 S；exact registry、私有原 cap、登记与固定 empty-business pre-open |
| `ops/maintenance/writer-control-v2.mjs` / `writer-control-v2.d.mts` | 本线 S；同一 registry 的 inspect 与永久 close |
| `ops/maintenance/writers-v2.node-test.mjs` / `writer-control-v2.node-test.mjs` | 本线 S；新 exclusive 合成 SQLite、所属 childprocess 与错误路径 |
| `src/lib/runtime/writer-admission-v2.ts` / `writer-admission-v2.test.ts` | 本线 S；无参数 driver/callback 的固定 runtime factory 和真实空库测试 |
| 本收据 | 本线新专属文档 |

激活前重新仅对 Git 登记 75 worktree × 八精确路径作 600 条 lstat/HEADblob 观察，当时全部 absent/no blob；不是释放历史计划的证明。当前窗口根据新增决定取得，具体竞争仍回主控；未在其他 cwd 执行，不扫描依赖/env/DB，不清理任何目录或证据。旧 tracked source 与 S1/U/W1、schema/jobs/HTTP/collector/provenance/A-P/D3/app-path 保持字节。没有新 worktree、配置复制、依赖安装或 live DB。

## 实现合同与真实限制

以 [S2a 精确 spec](../plan/specs/r3-r6-s2a-v2-format-2026-10-12.md) SHA `0a6a989a222ad7bc9b283d4cc0ecb1bae284e73f4b3d5efff59a12158bc5078e` 为准。actual SQLite 展开并核 10 table、20 trigger、12 autoindex 名称/列/NULL SQL；marker canonical UTF-8 + LF、APP_ID0x41335732/version2、root/marker/registry uid/mode/inode、无 symlink/hardlink、完整双向 row/fact/binding 校验。已确定binding的business目标在每次open/inspect/control的统一校验中重核真实inode/parent/uid/mode/link；create在O_EXCL成功即记录occurred，即使后续文件/目录fsync抛错也保留。审计按已见reservation/result/terminal状态逐项检查，unknown必须interrupted_unknown，terminal后不能出现同operation结果。中途残留不删除修复；v1/v2 不混用、不 migration/fallback。audit 链 hash 正确不能替代覆盖所有行，S0 inspect 的同步 IMMEDIATE 锁立即结束。

原 worker/operation cap 仅私有 WeakMap；持久行、clone、Proxy 或 restart 不重建权限。admit 必须 native getter 验证原 AbortSignal；strict own primitive scope 拒绝 accessor/额外键。六 entry 可登记/观察，只有 startup/local-seed 的 `open-business` 是固定消费，其余返回 unsupported_step，无未来业务 reservation。runtime 的 `openV2Business` 只组合 core 内固定 SQLite constructor/path/configuration，不接受 caller SQL/DB/driver/callback。

reservation 同步 COMMIT 后，重新 registry IMMEDIATE 核 open/原 cap/物理/S0 代际与未消费 step，再固定 O_EXCL create/open/configure、empty-business BEGIN IMMEDIATE/COMMIT、registry result/binding/audit ACK。已返回或新构造的同root本地business handle若inTransaction，在任何registry/S0锁之前拒绝；S0复核在business BEGIN之前及其结束之后，business事务内只物理检查，不再取S0锁。跨进程未知外部写事务仍不属于本地inventory或quiescence保证。没有锁跨 await；constructor/configuration/文件事实独立记录，未绑定残留不能普通重新 open。业务 COMMIT 正常后迟到取消保留 committed；COMMIT 抛错为 unknown，ACK 失败保留原 business 三态，不借 cleanup ROLLBACK 宣称撤销既成事实。实际返回 DB 是此 empty target 的本地 handle，不发布 application `_db`，不执行 schema/seed/reconciliation。

新 control 真正打开同一个 writers.sqlite，观察六 entry、operation 与未 ACK inventory，open→closed+audit 永久提交；重复只观察不声称新的 close COMMIT。close 不是 drain；writer_quiescence、drain_ready、production_permitted 始终 false。same-UID 直接 SQL、旧未接线 writer/未知 handle、通用 S0 CLI 仍不属全 writer fence，本文不签全应用覆盖或生产资格。

## 受影响验证与审查

本轮仅新 exclusive 私有 synthetic 根，不使用旧 fixture/live DB、不装依赖、VM、模型、资格矩阵或生产。测试根保全不删除。

| 已执行的真实验证 | 结果 / 证据适用范围 |
| --- | --- |
| 新两 Node 文件 `node --test` | 37/37，通过；actual schema/row-fact反例、v1混合、link/代际、SIGKILL初始化残留与未ACK重启、cap/信号品牌、六entry/control/永久close |
| actual childprocess close/consumer 竞争 | close胜0businessopen且看到unACK库存；consumer胜先真实COMMIT，child close在registry锁内忙拒绝，随后正常close；不是资格矩阵 |
| 同步 COMMIT/ACK 故障 | actual COMMIT后throw、ACK实际提交前失败分别保留unknown/committed与持久库存；cancel reservation/create/COMMIT后分别保留真实FS与首因 |
| `vitest run src/lib/runtime/writer-admission-v2.test.ts` | 3/3；startup/local-seed实际empty target及同registry closed拒绝 |
| `npm run typecheck` | ts7/ts6、app/tools 四项均通过 |
| 定向 eslint（六个实际JS/TS文件） | exit0 |

早期 Node 20/19 与另次 closed 统计断言失败原件保留：前者误把返回拒绝当抛错，后者 LIKE 匹配多个 reason 而非事实 kind；修正为实际结果与 JSON kind 精确核，后续 37/37 不抹掉历史失败。格式/链接与 exact diff 冻结后，新两位独立非作者审查代码范围最多两轮；旧 S2a/D2/S2b 文档评审不替代码签名。新代码首轮 A B2/W2/S0、B B2/W1/S0，独立真实反例共四个去重点：create后耐久错误的FS事实丢失、已绑定target物理代际未统一核、正确链非法terminal顺序、已有business txn及business→S0逆序。原报告/反例保全；本修复候选已补文件/目录fsync故障、目标替换/缺失/link/mode、unknown-denied/cancelled及terminal后result、known handle reverse与真实S0 IMMEDIATE锁序11个反例。37/37通过；runtime3/3、typecheck与定向lint重新通过。第二/最后轮仅核这些修复，最终结论以独立精确候选报告为准，不启动第三轮。代码候选 CI 与 formal ADR 发布仍须另核，代码合入只由主控再指 exact head/唯一 owner。

私有证据根：`/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-s2a-implementation-20261012/`，0700/0600；coord 保存 master/owner 决定、actual478/mainCI、600观察、schema展开、raw测试/失败日志与候选身份。旧 S2b74/S2a108/D2/S1U 原件不改。后续 final index 只覆盖明确成员，不称新增文件后的根永久 seal。

下一步：完成本新代码候选独立审查与必要修复，正常提交/PR/CI交付，等 formal ADR 主干与主控合入指派。S2b source/usage/terminal SQL、W1/A-P、D3/app-path 仍是后续单独窗口；本片空库 pre-open 不证明业务 schema 或 startup 全路径就绪。
