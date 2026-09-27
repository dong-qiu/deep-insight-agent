# 比例定向评测：分维度契约与验证

当前状态：已标注 24 项定向验证完成。旧历史重放 10/11 的 Coverage incomplete 失败保持原样；
补齐脱敏诊断后，固定 rank 13 三次均成功，一次历史 11 条恢复重放全部通过，随后一次
prototype-safety 完整通过。可进入 PR 收口，尚未部署；旧故障根因未确认，不宣称已修复。
本次评测绑定 dirty source 指纹，只作为开发/PR 证据；部署前仍需最终 commit 的同版收据。

## 范围和用户决定

用户明确选择：保持现有 Coverage 规则，争议样本标为 pending，暂不作为发布通过证据。
本轮不修改模型、prompt、thinking、token、重试、引用白名单或历史报告。
生产函数只增加合并前的 primary_decisions 摘要（claim_id/supports/reason），不增加调用或改变 AND 门，
摘要不进入原有持久化审计结构。它允许评测直接观察主审，不从最终拒绝原因反推。

旧 47 项失败记录保持原样，参见 `reader-ratio-semantics-2026-09-26.md`。
新契约 `reader-ratio-dimensions-v2` 与旧单标签结果不可比，不声称旧失败已变成通过。

## 独立盲标签

独立 reviewer 未读取历史模型输出，核对 source、translation 与现有 primary/countercheck 契约：

| 原 42 个静态样本 | true | false | pending |
|---|---:|---:|---:|
| 翻译等价 annotation | 25 | 16 | 1 |
| 生产 primary gate | 25 | 17 | 0 |
| quote 自足 | 17 | 0 | 25 |
| 组合接受 | 11 | 17 | 14 |

primary 检查证据支持 AND 翻译等价，不是纯翻译分类器。`pronoun-baseline` 的等价标签待定，
而必要条件预检按设计拒绝；不能把它记成模型语义否决。泛指基线的 Q 标签待定，原因是现有
countercheck 总则与 MCP 1.67x speedup 正例之间的契约张力；严格政策下拒绝只是建议，不是当前 gold。

新增三个控制：展示外 baseline（E=true/Q=false，primary pending）；quote 内定义 baseline
（E/P/Q 均 true）；忠实译文含成本但展示 quote 未给成本（E=true/P=false/Q=true）。
最后一项证明不能由 E 与 Q 直接推导 primary。

默认执行 **19 个完全已审定静态样本 + 5 个实际生成 = 24 项**，另列 **26 项 pending**，
不调用、不计通过。默认子集中 17 个应接受、7 个应拒绝；Q 标签均为正例，**不能证明 Coverage
负例安全性**，后续 prototype-safety 的 quote-only 负例门仍不可缺少。
原泛指分母必要条件的边界继续由确定性接线测试验证；被暂列 pending 的真模型结果不作发布背书。

产物包含全量清单、选中清单、标签理由、源码/配置哈希和逐维度观测。仅能称
passed_labeled_subset，始终 publication_ready=false / promotable=false / full_contract_labeled=false。
显式 `--observe-pending` 仅用于诊断；存在 pending 时不能退出为通过。

## 实现和测试

- 主审完整集合与最终 claim 集合连续、唯一、一一对应；聚合全部 statement，不只看第一条。
  任一角色响应契约错误/故障单列，不得被另一个拒绝掩盖；缺失观测不反推为支持。
- generated 与生产一样检查 containsChinese / isCompleteStatement；英文或半句不能作为中文生成成功。
- 本地合成产物保存实际译文、受控 primary/countercheck 原因及输入/prompt 哈希；不保存 provider error。
  生成后审计异常仍保存已有译文；既有产物不可覆盖。
- 全量 `npm test`：206 文件、**2,005 项 Vitest + 14 项运维测试通过**。
  相关 3 文件 103 项通过；TS7/TS6 typecheck、受影响文件 ESLint 与 diff 检查通过。

## 独立代码审查

pre-pr 第 1 轮：Blocking 0 / Warning 3，分别是仅取首条主审、生成语言/完整性漏检、证据保存不足。
第 2 轮确认前两项关闭；第三项仍指出生成后审计异常丢失译文。
主代理随后补齐 catch 中 statement 与生成成功后 timeout 的反例测试（103 项通过）；
该最后一行修正及测试未获第三轮独立审查，不虚称第二轮已全部签过。
PR 创建后的独立复核应特别核查此残项修正和最终证据一致性。

## 真实模型验证

固定 profile：volcengine-responses；analyzer=deepseek-v4-flash；validator=deepseek-v4-pro；
coverage=deepseek-v4.1-flash；VALIDATOR_THINKING=0；COVERAGE_THINKING=1；COVERAGE_MAX_TOKENS=2048。
定向输出：`evals/out/reader-ratios-dimensions-v2-20260927.json`：**24/24** 在 primary、quote、
combined 三个维度分别符合预期；26 项 pending 未调用、未纳入通过证据。54 次请求
（validator 25、Coverage 24、analyzer 5）无执行失败，无重试。耗时约 144.69 秒，
记录成本保守估算 $0.782417。产物 SHA256：
`f2003113b0f08a53426d316cb90824394ecab208faafe906e1465882496b983e`。
此结果不宣称纯翻译模型准确率；equivalence_prediction 明确为 not_isolated，翻译标签与生产主审分开。

随后只执行一次固定历史 11 条重放，读取既有只读导出，不访问 live DB、不改写历史报告：
`.data/diagnostics/replay-dimensions-v2-11-20260927.json`。
**10/11 保留**，保留项均满足中文、原引用身份不变、reader audit 绑定、已改写及原文投影不变量。
rank 13 在改写前的独立 quote-only Coverage 返回 incomplete，stop_reason=other，导致
self_contained_unavailable 和依赖它的重要性锚点拒绝。没有执行英文回退，也没有放宽白名单。

共 52 次请求（validator 21、Coverage 21、analyzer 10），Coverage 有 1 次执行失败；
outer errors=0 只表示未向重放器抛异常，不代表所有模型调用成功。退出码 1。
耗时约 91.72 秒，记录成本估算 $0.923040。产物 SHA256：
`c5f59ab4df439fe1735900d6b910ff174001b7f9b463bc7d2b3fec9a693c40fb`。

最终代码在上述两轮付费验证期间保持不变。没有把局部通过用来覆盖旧失败，未重新运行旧 47 项。
费用为本地 fallback 估算，不是提供商账单。

### 停止条件及下一步

按 eval-gate，在历史重放执行失败后停止后续 prototype-safety、PR、CI、合并和部署；
全部改动留在 fix/reader-ratio-semantics，主工作区干净，无提交/推送/生产变更。
本轮没有认定 token 不足、key 失效或翻译错误，没有修改 token、thinking、模型或重试。

下一步仅定位 Coverage incomplete：现有 other 已无法还原供应商原始原因，不能从此次聚合反推。
应先为该终态设计安全的原因分类/提供商侧关联诊断，再用固定失败样本做有界复现；
不输出未知 SSE 内容或凭据，不循环跑完整 A1。原因和修复有证据后再恢复 11 条及 prototype-safety。
26 个 pending 继续按用户决定保持待定，不用于这次失败的归因，也不计入发布通过证据。

## incomplete 诊断及有界恢复验证（后续轮次）

新增 `responses-incomplete-diagnostics.ts`：固定原因分类、reason 形状、过滤对象存在性、
usage 存在性与实际返回的非负整数 input/output/reasoning tokens。未知值仍为 other，
不保存原始 reason、过滤详情、事件正文或请求 ID。每角色/阶段最多 16 项，另计溢出；
读写均重新投影。保持模型、thinking、token、重试、接受规则不变。
提供商文档确认 incomplete_details 可有 reason/content_filter，且 max_output_tokens 包括思考与回答；
这不证明旧失败属于过滤或预算耗尽：[Responses 对象说明](https://docs.volcengine.com/docs/ark/list-model-responses-api?lang=en)。

预先固定 rank 13 quote-only 三次，同进程串行、生产 verifyQuoteSelfContained：3/3 支持，
3 请求、0 故障、0 重试，约 13.06 秒，fallback 估算 $0.078255。
本地 attempt/时间/输入与 prompt hash 用于关联，不能供提供商按 request ID 精确检索。
产物 `.data/diagnostics/rank13-incomplete-fixed3-20260927.json`，SHA256：
`d81f73f288786cf2316da4de5afc496ec941b71657c00542ffdec033c9a87aae`。

没有复现，不凭猜测修改预算或重试；随后只做一次原并发 2 的全链路恢复验证，非循环跑绿：
`.data/diagnostics/replay-incomplete-diag-11-20260927.json`，11/11 保留且全部引用/中文不变量通过，
55 请求、0 故障、约 77.33 秒，估算 $0.910870。SHA256：
`48799698497ac7f4e83850b3cf64ea220d6e727d1bd40caef99371fcb3071c1b`。

一次 `npm run eval:a1:prototype-safety`：run `a1-20260927042605-3e3a0d20`，完整完成。
固定 profile 与上节相同；consistency 12/12（support 3、uncertain 2、not_support 7，含三类负例）；
display unsafe_accept 0/9、false_reject 0/5、projection_violation 0/14；
quote-only unsafe_accept 0/4、false_reject 0/4。49 请求、0 故障，估算 $0.7836。
baseline 仍无同配置可比项，DCP/正式质量/许可不背书；按 ADR-0032 仅作为内部原型 scoped evidence。
收据 `evals/out/prototype-safety-receipts/incomplete-diagnostic-20260927.json`，SHA256：
`807b790d8d8c46a2296b97e4882e15ac7ba6044db47c7aa5a951e619508ada1a`。
对应 manifest SHA256 `ff8483e0eb060f15fd6d1ed32af02be5a60c574d2ca92d89b8beb995bb6dfd56`，
a1-run SHA256 `79e1713189d9bcfc169d63e7314f62169c36e36c04388bd626fe719269fd4ac4`。
执行时 HEAD=00c9a7a，dirty_fingerprint=
`f433b98d6c9c24c168ef384c245491fc6c49b4e8c4aa48d198bd00cb84236089`。
不能把该收据当作干净主干或最终发布提交的证据；不得改写其 commit/hash。

本轮全量 207 文件 2,019 项 Vitest + 14 项运维测试、双 typecheck、相关 ESLint、build 通过。
构建保留既有 middleware convention 弃用提示，不在本任务扩展迁移。
新建 reviewer 受 thread limit 阻止，复用独立 reviewer 做增量复核（非 fresh-context 全分支审查）：
Blocking 0、Warning 0；独立 95 项测试通过，确认上一轮 catch 保存译文残项已修复。
Suggestion：新 helper 加入 ratio runner 源码指纹清单，已处理，旧产物不改写。
生产代码在固定三次/11条/prototype-safety 期间不变；后续仅完善文档。

## PR 交接

[PR #356](https://github.com/dong-qiu/deep-insight-agent/pull/356) 的代码提交为 `f29f81e`。
PR 后独立复核代码 Blocking 0 / Warning 0，另跑 8 文件 199 项测试通过；未读取私有评测产物，
仅核对版本化记录与 PR 声明一致。该复核确认 pending 排除、primary 快照、catch 保留译文、
incomplete 脱敏及 dirty source 非发布证据的边界。CI 全绿后方可合入，不等于可部署。
初次 pr-policy 因 PR body 未用机器要求的中文字段/表头而失败；已补齐格式并通过本地同款检查。
该检查读取原事件的 body，简单重跑旧 run 不会获取更新说明，因此以本次纯文档交接提交触发
新的 PR CI，不改运行代码、不重跑模型、不删除旧失败记录。
