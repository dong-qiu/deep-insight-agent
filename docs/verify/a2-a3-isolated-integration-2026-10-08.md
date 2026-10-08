# A2/A3 隔离真实接口组合验收（2026-10-08）

本切片只增加 `ops/maintenance/integration.node-test.mjs` 与本收据，消费原真实模块；不实现新的维护流程。两条跨接口拒绝链通过，不代表生产运行、所有 writer 静默、部署/备份/恢复适配完成或回退获得批准。

## 冻结输入与归属

- combined input head：`ac7f80cd5b897cd0e5559386a7f1e47b2bd36172`；tree：`38475e169ca75ea44a4bce1bc3946e1bec220b9b`。
- 正常 merge parents：consumer `407f66461f4b7c65c41d44025b76785ee4bb11c3`、SSM `41767ba80a1f840ecda555b668c0f5a435497397`。五 consumer 文件与 407、九 SSM 文件与作者 c63 冻结逐字节一致；十 staged 文件与作者 b6 冻结逐字节一致。
- origin/main 当时为 `3486ca679ef479ced539ba55a8e7cff091117662`。协调者已核此精确 main CI `37725190924 / attempt 1 / success` 和原包；本收据不补签 consumer/SSM 的后续 PR 或精确 main CI。
- 协调者冻结 `coord/integration-test-only-interface-freeze-v1.json`：1379 bytes / SHA256 `c700de60b88256706f3869a886f183440a19f4e7cdfdf39743ab2f3aaa39ddc7`；combined input v2 经协调者核后才开始写测试。
- 本片两个新路径归 Agent A；consumer、SSM、staged、S0、S1、S2、schema、业务 runtime、政策、生产门、workflow 均只读。端口 3140；独立 worktree、配置、DB/DATA 与私有产物。

## 真实链 A：consumer before-stop → 同 operation drain replay

使用当前真实 `openDb`、provenance migrations、topic/request 创建隔离 queued dispatch。S0 acquire 的完整固定 profile 与随后 S2 请求一致；S1 登记未完成 writer，准入仍 OPEN。八个 A2 角色来自本 fixture 实际 schema、完整 48 条 TEXT migrations、全部 dispatch/lease 行、合成配置、冻结 447 compose 公共字节和三个诚实 `not-run` 声明。compose 从受审 Git 测试的公共固定字节嵌入，并与批准 policy 的 compose hash 比较；从未执行 compose、拉镜像或注入凭据。

实际调用 `consumeA2Isolated`：`isolated_consumer_integrated=true`，同时 `phase_verified=false`、`observation_atomic=false`、`all_writer_coverage=false`、`commands_executed=false`、`controller_uniqueness=unknown`；所有执行许可 false、`approved_safe_rollback=null`、进程终止 unknown。三个声明未认证/未 verified；production compatibility 与 approval 仍缺失。

接着实际调用 `openDrainLeaseSource` → `observeDrain`，相同完整 operation/owner/target/execution 请求得到 `writer_drain_replay`、token null、polls 0。未 close、重新 acquire、hold、续租或刷新 token。S0/S1/业务三个数据库原字节、逻辑行、完整令牌/revision/fence、active pre_submit 与 OPEN 准入均不变。此反例保留 existing-operation 不接管的边界，不是 owned-existing drain 的正向生命周期交付。

## 真实链 B：S2 timeout-held → staged revoke → late terminal → offline CLI

另一固定 SSM profile fresh root，原真实 business fixture 使用 DELETE journal，`openTerminalDispatchDriver` 实际 native connection、`initializeStagedTerminal`、`registerStagedTerminal`，fresh admit → 真实 `claimNextGenerationDispatch` → six-field `bindClaim`。没有模型 execute、恢复 cap、替身状态机或任意 callback。

staged close 后实际 `observeDrain` 使用 1000ms 有限窗口（低于原 60s 最大值）、10ms poll。未完成任务与 claimedCurrent=1 导致 `writer_drain_timeout`，真实 S0 token 为 held / pre_submit、submitToken/commandId/requestHash 均 null。实际 `bindDrain`、`revoke` 持久保存该完整 held token；两份记录不可替换为虚构许可。

实际 `admission.commitOutcome` 拒绝迟到 terminal：`kind=not_committed`、`businessCommit=not_committed`、`code=staged_terminal_revoked`，无 attempt/outcome 新行。完整 dispatch/lease/run/event 及业务数据库字节不变；不解除 lease、不 finish 未知任务、不制造 termination。

PATH-only 子进程实际运行 `controller-cli.mjs ROOT stage-submit`，输入原 S2 held token。输出为 exit 1、stdout 空、stderr 精确 `invalid_maintenance_transition`。该 throw 路径没有 ControllerResult；测试和收据都不捏造 result/permission 字段。CLI 前后四数据库字节及 S0 全状态/audit/hold、原业务行不变，未发命令、未补写 submit、未二次 hold。终止 unknown 与许可 false 来自实际 S2/staged 输出，而非从 CLI exit 推导成功静默。

## 验证与失败时点

- `integration-v1.log`：1 pass / 1 fail。实际流程已 revoke；作者测试错把真实 `stage.terminal` 写成不存在的 `stage.terminal_permission`。原原始日志、输出、全部该轮已捕获 DB bytes 保留，属于测试字段错误；不是原运行协议缺陷。随后也按原事实把 hold 的校验写为 disposition / failures，未改任何 runtime。
- `integration-v2.log`：2/2 pass、零 skip。最终新增覆盖缺失角色的物理 absence、全部声明未认证、all-writer/commands false、真实 queued/claimed 分类以及 active/held 状态保护后，`integration-v3.log` 再次 2/2 pass、零 skip。
- 六个既有 native 测试文件：`a2-consumer.node-test.mjs` 91、`controller.node-test.mjs` 24、`drain.node-test.mjs` 20、`ssm-response.node-test.mjs` 7、`staged-terminal.node-test.mjs` 31、`writers.node-test.mjs` 15，共 188/188 pass、零 skip；原日志 `ops-regressions-v1.log`。原命令中的 `ledger.node-test.mjs` 不存在，该 filter 未执行；S0 的 `protocol.node-test.mjs` / `ledger-recovery.node-test.mjs` 原套件未运行。两条组合测试直接调用真实 S0 接口，不能记为上述 S0 原套件通过。这六文件结果与两个组合结果分别记录，不将旧 probe 当作新组合通过。
- TS7 / TS6 的 app 与 tools 四项类型检查通过：`four-ts-v1.log`。最终新测试 lint 零 warning：`lint-v2.log`。测试/doc-only 未改变 app 构建闭包，本片不重新做 HTTP/browser/build/Docker 或模型评测；不从这项结论给父片 Docker/CI 盖章。
- 最终测试 20974 bytes / SHA256 `ae39a696bd8304bd1a22563605b7766edbd7bcd7ccf07fb93439230758aef33f`；最终 commit 与收据/原字节完整绑定见私有索引，避免本文件自引用 hash。

## 原材料与保全

私有根：`/Users/dongqiu/.local/share/insight-agent/evidence/a2-a3-isolated-integration-20261008/`，目录 0700、文件 0600。`combined-input-v1.json`、原 npm/失败/绿色日志、各实际 input/output/logical 回读、最终两文件及受控 parent Git 字节全部非覆盖保存。原汇总 `index-v1.json` 保留原时点；其 `affectedSevenNativeModules` 字段会计错误，最新 `index-v2.json` 明确更正为实际六文件 188 项，不覆盖原索引或原日志。

`native-v1` / `native-v2` / `native-v3` 按每个消费/观察/迟到提交/CLI 边界保存四库（ledger、writers、fixture-business、gate）main / journal / WAL / SHM 的存在与不存在记录、物理 owner/mode/nlink/inode、size/hash、实际字节副本，以及 S0/S1/stage markers 和八角色材料。Case A 没有 gate，明确 absent。新 fixture 在创建时使用 DELETE 以稳定本组合的业务字节；若出现 sidecar 仍必须保存，不能忽略 WAL/SHM。物理 capture 先于边界后逻辑 SQL 读取，未自动修权限、复制 live 数据或把新 run 回填历史缺证。

原合成 fixture 全部保留；日志有精确目录。只有公开源码/合成收据入 Git，DB、原始日志、签名公钥及私有样本只存私有证据。此测试未新做 hot journal/SIGKILL 矩阵，不把父片已有反例称作本轮新切点。

## 退出与尚需工程

本片等待两个非作者独立完整评审。协调者仅在 consumer/SSM 各自按条件合入、精确 main CI 与证据归档完成后 normal sync、定向复验并创建最终仅两文件 diff 的 PR；本时点不预签 review、Eval、PR CI/main 或生产执行。

仍属工程前置：owned-existing drain 正向消费、真实部署/备份/恢复适配、完整 writer 覆盖、C3/model-usage/raw/report/coverage 接线及执行控制器生产实际入口。当前跨连接观察、未知子工作与终态不得签 ready。生产访问/维护窗口、实名运行授权、模型预算、人类回退批准与真实生产证据另列为外部阻塞。始终保留 #435 硬阻断、safe_rollback=null、deployment blocked 与现有 hold；不把上述工程待办泛称外部授权问题。

## 原 188 项会计更正（2026-10-08）

独立 Reviewer W1 后，作者亲读原始日志确认上述六文件分组与计数。本次只修改本收据；测试/runtime 字节不变，已有两条组合、六文件 188 项、四 TS 与最终 lint 结果按原代码闭包复用，不重跑或补跑 S0 套件凑旧记录。原 be2 的 W1 与作者字段断言失败日志继续保留；本次只做 doc/diff 检查，最终独立 delta review、PR/CI/main 状态仍由协调者后续核验。
