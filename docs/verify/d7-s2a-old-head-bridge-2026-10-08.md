# TD20 / S2a 旧head外置bridge：隔离工程证据

本切片新增五个独占工具/spec/收据文件，未修改旧生产模块、prompt、schema、模型默认配置、来源、数据集或既有S2b守卫。工具基线为a51c0579310e9a3c380fc1caf2862ef14870ed75；动态执行对象固定235045d6424640d79c79874a403749c6bd17b823，tree为932ca0eee33ac2f27bc1b883991a9ec5fd685cbd。提交、受审head、tested merge、PR、合入head与精确main CI由协调者在最终交接独立绑定；本文件不预填它们。

## 实际路径与限制

- 实际旧analyze → primary/countercheck coverage → validateBatch，对单citation走旧citation_consistency_single；另以实际旧callStructured覆盖七operations及primary翻译system变体。
- 旧lock独立安装，实际旧Anthropic SDK HTTP429隐藏retry与旧Responses官方endpoint预检、合法EOF/application retry均经同一guard；每次先保全admission，native目的地永久127。旧head没有operation observer/logical ID，归属仅wire-signature，不伪造旧遥测。
- 默认cap0、未知body/getter/request/headers/model/envelope/URL、default SDK公有URL、安装身份错、dispose、307 redirect、100/20容量、取消/共同deadline、迟到finish/segment、partial write与证据写失败实际拒绝。首因sticky；完成后idle/原signal abort保持已有完成事实，随后新发送仍拒绝。
- 每request 1MiB、每response 4MiB、task 512MiB；真实512MiB容量case仅fsync no-op，其余真实HTTP/write/fstat/file bytes保留，不作durability或真实fsync性能证明。其他IO反例保留真实fsync。

## 作者验证

隔离命令以Node24.19.0、env-i、独立old worktree、无.env复制、显式fake credentials执行。原材料位于本轮私有b-td20-bridge目录；最终目录/文件权限、hash与受影响源码身份见协调交接的增量索引。

| 材料 | 实际结果与用途 |
|---|---|
| test-red-v1.log | setup目录缺失，失败，原样保留 |
| test-red-v2.log | 15/18通过；两个synthetic judge reason非法及SDK retry response取消反例失败，保留 |
| test-green-v3.log | 名称含green但实际16/18通过；单citation operation预期错、gateway负控缺fake header，失败保留 |
| test-v4.log | 实际24/25通过；真实fsync容量case先deadline、父级own-PID timeout，failed材料保留 |
| test-v5.log | 26/26通过；包括真实旧函数/SDK、容量和完成后idle/abort；容量限制如上 |
| test-final-controls-v2.log | 最终父级有界unknown收尾及显式独立DB_PATH/DATA_DIR后的25项轻量控制回归；容量case有意复用v5原script/bytes，不重复大盘实验 |
| test-old-caller-v1.log | 增补实际旧callStructured在途取消：原caller Error identity保持、HTTP1、迟到finish拒绝 |
| typecheck-final-v3.log | TS7/TS6 app与tools四路检查 |
| scoped-lint-final-v3.log | 三个NEW TypeScript文件，max-warnings=0 |
| old-ci-ref-v1.log | refs/pull/430/head精确235045d；CI无本地commit时获取该ref后核精确身份，缺失fail而非skip |

前置独立方案审已由R1与A通过；实现早期getter/晚finish/partial write三个反例及完成后timer/abort事实修正由R1实际复核。最终五路径独立审读和PR门仍以协调者后续冻结报告为准，不能把此作者收据当Reviewer通过。

## Eval路径判断与未完成范围

已按eval-gate读取最终路径：这是NEW隔离控制工具，未改生产AI语义/来源/评测口径。上述正控执行实际旧模型调用代码，但响应来自synthetic本地HTTP，只能证明控制、传输与归属；A1不执行NEW bridge，未用它补签，也未预签Eval skip。任何提交trailer由协调者在最终独立审查与实际验证后判断。

真实模型预算0，不写历史attempts0/费用0。TD20旧235质量Blocking仍保留；full专项harness、跨进程actor lease/恢复控制及真实质量方案/预算仍分别待工程与授权。S2b、新main CI或新checkpoint不能补签旧head。safe_rollback=null、deployment blocked、现有hold及#435生产硬阻断不变。本片不证明全writer静默、生产SSM、恢复可信覆盖或生产放行。

bridge首因仅options.signal、cap/deadline与自身sticky failure；native init.signal参与实际abort联结，其任意私有reason不导出到bridge，传输事实可保守标unknown。本片不宣称接完TD10旧所有单次取消/预算typed传播；上述实际旧callStructured在途取消回归确认caller Error原identity保持。

## R1 恢复移交及窄修复实际验证（2026-10-09）

以上为原 #463 的历史作者记录，未重写或代签。用户明确授权五文件恢复移交后，本轮从 `570ec795cfbe9e9581f7e3533bb30229daafb74a` 核对原文件 hash，再在基线 `08511c458163f52315128efc7fe0cbb9a4d668b9` 的隔离 worktree 实施。原工作区和私有原件未改动；不释放其他源码、备份入口或三份主台账。

本轮修复只改变 NEW bridge 的控制读取和 NEW 测试目录准备：在第一次 await 前以自有数据属性捕获不可变控制快照；验证原生 AbortSignal 品牌，后续读取及监听器操作绕过同名 shadow 属性；默认新建临时目录 canonicalize，显式非 canonical 输入继续拒绝。signatures 文件与恢复源逐字一致。两位独立方案 Reviewer 均无 Blocking；关于信号品牌和 shadow 属性的建议已实现并添加反例。方案通过不替代最终实现评审。

所有业务验证均在 Node `24.19.0`、空白/白名单环境和显式假凭据下执行。配置复制仅用于遵守新 worktree 本地配置规则，权限 0600、DB/DATA 指向本 worktree；业务 child 不加载该配置。初始化 npm 曾使用非支持 Node 25，已作为环境事件保留并用 Node 24 重新安装依赖；不作为验收证据。

| 本轮实际材料 | 结果及证明边界 |
|---|---|
| `.private/r1/implementation-red-EYAUc7/vitest-red.log` | 初版反例 30 fail / 3 pass / 27 skip，失败保留 |
| `.private/r1/implementation-red-QOYJQD/vitest-red.log` | 最终反例在原 bridge 上 32 fail / 3 pass / 27 skip；原 cap=0 被外部变更绕过，本地 server 实收 1 次；retry=0 被绕过后实收 2 次 |
| `.private/r1/implementation-green-CJ9eEm/vitest-green.log` | 修复后新增 35 项全部通过，原 27 项在该定向运行中未选；同一零上限反例实收 0 次，不以 admission 数冒充 server 计数 |
| `.private/r1/full-suite.log`、`full-vJSnBq/` | 完整 bridge 62/62 pass，50.20 秒；覆盖真实旧函数/SDK、loopback 429/EOF、原 IO/目录/取消及 512MiB 容量回归。容量仍仅 fsync no-op，不证明 durability 或 fsync 性能 |
| `.private/r1/adjacent-regressions.log` | S2b evaluation guard 与 checkpoint identity 32/32 pass，保留历史 ID 与身份隔离约束 |
| `.private/r1/typecheck.log` | `npm run typecheck` 成功，TS7/TS6 的 app/tools 四路检查 |
| `.private/r1/scoped-lint.log` | 三个授权 TS 文件 eslint 成功，`--max-warnings=0`；空日志为成功无诊断，不是缺失日志 |

上述路径相对于 `/Users/dongqiu/Dev/code/insight-agent-r1-recovery-20261009/`，私有原材料留存、不入 Git。冻结源码与验证日志 SHA-256：

| 对象 | SHA-256 |
|---|---|
| signatures（与恢复源相同） | `57a6be0ceb0a8213511200470f2f88a20f3db20f6b76b652dbe86970b0adbd8d` |
| bridge | `9eaba926ae84d68d71d7ac768fe2dd301c6c270339105369c97a1015b0207852` |
| bridge test | `c75eb5df5b48949c4d101f0868888b857cba722099e7f3b821fe4a172bc447ec` |
| full suite log | `1fdff31354330c9da2caa0d5269a146352132cb04b74f4ab36d3aa78e250530f` |
| adjacent log | `82d43374ad419ac2728039bb2976d58c16c73ab76370e01c6f4a9c3952b045d9` |
| typecheck log | `4576ccb2819cc20836f7a61bb82deb02ab9b14fa92983ef552b0098d4e9425a1` |
| lint log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

最终五文件实现评审、提交/受审 head、tested merge、PR 与精确 main CI 尚待正常门禁，完成后由 PR 最终交接绑定，不预填通过。外部模型预算仍为 0；synthetic 响应不证明旧 `235045d` 质量。full harness、actor lease、真实质量验收与部署阻塞继续保留，不关闭 TD-20 或其他整体项。

### R1 第一轮发现与实际修复

两位非作者在上述第一轮冻结版本确认一个 Blocking：`Object.fromEntries` 创建的内部字段表仍继承原型，缺省 syntheticLimits 可被 Object.prototype getter 注入。Reviewer A 独立复现 getter 2 次、captured admissions=2、真实 loopback HTTP=1 且 finish 成功；原始结果 `.private/r1/reviewer-a-i7n8gP/prototype-control-result.json` 的 SHA-256 为 `f3ba0681079ff43d5b8b005e08415bb1eb8ea5557649884cb6c429b7dd0fe27b`。该失败保留，第一轮不签通过。

实际修复将字段表改为 null-prototype，只复制已经核验的自有 data descriptor。补充 syntheticLimits/signal 的 getter/data 四个反例，分别证明缺省 cap=0、无继承 signal 绑定以及控制捕获不执行继承 getter。signal getter 的全局污染同时触发 Node FS/import 内部 options 读取，最终测试实际保留控制捕获 0 次、其他 native-runtime 20 次及全部栈；不隐去该观测，也不声称全进程 getter 零执行。自身 options accessor 与 Proxy 反例的零执行断言仍保持。

另一个已修 Warning 是时间反例稳健性：原 120ms 窗口可能在冷安装时先过期。最终反例使用 15000ms 安装窗口，安装完成后仅在隔离 child 偏移单调时钟，使其越过原 captured 窗口，并调用真实 `bridge.check()`；Date.now 固定、finally 恢复原 API，不等待 15 秒、不改生产阈值。它在原 `570ec795` bridge 私有副本上实际 exit 1（Missing expected exception），未切换当前源码或修改旧 worktree。

| 新修复证据 | 结果 / SHA-256 |
|---|---|
| `.private/r1/implementation-round2-scoped-red-HM8ADz/vitest-red.log` | 完全相同四个分列反例在前一 R1 私有源码副本上 4 fail / 62 skip；`667a80bb844edc7f8d81ac718faf6e3df3398bb11af97f4c3a8dc43c3b09766c` |
| `.private/r1/implementation-round2-final-E4nMLX/vitest-green.log` | 新 R1 39 pass / 27 skip，24.06 秒；`31a5bc21959fb9c2d02ce9010e2e2472fc1910139bb147e2b3a0f25a400048c6` |
| `.private/r1/implementation-round2-red-2gsZLZ/old570-window-red.log` | 原 570 bridge 的新窗口反例 red；`decc4d20057b2e65a6925f6faffb3e0747021a915b19b9c5f9535c3e21d1c393` |
| 最终 bridge 源码 | `4791ee2cf13f5f026a0794f93af4cdf65943cb141f65e115e5341d6997e9fb42` |
| 最终 bridge test 源码 | `24fdbd901b2082a98eafa32f194ff038dcca9b9c3a9108d5d1e288d5a99b311f` |

全局 prototype limits 污染 HTTP 1 → 0；signal 污染的控制捕获 getter 1 → 0、继承信号 listener 2 → 0。所有全局污染均 finally 恢复。初次第二轮 green 中 signal getter 的总计数非零导致的一项失败及 native-runtime 定位材料继续保留，不用日志名称或新通过覆盖失败。

保留一项非阻塞覆盖 Warning：原 spec 的单 chunk >4MiB、deadline 后晚 chunk、部分 dirty/hash/lock/依赖 resolve/overlap 身份错误及其他未知 body 形态尚无逐项专属反例；相邻回归不作为这些 AC 的完整证明。本轮不扩大工程范围，也不签 full harness 完成。

最终修复源码独立重跑完整 bridge 66/66 pass，58.07 秒，原 27 项均实际运行；材料为 `.private/r1/final-full-suite.log` 与 `final-6FR1YL/`。最终四路 typecheck 和三 TS scoped lint 均 exit 0，分别留存 `final-typecheck.log`、`final-scoped-lint.log`。相邻 32 项守卫/身份验证沿用本轮未改相邻代码的实际记录。第二轮双独立复核与 PR/精确 CI 尚待完成，以正常门禁实际结果为准。
