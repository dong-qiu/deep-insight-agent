# S1→R3：逐文件移交核对收据

日期：2026-10-12（Asia/Shanghai）。此收据记录当前核对，**不是原owner已经释放的收据**。
用户已委派本聊天承担共享接口S及随后usage U；D1已选定。接收人/关闭语义无需重新决定。
沿用 `/Users/dongqiu/.codex/worktrees/bcba/insight-agent`、`codex/r3-r6-interface-prep-20261011`。

## 当前执行状态（覆盖下方历史暂停结论）

主控原人类决定“批准八个文件的限定接管”已核原件和当前八源身份；这是明确用户接管，
不伪造旧owner释放。S1已实现并冻结v2，随后U已实施可选固定消费者，正在新候选独立审查。
下方“未实现/待释放/暂停”各段保留为**授权到达前的历史核对**，不是当前阻断状态。

| 阶段 | 当前事实 | 证据与边界 |
| --- | --- | --- |
| S1 | shared usage方法/类型、固定同步driver、两套专属测试已实现 | `s1-candidate-v2.json`，22/22定向测试，TS7/TS6通过 |
| S1双独审 | round1 B1/W1；修复后两位round2均B0/W0 | `s1-review-contract/review-round2.md`、`s1-review-native/review-round2.md`；最多两轮，仅签S1 v2 |
| S1历史失败 | 原提交注入没命中实际registry COMMIT、类型失败、replay observer和root inode反例保留 | 原日志/原探针不改为通过；真正registry connection loss、目录替换和新cap replay有新反例 |
| U | `runtime/model-usage.ts`增加可选`usageWriter`，配置时严格核原db/run/trace/signal，不回退repo | 固定begin仅fresh committed允许发transport；unknown固定诊断和sticky；原C3 repo复用，无schema迁移 |
| U真实路径 | 新专属maintenance integration通过现runJob的显式测试组合调用真实callStructured/SDK/Responses parser | 外部仅合成fetch；没有修改jobs、provider/parser或业务调用方，不声称W2生产注入已完成 |
| U审查 | 两位新非作者首轮均B0/W0；contract S1仅历史状态文案建议，已修正 | `u-candidate-v1.json`；`u-review-contract/review-round1.md`、`u-review-native/review-round1.md`；不签生产W2/R6 |
| 交付 | 本地最终候选验证通过；正常提交/Draft PR/远端diff复核/候选CI随后据实绑定 | PR和Actions身份优先记PR摘要/私有索引，不为补CI链接重复改候选；无合入/上线授权 |

U通过原同步factory/repo保存实际观测；取消后允许条件只忽略signal和本地finish，不忽略
维护close、lease、DB closed或物理身份。真实SDK的pending raw read在Job取消/finish后才释放，
open保留reported费用，close/lease/DB closed拒绝且不改已收尾Run；已有partial在close后保持。
begin与observe拒绝均进入原sticky；COMMIT尝试未知、实际提交后ACK丢失保留原事实而不补偿。
first cause/budget和TD14 observer是原依赖，未改变算法、模型、parser、价格或重放口径。

此次源码实际写窗：三shared文件＋`runtime/model-usage.ts`，新四专属driver/测试；
其余获授权C3 repo和三旧测试无需修改，直接复用和真实回归。八文件授权不要求制造无用diff。
R4/R5/D2/D3和共享调用方W1/W2/W3仍未实施，原文件归属/正式ADR/架构/主台账继续原owner。
S/U写窗仍由本聊天持有，clean、commit或PR不表示再次释放；后续W2须有明确逐文件接线owner。

全部私有证据位于 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-usage-s1-20261012/`，
原旧准备三文档hash不变；没有模型/资格矩阵/生产/SSM-drain/R2操作、部署、hold释放或清理。

### 最终本地验收与审查证据

| 实际命令/验证 | 结果 | 私有原件 |
| --- | --- | --- |
| S1 fixed driver/admission定向Vitest | 22/22；新增root替换、新cap replay拒绝；两进程、实际COMMIT/ACK、SIGKILL及hot journal | `s1-tests-v4.log`；独审两个round2 |
| U/C3/C2b/TD14/S1相关11文件Vitest | 162/162；U专属19测试走真实SDK/parser | `u-regression-v2.log` |
| `npm test`（最终实现同字节） | 298 Vitest文件/3440通过；ops 756中752通过、4明确Linux Docker场景skip、0失败 | `final-full-tests-v1.log`；skip不作为Linux镜像资格证据 |
| `npm run typecheck` | TS7/TS6 app与tools均通过 | `u-typecheck-v2.log` |
| `npm run lint` | 全仓0 warning，通过 | `u-lint-v1.log` |
| `npm run build` | 本工作区隔离合成env/DB路径构建通过；既有middleware convention deprecation保留 | `final-build-v2.log`；不代表部署或HTTP注入 |
| 文档链接/候选身份 | 无断链；源码仍为已审U v1和S1 v2，最终两文档仅状态/证据摘要delta | `u-doc-check-v1.json`及最终候选索引 |
| U contract独立验证 | 6文件90tests及TS7/TS6；原生身份/firstcause/budget/finish后observer探针通过 | `u-review-contract/review-round1.md`；首次探针CJS transform失败原件保留，MTS真实运行通过 |
| U native独立验证 | 11文件158tests及TS7/TS6；真实第二SQLite连接busy导致observer sticky，无下一transport | `u-review-native/review-round1.md` |

U manifest SHA256 `acaed797d290282a47722801ca63f2f1d1f8c1c6767a35caaabe48cbad822484`。
S1最多两轮已经用完；U首轮通过。此次仅纠正spec历史状态和补验收摘要，按文档delta/身份核对，
不重开算法或用新阶段为旧R2补签。新代码未命中AI语义/eval触发：未改模型、prompt、来源、
validator、评分或parser；使用实际确定性runtime/native路径验证，没有A1或模型准入声明。
最新origin/main实fetch与GitHubcompare均仍为 `ff7820af9d6517a7543355fd58524fccac6bbc19`。

### 限定交付、恢复与下一行动

1. 当前只交S1/U可选固定consumer；四旧C3文件没有必要改动。旧default/terminal/staged及
   unconfigured C3仍走原协议；所有shared实际改动由本聊天串行编写，测试和审查不取得写窗。
2. 已提交的usage事实、unknown/partial和价格快照保持，失败不会退款；无schema/迁移。将来
   回退须正常feature/review/PR，不能删除usage、改写COMMIT为rollback、恢复旧cap或重开DB补偿。
3. 后续W2最小动作：主控给唯一调用方owner明确jobs/dispatch精确写窗，准入置于隐式写入之前，
   绑定实际child Run和原signal，走AC-U2真实Job注入验收；本轮test组合不是该接线授权。
4. D1正式ADR/architecture/主台账落账仍需原owner；R4/R5/R6继续按原准备spec的独立片和归属
   前置推进，不启动reports/report-gen延期拆分。无新合入授权时交付停在可评审PR/CI。

## 以下为授权到达前的历史核对（保留原身份）

## 范围与执行结果

10-12追加：用户在主控明确“批准八个文件的限定接管”，原保留/blocked是此前历史事实。
授权原件 `r3-usage-handoff-master-20261012.1bq32btp/takeover-authorization-v1.json` SHA256
`5830dadbbcbb095d8562162df7140ff372c66fc82e3e80de5789fe7d8ee0fd62`，绑定proposal SHA256
`d700da6d6aac72447c13a19575326f132d6051650c58fbd7ae4151fb769ead45`。
本聊天已再次核八文件hash/blob和当前无未提交delta；以下表格“待释放”保留为原时点，现八行
均为“用户明确恢复接管→本聊天S/U，限定shared usage及U opt-in写窗”，其他原边界保留。
新专属四文件同授权；开始S1→U串行，不再以旧保留记录阻断。最终实现/验证状态另追加。

重新读AGENTS/L2/L3、两准备spec及阶段收据；保全并逐字节核对原三文档与旧final-index。
新远端GitHub比较main与 `ff7820af9d6517a7543355fd58524fccac6bbc19` 为identical，ahead/behind=0；
本地HEAD/源blob同基线，源码无diff。元数据定向核worktree登记，不进入清理或r2-native目录。
只读核主控委派原人类消息、原A3/C3/C2b/TD14及协调者交接；未向任何其他聊天发消息。

已新增[精确D1合同](../plan/specs/r3-usage-strict-close-2026-10-12.md)：exact值接口、同DB/锁序、
同步COMMIT三态、close fencing及取消后既有observer生命周期。不是新接口已实施或测试通过。
查明8个源码/测试窗口仍缺逐文件释放；当前仅独立新文档/证据可写。不得以用户指定接收人
覆盖明确保留边界，不用相邻新driver绕过shared写窗；S1→U代码链暂停在移交前置。

## 精确源身份与拟移交窗口

全表基线为ff7820a；Git blob、bytes、最后变更提交及完整私有源快照见source-ownership-v1.json。
下表历史作者不等于已确认当前释放人；最近Git提交只说明来源，不授予写权。

| 精确路径 | 历史owner/变更链 | 当前SHA256 | 接收与释放状态 |
| --- | --- | --- | --- |
| `ops/maintenance/writers.mjs` | A3 Agent A / staged；精确原执行身份待主控核定 | `2e369995a070c36266a386336e9243b4cfa6159da2830eb3eee62f771c5c8615` | 待释放→本聊天S/U；无已释放写窗 |
| `ops/maintenance/writers.d.mts` | A3 Agent A / staged；精确原执行身份待主控核定 | `628cc5a5b0ea779ab2628e1ac46f3625deb1436f9b4d6c890736fb28d640529d` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/runtime/writer-admission.ts` | A3 Agent A / staged；精确原执行身份待主控核定 | `206c61e0d37a6c2514b80471a141908dcacbae9838817f95e578ad80f2707fdd` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/db/model-usage.ts` | C3 / #410 原作者 | `ecdb2c02820b39ff2c12b8229e50edec2766de4fcc78601ed8391c52a4f655a9` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/db/model-usage.test.ts` | C3 / #410 原作者 | `4b711dde9914c32245dff1e2f4e4b534cfe552e66900e3fd92dc242519d92176` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/runtime/model-usage.ts` | C3→C2b→TD14 #431；分别需核保留边界 | `8fad2a5e3dd8bfbe021a585cb2e1cb13fcb9c771cc32d1e97dc32b167cab8679` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/runtime/model-usage.test.ts` | C3 / #410 原作者 | `7a585abf48244cda05a84ca96920780062215b5ba2217844535155e641bbbebe` | 待释放→本聊天S/U；无已释放写窗 |
| `src/lib/runtime/model-usage.integration.test.ts` | C3 / #410 原作者 | `db8e6b15a436d218a201ab2909210c0e9c157ffb4dca7e160ce5137193fb7ae0` | 待释放→本聊天S/U；无已释放写窗 |

S释放窗须明确三shared文件的新增usage方法/类型及专属固定driver/tests；旧default/S1/strict/staged
逻辑和旧测试仍由原owner保留，只读回归。U释放窗须明确五usage文件的opt-in固定消费者接线和
保护反例；C3 repo/价格/replay、C2b首因/预算及TD14诊断observer保持，jobs/provider/parser只读。
如确需修改旧shared/dispatch测试，另列精确delta，不能由“相应测试”泛称取得全部归属。

## 保全入口与未释放证据

- 当前8源快照：`/Users/dongqiu/.local/share/insight-agent/evidence/r3-usage-s1-20261012/source-v1/`，逐文件0600；索引目录0700。来源为本专属工作区/base Git，非原owner未提交内容的替代件。
- 原准备三文档与证据仍位于 `r3-r6-interface-prep-20261011/final-index.json`，当前hash核对一致，不重写旧审查/收据。
- 原协调 `refactor-continuation-20261008-224349/coord/final-retained-ownership-v2.json`明确existing runtime/dispatch/DB commit源保留、normal Git/meta不释放；10-08协调文档继续保留shared writer归属。
- 原C3、C2b和TD14聊天确有合入/收口/清理记录，但没有此8文件到本聊天的逐文件释放。runtime/model-usage.ts最后实际变更是TD14 #431，不只C3/C2b；该诊断绑定也须纳入移交。
- 当前明确使用的是Dev-Agent-重构的N08窗口；其源码/环境全部不动。未取得其他8文件当前写占用与未提交保全入口的完整证明；idle、clean、已合入、目录删除或聊天结束均不填补这个缺口。

## 交主控的最小精确缺口

不再询问S/U负责人或D1选择。请主控协调上述8文件：原释放owner的具体身份、原head/blob/hash、
未提交保全入口（或原owner明确声明无未提交增量）、原owner→本聊天、释放的usage写窗、仍保留窗，
以及不与其他正在处理文件相撞的当前写占用。三shared先满足即可实施S1，五usage随后满足才能U。
无法确定原owner时，应由用户对具体文件恢复接管，不把普通委派或Git权限当既有保留边界解除。
正式ADR/architecture/主台账仍归原owner：请落账“isolated dispatch usage strict-close，取消后既有
attempt在有效原lease/open维护域允许本地迟到用量，禁止新transport/收尾Run/DB重开；D2/D3不变”。
本轮不代写这些共享文档。主控读取本聊天跟踪；本次无向其他聊天发消息授权，不主动发协商消息。

## 验证、审查与PR状态

代码未改，S1/U真实路径测试、typecheck/build/e2e、代码双独审、PR/CI/合入均尚未发生；不预签。
新代码高风险两位fresh非作者、最多两轮，待写窗和候选满足后执行，不复用旧准备双审签实现。
新合同/收据文档格式、链接、原材料保全及源码身份核对的结果另由本阶段final-index绑定。
无付费模型/资格矩阵/生产、备份/恢复/迁移/部署/hold释放/环境清理；safe_rollback=null、#435保持。

## 回退与下一步

当前无应用状态变更；保留原三文档、两个新文档、分支与新旧所有证据，不清理、不删除。
下一步为主控补shared三文件的释放记录；到位后继续S1固定bridge→新候选审查/验收→U，
无需重新委派S/U或重新批准已冻结D1。新文档留在当前分支，暂未提交/推送/建PR。
