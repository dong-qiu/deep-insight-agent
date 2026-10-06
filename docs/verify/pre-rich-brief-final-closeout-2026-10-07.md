# 新版 Daily Brief 实施前：最终诊断收口交接

> 2026-10-07（Asia/Shanghai；下述运行时间均为UTC）· 按用户明确批准的诊断范围收口。原T03/T04完整实验门、S1及生产准入仍未通过；没有实施新版功能、部署或破坏性数据操作。

## 六项清单与完成门

| 工作 | 实际完成与可复核证据 | 未完成门/保留项 |
|---|---|---|
| 1 保存对账 | [原件对账](pre-rich-brief-material-reconciliation-2026-10-05.md)；原六文件hash6/6不变，原S0进展独立提交，提取探索已归档 | 原件、配置、原文/DB/标签均保留 |
| 2 T03诊断分区 | [第三轮](pre-rich-brief-third-run-closeout-2026-10-06.md)、[分区审计](pre-rich-brief-t03-partition-audit-2026-10-05.md)；三次实际观察、31标签/30事件保全，188版本全探索/正式留出0 | 完整输入事件/重要维度/必要限定/固定题金标仍未完成；未知家族关系不记负例 |
| 3 T04停止及读测 | [未冻结协议](daily-brief-density-experiment-protocol.md)；同事实含引用X/Y各120秒，自评无差别，当前B1路线有界no-go | 重复曝光不证明收益；数值/资源版本/未见前瞻留出未冻，S1禁入 |
| 4 #360工程归档 | [PR#360](https://github.com/dong-qiu/deep-insight-agent/pull/360)，head30bfcc273cf7ea9853d4150d602790ee4d09c3e6，17:39:15Z正常merge1bf16e4bb75e9fb04dcc70f9d15ccbdc14b5bb24；35文件33Markdown+exporter/test，独立终核0/0及本head完整CI通过 | 仅签[诊断范围决定](daily-brief-density-diagnostic-closeout-decision-2026-10-06.md)，不认证原S0全阶段成功 |
| 5 C1有界验收 | [三层记录](pre-rich-brief-c1-bounded-closeout-2026-10-05.md)；Node38/Vitest105及双TS，机制/合成组件与实际生产身份分层 | H08无可连接浏览器、同镜像服务演练、TD-09完整生产历史恢复仍未通过；KNOWN GAP绿色仍代表旧CLI漏回放缺陷 |
| 6 条件清理 | [逐项实际收据](pre-rich-brief-local-cleanup-2026-10-05.md)；本地-d成功删除5/拒绝保留1，worktree移除0/远端手动删除0 | 最终只读预演；S0/提取试验/主树及全部配置或私有材料、排除/其他会话资源保留，没有-D/force/apply |

独立材料、协议、完整diff、推送后head/base/正文与合入状态审阅均Blocking0/Warning0。私有原文/标签/DB/SSM完整收据仅由执行者在owner-only gitignored隔离目录核验，未送给reviewer或提交。原人工确认沿用，不代签新金标或阅读效果。

main CI通过后的最终只读清理预演和保全核对已完成：原六文件hash再次6/6不变，实时15个worktree全部保留（14个存在配置/私有目录，另一个属于其他会话活动树），新增删除0。三个指定排除分支本轮不操作；其中两个本地引用已由外部状态变化不在列表，不计本轮清理或重建。#420新增无worktree本地分支仍保留，生产未更新，不能以dev-only豁免安全核验。

## CI、必要修复与实际版本

最新主干同步后真实exporter/report-gen/pipeline integration/db review/db reports五文件204/204、TS7/TS6 app/tools、exporter lint、33Markdown格式/链接/diff检查通过。#360精确head的[完整PR CI37504364349](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37504364349)成功，包括coverage/build/browser/audit、Docker及汇总门；合入后[main CI37505217117](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37505217117)已完整通过（同一merge1bf16e4，应用/coverage/build/browser/audit、Docker及汇总门），不以PR绿色替代main。没有生产AI路径或评测口径变更；eval-gate判断A1不执行只读导出/文档路径，不加假pass章。

旧失败原样保留：afceab3/CI37459884296图谱首次滑块未等React挂载，后续audit未执行；ec72454/CI37500338318已browser7/7但sharp高危audit失败，b407/mainCI37501620737同样失败。最小[#420](https://github.com/dong-qiu/deep-insight-agent/pull/420)声明source-map-js锁修复、外部另一会话[#423](https://github.com/dong-qiu/deep-insight-agent/pull/423)内联副本修复以及必要[#426](https://github.com/dong-qiu/deep-insight-agent/pull/426)sharp0.35.5与测试同步各自分开。#426完整PR CI37502578190和mainCI37503548677成功，merge5539ec1；#360继承main，两份browser变更从diff退出。没有弱化audit、严格图谱断言、零重试、hooks或validator白名单，不把这些修复冒认为生产已更新。

合入后生产只读SSM `5144a93d-f254-463f-8b6b-1bb0cc33d611` 于2026-10-06T17:40:20.321Z成功（rc0/stderr空、避开窗口），三个服务running/restart0，app/worker healthy；OCI revision仍`b199bc0381a1ebd2b50fde0e68819e0b884a4383`，Docker image ID仍`sha256:b947ee53b22ba26494ac30da7730bd76612a67bc3410a1aafafb57cd8fdd4406`。GitHub最新production deployment6827351877/b199为success，与现场一致。image ID不是可拉取的registry manifest digest；回退目标与部署仍须另核镜像/兼容性及另取执行授权。镜像发布不等于部署，身份inspect不代替H08或恢复演练。

整体备份仍incomplete，415missing/1808unmapped；历史规范路径387缺文件、6空引用、10缺报告与4新增候选未恢复各自保留口径，不混加或删真实引用换complete。未知/失败不写为零。出现新原件才按命中范围重开，不重抓网页冒充历史原件。

## 新版 Daily Brief 从何处开始

下一工作从[新版规格](../plan/specs/daily-brief-rich-insight-freshness.md)的阶段0开始：明确各主题读者/决策，建立来源证据契约、完整输入分母、前瞻分段时钟与各切片不可变预登记；先离线诊断和评测，再决定适用路线。188旧版本只能探索，不能作新留出；B1若重开必须补齐原T03/T04再过S1，C1首次提取仅是离线备选。

P论文从可归档且版本/身份/许可可核验的全文与章节定位起步；C播客从同集转写、说话人映射和可归属观点证据起步；I有界启示从已验证前提、适用/失效条件与独立标签起步；F时效从固定完整来源池和分段时钟起步。摘要不当全文、show notes不当嘉宾发言、位置匹配不当语义支持、同池B1收益不当时效收益。每一切片另过eval-gate、生产路径发布/恢复回归和自身准入；本次收口不启用功能或部署。
