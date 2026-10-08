# 剩余重构：2026-10-08 协调、证据与交付索引

当前已完整验收并保全本轮17个代码/验证切片，最后完整应用main为 `8bdc1cde688682fb9a5a5769b8cb311abaf8d79e`，精确CI [37765697243/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37765697243/attempts/1) success。整体20项仍为12项既有范围关闭、7项部分完成、TD19阶段完成而整体未关闭；未上线。四份台账#460的精确文档身份见下方增量；本次两文档增量自身未来PR/commit/CI只由私有最终交接索引记录，不预签。

本轮启动重新fetch并核对 `origin/main=81dac77cd27f82d7b554694bf0a12cd82cd0920b`，
精确main CI [37665469691/attempt1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37665469691/attempts/1)
为push/full/success。已合入切片不重复实现；旧“未合入/CI待核/S2未处理”只保留历史时点。
本文由协调者独占更新，承接[统一台账](d6-technical-debt-ledger-2026-10-06.md)与
[治理计划](../plan/specs/technical-debt-remediation.md)，不是自动调度平台或生产收据。

## 冻结范围、接口及归属

以下保留启动批次的冻结记录；后续交付与失败以本文最后的精确时点增量为准，不将历史待办当作当前判断。

| 分类 / 切片 | 目标、负责人和独占文件 | 验收、依赖、退出 / 回退 |
| --- | --- | --- |
| 实施 / A3-S1 | Agent A；公共持久登记、停止新准入及真实generation-dispatch core opt-in；新writers模块、dispatch及专属spec/测试/收据 | 真实SQLite竞争、重启、热journal、未登记/旧代际、迟到完成反例；两位独立Reviewer、实际CI。不是全writer/drain/fence；未知子工作保持阻断。撤回opt-in不删除登记事实、不重开closed |
| 实施 / A3-S2 | Agent A；新drain模块及专属spec/测试/收据，先方案审查；只读真实合成业务lease | 依赖S0修复与S1合入且精确main CI成功。完整身份先验→close→acquire→有限观察→持久hold；queued/current/expired/unknown保留原行；取消/重启/旧revision/迟到完成不放行。不得处置lease或冒称崩溃原子 |
| 实施 / A3-S3a | Agent A在S2后串行；writer同私有连接+固定runtime driver+dispatch终态与专属spec/反例 | 4998方案双独立B0/W0冻结；仅显式close-fences-terminal profile/6字段freshcap/同步registry→business提交。S1默认合作finish不改，两个库crash unknown，其他writer未覆盖。不得把close时撤销称drain后分阶段revoke，全维护ready恒false |
| 实施 / A2不同版本 | Agent B；候选调查及新a2-version-pair模块、专属spec/收据 | 先冻结候选与方案，实际Linux隔离镜像、认证/reader/新writer/旧数据/重启/故障卷；停止所有本轮进程后切换。只作资格建议，不批准policy、生产或回退对象 |
| 实施 / TD-04 | Agent B，A2之后轮换；先盘点危险配置并冻结有限字段与真实消费者 | 保留合法/default/dynamicgetter与加载时机；无模型/prompt或全局配置框架变更；逐字段实际反例，不整体关闭 |
| 实施 / TD-10 | 协调者；followup独立函数及两份专属测试/spec/收据 | 既有取消/预算/caller ownership传播；真实SDK fakefetch、缓存隐式写与迟到反例。与A3 dispatch零共享写；不修改HTTP保存/全局deadline/费用或UsageJob契约 |
| 实施 / TD-10 C2d | Agent B；collector准入/控制/checkpoints、专属真实SQLite/HTTP/shadow反例；root仅交接Git/独占台账 | #449已合，main37698406412/1完整success并保全；lease优先、失败载体合法、committed保真、子await真实join，原源调用尚不透传signal；不宣称全子树或raw内部fence |
| 实施 / TD-10 C2e | Agent B；六source局部+新真实HTTP/readercancel测试/专属spec收据；原collector/runtime/dispatch/shadow/schema只读 | SourceFetchOptions.signal v1，RSS/article opt-in/native原reason与真实join/default等价；arXiv live signal明确unsupported。398源码两final B0/W0，#450候选与main37699429841/1完整success保全；341新集成+双TS通过，无signal原caller不变；预算不翻成signal，不证明全子树静默 |
| 实施 / TD-10 C2f | Agent B在C2d/C2e父合入与精确main成功后；仅collector RSS/article两调用及明确交接3旧limitation测试、新实际consumer测试/spec/receipt | 方案`6b646a563b5dd7c65ad9fa6d492330ed300e8d58`（93行）冻结后，父main依赖成功/保全才实施；#452源a351双独审、426实际回归/四TS/lint/build；精确main37709253322/1完整success保全。explicit signal或deadlineAt激活canonical signal，default/trace/budget/probe arity等价，arxiv仍未知，不把cap转network budget |
| 仅准备 / TD-20 | 协调者；[旧head专项方案](d7-s2a-old-head-acceptance-plan-2026-10-08.md) | `235045d6424640d79c79874a403749c6bd17b823` 独立缺口；旧树缺observer/diagnostics，外置guard bridge工程必须先过零发送保护验收；真实模型预算0，不能补签质量通过 |
| 仅补证据 / TD-19 | 协调者；主台账及本文；Reviewer独立原材料复核 | #440/#443精确身份、原包及A3临时证据非覆盖保全；TD-14/D3只核已知路径与定向交接，不无界搜索或重跑原实验 |
| 延期 / 保留 | TD-12 A/R/G延期、L/P保留；TD-14/15不追加性能实验或强行优化；P1和独立Brief保持原范围 | 不重开已确认取舍；原性能warning保留，不由代码review B0/W0消除 |
| 依赖阻塞 / 第三批 | A2/A3实际消费适配、部署/备份/恢复维护及真实SSM执行协议，由唯一负责人串行接手 | 现有登记不覆盖HTTP/startup/CLI/未知子工作，实际提交fencing只覆盖strict terminal，其余缺；这些是工程前置，不能写成“只差生产授权”。前置未满足不接生产执行，不新增解锁入口 |

A2现行 `a2-a3-handoff-v1` 消费context中的 `operation_id/maintenance_holder/operator`、
schema/migrations/configuration/data_sample四个SHA256及release/rollback完整镜像身份；
phase和failure_disposition是documentary assessment，声明 `verified=false`。
A3现行 `maintenance-contract-v1` 消费完整camelCase target、operationId/ownerId、单调fence、
revision、fixture executionIdentity及精确submit/command/request绑定。两个真实模块字段不能
直接互换；缺owner/fence/target/revision或来源验证不能用接口名称相同、文件接收或范围确认补签。
启动时实际消费者尚未接线；现已交付#455的实际隔离消费，但资格/静默/生产许可仍一律false。

S1 snapshot schema=`a3-writer-admission-v1`；admissionFor返回对象没有独立version字段。调用方负责明确worker/task代际、先登记再claim及本地收尾；
登记模块负责原子admit/close和持久unknown状态，不认证OS进程身份。
S2 `a3-drain-observation-v1` 必须完整strict request、绝对有界deadline、poll及精确同root
fixture-business.sqlite只读来源，先验证所有身份再close/acquire；Agent A持有本片唯一写权限。
S1/S2登记task尚未绑定业务trace/claim；S3严格终态cap另绑定真实六字段，不能倒填S2覆盖；completion或expired lease不构成进程终止证明。

每个执行切片有独立worktree、DB/DATA、端口和产物目录；必要.env.local仅从主worktree复制，
0600且先隔离路径；从不复制.data、live SQLite/WAL、报告原文或.env.development.local。
主worktree和Brief两处未提交analyzer/shadow内容保持原Session归属；干净历史worktree不代表释放。
Reviewer只读实现并独立验收，不审自己的实现；高风险维护/fencing/SSM必须两位独立通过。

## 已交付基线的精确续核

| PR | 最终head / tested merge | 合入 / 精确main CI |
| --- | --- | --- |
| [#440](https://github.com/dong-qiu/deep-insight-agent/pull/440) A3-S0 | head `6452c65b607d5fe71a08cda87e97df1ef46fbd75`；tested `43883039af12a0738eaac2ecd78abc3f411695d4`，CI37652012826/1 success | merge `2910a867a94d7d3a5ab657c2ad8d05cd8b4edc4a`；[37653460318/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37653460318/attempts/1) push/full/success |
| [#443](https://github.com/dong-qiu/deep-insight-agent/pull/443) A2同镜像矩阵 | head `89d6399bd7225d3abcc9ea0667f2d20ed197b507`；tested `f84a132f1eba2bdfcfabbc22cd06b6be6db47ccf`，parents精确2910a867+89d6399；CI37663651946/1 full success；原业务工具5c12e85/tested e35b860/CI37661379512/1分开保留 | merge `81dac77cd27f82d7b554694bf0a12cd82cd0920b`；[37665469691/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37665469691/attempts/1) push/full/success |

#439精确main37649415774/1已success，替代旧台账“in_progress”当前判断，旧观察记录不改。
#435冻结安全revision `4477412a3e2b1cb2764fb4357f2284e73952af67`、amd64 manifest
`sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c`仍独立绑定；
工程main和新维护代码不在该旧镜像内，不移植旧矩阵证据给新候选，实际生产版本本轮未访问。

## 本轮交付的精确身份

下表每个候选及精确main已完整success，原API/artifact digest与tested绑定单独保全。
原首次failed/cancelled不改签成功；新代码不在旧4477412冻结安全镜像内，生产未访问/未部署。

| 切片 / PR | 最终head / tested merge / 候选CI | 合入SHA / 精确main CI |
| --- | --- | --- |
| TD10 followup [#444](https://github.com/dong-qiu/deep-insight-agent/pull/444) | `86377cdd38cfda05f9421f86e643c8b6fc775efa` / `338f7e40192ca2ebed5cc9cbdfd764855de8a0a0` / 37678449999/1 | `41def9a7c75fff488cde206a5a2bfddebb6a9fe8` / [37679937948/2](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37679937948/attempts/2) |
| A3 S0 preflight [#448](https://github.com/dong-qiu/deep-insight-agent/pull/448) | `5a38691d104aadde272c820698f74e2dfa96d92d` / `e2d6b4e641d139d5f89780632f9cb6c3ac1019cf` / 37682264475/1 | `cb2f924ee18c14f24b81d1b85679f4d91f5d509d` / [37686929840/2](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37686929840/attempts/2) |
| A3 S1 [#445](https://github.com/dong-qiu/deep-insight-agent/pull/445) | `9b80a7be98cad74c86a7dd725be4b20334a7781e` / `9d5cc2c1f4256fd8805004478aa5b5a90f15fb13` / 37687359002/1 | `0ca3ec9bfa9d1e7ad7134f027bf1dc7b53b5f813` / [37691558952/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37691558952/attempts/1) |
| A2 version pair [#446](https://github.com/dong-qiu/deep-insight-agent/pull/446) | `cae449a9550e7ef0dbdf5a4153bff0d8df9afc67` / `76205e2c680a3e2c98b1433e930a8db18d7fc57c` / 37691813038/1 | `b5a0f71684999f077db58c5823563acc2253a968` / [37695107249/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37695107249/attempts/1) |
| TD04 notification [#447](https://github.com/dong-qiu/deep-insight-agent/pull/447) | `8d99e74701349191f6d5699afddd859232b8e5e9` / `08b18627382e60313aabb971a2ecb06a44e7ec19` / 37695310964/1 | `56c7ddbcf0bc9d6a7d84f231e6804896d76d0841` / [37696229494/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37696229494/attempts/1) |
| C2d collector [#449](https://github.com/dong-qiu/deep-insight-agent/pull/449) | `816e34bd88c5b3c4b33cf474caac570f2f5d1da9` / `fb5ce69e3f2092ae27363bd687dcf69201e80c04` / 37697586876/1 | `5ae17c3eb5cd264d3b646280c76c429ac8d69866` / [37698406412/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37698406412/attempts/1) |
| C2e sources [#450](https://github.com/dong-qiu/deep-insight-agent/pull/450) | `6adc27e48b8dd370a8f7fd249c812b4567587be0` / `a108f28181ca3e2aa2bca54829a41119c0141668` / 37698833414/1 | `cfca8bc70587a78941cde28487af2d1c1b2d90b1` / [37699429841/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37699429841/attempts/1) |
| A3 S2 drain [#451](https://github.com/dong-qiu/deep-insight-agent/pull/451) | `b8fd27f799ab1b2a0e5581d55b487bdd9fb5efce` / `4d70679e9f40aa8261378792677bfb235258d9fb` / 37700796955/1 | `bb0b1c0ae9af9de7089abb85559440a33849aea1` / [37703691664/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37703691664/attempts/1) |
| C2f source consumer [#452](https://github.com/dong-qiu/deep-insight-agent/pull/452) | `04ee56578e4e8ccaf2e7ecc47466c44e2685b019` / `4526544c97511c9f53e0f444f1f5b4765dc25943` / 37706900772/1 | `8d8ac91e699651c761e82cd82113db29823511b4` / [37709253322/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37709253322/attempts/1) |
| A3 S3 strict terminal [#453](https://github.com/dong-qiu/deep-insight-agent/pull/453) | `d3969570bf895b12f1d88183ba3df28e4b406bda` / `694b697cfd19c8d6b004640b1bc67a4ef6bfd82b` / 37710245116/1 | `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0` / [37710999247/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37710999247/attempts/1) |
| A3 S3b staged terminal [#454](https://github.com/dong-qiu/deep-insight-agent/pull/454) | `cce88134bbb748472bf1aa71263ca6716e6a66a1` / `8e4873191038bd5703f85b18e73088d096bc1311` / 37724003592/1 | `3486ca679ef479ced539ba55a8e7cff091117662` / [37725190924/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37725190924/attempts/1) |
| A2 A3 isolated consumer [#455](https://github.com/dong-qiu/deep-insight-agent/pull/455) | `407f66461f4b7c65c41d44025b76785ee4bb11c3` / `36084b8abaec72c747f4dab4def901e5d4874f34` / 37728859644/1 | `4433689f70588dc7a1143037dc9bbb29516eac83` / [37729534773/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37729534773/attempts/1) |
| A3 isolated SSM controller [#456](https://github.com/dong-qiu/deep-insight-agent/pull/456) | `1f4dbb0f699ba27980f247a80e644aecbd8f9a74` / `5526f75663dbb2f7d91e98ae098bbfcd3989ea5a` / 37734222607/1 | `5b65d99c12327c94059a32043463b0f22b8e6015` / [37734983974/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37734983974/attempts/1) |
| C2g followup HTTP control [#457](https://github.com/dong-qiu/deep-insight-agent/pull/457) | `c729a1e966e3dc56596c72484394349c7426e540` / `a8f3cfa58261f325013ef8edc48d18764977166c` / 37735867485/1 | `1f278ec815cd75a2f0da26d3e94e9de822daab91` / [37738854606/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37738854606/attempts/1) |
| A2/A3 isolated refusal integration protection [#458](https://github.com/dong-qiu/deep-insight-agent/pull/458) | `20836d0e387611952de5854e52594b08d8ccfb01` / `eb2302db0afb26d39398261f693886e7b7e645e7` / 37742563499/1 | `5de58f707698f9b0fe186db104d1305d0f4f2efe` / [37743585704/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37743585704/attempts/1) |
| A2/A3 owned hold-first drain [#459](https://github.com/dong-qiu/deep-insight-agent/pull/459) | `b88364bf058b61daefe6472847d70428dedea1d3` / `bc307dd6ed04441a919f13aaff2db378b747f2d2` / 37748057698/1 | `284efebd8a8b21356f66e73680940879ee73126c` / [37749589993/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37749589993/attempts/1) |
| TD04 re-alert [#461](https://github.com/dong-qiu/deep-insight-agent/pull/461) | `6bb275ce0e9d85ba4c611ea9ba4e65873997b846` / `16e9b835d8796e6fd111520342745349fed81af9` / 37764537940/1 | `8bdc1cde688682fb9a5a5769b8cb311abaf8d79e` / [37765697243/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37765697243/attempts/1) |

## 候选与main原包索引

均在私有本轮coord/下；目录0700/文件0600，不将raw日志/凭据/业务原文入Git。

| PR | 候选index SHA256 | main index SHA256 |
| --- | --- | --- |
| #444 | `pr444-ci-37678449999-attempt1/archive-index.json` 3830bytes / `2ac1fb80a665f05532070486362f94c200b147bb927374099d2ad5193be53b8c` | `main444-ci-37679937948-attempt2/archive-index.json` 5066bytes / `0e3d5a61670cbfe18a93c71759eee7ac5bfc76e98af72e99c411edde1f46312f` |
| #448 | `pr448-ci-37682264475-attempt1/archive-index.json` 4519bytes / `c1b1873764e331c6e2ecb6f2c9d474a43736f65767d4befb8d2bb4f5b9118318` | `main448-ci-37686929840-attempt2/archive-index.json` 5066bytes / `d66888f9528a308266f7940f253b1d670fdf56fee9981046807efc8fa6dd8ace` |
| #445 | `pr445-ci-37687359002-attempt1/archive-index.json` 4519bytes / `9eab2fa476a3323b0c7fb2b2a86eb97079b91f15aaacaffa07283226f11581c8` | `main445-ci-37691558952-attempt1/archive-index.json` 5066bytes / `d7ec46dfb93352b9eea272a0ad2e1275fb5efdd3165f1e5cdcefdb65f4e71fd9` |
| #446 | `pr446-ci-37691813038-attempt1/archive-index.json` 4884bytes / `58246a7f020f0c457c3843d990f6d60fa9d074b288db0a00764f17966809501d` | `main446-ci-37695107249-attempt1/archive-index.json` 5433bytes / `dd3e674ea8fc36fbcd3f69da95e11235c1efba11db0cf362cdb9420066a94eb2` |
| #447 | `pr447-ci-37695310964-attempt1/archive-index.json` 4884bytes / `bf8746f27e2cfbc395432dc54bbec43df6935364d0b91ffe51e034cad32eede9` | `main447-ci-37696229494-attempt1/archive-index.json` 5433bytes / `2b566a3f71f3ec52c5fec4d7b178bdffc9a83b9d16316fdaa156a58979afc018` |
| #449 | `pr449-ci-37697586876-attempt1/archive-index.json` 5770bytes / `4e3fc5ef310e7e65ded1b235c56f14e4645a63cce6e2b2af427d3afdccb8b071` | `main449-ci-37698406412-attempt1/archive-index.json` 5433bytes / `7c594345231a462db5b3e8ed1b5db0f8a2c9deb6e296319ce7ac57e92ea0da68` |
| #450 | `pr450-ci-37698833414-attempt1/archive-index.json` 4884bytes / `7ba937887617d472db80a9045520d206d446f5c3612d5dabf9de73474af334e3` | `main450-ci-37699429841-attempt1/archive-index.json` 5433bytes / `b8bd8cf9b2b911ee81b46ab44cfbb36bb8fa119449edc74809d08e107d3c631c` |
| #451 | `pr451-ci-37700796955-attempt1/archive-index.json` 4884bytes / `9d7dc04a3fe57425ce3b52b7d2a7991167509754e899d2f6e3527436adb47125` | `main451-ci-37703691664-attempt1/archive-index.json` 5433bytes / `927f1c8f2b19ba53adb820ca250e253cb91278f74c31ab9bf5a03f7927fc198d` |
| #452 | `pr452-ci-37706900772-attempt1/archive-index.json` 5770bytes / `fa40e5488334734332d8b80cc6bae2dfd5acb86e2d13da9454f72b4700d687d5` | `main452-ci-37709253322-attempt1/archive-index.json` 5433bytes / `de0f9032d9703f80c987d48bf44710b74f35ec1ecbefd04d83118b9be0369c35` |
| #453 | `pr453-ci-37710245116-attempt1/archive-index.json` 4884bytes / `8ace3def36352da36d6890adcbc21f0e6db7a9f62347163b23bc11f353ce6cbd` | `main453-ci-37710999247-attempt1/archive-index.json` 5433bytes / `960d4604f13100ed0033f57dc6ca00bf78dbe1b0e8fdd0a8857aa26146b17440` |
| #454 | `pr454-ci-37724003592-attempt1/archive-index.json` 4884bytes / `902e3e619248fb02883a235de84d0bd5b0a4d6f9025d7a5ab2056d6c6a585fc9` | `main454-ci-37725190924-attempt1/archive-index.json` 5433bytes / `82130183edb0d12082d1a796378eb38a61b5ae3cc0a270cbd128cbec3da233ca` |
| #455 | `pr455-ci-37728859644-attempt1/archive-index.json` 4884bytes / `b2a4cee9082c272581b643f487a7f76db30075ef092468bc9cd6598686e655c2` | `main455-ci-37729534773-attempt1/archive-index.json` 5433bytes / `23070244ee972de8df53fbf9c27dc34df089ffbfcd11120119bd7500a62b928d` |
| #456 | `pr456-ci-37734222607-attempt1/archive-index.json` 4884bytes / `755985bc09c5297b96a208418def0f482b4c95f0091b745b510ccf511eddee9c` | `main456-ci-37734983974-attempt1/archive-index.json` 5433bytes / `90c27feab2b3e14e08a79f84f49484ed5836352effa8eedb6d6946e7d052d624` |
| #457 | `pr457-ci-37735867485-attempt1-v2/archive-index.json` 4917bytes / `b1f51ec515ee7dcaf95257feb8fded32d400990b0ecdde0e42b36467f3e41a05` | `main457-ci-37738854606-attempt1/archive-index.json` 5433bytes / `63d4b267bebb3cac43ddde5a3468a76f3ef1566dfc5afbb0cb807f353fafb876` |
| #458 | `pr458-ci-37742563499-attempt1/archive-index.json` 4884bytes / `93f1e318f854efccdeeb076f992589880d9be3db1ab95053095e95a8d4a2a62e` | `main458-ci-37743585704-attempt1-v2/archive-index.json` 5469bytes / `21ebb16f813f2af555cff24150a4bf54d3b8f04d312f0595430238403498c631` |
| #459 | `pr459-ci-37748057698-attempt1-v3/archive-index.json` 4946bytes / `a3a53058bca1054d5b8be55867cabeae66523c4e895705edf746767a14d7cb47` | `main459-ci-37749589993-attempt1-v2/archive-index.json` 6839bytes / `1859c7cffc8e90e610b5af976fe8aa15e7778d14b3489e7578bf3ad869712d36` |
| #461 | `pr461-ci-37764537940-attempt1/archive-index.json` 4913bytes / `8b1d71d462c2021131f8f68af2819604ee23582952de32f4033f0cd9542bfa16` | `main461-ci-37765697243-attempt1/archive-index.json` 5462bytes / `87fc74dd79ee2cf69ef19aa8979c646837aeb582335da21ab57e7bbd8e6fb369` |

## 真实反例与修复绑定

| 原反例与原绑定 | 修复及实际验收 | 仍未证明 |
| --- | --- | --- |
| S0热journal在SQLite预检前恢复/删除；S1旧候选Docker TS2307 | #448全部SQL前物理门58native；#445类型置于既有runtime允许范围，新候选Docker实际通过 | 非业务恢复或扩展Docker上下文许可 |
| C2d原ordinary nested异常被控制冲突改写；C2e原RSS/article/robots上层已有Response却未join清理，三条原红例 | #449保留原stage_failed/retryable；#450三上层最小guard await discard，原3red→3green及永久真实body/cancel反例 | arxiv/shadow/raw内部控制不等于已覆盖 |
| S2原首cancel被source_closed覆盖；077 umask掩盖synthetic0644；初次正常push被历史AI路径祖先门阻断 | #451首因保持、失败采样只记null、fixture显式chmod0644；真实20/20；全文/实际回归/双审后空Eval盖章，正常hook通过 | 不以fixture问题冒充业务bug，不改门或清零旧失败 |
| S3原localfinish异常可能丢已观察COMMIT诊断；b4原ATTACH创建后execute1/task1/claimed | #453原localfinish16/1red→17green；ff actualdatabase_list在admit前拒绝，原独立ATTACH red→green且execute0/task0/queued不变；提交后registry失败保持unknown/business committed，无fallback | 两个库crash不是原子；C3真实partial usage在close后仍能写，证实只覆盖terminal |

详细原输入、日志、最终diff及独立报告沿各PR专属收据/上述原包索引，不把同head fixture失败或CI旧attempt改签通过；所有实际测试无真实模型质量声明。

## 非覆盖保全与原证据缺口

私有持久根 `/Users/dongqiu/.local/share/insight-agent/evidence/`；目录0700、文件0600。
本轮根 `refactor-coordination-20261008-185052/`，不提交原日志、业务原文或模型输出。

| 原材料 / 私有索引 | 当前已核位置及SHA256 | 边界 |
| --- | --- | --- |
| A3历史临时证据 | 原 `/tmp/insight-a3-evidence-20261007.Rq6vkN/` 保留；本轮 `a3-original/` 非覆盖复制60文件2106013bytes，`a3-copy-index.json` = `ae58bad3ffcea23bf54d9f60dd6e134c1e4871626d662e4a9e96b34c9536331c` | 每文件size/hash一致；不删除原目录，不从摘要重造证据 |
| A3-S0最终原包 | `a3-s0-closeout-440-6452c65-20261008/sealed-files.json` = `240c34135d7940e0d7f21612f577f320d975e880baea55a8ed65d1e0112db6b7` | 原候选/main ZIP和seal仍保留；本地归档不是异地备份 |
| A2 #443原包 | `a2-business-matrix-20261008-zwd5vh3o/sealed-files.json` = `f79c6a4cd23ba4afa202a3318e67c4d69a73210a6311b73ed81a5f2746d3135c` | 候选与main分别绑定，旧镜像矩阵不会移植到新代码 |
| #443精确main原始4包 | 本轮 `main-443-original/archive-index.json` = `2d7927401676dfa5c5cda6728af8d99fc96e90e89b3d28c550ee865916393c4d` | ZIP hash逐一匹配GitHub artifact digest；期限2027-01-05T18:15:48Z，不宣称GitHub永久保存 |
| TD-14原实测 | 已知 `/Users/dongqiu/Dev/code/insight-agent-td14/.private/td14/authorized-20261007/` 当前不存在；私有根直接清单及定向交接未获得迁出位置/有效index | **现保存位置缺证**，不等于宣称永久丢失；不重跑冒充原件、不广搜个人目录 |
| D3原样本 | 已知 `/Users/dongqiu/Dev/code/insight-agent-d3-report-list/evals/out/d3-report-list/baseline-v1.json` 当前不存在；没有迁出index交接 | **现保存位置缺证**；原13328322bytes和历史hash只是旧记录，不是本轮原件验证 |

TD-14唯一实测仍是D7前 `d18009f221a51662ca3802d0fc06a2839e0ee929`，169.377s/34attempts，
smoke/incomparable/manual pending。1项人工裁决必须由人完成；原item未定位，无法提取可靠
逐项AI意见。AI参考建议是保留pending、待原item+原输入/输出/原因与索引归属核实再裁决；
这项建议不计人工裁决，不签真实质量或性能通过。D3的13/24 noisy、20/24 observer及P0c warning保留。

## 20项整体与本阶段逐项口径

| 项目 | 整体状态 | 本阶段状态 / 未关闭边界 |
| --- | --- | --- |
| TD-01 初始化 | 既有范围关闭 | 沿既有事实源保持；不重写迁移或恢复契约 |
| TD-02 reader | 既有范围关闭 | 既有可见性/历史快照及人工验收保持；未测browser P95保留 |
| TD-03 认证 | 既有范围关闭 | 既有认证/会话保护保持；本轮无生产认证矩阵 |
| TD-04 数值配置 | 部分 | 通知两字段#447与重告警两字段#461已合入，精确main37696229494/1及37765697243/1通过并保全；合法/default/clamp/getter/加载时机保持，其他危险字段仍逐项工程待办，无全局框架 |
| TD-05 测试入口 | 既有范围关闭 | 新运维测试复用真实递归入口，JS不冒称严格TS |
| TD-06 报告维护 | 既有范围关闭 | 历史维护拒写及预览保持；版本化历史修复不重开 |
| TD-07 运维入口 | 既有范围关闭 | #435硬阻断保持；A3新维护工程不等于生产放行 |
| TD-08 信息边界 | 既有范围关闭 | 构建允许列表保持，S1类型修复未扩大Docker输入 |
| TD-09 恢复能力 | 部分 | A2#446有界版本对合入/main通过；A3 S0修复#448与S1#445合入/main通过，S2#451合入bb0b1c0、精确main37703691664/1通过并保全，S3a#453及staged终态#454合入、精确main37725190924/1完整success保全；A2/A3隔离消费#455合入4433689f、精确main37729534773/1完整success保全；离线SSM记录控制#456合入5b65/精确main37734983974/1完整success并保全，但未实现实际SSM transport；全writer覆盖、组合test-only保护#458合入5de58/精确main37743585704/1完整success并保全，两真实拒绝链不代表正向停止；正向owned hold-first隔离入口#459已合284efebd、精确main37749589993/1完整success与原包保全；全部许可仍false，实际运维消费/全writer仍工程待办，全量历史恢复incomplete |
| TD-10 取消预算 | 部分 | followup#444合入/main attempt2 success；collector#449已合，精确main37698406412/1通过并保全，178实际回归/双审/Eval例外绑定；source#450已合cfca、精确main37699429841/1通过并保全；C2f消费者#452已合8d8ac91，精确main37709253322/1完整success保全，426实际回归/四TS/lint/build及双独审完成。C2g真实followup POST#457合入1f278ec8/精确main37738854606/1完整success并保全，实际当前构建HTTP/Chromium路径通过；原403潜在外部尝试、未知发送/费用及原输入缺证保留。arxiv/shadow/raw内部fencing及其余入口仍工程待办；无默认deadline/全局费用承诺 |
| TD-11 DB职责 | 既有范围关闭 | 保持只读/启动/迁移职责，S0只处理维护数据库恢复前门 |
| TD-12 模块拆分 | 部分，阶段收口 | Analyzer/reports/report-gen延期、LLM/replay保留；不重开 |
| TD-13 用量 | 既有范围关闭 | 既有Job最小契约保持；followup不新增UsageJob或完整账单承诺 |
| TD-14 评测性能 | 部分，阶段收口 | #431诊断/暂不优化保持；原材料位置缺证、1项人工裁决pending；AI意见不是人工裁决；不追加实验 |
| TD-15 reader性能 | 部分，阶段收口 | #436测量/暂不优化保持；D3位置缺证，所有observer/noisy/P0c warning保留 |
| TD-16 浏览器 | 既有范围关闭 | 必需CI实际browser检查不skip；不以安装pending记通过 |
| TD-17 CI | 既有范围关闭 | 保持单应用build复用与独立Docker必需门 |
| TD-18 构建依赖 | 既有范围关闭 | 双编译器/vendor退出条件保留；不无目的追新或削弱audit |
| TD-19 台账 | 既有阶段完成，整体未关闭 | 本轮保全#440/#443原材料、增量索引；原始审计/TD14/D3现位置缺证，不自行关闭 |
| TD-20 ID容量 | 部分 | S2a旧head专项方案准备，外置guard bridge工程及专项验收待办，真实模型预算0；S2b及新main不能补签旧质量 |

本表不是全部技术债重验或新产品承诺。本阶段未访问生产，当前上线状态未核。

## 性能测量warning保留

每轮原reader测量与通过门分开记录，代码review B0/W0不消除性能warning；不追加性能实验。

| PR / 精确main | baseline/current P95 ms | warning / passed / 增量ms |
| --- | --- | --- |
| #444 / 37679937948 | 0.06937536 / 0.09126260 | true / true / 0.02188724 |
| #448 / 37686929840 | 0.18167424 / 0.22069864 | true / true / 0.03902440 |
| #445 / 37691558952 | 0.12840580 / 0.16576744 | true / true / 0.03736164 |
| #446 / 37695107249 | 0.10592884 / 0.13698364 | true / true / 0.03105480 |
| #447 / 37696229494 | 0.17133588 / 0.21443136 | true / true / 0.04309548 |
| #449 / 37698406412 | 0.07114328 / 0.09324664 | true / true / 0.02210336 |
| #450 / 37699429841 | 0.13590436 / 0.17622544 | true / true / 0.04032108 |
| #451 / 37703691664 | 0.12423960 / 0.16403596 | true / true / 0.03979636 |
| #452 / 37709253322 | 0.07062924 / 0.09321376 | true / true / 0.02258452 |
| #453 / 37710999247 | 0.06731608 / 0.08866756 | true / true / 0.02135148 |
| #454 / 37725190924 | 0.07367108 / 0.09676220 | true / true / 0.02309112 |
| #455 / 37729534773 | 0.10869256 / 0.14043752 | true / true / 0.03174496 |
| #456 / 37734983974 | 0.16980276 / 0.20676680 | true / true / 0.03696404 |
| #457 / 37738854606 | 0.19478144 / 0.24173540 | true / true / 0.04695396 |
| #458 / 37743585704 | 0.17261716 / 0.22199424 | true / true / 0.04937708 |
| #459 / 37749589993 | 0.08168964 / 0.10279784 | true / true / 0.02110820 |
| #461 / 37765697243 | 0.10634952 / 0.13948464 | true / true / 0.03313512 |

## 最终受影响路径与必要质量门

#459受审head b88364bf、实际候选checkout bc307dd6、normal main284efebd分别绑定；ordered parents5de+b883、tree96d3与受审树一致。候选37748057698/1和精确main37749589993/1完整success，两个原包分别全部11/12件、三份actualtested绑定与Git parents/tree/hash/0600核完。实际Linux native627/627、零skip包含新owned30；当前应用3253/293files及built HTTP/browser/Docker/audit门均执行通过。主干advisory PR与full模式opposite docs为正常skip，不能当独立文档检查通过。此段保留#459的受审时点；其后#461完整应用结果绑定8bdc1cde/37765697243，见本节增量。后续仅docs PR的policy分类/文档CI不能称新的应用或镜像验收。

代码/路径审查采用pre-pr-ai-review，最终高风险维护/fencing/SSM有两位非作者FULL。owned双方各自30/30，所有2228作者原材料和140×29物理inventory1832present/2228absent独立核；每位Reviewer新32×29、419present/509absent与原包分开。六真实SIGKILL均在恢复前保全原main/journal/WAL/SHM/marker/八A2角色和两optional absence，再分类实际initial/close/final COMMIT事实。initial-before回滚active/rev1/OPEN/failures[]无nonce，controller_uniqueness仍unknown。首取消、失败sample NULL、旧owner/revision、两进程同ingress CAS、unknown COMMIT不重试、缓存handle真实unsafe热journal BEGIN0、原CLI abs+mono直到第一CAS/cleanup、64KiB/UTF8/noEOF/SIGINT/异步EPIPE反例均执行实际入口。

最终只六NEW，旧S0/S1/S2/consumer/core/staged/schema/policy/镜像批准边界不改。typed结果全部ready/phase/生产/回退许可false，safe_rollback=null，跨库partial-stop、旧reader跨连接/ABA及同步SQL耗时界仍明确限制；没有clock/window/source/driver/callback公共注入或unlock入口。空/完成登记与fixture状态、health或信号取消不能签全writer静默。旧447冻结镜像不含新维护代码，新候选须重新冻结/验收，不能移植旧矩阵。

与AI语义有关的每个已交付切片按实际最终diff使用eval-gate选择受影响路径、真实SDK fakefetch/native/HTTP/source-body/reader/生产路径回归及类型检查；纯控制协议不证明真实模型质量。A1不执行这些维护/report/HTTP确定性路径时没有拿其补签，未预签skip、未改评测口径。TD20旧head专项仍只是零预算准备。

## 当前剩余分类与唯一后续工程动作

退出判断来自只读专属handoff `a3-remaining-exit-audit-20261008-7he17fgl/handoff-v1.md` 11797bytes / SHA `6947ad7435f7c5c199879b6e477f36443c34c3f3b057f1a26bce0d7762207f9b`；index8800bytes / SHA `c331d45ee8da2c8527b307a898d9e7b0341bc041fe5dde5722c7beaff990cf39`，绑定31份b883不可变Git输入及旧R2原时点报告。协调者全文读handoff并核全部Git绑定与两私有原件；这些是源码盘点，没有作为新增测试或生产收据。

| 分类 | 当前未完成项与实际消费路径 | 退出条件 |
| --- | --- | --- |
| 工程前置 | HTTP internal/generation-dispatch仍只传telemetry，未组合admission/staged；getDb startup/bootstrap/reconciliation/seed、直接runJob及其他入口未纳共同维护门 | 确认原owner交接、冻结一个具体入口及其阶段/恢复合同，逐片真实SQLite/文件效应与迟到反例；不能以fixture状态或health成功签全writer静默 |
| 工程前置 | S3b真实core负控仍允许revoke后C3 usage写；report/raw文件效应、其他持久提交缺共享维护fencing | 保留原lease-loss拒写、预算优先、validator白名单及planned/committed/unknown事实；分别确定真实最终提交边界，不能删原unfinished证据 |
| 条件工程 | crontab→backup-db异步db.backup及reports/raw拷贝、manifest/rename/prune未消费A3；snapshot/restore/record-deployment也不是新维护消费者 | 全writer前置与固定隔离consumer/效应/故障恢复合同先明确；现owned持久held不能改ready、refresh/release/newop或送active stage-submit绕门；本轮不执行真实备份/恢复 |
| 工程+缺证 | recovery-time-coverage的C1 synthetic registry、真实报告删除/save/reader/PPT边界已有；历史恢复runner/startup仍缺可信checkpoint连续覆盖、全部delete writer门及snapshot/cutoff/start-receipt绑定 | 不重复已交付C1，不把旧KNOWN GAP绿签修复；可信历史覆盖/issuer/真实远端终态不能由fixture补造 |
| 工程待交接 | TD04 re-alert两字段#461已完成；followup route的FOLLOWUP_RATE_LIMIT及其余危险字段仍待合法/default/getter/加载时机有界校验 | 原B/Session route文件归属未释放，须专属交接再冻结字段验收；不凭clean接手。控制校验不统称模型预算阻塞 |
| 需逐字段划界 | 来源/熔断/AI可见输入、选择/校验数值 | 合法语义保留的非法值拒绝独立冻结；若改变模型/prompt/来源/校验口径则按用户边界先批准及eval，不预盖章、不改默认 |
| 缺证/人工 | TD14/D3原产物现位置及有效index/hash、TD14原1项人工裁决输入缺；原审计/可信覆盖及合格新镜像证据不足 | 仅定向原owner交接，不广搜/重跑冒充；AI建议pending不作人工裁决 |
| 模型预算 | TD20旧head真实质量专项；外置guard bridge零发送工程仍须先验收 | 本轮预算0；旧235质量缺口不能以S2b/新main补签；未来100attempt/20retry/45min仅申请建议 |
| 生产授权 | 新候选镜像重新冻结验收、实名窗口/真实主机与SSM/备份迁移恢复/回退批准/hold释放 | 工程与必要可信证据齐备后才一次性精确专项申请；#435 blocked、safe_rollback=null及原hold持续，串行避16:50–17:30UTC |
| 延期/取舍 | TD12延期/保留、TD14/15不追加优化、无新线索历史搜索、P1/Brief | 不重开，不自动记100%技术债关闭 |

唯一后续工程动作应先取得旧C1 Session的backup-db/backup-integrity/cron专属文件交接，再冻结一个真实隔离备份消费者的阶段/故障恢复合同，再实现该具体synthetic DB+reports/raw路径与反例。持锁不得跨backup await，既有held不能推导执行资格。这属于仍待完成工程，不是生产申请或必须额外人类许可；若实际方案改变已确认架构/历史数据/安全批准边界才请求批准。本轮稳定六NEW已完成双审→PR→精确CI/main及原包保全；17片交付和本只读审计不关闭上述工程，不宣称全部授权工程100%完成或只剩外部阻塞。

## 原失败、隔离遗漏与原包读取处置

#444与#448的原main attempt1 cancelled/浏览器镜像等待保留，精确相同SHA的attempt2才是验收。#454原PR policy失败、实际tested8e4873与后续ref505498元数据相同parents/tree但不是同一个checkout都保留；#456旧whole lint ambient缺declare失败及最小8byte声明修复分开，不以原五MJS局部lint冒充whole检查。原field/cached/CLI/fixture准备失败及其原时点在专属原包/收据保留，不重写历史通过。

owned原fullOPS `ops-regressions-v1.log` 624=618pass/2fail/4本机镜像skip；原 `owned-final-v1.log` 29total/28pass/1fail（final owner Missing expected rejection）保留。原1s fixture并行load耗尽时门正确not_attempted/timeout；只一般测试余量改5s，不改库≤60s/专门expiry/原mono或全局deadline。正确五旧文件184/184与最后作者30/30@3dd分别绑定，b883随后仅两doc追加、runtime/types/tests逐字节不变；两Reviewer各自b88330真实运行不是作者重跑。后来候选/main实际627/627零skip是新Linux CI，不倒签原624全绿，也不将原4skip作本机pass。

C2g原测试漏默认fakefetch，以合成key走默认SDK路径观察HTTP403，有一次潜在外部attempt；实际发送次数、响应来源/中间环节和费用未知，未观察成功模型响应。原瞬态输入未捕获，后来重建材料不能算原件，原不准确v1和晚DB关闭异常保留；isolation-omission-v2.json2381/SHA747defd9f0a6c4670b22c3c8e50ba01434a4a48e54ac9cb18cd025c8b457db29修正事实。后续fresh SDK在构造前强制loopback、每例默认fakefetch和独立builtserver；实际framework disconnect的cancelled/本地socket closed不是远端全任务终止。预算仍0，不能给全阶段盖attempts0/费用0章，不reprobe或补查生产账户。

#457/#458及#459候选/main归档中，原部分目录和EOF保留；v2/v3只重新读取同一已completed run/attempt的原API/artifact，不是CI/测试重跑、不借其他SHA原包。#459 main v1某zip三次EOF原stderr保全，单次HTTP1取得同一原artifact904bytes/hash与GitHub digest一致，随后临时HTTP1/每GET最多3次完成新v2；这不证明唯一网络根因。只读helper仍校验原digest、tested对象、terminal CI与必要门；未放宽标准。性能Warning全部按原双门保留，没有追加性能实验。

## 私有归档、保留环境与归属

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/`；本轮协调索引在 `refactor-coordination-20261008-185052/coord/`。目录0700、文件0600，原SQLite、WAL、报告/敏感原文与日志不入Git。总交付 `completed-deliveries-v10.json`31986bytes/SHA7ea613b3ae715b5802aa348cb9628d45d018f104e89cc87192985748fa32faff绑定17片候选/tested/精确main/CI/原包及reader Warning；旧v9十六片原索引保留。

owned作者 index-final-v1.json10313/SHA48ae39cb84c6ebed66b69f3821dbb483ccc1c7454b3ea0edbe7e780992597c16；R1 index169766/SHA4b0047be36797ccbf82f3960cc1652fc49c05a6269cb3a746393cf02123255ac，R2 index6388/SHAacc941935c5696f36771298b245652029dd0349bde0da7801535ec2e4dd82851；实际PR459独立复核4651/SHA20f8cfba86d567a462328b46e8f297895ac7c11ed9bf288c504b38ed10d29b49。两FULL B0/W0与PR B0/新增W0只判受审隔离合同；不清历史Warning或签生产。root合前判断1667/SHA4e61e94a9753d447eba02557dd8c2091c4a0d97f153d3528a2525e887fd250d2先完整保全必要候选证据、核latest5de后才正常merge；精确main完成/原包保全后才准备依赖文档PR。

2026-10-08T08:36:45Z只读v5观察64WT/15处未提交文件名/38个local head非main284ef祖先；worktree-readonly-inventory-v5.json33927/SHAe9aca7cb42f652f3ef2e84816420b0acd34db494ea67f709373d4cbe760cbd0d。非原子时点，不证明未读内容相同、Session已释放或可清理；文档交付后专属私有索引另补最后快照。全部WT、local branches、tmp/private原证据保留，不执行清理。原调查/方案分支未合不代表内容未交付，相关方案已随代码PR入main，不重复实现。

root唯一写四主台账；A保持staged10/SSM9/integration2/owned6及re-alert5冻结内容，B保持consumer5/C2g7及原交接源；root仅获得相应正常Git/meta交接。其他原Session、Brief/analyzer/shadow和Reviewer各自环境归属保留，clean/FINAL不构成释放。新WT仅必要.env.local从主复制600并先隔离DB_PATH/DATA_DIR，运行env-i不加载凭据；不复制.data/live SQLite/WAL/报告/.env.development.local，不输出密钥。

工程main、reviewed head、actual tested merge、CI镜像和生产分开；本轮无AWS/SSM生产访问或部署/stop/drain/restart/备份/迁移/恢复/配置覆盖/历史回填/回退批准/hold释放。生产身份与上线本轮未核。工程与可信证据前置齐备后才一次性精确目标/命令/窗口/副作用/实名人员/失败处置申请，串行避16:50–17:30UTC。

## 历史协调原件

较长启动/逐时点协调时间线完整非覆盖封存于 `coord/master-coordination-chronicle-v5.md`，80783bytes/SHA `05590f7b92a63cfeec14556eda05dd12ffa4256a66c781599e241f2612b939d2`，保留旧pending、各原失败/修复/原包时点与doc草稿；v3/v4冻结副本和独立FULL报告也保留。既有Git台账/spec/专属收据的历史记录未重写。本文入口汇总当前事实；最终四文档commit/PR/精确docsCI和最后归属快照只记录在专属私有最终交接，避免伪造本文件自身未来SHA或借docs分类skip补签应用质量。

## #460 文档交付与 #461 配置增量

四主文档[#460](https://github.com/dong-qiu/deep-insight-agent/pull/460)受审head `d3e8dd93f37fa6ddf8804366925fa36b1aae0fe9`、实际tested `40cc9d23baf1655659c2cb8857e82904d95908a7`、normal main `0ca435d63dbf1fdb69e8abcc3846c687fb137a8b`分别绑定。候选37756308419/1与精确main [37760885978/1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37760885978/attempts/1) docs success；两原包index分别2411/SHA d98d504a3b1027ed41b5a6deaf028776a8b665e2f08cf806f5df273c1654284c、2060/SHA ebff8bba2380eb04f402cbf729167e147e71d0e66a22dedc7117c31a9fd0bae9。两独立报告B0/W0，正常merge原GraphQL EOF后先确认仍OPEN再单次正常重试；不绕保护或hooks。docs实际检查与必需聚合门通过，full app/Docker为正常分类skip，不能把0ca记为新应用或镜像验收。

#461仅五路径，保持原数值grammar/default/clamp/动态读取与合法失败状态，只对最终非有限重告警毫秒拒绝，并用固定field/reason诊断，logger抛错不改变health响应。原80测试13fail/67pass保全，global原红仅是缺诊断；作者与独立Reviewer各自6文件105/105零skip、四TS，作者wholelint与Reviewer受影响lint分别绑定。实际候选与main均3333/294files、native627/627零skip及build/HTTP/browser/Docker/audit通过。候选reader Warning true/PASS true，ratio1.214334/delta0.04352432ms；main Warning true/PASS true，ratio1.311568/delta0.03313512ms，原双门不放宽。P1 extended checks按实际非P1 scope正常skip，不记其新的专项通过。

作者索引 `td04-realert-20261008/index-final-v2.json`13725/SHA9a1aa4816f7c33145250c29c9c60ad70b8b0e9a6803d32355ee8175b113fcf64；R1 FULL index21110/SHA b121d0653224277b1671ce3621379c185177d7dcc9c12244756c7be34a42d120；R2 actualPR index8295/SHA5b50724a0081f0bccb7b60a2fda15f2b3d73cfd5f433c59205b2a5ce620bcb0c，均B0/W0。五源码/18未变闭包/43作者材料/71R1材料/28R2材料和807tracked TS输入superset独核；superset不是compiler listFiles。私有runner envDir:false与逐文件凭据/通知target absence、R1六文件fetch attempts0只证明该运行，不签全阶段零费。原docs调用失败与修正、旧v1/plan warning都保留，无A1或Eval skip预签、无模型/prompt/source/validator/schema/维护许可变化，TD04整体仍部分。

下一备份消费者定向原码盘点封存于 `a3-backup-consumer-feasibility-20261008-qy5n3qov/handoff-v2.md`10568/SHA aeaef9c256ddbd621c6c5cbdd639aa87da288d4ff1fa8c580209f3229f0c7fa2、index-v2.json10227/SHA1f9958e9363f7012545b8be50d33e6c8ef041ae9d91d5472220b004595d231b5；28个不可变0ca输入与8bd逐字节相同，协调者全文读handoff与backup-db/backup-integrity并核size/hash/700/600。盘点不执行测试或备份，不计新工程交付。现held/allwriter unknown/allpermfalse不允许正向backup-db；异步db.backup及DB/FS发布/轮转不受terminal fencing覆盖。C1 manifest没有operation身份，新的只读fixture组合既重复已有inspect/verify、也不能认证真实备份来源。旧C1 worktree干净未证明文件释放，专属交接仍缺；已定向请求负责人或交接索引，未答不视为交接。先补实际writer/异步效应/取消/重启阶段合同，不能把这些工程写成只差生产或模型预算，亦不改hold来执行。两新worktree及原产物全部保留；最终readonly归属快照与本次文档自身精确PR/CI只进入私有最终交接索引。
