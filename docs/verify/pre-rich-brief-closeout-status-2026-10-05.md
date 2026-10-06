# 新版 Brief 实施前收口：执行状态与后续起点

> 2026-10-05 起执行；**原实验完成门未通过，未允许启动新版功能**。2026-10-06用户明确批准诊断收口范围；原T03/T04实验门未完成，未知证据不升级为通过。

| 项目 | 实际交付/证据 | 状态与合入 |
|---|---|---|
| 1 材料保存对账 | [文件级对账](pre-rich-brief-material-reconciliation-2026-10-05.md)；`946d036`，原未提交进展独立提交 `e7e9153` | 完成门与独立文档review通过；S0前置步骤，仅保存在分支 |
| 2 T03 家族/标注分区 | [聚合/缺口/分区审计](pre-rich-brief-t03-partition-audit-2026-10-05.md)，私有184已见版本/原确认标签；`abbd0e7` | 10月3/4完成观测；10月6日已补第三轮及首份备份；188版本全探索，供给路线有界no-go；T03完整输入事件/维度/限定/题目金标门仍未通过，S0总门未通过 |
| 3 T04 数值协议 | [冻结条件及停止点](daily-brief-density-experiment-protocol.md)，等事实X/Y含引用包、真实回填120/120秒、主观无差别 | 无B0收益证据；B1/完整事件金标/资源版本/数值门与新前瞻留出未冻，总门未通过 |
| 4 PR #360 | 只读exporter、T01/T02有界证据、T03/T04真实缺口及经确认产品方向；同步main `1d8925f` 的merge `883b78d` | 工程门待核验，暂保持draft；用户已明确批准仅诊断收口，独立复核和实际head CI通过后可自主ready/merge。旧远端head的CI不得用于新head；10月6日同步实际main `6eabc5f` 的merge `b6b235d` 待本轮新head验证 |
| 5 C1及已合入交付 | [分层有界验收](pre-rich-brief-c1-bounded-closeout-2026-10-05.md)；生产b199镜像/内容/健康收据，main CI/交付merge SHA，Node38/Vitest105 | 有界整理完成，原工作已合入；本轮未部署。H08、同镜像服务演练、TD-09完整生产历史恢复均未通过 |
| 6 本地清理 | [逐项审核及实际非强制收据](pre-rich-brief-local-cleanup-2026-10-05.md) | 已删除5个无worktree已合入且未推进的本地分支；1个-d拒绝保留；移除worktree0、远端删除0 |

私有输入、标签、运行/SSM收据、原文/快照、阅读正文/曝光记录与备份原件保持在 gitignored owner-only 目录。主工作区六份原件保留；S0、提取试验及所有含配置/私有数据的worktree保留。三个排除重构分支及旧C4b路径不由本轮清理；其他会话推进/删除的元数据不得计为本轮操作。

## 实际剩余门与停止点

第三次软件工程日跑及截止内首份备份已按[10月6日实际收据](pre-rich-brief-third-run-closeout-2026-10-06.md)补齐，原时限未延长。避开16:50–17:30 UTC生产访问窗口；只读下载隔离副本，完整记录无batch/失败/未知候选数，不凭日程或较晚备份补证。三次供给结果只决定有界工程顺序，不能替代S1收益。

即使第三轮无合格互补供给，也只能给出有证据的no-go/不适用。T03仍缺完整输入的关键事件、重要维度、必要限定与固定理解题金标；T04仍需有依据的数值门、完整输入事件/维度分母、版本/资源绑定与未用于调参的前瞻家族封存。若这些材料不足，保持当前门和draft；如确需“诊断成果可合入、T04不在本PR完成”，必须先取得并记录独立的完成门修订决定，不能本轮自行宣布通过。

## 新版 Daily Brief 从何处开始

当前只保留 [新版规格](../plan/specs/daily-brief-rich-insight-freshness.md)作为经确认方向，不启动功能。完成旧收口后：

- B1已核验多事实消息先以S0完整候选/证据白名单为输入；只有正式S1有适用新事件/互补事实及收益证据才进入新格式发布契约/投影实现。供给不足时，C1首次提取仅是后续离线备选。
- P论文全文深读：以不可变、许可与身份可核验的全文及章节定位为起点；摘要不得当全文。
- C播客嘉宾观点：以同一冻结可见输入、可归属的转写/speaker证据为起点；show notes不能当嘉宾发言，位置匹配不替代语义支持。
- I有界启示与线索：以已核验来源事实、来源明确影响与离线启示标签为输入，启示需已验证前提、适用场景/失效条件和验证动作，不能由报告层自由推断。旧提取诊断的 P/I（解析/输入选段）是另一套干预编号，不混作本新版 P/C/I 产品切片。
- F时效：固定完整来源池和分段时钟、重要事件金标；独立比较采集/入选/出刊延迟，不能把同候选池B1收益记作时效改善。

上述各切片独立预登记、eval-gate与发布/恢复回归；本次阅读反馈、组件绿色、镜像workflow success与阶段收尾都不是新版功能生产准入。

## 2026-10-06 续办核验

网络/文件访问恢复后只读补齐第三轮，原31份标签hash及id/revision/body hash保全核对通过。私有原文/DB留隔离目录。生产08:46只读核查三服务仍running/restart0、镜像image ID仍为已核验b199对应的 `sha256:b947ee53b22ba26494ac30da7730bd76612a67bc3410a1aafafb57cd8fdd4406`；没有部署。H08再次连接浏览器仍无可用浏览器，继续pending。

主干同步期间其他会话合入D7，实际merge `b6b235d` 的第二parent为 `6eabc5f671073c377200f7551daf8a143d333989`，不把先查到的4855版本当最终基线。本轮不修改D3/D7或排除分支；C4b原路径后续已由其他会话移除，不计本轮清理。本轮worktree remove仍0。

最新实际 main `6eabc5f` 的 CI [37437928802](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37437928802) 未通过：`npm audit --audit-level=high` 报 `source-map-js 1.2.1` 的 GHSA-68fv-2mgg-jv7q 高危漏洞，Docker 检查通过不能抵销 audit 失败。以独立最小依赖补丁 PR 修复后，仍须核验新 main 与 S0 head 的真实 CI；不降低安全门。

用户随后明确同意“缩小为诊断收口，保留未完成门”；[决定与新交付门](daily-brief-density-diagnostic-closeout-decision-2026-10-06.md)已记录。此前待确认文字保留为决定前的状态；现在只核验诊断归档合入，不认证原T03/T04完整门或S1。

安全补丁[#420](https://github.com/dong-qiu/deep-insight-agent/pull/420)已通过独立审阅/完整PR CI并于11:48:30 UTC合入`86d824f`。S0已非破坏性同步`a105ec9`；[新main CI37458872550](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37458872550)此时仍在跑，不提前签绿。当前工程复核见[10月6日审阅](pre-rich-brief-pre-pr-review-2026-10-06.md)，最终head/CI/合入结果见#360正文收据。本轮继续只做dry-run清理，无新增删除。

#360候选afceab3的CI37459884296失败于图谱加载同步，修复与复现见[测试收据](pre-rich-brief-ci-graph-readiness-2026-10-06.md)；重新推送并独立复核后只用新head绿色，不抹去失败。#420的audit修复不涵盖magicast内联副本，另有#423独立draft，本轮不动其分支或声称部署/安全全路径通过。

## 2026-10-06 最新 CI 安全阻断（历史不覆盖）

候选 `ec72454d04588d1a88c01d79f4e61fa300f8c8ff` 的 [CI37500338318](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37500338318) 图谱smoke已7/7通过，但后续高危audit失败：sharp0.35.4命中GHSA-wq5f-xc86-pv6w，不能把browser成功当整套绿色。另一会话的#423已于17:11:28 UTC合入`b407b9e61915c33f835966f8f760f3424f0e17f5`，这是外部交付事实；此前draft文字仅为当时快照，本轮没有修改该分支或部署。其[main CI37501620737](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737)同样失败于sharp高危audit。

必要修复独立为[#426](https://github.com/dong-qiu/deep-insight-agent/pull/426)：既有sharp override0.35.4→官方修补0.35.5，只改27个sharp锁树条目，同时承接已经验证的两份graph测试同步文件；CI/hook/引用和原断言未弱化。本地clean npm ci/audit0、双TS、lint、原生SVG与SQLite探针、生产build、HTTP E2E8/8及browser7/7通过，独立PR前和远端四文件终核Blocking0/Warning0。#426 head `7278d0bc64e23986534254e486304eccd0c28b68` 的必要CI此时在跑；合入及main CI后再同步#360，最终真实SHA/CI/合入状态以PR正文固定收据为准，未提前签绿。

最新原件hash6/6不变。再次清理预演未执行任何删除；三个排除分支不操作，其中perf/c4b-a1-low-risk与refactor/d2-hotspot-pure-slice的本地引用已不在实时列表中，不能归因于本轮。S0及其他含配置/私有资料的worktree全部保留。
