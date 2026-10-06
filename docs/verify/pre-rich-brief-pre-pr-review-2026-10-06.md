# 诊断收口：最终 PR 前独立审阅

> 2026-10-06 · 只签诊断归档交付，不签原 T03/T04、S1 或生产准入。最终推送 head 与 CI/合入结果以 [#360](https://github.com/dong-qiu/deep-insight-agent/pull/360) 正文的固定 SHA 收据为准。

## 范围与独立结论

用户明确批准[仅诊断收口决定](daily-brief-density-diagnostic-closeout-decision-2026-10-06.md)。三次实际观察、188已见版本全探索/正式留出0、原标签保全、T04真实读测与未完成门，以及C1/清理记录均可作为有界交付。独立材料、协议、完整diff审阅及范围修订后的定向复核：Blocking 0 / Warning 0。发现的旧“当前没有明确决定”歧义已修复；不是通过降低实验门宣称S0成功。

代码仍是只读exporter及合成测试；没有生产prompt/模型/来源/validator/报告选择或评测集变更。报告继续使用逐引用validator白名单，unknown不计零、不批准拒绝草稿。评审不读取私有原文/DB/配置，不替代事件重要性、阅读收益或历史完整恢复的人评。

## 定向验证与主干同步

- 本轮在同步 `6eabc5f` 后：exporter/report-gen/pipeline-reportgen/report-review/reports五文件204/204；独立exporter15/15与TS7/TS6 app/tools通过。文档空白和链接检查通过。
- 原远端 `e75c860` 的2731 Vitest/150 Node及coverage收据属于旧head；不得用其绿色证明本次新head。最终推送必须重新跑必要CI。
- main CI `37437928802` 的高危audit失败原样保留。独立最小安全补丁 [#420](https://github.com/dong-qiu/deep-insight-agent/pull/420) 仅将锁文件source-map-js 1.2.1升级1.2.2；独立审阅Blocking0/Warning0，audit 0漏洞、typecheck、生产build及[完整PR CI37457774910](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37457774910)通过。
- #420于11:48:30 UTC合入，实际merge `86d824fd5fbe12006679a02cebcc877f71493f73`；S0非破坏性同步merge `a105ec907d66baae59e630f872a5008b45944d0b` 的第二parent精确等于该main。新main [CI37458872550](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37458872550)此时在跑，未提前签绿；未部署。
- Eval-Gate不适用：A1不执行只读导出/文档路径，没有改AI评测口径或数据；安全依赖补丁不引入AI语义变化。没有伪造pass章。

## 合入与移交要求

推送后独立核对最终diff、head/base、正文与必要CI；实际head未全绿前保持draft。诊断工程门通过后可依已有授权自行ready/merge，再验main CI。工程合入不会补齐T03完整输入金标、T04数值/资源版本/新留出、H08、同镜像服务恢复或TD-09历史完整恢复；这些继续按各自原门处理。

本地分支再次仅dry-run，主工作区六份原件hash6/6不变；没有新增worktree移除或远端删除，没有动三个排除分支或其他会话资源。本轮为安全修复创建的隔离worktree仅复制所需配置并隔离DB/目录，未复制生产数据。所有私有资料保留。

后续候选afceab3的browser CI失败已按[图谱挂载同步收据](pre-rich-brief-ci-graph-readiness-2026-10-06.md)因果复现并仅修复测试等待，未改原严格断言。新增两份browser测试同步文件与本收据纳入独立终审，必须用再次推送的真实head CI核验；上文34文件范围属于失败候选的历史复核。#420仅修复锁依赖audit阻断，内联副本另见#423，不冒称所有安全路径清除。

后续真实候选ec72454的browser已通过，CI37500338318仍因新sharp高危audit失败；base b407的main CI37501620737亦失败。最小[#426](https://github.com/dong-qiu/deep-insight-agent/pull/426)已独立审阅、定向测试、创建并完成远端四文件复核，CI未提前判绿。#423此时已由另一会话合入；早先draft说法为历史状态，不代表本轮审阅或部署。待#426合入同步后，两份browser变更由main承接，#360剩余diff仍须独立终审。
