# 台账与证据增量同步收据

## 范围与身份

日期2026-10-07（Asia/Shanghai）；Git/GitHub只读核对时间 `2026-10-07T11:22:01Z`。
重新 `git fetch origin main` 得 `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71`；本地主worktree的8345f89未用作基线。
专属branch `docs/ledger-evidence-sync-20261007` / worktree `insight-agent-ledger-sync`，没有复制配置、数据库或业务内容。
只修改[主台账](d6-technical-debt-ledger-2026-10-06.md)、[治理计划当前入口](../plan/specs/technical-debt-remediation.md)及本收据，共3份Markdown。
沿用[D6 spec](../plan/specs/d6-documentation-evidence.md)的状态分层/历史保留要求；本轮授权只到文档PR/候选CI，不继承#422/#429等此前合并或生产授权。
roadmap/ADR/README未交接，本轮未改。#432/#433仅核必要基线/归属，不算重构关闭或产品验收。

## 核对方法与证明等级

逐项读取专属spec、收据、PR完整正文及最终交接；#422补最终main交付，近期八项逐项核Git祖先及GitHub元数据。
所有表列PR target base、head、合入SHA、tested SHA与Git tree；candidate merge的父提交集合须正好为其base/head。
9组head/tested/main的tree一致，9个merge均为启动origin/main祖先；**tree一致不等于源码commit SHA相同**。
18个CI逐项查询run/attempt/event/head/conclusion、对应attempt jobs及artifact API，未重跑历史workflow或下载历史原包。
分类依据实际所选job及仓库scope契约；scope artifact名称补tested身份，并与GitHub Git commit API/PR原交接交叉核对。
本轮未读取历史scope/app/Docker原JSON内部正文：内部字段/hash复核来源是原专属独立审查记录；API包digest仅是元数据核验，不能冒称本轮原包字节重算。
所有表列CI均attempt1、completed/success。候选事件均pull_request；main均push且head=tested=合入SHA。
full行的应用/Docker实际success、docs job skipped；docs行只有documentation checks实际success，应用/Docker skipped。
三个必需汇总均success；其名称如“docker build”在docs路径只代表汇总门通过，不能写成Docker实际构建通过。
main的PR policy正常skipped、full的docs检查正常skipped；P1扩展step是否执行以各专属交接/原run为准，不从总体success推导全部step通过。

## 独立评审来源与有效归档

独立代码review来源为原PR的pre-pr-ai-review及最终交接，不冒称本轮重做全部技术代码审查：

| PR | 原独立审查 / 最终交接来源 | 有效证据入口、hash与缺口 |
| --- | --- | --- |
| [#422](https://github.com/dong-qiu/deep-insight-agent/pull/422) | 最终正文“授权合并与精确主干验收”：B0/W0/S0；原[D6收据](d6-documentation-evidence-2026-10-06.md)/[续核](d6-followup-2026-10-07.md)保留 | [C归档索引](c-evidence-archive-index-2026-10-07.md)，封存hash见下表；原审计全文仍缺 |
| [#429](https://github.com/dong-qiu/deep-insight-agent/pull/429) | 最终正文“合入结果与精确main CI”：B0/W0；[C收据](c-evidence-readiness-receipt-2026-10-07.md)及[A快照](c-production-readonly-2026-10-07.md) | C三阶段有效仓库外入口；文档CI不提供应用/生产证明 |
| [#430](https://github.com/dong-qiu/deep-insight-agent/pull/430) | 最终正文“授权合入后的主干回执”；确定性review无问题，**AI Blocking1未消除** | [S2原收据](d7-s2-id-capacity-2026-10-07.md)和原交接包 `insight-agent-handoffs/d7-s2-closeout-2026-10-07/README.md`；旧head真实质量独立待办，未声明全部S2a CI原包永久保全 |
| [#431](https://github.com/dong-qiu/deep-insight-agent/pull/431#issuecomment-6032148084) | 最终main交接评论：独立集成/CI证据B0/W0；[真实诊断收据](td14-a1-authorized-diagnostic-2026-10-07.md) | 原测量SHA d18009f不改；收据所列 `insight-agent-td14/.private/td14/authorized-20261007/` 当前不存在，现保存位置未确认；hash仅为历史声明，不断言丢失/永久保存 |
| [#434](https://github.com/dong-qiu/deep-insight-agent/pull/434#issuecomment-6033503904) | 最终收口评论：独立代码/六份main包B0/W0；性能Warning1分列 | `insight-agent-handoffs/c4b-d7-closeout-2026-10-07/README.md`及SHA256SUMS当前存在；测试文件hash `640c783133ec9b9f3d5f1128bb8dfe2a235f2c6b0ea071f656681c44b53f75cc`与main字节相符；无必做尾项 |
| [#435](https://github.com/dong-qiu/deep-insight-agent/pull/435) | 最终正文“补充授权合入与main验证”；独立部署方案/完整diff/候选证据B0/W0/S0 | security-deploy两套封存index当前存在且hash相符；身份门不提供生产执行许可，回退null |
| [#436](https://github.com/dong-qiu/deep-insight-agent/pull/436) | 最终正文“授权合入与主干收口”：独立14项tests/58输入hash/原样本统计/CI核对B0/W0 | [D3收据](d3-report-list-measurement-2026-10-07.md)/[聚合摘要](../../evals/fixtures/d3-report-list-baseline.v1.json)有效；原 `insight-agent-d3-report-list/evals/out/d3-report-list/baseline-v1.json` 当前不存在，现保存位置未确认；历史raw SHA256 `fc0658fa235d50ee79c06b8233d112e4f9f8dfeefa7bf05b9cae6807696ab37f`不能代替原字节 |
| [#437](https://github.com/dong-qiu/deep-insight-agent/pull/437) / [#438](https://github.com/dong-qiu/deep-insight-agent/pull/438) | 两PR最终正文“授权合并核验/授权清理归档”及迁出README/最终handoff：独立B0/W0 | `insight-agent-handoffs/d7-s2b-closeout-2026-10-07/README.md`为当前入口；旧已清理worktree路径只作执行时身份；原实测dadc/dc494及无输出限制不改 |

以上 `insight-agent-handoffs/` 均位于 `/Users/dongqiu/Dev/code/` 下，不是仓库目录或异地备份。读取限README、交接、清单与必要hash；未输出原文、请求、checkpoint、环境、cookie、生产/个人数据。
TD-14/D3负责人须提供当前私有位置和对应索引/hash；已知路径/交接目录未见入口后停止扩大搜索，不重跑补造原产物。

### 限定本地hash复核

私有持久根为 `$HOME/.local/share/insight-agent/evidence/`。本轮仅复核下列清单字节hash/存在性，不展开SSM结果或原日志，也未重新核所有封存成员。

| 归档 / 文件 | SHA-256 | 本轮核对与边界 |
| --- | --- | --- |
| c-20261007T042516Z / sealed-files.json | `a791219e088523aa05e027edcca24af63836a7fa035b07c92b816f63b3019eeb` | 当前存在，hash同C索引；原10run/12attempt/31包由原review核验 |
| c-a-readonly-20261007T044259Z / sealed-files.json | `8dfb2a9f799d3e96bf1d98fc99b60706e8b8bebf846d863302a13e37f11041ae` | 当前存在，hash同A收据；40文件完整性沿原独立复核 |
| security-deploy-435-c90aeff-20261007 / sealed-files.json | `0d28d55d30931d6a0dab4778adc367c9d7e323c92950bf3f47ca42229319b074` | 当前存在，hash同#435候选交接 |
| security-deploy-435-merged-e6045ad-20261007 / sealed-files.json | `13f4c16e63ac753d9e35d3131f39403bfa38b0bced0b5c837b573af9465e9c73` | 当前存在，hash同#435 main交接 |
| D7 S2b迁出 / archive-manifest.json | `482608e8a29ccd58d075ba0d226853afc6c1672129532c6e3a4980b1b697b353` | 当前索引hash；160文件及源码bundle恢复是原独立审查结论，本轮未导入源码或重验全部成员 |
| D7 S2b迁出 / s2b/resumed-20261007/model-aggregate.json | `f76cb7bea58dd206ff4197dc3415cf13db915c2b89c44fbea25f759e1b959200` | 仅hash字节与原PR对照，未输出/消费模型正文；原dadc/dc494绑定不变 |

原封存无本轮新到期承诺；本地保全不等于异地副本。GitHub artifacts正常90天且可提前删除；下方逐项API期限只指原Actions对象，hash/摘要不代替原包。

## 历史失败、不可恢复与未核缺口

- 原#419/#423 main failure、#422首次图谱/审计失败及D3超时、#427早期包装失败全部在旧台账/C索引/原PR保留；后续success不能覆盖它们，也不能推出根因已修。
- [C索引历史404](c-evidence-archive-index-2026-10-07.md#缺口与历史失败保持)：37460791666/attempt1的11411253208、11411592700、11413097148、11411488210，37506167287/attempt1的11432630140、11432235893、11431911328，共7个（5关键/2附属）原包于原归档核对时404，本轮不可恢复原字节。API404不证明删除机制；后续attempt原包不能替代。原attempt jobs/logs可用；从未上传的后序app/reader结果不能称“丢失”。本轮未重新下载或探查这些对象。
- #438首次37599354338因旧body policy失败且被新run取消，保留原PR说明；后续成功不改其结果。原S2收据“未验收”、申请“未授权”、C准备“A待执行”是旧阶段，最新层分别引用原最终交接，不回写正文。
- TD-14原manifest历史hash `80e806267aeaeedc2ecd4562d54413575b7f1c94772811a92344dba9c7e51094`及D3 raw hash保留为声明；当前路径缺失不能写成新hash复核通过或确定永久丢失。
- 原AI reviewer完整会话不是独立原产物；PR中的B0/W0结论只是可追溯摘要。原审计全文仍缺，取得原件才补核。当前生产对象/修复效果、安全回退批准、完整历史恢复、性能分布与费用未知；不为填空重新实验。

## 本地验证

最终diff仅3份普通Markdown。本地 `checkDocuments` 实际检查3份文档及指向它们的入链：链接/anchor/格式/标题/收据结构通过；`git diff --check`通过。
与启动base逐字节对照：旧台账自“来源与归属核对”起全部原样保留；治理计划仅插入1行当前入口，删除该新增行后整文件等于原Git对象，原20项验收正文未改。
本地文档工具Node v25.9.0，仅执行不需依赖的文档检查，不冒称Node24应用验证。`evaluatePolicy`以完整3文件范围执行，ok=true/riskFiles为空且无eval例外；冻结提交后正常eval触发器结果写PR摘要。
无受影响应用模块或TS输入，本地不安装依赖、不运行无关应用typecheck/build；沿D6文档路径检查，最终CI按真实docs分类验证。不运行A1或模型/性能实验。
按最终diff，eval-gate语义触发面不适用；没有AI实现或评测口径变更，不签pass/skip/scoped，不设置ACK、不绕hooks。仓库确定性CI的eval-gate检查成功也不表示新模型质量通过。

## 独立审查与PR停止点

主Agent完整读取并使用[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。由独立新上下文reviewer审完整base到工作区diff（含本收据）、身份表、层级/历史保留、统计、归属与禁止生产/关闭边界；重要发现先修再定向复核。
独立新上下文 `ledger_independent_review` 预审通过：低风险，Blocking0/Warning0/Suggestion0。初审发现未跟踪新收据EOF多余空行，已修正并用 `git diff --no-index --check /dev/null <新收据>` 独立定向复核通过，不把普通tracked diff检查冒称覆盖未跟踪文件。
reviewer独立执行3份checkDocuments/入链、tracked及新收据diff检查、3文件policy检查；逐项核9组PR/Git身份、18个run与scope API digest/期限、tested父提交/tree及专属收据边界。旧台账历史正文40969字节SHA256 `9eb9cc21be1e812e9da5ff6e7ea61150e622e90e246331b346c9cab0d34a935b`保持一致；治理计划去掉新增入口行后整文件等于原Git对象。
此为文档与元数据独立审查，不代证技术原产物/性能/生产通过；reviewer未访问生产或运行模型/性能实验。候选CI此时尚未取得；PR创建后最终head/base/tested、run/attempt/分类及远端独立复核写同一PR摘要，避免仅为CI URL移动head。
本轮只到“台账与证据增量同步”PR/CI收口；不自动合并。合入授权后须另核精确main CI，不能沿用本次候选CI。

## 下一步、负责人及重启条件

当前12项按既有范围关闭、7项部分、TD-19本阶段完成整体未关闭，编号及条件详见[最新状态](d6-technical-debt-ledger-2026-10-06.md#最新状态2026-10-07-增量同步)。本轮不扩大关闭或全部技术债验收。
A2/A3只读观察时间同本收据，均HEAD=a5253da且有未提交专属材料，GitHub无对应open PR；工作中，不作主干证据。
A2负责安全回退与数据兼容，A3负责维护互斥/writer/drain/lease/SSM未知终态（不是早期数值配置A3）；接口/状态问题在台账逐项列明。
D7负责人承接S2a旧head真实质量；TD-14负责人承接1项人工裁决与原产物位置，D3负责人承接原样本位置，D6负责人取得原审计后补核。
实名operator/值守/reviewer/批准人由协调者指定，不代填；TD-09已知备份搜索停止，P1休眠保持。
PR合入、生产访问/部署dispatch/业务库/迁移恢复/付费模型/实验重跑/分支worktree与原产物清理均需要另行授权。
如需补下载，先指定精确run/attempt/artifact和私有独占保存位置；不得无差别下载全部历史原产物。

## 回退

普通文档revert PR；不涉及源码、数据库、环境、生产或原产物清理。旧台账/收据/验收正文不删不重写。

## PR与Git身份索引

以下均为GitHub实际冻结PR target及合入对象，base branch均main；不把启动实现base与最后target base混用。PR URL链接到原完整交接。

| PR / head branch | target base SHA | head SHA | merge SHA / tree / merged UTC |
| --- | --- | --- | --- |
| [#422](https://github.com/dong-qiu/deep-insight-agent/pull/422) / `docs/d6-td19-evidence` | `4477412a3e2b1cb2764fb4357f2284e73952af67` | `eca211f0e24af6d84f5ddb3bdedfa7c03d4fe93c` | `473e2eeae119b600b63abd78ce886301bd882235` / `e661b28d505933b896f814dea1cd1b0b99074da0` / 2026-10-07T02:26:54Z |
| [#429](https://github.com/dong-qiu/deep-insight-agent/pull/429) / `docs/evidence-release-readiness-20261007` | `afbe4a55f89957839a7ee619733f21c2736eb1af` | `265e480506bda15855c7f41075f9ce5215910f74` | `41270a7aa02d3880d96fcd6ba7f9a2cbb54a3b99` / `9424de550e44f573da053e3f00c6f748dd8db3d5` / 2026-10-07T05:53:22Z |
| [#430](https://github.com/dong-qiu/deep-insight-agent/pull/430) / `feat/d7-s2a-id-capacity` | `473e2eeae119b600b63abd78ce886301bd882235` | `235045d6424640d79c79874a403749c6bd17b823` | `eb2bd4d6a096331d888f938391749a42aa16625b` / `932ca0eee33ac2f27bc1b883991a9ec5fd685cbd` / 2026-10-07T04:57:50Z |
| [#431](https://github.com/dong-qiu/deep-insight-agent/pull/431) / `perf/td14-a1-attempt-diagnostics` | `41270a7aa02d3880d96fcd6ba7f9a2cbb54a3b99` | `b0cf89c5aa30a77541baa54f40c174b8b3c8790a` | `75c189d883a701943ad0308a07ba4f4542d878be` / `1f826afcf31f250c9a9d439b27d84f054a08e608` / 2026-10-07T06:04:10Z |
| [#434](https://github.com/dong-qiu/deep-insight-agent/pull/434) / `test/c4b-d7-dual-format-20261007` | `8345f89a6d2ee0379690fa6c3c5f2a8b00354194` | `8d8de54314aef05875342023bc7f7999c16f9291` | `41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1` / `1ede8bfee2cde7f0f01532be5f1d9309edd04e0e` / 2026-10-07T07:42:45Z |
| [#435](https://github.com/dong-qiu/deep-insight-agent/pull/435) / `feat/security-deploy-preconditions-20261007` | `41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1` | `c90aeffa061841878b7b827ded22e5aee409f36a` | `e6045adf3233fdded3b7567a0debd6962970c165` / `a734c20d66ef8d7eafed43786e12d69406fe2647` / 2026-10-07T08:33:22Z |
| [#436](https://github.com/dong-qiu/deep-insight-agent/pull/436) / `feat/d3-report-list-measurement-20261007` | `e6045adf3233fdded3b7567a0debd6962970c165` | `073f0a7d7179dd430c764185bd06b2099635debe` | `0d0701caa1a13c22716c6a03c0b675c135b8998a` / `60aca737e83c9dd297d0e82ee11977a2f5c62ed4` / 2026-10-07T09:11:51Z |
| [#437](https://github.com/dong-qiu/deep-insight-agent/pull/437) / `feat/d7-s2b-evaluation-guard-20261007` | `0d0701caa1a13c22716c6a03c0b675c135b8998a` | `08f5bc1a69ab1e694d9ccfe3c2fc4e0196afa227` | `55c1a41ba4f57f4c9a17f2b54558eba6ba10a852` / `ca0bc7e8ea21808c07bbb6ceaf84c0bea233b8b0` / 2026-10-07T09:42:52Z |
| [#438](https://github.com/dong-qiu/deep-insight-agent/pull/438) / `feat/d7-s2b-id-capacity-20261007` | `55c1a41ba4f57f4c9a17f2b54558eba6ba10a852` | `eadccc5c95f375a00a7963ff2b5a5ea32e60da98` | `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` / `970913d1578c9047b6c7cfc5870097276542f112` / 2026-10-07T09:51:40Z |

## 精确CI与Actions证据索引

18行均attempt1/success；candidate与main分列，CI日期均2026-10-07 UTC。开始/更新为run元数据时间，不当作测试耗时。main tested完整SHA沿上表merge列；候选tested逐行列全。

| PR / 类型 / CI run | event / 分类 / 结果 | tested SHA | run started / updated UTC |
| --- | --- | --- | --- |
| #422 / candidate / [37561418156](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/attempts/1) | pull_request / full / success | `82a01056a6aafc22f5e5247cf6fd9000c618959b` | 2026-10-07T02:19:19Z / 2026-10-07T02:24:11Z |
| #422 / main / [37562025600](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/attempts/1) | push / full / success | `473e2eeae119b600b63abd78ce886301bd882235` | 2026-10-07T02:26:57Z / 2026-10-07T02:31:40Z |
| #429 / candidate / [37578324280](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578324280/attempts/1) | pull_request / docs / success | `438defd0639d28706e36110de56b574d6b5b3d91` | 2026-10-07T05:50:31Z / 2026-10-07T05:51:00Z |
| #429 / main / [37578566493](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578566493/attempts/1) | push / docs / success | `41270a7aa02d3880d96fcd6ba7f9a2cbb54a3b99` | 2026-10-07T05:53:25Z / 2026-10-07T05:53:52Z |
| #430 / candidate / [37572630559](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37572630559/attempts/1) | pull_request / full / success | `57e6e7aaeeb5566f4029604e2cb9321c8c45125d` | 2026-10-07T04:40:59Z / 2026-10-07T04:46:36Z |
| #430 / main / [37573978663](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37573978663/attempts/1) | push / full / success | `eb2bd4d6a096331d888f938391749a42aa16625b` | 2026-10-07T04:57:53Z / 2026-10-07T05:02:33Z |
| #431 / candidate / [37578923943](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578923943/attempts/1) | pull_request / full / success | `762b58370c6e7844627f835a3395b2f0f4968125` | 2026-10-07T05:57:34Z / 2026-10-07T06:02:59Z |
| #431 / main / [37579519625](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37579519625/attempts/1) | push / full / success | `75c189d883a701943ad0308a07ba4f4542d878be` | 2026-10-07T06:04:13Z / 2026-10-07T06:11:02Z |
| #434 / candidate / [37588249770](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37588249770/attempts/1) | pull_request / full / success | `744f911feb7a8319952a29257b797d2b664ce740` | 2026-10-07T07:35:19Z / 2026-10-07T07:40:26Z |
| #434 / main / [37589024973](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37589024973/attempts/1) | push / full / success | `41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1` | 2026-10-07T07:42:48Z / 2026-10-07T07:48:49Z |
| #435 / candidate / [37591721410](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37591721410/attempts/1) | pull_request / full / success | `653c56bc568a315f03e83ba0caa21f7786dcced3` | 2026-10-07T08:07:47Z / 2026-10-07T08:12:14Z |
| #435 / main / [37594547149](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37594547149/attempts/1) | push / full / success | `e6045adf3233fdded3b7567a0debd6962970c165` | 2026-10-07T08:33:25Z / 2026-10-07T08:39:48Z |
| #436 / candidate / [37595679890](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37595679890/attempts/1) | pull_request / full / success | `5e4894200a9af5632703b90a62f71cb2d425b148` | 2026-10-07T08:43:30Z / 2026-10-07T08:49:24Z |
| #436 / main / [37598938050](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37598938050/attempts/1) | push / full / success | `0d0701caa1a13c22716c6a03c0b675c135b8998a` | 2026-10-07T09:11:54Z / 2026-10-07T09:18:08Z |
| #437 / candidate / [37601683206](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37601683206/attempts/1) | pull_request / full / success | `169e7350b9d1c3a726330768a31a5cba49c64eef` | 2026-10-07T09:35:38Z / 2026-10-07T09:41:42Z |
| #437 / main / [37602507907](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37602507907/attempts/1) | push / full / success | `55c1a41ba4f57f4c9a17f2b54558eba6ba10a852` | 2026-10-07T09:42:55Z / 2026-10-07T09:47:42Z |
| #438 / candidate / [37602808982](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37602808982/attempts/1) | pull_request / full / success | `45f1000fc68ff298e0b183d7164b20b975c771ed` | 2026-10-07T09:45:34Z / 2026-10-07T09:50:41Z |
| #438 / main / [37603495951](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37603495951/attempts/1) | push / full / success | `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` | 2026-10-07T09:51:42Z / 2026-10-07T09:56:18Z |

### scope包hash与到期时间

下表仅当前artifact API的包digest、到期字段；本轮未下载/重算历史ZIP，不声明原JSON hash新认证。分类与tested还交叉核对原PR摘要/Git对象及所选job；未来严格receipt消费者仍需原schema JSON。其他app/Docker/reader包身份/hash入口沿各原PR与私有索引，未归档所有附件。

| PR / 类型 / scope artifact ID | API digest（ZIP对象） | API expires_at UTC / expired |
| --- | --- | --- |
| #422 / candidate / [11456289780](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/artifacts/11456289780) | `sha256:2bbaa4fd3ec15637e504e406e825c499eecb6a8228ade00219c5547438991d9a` | 2027-01-05T02:19:19Z / false |
| #422 / main / [11457167568](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/artifacts/11457167568) | `sha256:e3733afaf5850b67367c297898f420aa33e4950240e69fa458ed032d8ac396fb` | 2027-01-05T02:26:57Z / false |
| #429 / candidate / [11463995247](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578324280/artifacts/11463995247) | `sha256:2f6781b6dbf50bc21cb0b3262fef26a2613a335b283e59ed041b6ff7d2f01031` | 2027-01-05T05:50:31Z / false |
| #429 / main / [11463731807](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578566493/artifacts/11463731807) | `sha256:a6a3fa5269acba425da577bc23818b8f9da0dde804b8b77acd7d00bb3a3cbaff` | 2027-01-05T05:53:25Z / false |
| #430 / candidate / [11460897625](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37572630559/artifacts/11460897625) | `sha256:4d69f7bf15a8d6135642e60b94e9e341c055f5da31104acc4bc841f7a4c1be21` | 2027-01-05T04:41:00Z / false |
| #430 / main / [11461579568](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37573978663/artifacts/11461579568) | `sha256:00a68261ae944aaa253a73ad58af05cfe6fa1d83c1e71ce564ab8a8566dbde94` | 2027-01-05T04:57:53Z / false |
| #431 / candidate / [11464050583](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37578923943/artifacts/11464050583) | `sha256:4699bdb1acf18bb7a3b9ec19b47cf57346a3dbf566f6d3358db9e2f5d1a69755` | 2027-01-05T05:57:34Z / false |
| #431 / main / [11463623920](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37579519625/artifacts/11463623920) | `sha256:76bcdbecadfcd3bfec093fbecf81471d7bad40180a0bea11eda07fd87e3d5793` | 2027-01-05T06:04:13Z / false |
| #434 / candidate / [11467686156](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37588249770/artifacts/11467686156) | `sha256:cf2ce1a956c2b20db802b4d117c1061317dbc51ca7215fbbe27224f2cfdd8d51` | 2027-01-05T07:35:19Z / false |
| #434 / main / [11467861736](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37589024973/artifacts/11467861736) | `sha256:9a45fb24ac76c116d16fe49afd7865ab3ae6491fa60001d457a9cde272b90af1` | 2027-01-05T07:42:48Z / false |
| #435 / candidate / [11468288187](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37591721410/artifacts/11468288187) | `sha256:286fe59aa51a5d7f7dccc794f42f75c94ea11d6b18c7e6a0858a2ce948b3778e` | 2027-01-05T08:07:48Z / false |
| #435 / main / [11469871617](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37594547149/artifacts/11469871617) | `sha256:c978b9668bed7f3abbd7046878f5c92237b4f1f8b0605c72d6d60e2c1f11e2fd` | 2027-01-05T08:33:26Z / false |
| #436 / candidate / [11469804331](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37595679890/artifacts/11469804331) | `sha256:28ce818d1af7726aeee43c106706922002f5edbd9690130f138b6d2615ae90a8` | 2027-01-05T08:43:30Z / false |
| #436 / main / [11471523618](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37598938050/artifacts/11471523618) | `sha256:13b2f32be35bceb8d4a873dc1d7e99450823e07307a3059b6ef2184538b787d0` | 2027-01-05T09:11:54Z / false |
| #437 / candidate / [11472433959](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37601683206/artifacts/11472433959) | `sha256:4cdde2b97aec1c63886af26698e695566be5dcc140c33d53ba0948f311e4e528` | 2027-01-05T09:35:38Z / false |
| #437 / main / [11473870106](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37602507907/artifacts/11473870106) | `sha256:6d368fe264473f5487943fd326ce32b8de2c2e927a28f3b3e3d57ee286cb5220` | 2027-01-05T09:42:56Z / false |
| #438 / candidate / [11473303683](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37602808982/artifacts/11473303683) | `sha256:3873b3453b4fdd1ec7f63a808af799faee1b272a6d65f3abb9298c2fecf9e6af` | 2027-01-05T09:45:35Z / false |
| #438 / main / [11473233933](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37603495951/artifacts/11473233933) | `sha256:c90e2db3c472a41bb79891e60e97051927c58757a82d0f90ddb0221844d30da6` | 2027-01-05T09:51:43Z / false |
