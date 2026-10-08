# A2/A3 真实隔离消费者首片收据

日期：2026-10-08。状态：实际本地工程验收完成，待两位独立最终审查；未 Eval 盖章、未推送/创建 PR/合入，未上线。受审最终 head 与本轮原材料 hash 见下述私有 index；本文件不预签未来 tested merge 或 main CI。

## 绑定与范围

实现基线 `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`，启动重新 fetch 核对一致。完整冻结 spec 三提交 ad2de23、26058e4、887d934 经正常 cherry-pick 继承，实施前 head `c0ff30c9ae5c011c64d33f2662abb6aeb7965297`。父 main CI `37710999247 / attempt 1 / success` 是父证据，不是新 consumer CI。

唯一入口 `node ops/maintenance/a2-consumer.mjs <canonical-isolated-root> <canonical-artifact-root> consume-isolated`，stdin 有界 16KiB；library `consumeA2Isolated({root,artifactRoot,input,now?})`。实际调用 unchanged `assessA2`、S0 `openLedger.inspect`、S1 `openWriters.inspect` 和 S2 `openDrainLeaseSource.sample`，另外用 private readonly SQLite 连接在完整列物化前做 type/count/UTF8-byte 准入。

八个必需私有合成文件读取实际 FD/字节/size/hash；正控诚实缺 production_compatibility/approval。它仍可 `isolated_consumer_integrated=true`，CLI 固定 exit 1，所有 permission/ready/authenticated/verified=false、safe_rollback=null、A2 原 blockers 保留。完整 token/owner/fence/revision/target/执行身份/command-submit-request 绑定不 acquire/刷新/升级 capability。原 policy/gate/SSM/ledger/writers/drain/provenance/schema/runtime/workflow 均未更改。

fixture 由真实 `openDb` + `applyProvenanceMigrations` 创建 48 个原 TEXT migration 版本，使用实际 trace/dispatch/lease seed；schema/migrations/full selected lease/dispatch bytes 与该 native fixture 精确比较。schema/migrations/data 的事实仅为当前工程合成隔离绑定。compose 公开 fixture 来自 frozen447 Git 原字节，其 SHA `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd` 可重算；没有 pull/运行447镜像，更不把旧矩阵移给新代码。

## 实际验收

| 检查 | 实际结果与边界 |
| --- | --- |
| 新 consumer 专属真实模块/SQLite/FS/CLI | 最终 71/71 pass、0 skip；最终原日志 `consumer-frozen-source-archive-v7.log`（v6 原字节保护日志亦保留）。 |
| consumer + S0 recovery/protocol、S1 writer、S2 drain、S3 terminal、原 A2/#435 回归 8文件 | `consumer-final-affected-native-v5.log` 308 registered、306 pass、0 fail、2既有 Linux Docker/GHCR 专门门在本机 skip。consumer 源与 facade 字节保持；随后 final test 仅加强三个 DB 原字节不变断言，经上述71/71实际验证。CI 必须实际执行其必需门，本收据不签镜像资格。 |
| repository TS7/TS6 app+tools 四检查 | `consumer-final-typecheck-v2.log` 全通过；新 `.d.mts` 另 TS7/TS6 两次独立直接编译通过（`consumer-declaration-ts7-v2.log` / `ts6-v2.log`）。 |
| 受影响新 module/test lint | `consumer-final-lint-v2.log` 通过；最终补充 test 的原字节断言再次定向 lint，见 `consumer-frozen-lint-v3.log`；仅新增测试私有归档后 `consumer-archive-lint-v4.log` 再通过。 |
| build | 未命中 HTTP/app/Docker 构建闭包，未为凑证据重跑 build/447矩阵/A1；源码依赖闭包如在最终集成变化，由协调者重核。 |

永久保护包括：逐 token/target/binding 字段错配；必需文件缺失、receipt raw/input/hash/size/绑定/有效期错配；假 production/approval 仅标明 untrusted synthetic negative；完整 migration TEXT 保留及数值/BLOB/重复/错值/UTF8超限负控；单条大 SQL/lease TEXT、多行业务/registry、ledger audit 行/总snapshot容量门；FD在初始fstat后增长、stdin cap+1、symlink/hardlink/非私有权限/非UTF8；同counts的owner/独立epoch变化、读取gap的revision/writer/artifact/容量变化；真实 SIGKILL hot journal 的 unsafe preSQL 拒绝与 readonly恢复拒绝（原 DB/journal bytes 和权限均未修复，四份 SIGKILL 原合成 DB/journal 非覆盖持久归档）；真实 submission_unknown/cancel_requested/terminal_pending Success 消费始终未知终止；实际 native close 后异常不发成功。默认 queued、expired 和 unknown inventory 保留原 sample 分类；不清/释放任务来造 quiet。

正控和合法失败用例核 ledger/writers/business 原文件摘要及逻辑事实不变；unsafe hotjournal case 辅助原 SQL 调用计数为0。测试的 syscall/SQLite method 注入只制造有界增长、读取间变化/cleanup fault；assessment/S0/S1/S2/native本身始终真实，没有以 mock 返回值替代。

## 原红、失败与修正

- `old-documentary-gap-red.log` 原共47 failed：46个接口/输出 assertion 红实际调用原 `assessA2` 或 documentary CLI，证明原链缺少新 consumer 输出/实际映射字段；另1个 too-many-rows 在 fixture 构建中抛 SQLITE_CONSTRAINT_UNIQUE，尚未调用 consume，不能计为旧消费路径反例。不是 import missing-module 红，也不声称原安全硬门失效（2026-10-08按两独审W1更正；4108原字节/原日志保留）。执行时的 test-first source 保存为 `test-first-source.mjs`，新永久测试使用新 module 明确 import。
- `consumer-first-run.log` 初次46/47，`consumer-expanded-run.log`64/65：大行数 fixture 先碰 UNIQUE request_id、然后 FK。修正为仅明确非法容量负控关闭其 fixture connection FK并生成不同 request/trace id，实际 consumer 仍 readonly/容量先于旧 reader；没有修改原 schema 或业务 FK 门。
- `consumer-final-targeted-v2.log` / `consumer-final-diagnostic-full-v3.log`66/70：OCI负控错误共享 identity 对象，污染后四个新正控；定向原 cause 为 `invalid_consumer_input`。每fixture完整 clone 后实际全70绿 (`consumer-final-targeted-green-v4.log`)；最终加入容量race和原DB byte hash后71绿。原失败原样保全，不记成产品风险消失或镜像通过。
- 两次 `.d.mts` 首直接编译命令被 TS 新版 TS5112 要求显式 `--ignoreConfig`，原日志保留；修正命令后两编译通过。这是命令准备错误，不是类型失败被忽略。

## 证据与限制

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a2-a3-isolated-consumer-20261008-v1/`，目录0700、文件0600、非覆盖。`archive-index.json` 记录最终head、五内容路径与原始公开Git源/计划review reports、命令日志及每文件size/hash；SHA由协调者核原件。Git不含fixture DB、配置密钥、原日志或敏感原文。

| 4108首轮实现源码（历史字节） | byte size | SHA256 |
| --- | ---: | --- |
| `ops/maintenance/a2-consumer.mjs` | 22024 | `3eaef064ba40ea1db193aebe73cdb6c2d3db0997e417e837f02c3880ffa9ee35` |
| `ops/maintenance/a2-consumer.d.mts` | 4217 | `e927d3bb4641895a489528afba71d3f64aad43dd141b67f3ea666239a42f871a` |
| `ops/maintenance/a2-consumer.node-test.mjs` | 29831 | `084ff30d7f24daa5bcecf68e42ab32473500a20fdefcbcd56255743db45381f0` |

旧 S0/S1 audit 和旧 S2 sample 仍在另连接做全量快照。consumer 的有限元数据门在旧 open/sample 之前执行并复核已观察变化，不能保证两快照间无增长/ABA、整个进程内存上界、全库无损或控制器唯一性。`observation_atomic=false/controller_uniqueness=unknown/process_termination=unknown/all_writer_coverage=false` 永久保留。单 hash/私有权限匹配不认证收据；没有真实当前生产配置、批准、SSM终态、全writer quiet 或部署许可。

staged/SSM/备份恢复维护适配是不同后续切片，未借此首 consumer 收口；rollback批准、生产执行与真实模型预算没有新增授权。本片正常源码/产物冻结后，协调者安排两位独立审查、最终 Eval 判断、正常 PR/精确CI/main 绑定。五内容文件由 B 保留唯一 owner，其他原Session文件与所有worktree/原证据保持。

## 2026-10-08：4108 B1/W1 定向修正，待双独立 delta

两位独立 FULL4108 原审查均 B1/W1：缺省 optional receipt 只在初次读时 lstat，实际旧 S2 后续读取中出现的固定文件未重核，4108会错误返回 integrated=true/missing=true；所有生产权限当时仍 false。R1 原1正2红及R2 原2红/root 原1正2红均保留，原4108及77档案不覆盖、不倒签通过。

最小修正只登记初次 ENOENT 的两个固定 role/basename，并在末次检查已读文件之后再对这两个路径 lstat，必须仍 ENOENT；新普通文件、目录、悬空 symlink、hardlink、非私有文件均 integrated=false，稳定 code `optional_artifact_appeared`。不扫描其他文件，不读坏新receipt正文，不更改旧接口、policy、身份、输入/输出typed契约或权限。继承的非原子/ABA/全量reader容量限制保持。

新增永久20例保护实际 S2 exact full SELECT：两role × constructor sample/后续late sample × 五对象形态；每例执行 real native Statement.all，并核 sourceReads/实际出现对象、原三DB bytes和协议事实不变。原4108执行20/20红 `author-presence-4108-red-v1.log`，修正后20/20绿 `author-presence-fixed-green-v2.log`。之后完整91 consumer +原A2 contract/S2 drain三文件：168 registered、167 pass、0 fail、1既有Linux镜像门local skip（`consumer-presence-affected-green-v3.log`）；新91项全部实际通过无skip。八文件首轮308结果保持历史，不改称本delta新执行。四 repository TS重新通过 `consumer-presence-typecheck-v1.log`，定向lint通过 `consumer-presence-lint-v1.log`。`.d.mts`以及所有TS/TSX/source/旧ops仍对4108逐字保持，旧两facade TS有效结果复用；build闭包没有变化。

W1已按原raw精确改为47总failed =46接口assert +1 fixture UNIQUE，最后一个未执行旧consumer调用；原oldred/first/expanded全部保留，不以修后夹具补签原路径。修正源字节/此文档/完整原审报告及新日志位于私有v2 `archive-index.json`，包含精确newhead及五内容hash；本段不预签最终delta审查、Eval、PR、CI、main或上线。
