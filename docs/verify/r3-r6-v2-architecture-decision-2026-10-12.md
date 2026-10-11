# R3–R6 v2 writer：原架构 owner 最小决定收据

## 状态、唯一归属与接受范围

本片原 owner 为 Dev-Agent-重构/root，按主控六小时自主协作中的精确窄片授权，只追加
decisions.md 的 ADR-0045、architecture.md 的隔离 writer v2 段及本收据。
状态为设计接受、待独立增量核对与文档检查；尚未 main 合入，无源码/DDL/runtime 交付。
源实现写窗仍等主控逐文件冻结；本片不释放 W1/A/P/D3/app-path/旧 target 或 S2a/S2b 文件。

## 固定来源与身份

[PR #477](https://github.com/dong-qiu/deep-insight-agent/pull/477) 合入 `fb7e3c845bef5d7a310ea5017f71bf905beedf49`，
父提交 `b9cd8a208436b6a50dede73dd1b78f8416ef44aa`。精确 main push docs CI `38172573309 / attempt1`
为来源文档交付证据，不提供应用构建/镜像/运行证明。

- [精确 S2a spec](https://github.com/dong-qiu/deep-insight-agent/blob/fb7e3c845bef5d7a310ea5017f71bf905beedf49/docs/plan/specs/r3-r6-s2a-v2-format-2026-10-12.md)：SHA256 `0a6a989a222ad7bc9b283d4cc0ecb1bae284e73f4b3d5efff59a12158bc5078e`，Git blob `83ca080cba04508bce4656bf41ae40d6dbe88014`。
- [最小 ADR delta](https://github.com/dong-qiu/deep-insight-agent/blob/fb7e3c845bef5d7a310ea5017f71bf905beedf49/docs/plan/specs/r3-r6-d2-adr-delta-2026-10-12.md)：SHA256 `7f1b40094f893f4955077f1bb85514f228ac82c98beb06124ac9983b8fc993ab`，Git blob `e78faabbf59d13853163277a4427c5e2281161a9`。

原 worktree 无本来源的本地文件，采用合入 commit 永久链接，不新增不存在的相对链接、不复制别线专属文件。
D1 strict-close/迟到成本与 D2 已冻结方向不重审；本片仅正式接受新 marker/ID/version、exact schema/API、
固定六入口能力、同步锁序与 COMMIT/ACK/FS 三态、同 registry control 及阶段边界。

## 旧字节保全与新增边界

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-v2-owner-decision-20261012.lfEtY1/`：
原八文档/源码集合完整字节、mode/身份/hash、原 dirty diff/base、两份来源原件先非覆盖保全。
初始化已核本 worktree feature HEAD `ff7820af9d6517a7543355fd58524fccac6bbc19`，
本地 `origin/main` 为 `fb7e3c845bef5d7a310ea5017f71bf905beedf49`；不是远端最新证明，未 fetch/checkout。
原 decisions 为220303字节，SHA256 `671c6178625c3a591f62823482d065b896e9ec8852d0f06660cb4359b9d5b352`；
原 architecture 为56185字节，SHA256 `edfa4398faa90eaede601da18fc1690ef149e567d6a0a1617b9742011f9cd45d`。
这两份旧未提交内容保持精确字节前缀；新增专属 diff/原件/source freeze 独立绑定，旧 dirty 内容不是本片受审或已交付范围。

ADR-0045 是设计决定，不是 implementation done：initial newroot独占、v1保持无升级/fallback；
APP_ID0x41335732/version2、marker a3-writers-isolation-v2；六 entry、原 worker/operation capability+必需原 AbortSignal；
registry→S0同步身份事务结束→business，无stage/跨await；exact facts/audit双向覆盖；pre-open保护与真正同registry永久close。
旧S0CLI仍非writer版本gate；S2a/S2b/W1/A/P/D3及app-path窗口不以本决定自动释放。

## 验收与后续交接

作者冻结三doc新增delta后两fresh独立非作者最多两轮，只审新决定/架构段/本收据及来源链接、旧字节保全。
一次实际 docs check 和其 stdout/stderr/exit/close、源码原件/新增精确 diff/审查/最终收据索引加性封存。
最终实际评审、候选 hash、检查结果在私有 coord/stage-receipt-v1.md 与 final-index-v1.json；
本版本的此段是提交前流程记录，不能提前宣称通过。主控取得实际完成收据后按精确决定版本提供实施写窗。

没有 stage/commit/push/PR/merge、应用/native/模型/资格测试、环境启动/VM/logs/P1/生产操作或清理。
旧八集合中另外六项、其他 owner、旧sealed根不改。writer_quiescence/drain_ready/production_permitted=false，
safe_rollback=null、deployment blocked、hold/#435、model/recovery/P1/prepare/matrix消费0保持。
本设计落账不关闭完整技术债、不确认生产修复上线；后续 Git 交付与源码实施需主控分别冻结具体 diff 和归属。

## 独立文档 PR 交付上下文（2026-10-12）

上文是原 worktree 设计接受阶段的历史收据，保留其未合入、未 Git 交付及冻结前 pending 的时间语境；
不把历史源 HEAD、旧评审或旧检查重绑为新 PR 验收。后续实际 Git/CI 状态记录在本 PR 摘要与私有交付收据，
不能由本文预先宣布 main 合入或源码实施。旧设计封存索引 SHA256
`f843481da4c76dc45bda5b31c060bcebbea8af6e23833b87255c0937bf20126c`。

本次新 checkout `/Users/dongqiu/Dev/code/insight-agent-r3-v2-doc-delivery-20261012`，
分支 `codex/r3-v2-adr-doc-delivery-20261012`，fresh 远端 main 及新基线均为
`fb7e3c845bef5d7a310ea5017f71bf905beedf49`；ls-remote/fetch/worktree-add实际原件保留。
基线尚无 ADR-0045 或本收据；ADR-0044 为原工作区其他历史未交付内容，本 PR 不带入。
仅从已封存 candidate-v2/0.delta、1.delta、2.original 取得本次新增段，不复制整份 dirty 文件。
新基线 decisions/architecture 完整旧字节前缀保持；原 r2-native HEAD/index及九个现有候选文件保持不变。

仅为正式发布语境将新 ADR/architecture 的“尚未 main 交付”改成文档接受与源码未实现的明确分离，
不改变六入口、exact registry、cap/signal、锁序、COMMIT/ACK/FS、S0/S2a/S2b边界。
M1/M2尚未冻结，本 PR 不接受新的 S2b 决定，也不释放源码写窗。

验收只针对真实 main 上三文件增量的编号/链接、来源身份、文档语境和原 dirty 保全。
两 fresh 非作者最多两轮；冻结后一次限定文档检查，再正常显式三文件 commit/push、Draft PR及必需 docs CI，
新候选 head/base/tested merge与实际结果在 PR 摘要绑定，不用来源 PR477 docs CI 或旧接受阶段检查代签。
不运行 app/typecheck/build/native/eval/模型/资格矩阵，无 .env/数据复制、setup或依赖安装。

回退仅另立正常文档 revert PR，不逆迁移、不改数据或旧 v1、不授权运行/恢复/部署。
本轮不执行合并，新 PR 精确 head 由主控指定唯一 merge owner；新 worktree与证据暂保留。
私有交付根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-v2-doc-delivery-20261012.CCk6cO/`。
safe_rollback=null、deployment blocked、hold/#435、controllerComplete/qualificationReady=false，
真实环境/模型/恢复/P1/prepare/matrix消费0继续有效；设计文档交付不关闭整体技术债。
