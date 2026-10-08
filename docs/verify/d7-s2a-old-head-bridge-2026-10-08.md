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
