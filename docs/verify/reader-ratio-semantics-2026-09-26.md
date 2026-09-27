# 中文结论比例语义：原文核对与最小修复

## 当前状态：恢复验证完成，进入 PR 收口

最新进展见 [分维度评测验证](reader-ratio-dimensions-2026-09-27.md)：用户选择保持现有规则，争议标签
保留 pending，不计发布证据。新版已审定子集 24/24 符合预期；旧历史重放 10/11 的失败保留。
补齐 incomplete 脱敏诊断后，固定 rank 13 三次及一次 11/11 恢复重放通过；随后一次
prototype-safety 完整通过、两类 unsafe_accept 均为 0。可以进入 PR，尚未部署；旧故障根因仍未确认。
本次开发评测绑定 dirty source 指纹，最终发布需另有同版 commit 证据。下面保留前序结果。

2026-09-27 新增受控传输诊断并完成固定恢复对照后，完整 47 项为 **46 项符合脚本预期，
90 次调用无执行失败，17 个负例全部拒绝**。唯一不匹配为 negated-explanation 的
quote_not_self_contained；独立 review 确认 runner 把翻译等价/预检放行误当成组合展示应放行，
不能仅据这次结果认定 Coverage 误拒绝。当前首先需要修正评测维度及独立预期。
旧传输故障本次未复现，但根因尚未确认，不宣称已修复。
按 `eval-gate` 暂停发布链路；本轮未继续执行历史 11 条和 prototype-safety，未创建 PR 或部署。
下文通过记录均按其发生时的版本解释，不能替代当前版本的完整评测；所有失败保留。

## 范围与原文结论

基于 `ac558f8`，分支 `fix/reader-ratio-semantics`。执行原文上下文核对、反例与最小修复、独立评审和回归；
不改模型/provider/thinking/token 预算，不改变 quote-only Coverage，不重写历史报告或推送。

生产只读核对的目标句位于 Jev-as-a-Judge 介绍中，上下文列出价格、时延与多个评测差异，
随后描述低置信度请求交给另一模型的级联。保存的上下文**没有明确两个比例的精确比较基线**。
因此不能把路由目标补写为“单独运行该模型”的成本/准确性基线，也不能假设原准确率为 100%。
该句表达准确性的保留比例与成本比例，不是绝对准确率或成本降幅。

只读摘录、定位及源正文哈希保存在 gitignored `.data/diagnostics/ratio-context.json`；
原文不进入版本化测试。测试使用独立构造的 Atlas/Orion 合成文本与不同数字。

## 实现

- 翻译与译文 primary 共享比例语义约束：保留比例/绝对值、成本占比/降幅、百分比/百分点、
  未说明的比较基线。路由目标仅是参与者，不自动成为比较基线。
- 原始案例证明**仅加强 prompt 不足以可靠拒绝歧义中文**。新增有界确定性预检：
  英文明示保留某比例准确性，而译文明显写成“准确率达到/为/是X%”或“保持/维持X%的准确率”，
  则记录 `translation_ratio_denominator_lost` 并拒绝，不调用 primary 让模型推翻此必要条件。
  该预检仅处理明确的英文保留比例/中文绝对形式，不声称是通用跨语言数量解析器。
- 其他表达继续执行语义检查；独立 quote-only Coverage 仍执行，不能覆盖已拒绝的主张。
  不新增通过缓存，不通过重复调用挑选接受结果；quote、locator、citation_ref 均不修改。
- 新原因码进入脱敏诊断白名单，不保存原始文本或模型错误。分析输出缓存版本更新为 v26；
  既有报告/审计不回写。

## 早期测试与真实模型对照（历史记录）

Node 24.19.0。受影响 8 文件 **298 项测试通过**；TS7/TS6 typecheck、受影响文件 ESLint、
`git diff --check` 通过。新增测试先在旧代码上确认提示约束缺失，后补实现；mock 测试只证明接线、
拒绝传播和证据不变，不作为 LLM 语义准确性证明。单独的真实模型检查承担该部分。

命令：`node --import tsx evals/check-reader-ratios.ts evals/out/reader-ratios-final.json`。
显式配置：volcengine-responses，analyzer=deepseek-v4-flash，validator=deepseek-v4-pro，
coverage=deepseek-v4.1-flash，VALIDATOR_THINKING=0，COVERAGE_THINKING=1，COVERAGE_MAX_TOKENS=2048。

| 固定合成用例 | 修改前 | 当时实现 |
|---|---:|---:|
| 6 个错误译文由 primary 拒绝 | 4/6 | 6/6 |
| 5 个正确译文通过展示语义门 | 5/5 | 5/5 |
| 5 个实际生成译文通过展示语义门 | 5/5 | 5/5 |
| 执行失败 | 0 | 0 |

修改前误放行为“百分点→百分比”和“把路由目标补为比较基线”。固定样本 SHA256：
`61d2880211f39a974c3295a8733f1186fa558759dcb140e3aa9b9182f4a33bf3`。

- before 文件 SHA256：`50cc76b9f923ace3e41371d703fe1cb4da3b73ce7e197c69b71b918e6048ddd8`。
- final 文件 SHA256：`d26eef9ef6e152b13d4c2b8f35b34d2e65191061eee775ea228a92383a201c88`。
- 最终定向运行约 77.6 秒，成本保守估算 $0.493759；未知模型价格采用 fallback，非提供商账单。
- `before`、`after`、`after-v2`、`after-v3`、`final` 均保留；中间版本不能替代最终证据。
  v1 尚误放基线，v2/v3 合成例全过但仍未可靠拦住真实歧义译文，由此才增加确定性预检。

原始历史案例的单独最终检查位于 `.data/diagnostics/original-ratio-check-final.json`：
旧歧义译文被 `translation_ratio_denominator_lost` 拒绝，新生成译文保留相对比例并获语义支持，
无 API 失败。这个检查不是原 11 条全量重放，也没有重新执行报告发布或下游全文 validator。
不应写成“旧日报所有问题已解决”或“纯 prompt 修复已足够”。

## 限制与后续边界

### 早期原型安全评测（eval-gate / L3 快速路径，非当前发布证明）

`npm run eval:a1:prototype-safety` 完成并生成收据：
`evals/out/prototype-safety-receipts/a1-20260926101137-3f158d46.json`。

- 规模：1 主题、12 一致性对、14 display、8 quote-only。
- 三分类 12/12；display unsafe_accept **0/9**，false_reject **1/5**；
  quote-only unsafe_accept **0/4**，false_reject **0/4**。43 次逻辑调用，0 失败。
- 保留 display 的 1 个误拒绝，不能把该结果称为零退化；按原型规则作为趋势指标记录，不改阈值。
- manifest SHA256：`b329f647c230681da4449804e989a1988ddcd099316e3639f57d5d73d50c5e83`。
- a1-run SHA256：`b3ed7796dfc2664f6b37c72192876f685c8babfb6d65a70dcb371593a08611c4`。
- 成本保守估算约 $0.6490，不是提供商账单。最终收据对应基于 ac558f8 的未提交工作区，
  不是 ac558f8 原提交或生产镜像已经包含本修复的证据。
- 迭代阶段的 `a1-20260926094753-c8fcd047` 与 `a1-20260926095027-b032fc93` 也保留，
  不冒充最终版本结果；后者曾有 1 次 Coverage 调用失败，不能宣称所有迭代均无错误。

真实对照是同配置、固定合成样本上的局部观察，不是新的 baseline、DCP 或人工质量验收。
`evals/baseline.json` 是旧模型与不同数据口径，不能计算可比 Δpp；本次不更新它。
新预检只保证已明确定义的句式；分母语义仍有模型判断边界，不能推论所有自然语言表达均受覆盖。
证据不足的候选仍可被拒绝，不承诺为了产出率而放行。

## 后续独立评审与回归（当前收口依据）

### 独立评审与确定性修复

按 `pre-pr-ai-review` 完成两轮独立评审，两轮均为 Blocking 0、Warning 1，结论均为需修复，
不能表述为独立评审已批准。第一轮发现否定解释、多主体句会误触预检；第二轮发现显式基线或
括号内参照表达也会误触。已将这些歧义形式交回原有语义校验，并补充反例。
第二轮后的基线边界修复由主代理验证，未追加第三轮独立评审。

真实模型检查脚本增加预检正反例，并仅允许明确的 primary 拒绝或
`translation_ratio_denominator_lost` 计为负例成功，不能将 Coverage 调用失败算成正确拒绝。
当前脚本共 22 项；本轮真实调用开始时为 20 项，最后新增的两个基线正例仅完成单元验证，
不得声称 22 项均已完成真实评测。

最终本地检查：受影响 **8 文件、308 项测试通过**，TS7/TS6 typecheck、受影响文件 ESLint、
`git diff --check` 通过。测试覆盖 reader ratio、reader language、analyzer、display coverage audit、
pipeline、coverage diagnostics、report-gen 和 pipeline/report-gen 集成。

### 扩展合成评测：1 次错误放行

`evals/out/reader-ratios-reviewed.json`：20 项中 19 项符合预期；7 个负例中 1 个被错误放行，
13 个正例通过，API 失败 0。错误负例将路由目标补成“单独使用 Orion”的成本与准确性比较基线，
primary 与独立 Coverage 均接受，而原文没有说明该基线。

- 运行约 116.0 秒，成本估算 $0.662829，非提供商账单。
- 文件 SHA256：`f382495257ce13cf09d7af5edb18a62df5636f8e17bbf5f103db2d896a48796f`。
- 错误放行 primary prompt hash：`f73cde5473cc16df74c4f932c49289caa02be88b2949bb1e4738556937bb0b1c`。
- input hash：`3db7cbe2f593c460c85bd4fb82273e3551157dcf5d78ec3916e5e057e88ca84d`。

该运行早于最后的基线关键词预检收窄，但本例源句不命中有界预检；后续最终工作区固定诊断
确认 primary prompt/input hash 相同。因此不能将本次错误放行归为已修复的旧实现问题。

### 本轮原型安全评测：不完整

`a1-20260926103501-624d6bec` 退出码 1，`core_complete=false`，没有生成新的通过收据。

- 1 主题、12 一致性对（12/12）；display unsafe_accept 0/9、false_reject 2/5；
  quote-only unsafe_accept 0/4、false_reject 0/4。
- `generic-subject-direct-positive` 的主校验调用失败（约 47.1 秒），错误为
  `coverage audit unavailable or invalid`；未证实网络、token 或其他底层原因。
  本轮 false_reject 至少包含这一次执行失败，不能全部解释为模型语义误判。
- 成本估算 $0.8611。
- manifest SHA256：`602b47c2b46e563ffd9d0763280a0c671f022d87e77b70d0b3128cf9e5aa69b7`。
- a1-run SHA256：`b10d92bed7f9b64b2972576e755e8e8cedd40d869d74d7d4afe21f91bbb52a3a`。

该轮也开始于最后预检收窄之前，既不完整，也不能充当最终工作区通过证据。历史通过收据不能替代它。

### 原 11 条中文化回归：通过但不替代安全评测

最终工作区的生产函数 `filterByQuoteCoverage` 重放原 11 条：**11/11 保留、零错误**。
quote、content ID、citation reference、locator 均保持不变，reader hash 绑定检查通过，
canonical statement 仍保留原文。约 92.7 秒、55 次调用，成本估算 $0.930460。

结果位于 gitignored `.data/diagnostics/replay-final-11.json`，SHA256：
`cd58ff9bef21a04085f9d8613f94e49da65d5389ca8429eb3676126e292d98bb`。
该重放不含下游全文 validator 或完整发布流程，不等于新日报周期验收。

### 固定 3 次诊断：确认波动，不重跑挑选通过结果

每类预先固定 3 次，全部结果保留，共 9 次观察、零 API 失败，成本估算 $0.293854：

| 对象 | 三次结果 | 解读 |
|---|---|---|
| 历史第 15 条 quote-only Coverage | 支持、支持、支持 | 小样本观察，不承诺持续稳定 |
| 未明示基线的合成负例 | 拒绝、拒绝、拒绝 | 与此前错误放行的 primary 输入及 prompt hash 相同，证明波动而非修复 |
| 既有中文正例 | 拒绝、拒绝、接受 | 不经过新增翻译预检的路径亦存在判定波动，不能据此认定新增回归 |

结果位于 `.data/diagnostics/fixed-three-checks.json`，SHA256：
`0ff4a0cdf2338e45f748613ba9e13ec3be6c26d839f6443963465a93dfe2bf2d`。

### 生产不变与下一步

只读复核确认历史报告及源正文哈希未改变；没有回写、重生成或通知：

- Markdown：`17682f2cbc9b1dcebff40aae4e31d1a2d62e6f388cc93765f21699d30312eafd`。
- HTML：`00a387f767c409088cd5fcf68e00d23dbcbe589fb28dfd23ee01c946339b7d5d`。
- 报告行：`bfb77ff1ff197e262450e9b5493b6c6b7607effda32fb9e5aaedc228c979e935`。
- 源正文：`595bcb6346883decdd60264826f6aa259592a149489af734b0fa94f118dc5ac2`。

尚未创建 PR、合入或部署，也未执行新日报周期验收。修改留在独立工作区，主工作区干净。
worktree 配置仅复制 `.env.local`（0600）并固定隔离 DB/DATA 路径；未复制 live 库。

建议下一步先设计“比较基线必须由证据明确绑定”的保守检查；证据缺失时保留原文的未指明状态，
不得凭路由目标推断。评估对正确译文的误拒绝风险并补验收用例，再修复并运行预定完整验证。
不要通过继续堆叠提示词、扩大正则或反复重跑直到通过来替代安全结论。
同时单独诊断主校验执行失败；只有完整评测和反例验证满足门禁后，才恢复 PR → CI → 合并 → 部署。

## 下一轮实施：有界泛指分母守卫（2026-09-26）

在用户批准上述顺序后，新增 `hasUnverifiedRatioBaseline`，接入同一生产译文 primary 前置路径。
只识别明确的准确性保留谓词与 `at … cost` 占比，不凭路由目标或邻近名字绑定分母；
未通过必要条件时记为 `translation_ratio_baseline_unverified`，不等同于已证明事实矛盾。
符合泛指格式仍必须执行 primary 和独立 Coverage，不新增模型调用、重试或接受缓存。
翻译器获得有界格式要求；该格式偏好不附加到语义 primary，避免将格式偏好当成等价性判据。
模型/provider/thinking/token 预算均不改变。

一位独立设计 reviewer 建议以有界语法约束泛指分母而不猜测具名对象。
随后新开上下文进行两轮实现 review：

- 第 1 轮 Warning 2：后置 `of Orion` 等分母被误识别；损失/节省也被套用保留/剩余格式。
  已收窄源谓词及 atom 结束边界，新增 5 个正例及真实接线测试。
- 第 2 轮 Warning 1：一个比例匹配、另一比例未匹配时，剩余文本检查会误拒绝正确组合句。
  已补 3 个组合正例；任一泛指关系未完整解析时将整句交回语义门，支持 `the original`。
  此轮后的修复由主代理验证，已达到两轮限制，没有宣称得到最终独立评审批准。

最终本地检查为 **8 文件 351 项通过**，typecheck（TS7/TS6）、ESLint 和 diff 检查通过。
测试还包括：即使 mock primary 一律接受，新增负例仍不能放行；独立 Coverage 仍执行；
非翻译路径不受新增规则影响。版本仍为未发布的 v26（main 为 v25），不是修改已上线版本而不失效缓存。

### 上轮调用失败的诊断

读取原 `a1-20260926103501-624d6bec` 的持久化 role telemetry：
`display_quote_primary` 14 次中 1 次失败，`provider_stream_failures.error=1`，
未完成 function arguments 1 次，失败调用约 45.2 秒；没有记录 HTTP 错误或 `max_tokens`。
该受控 `error` 标签在适配器中同时覆盖显式 SSE error 事件与无效 SSE JSON，
因此只能定位到流式/协议错误，不能进一步断言提供商内部原因，也不能据此认定 API key 失效。
保持失败关闭，不将其伪装为模型拒绝，也不扩大重试策略。

### 迭代 40 项运行（保留，不替代最终版本）

`evals/out/reader-ratios-baseline-bound.json`：40 项中 38 项符合预期，14 个负例全部拒绝；
两项正确译文（`explicit-relative-baseline`、`cost-saving`）被 primary 拒绝，API 失败 0。
运行约 191.3 秒，成本保守估算 $1.178087。
SHA256：`3f8adcaa2d1ae23697193a3c057d490005e157c8947ce9f6f23c1d618e6fe5dd`。
运行期间加载的是第二轮组合场景修复前的模块快照；产物保存了源码、fixture 与 runner 指纹。
随后补完组合修复，并将泛指生成格式仅限定于 translator，因此最终版本另跑固定的 43 项，
不是同版本循环重试直至通过。上述误拒绝结果不删除，也不据此宣称格式调整已解决语义波动。

### 最终固定 43 项：18 项完成，第 19 项超时

`evals/out/reader-ratios-baseline-bound-final.json` 保存 18 项（7 负例全部正确拒绝、11 正例中 2 项误拒绝）。
误拒绝为 `explicit-relative-baseline` 与 `parenthetical-baseline`，均是 primary 的 `judge_not_supported`，
不是确定性守卫或 Coverage 造成。当前不能声称“所有相对比例表达已正确处理”。

第 19 项 `routed-model-baseline` 在 120 秒 deadline 抛出 `TimeoutError`；该项预检不调用 primary，
在随后独立 Coverage 路径中超时。进程退出码 1，没有继续执行剩余 24 项，也没有再次重跑挑选通过结果。
原脚本仅在成功返回时保存，因此此文件没有第 19 项的终态和最后一次调用的 telemetry；
超时结论来自本次命令输出，不能将文件中的零 failures 解释为全程无失败。

- 文件 SHA256：`c36b63d49d8135d03cebb213924bc044dfd813cd0a46ecfa5312e954a57afffb`。
- 保存进度约 93.3 秒；进度内成本估算 $0.540247，不含未保存的超时调用，不是整轮完整成本。
- 运行生产代码指纹：reader-language `9b9e8db6ade3cc7665e90c0fce7aed6f627dd296b51c214cb89391150da443e0`；
  analyzer `5d99bd2e24ec01faff8e077cf319bbb67214f25a596ec4cf60ca7647be8c03dc`。

已修复 harness 的失败留痕：每个 audit/生成用例异常时保存受控 `timeout`/`execution_failed`、
保留 telemetry，继续执行固定计划，不重试失败项，最终退出码仍为 1；任何 role execution failure 也使整轮失败。
新增无付费 mock 测试证明完整 43 个唯一用例继续执行、异常内容不泄露、失败项不被重复调用。
这项 harness 修复没有再次执行付费定向评测，也不补造上述缺失终态。
最终本地检查更新为 **9 文件、352 项通过**，TS7/TS6、ESLint 和 diff 检查通过。

### 最新原型安全评测：完整通过，不能替代未完成的比例回归

运行 `a1-20260926121917-3626d237`，收据
`evals/out/prototype-safety-receipts/a1-20260926121917-3626d237.json`。
1 主题、12 一致性对（12/12）；display unsafe_accept 0/9、false_reject 1/5；
quote-only unsafe_accept 0/4、false_reject 0/4；48 次逻辑调用，0 失败。成本估算约 $0.7513。
display 误拒绝仍为 `source-quote-chinese-synthetic-positive`，原因 `judge_not_supported`，没有执行错误。
manifest SHA256：`3becfa9f43ea23f11f481f6879526ff66033fec489d61df13f59d105455b1f17`；
a1-run SHA256：`a33c3cce4c72587e197d5e7bedf6be53c2eb845cef128bf3a5c48789b0b8dd94`；
收据 SHA256：`1971864e0cdf8404384d0e2113a2585912cf2a79f549961e1a1a9e5cabd2f981`。
这说明本轮未复现先前安全评测的调用失败，不证明间歇性流式错误/超时已经消失。
按 ADR-0032 仅为内部原型 scoped evidence，不是 baseline、DCP 或人工质量认证。
旧 baseline 的模型、数据集与配置不同，不计算 Δpp，不更新 baseline。

### 最新原 11 条回归：10 条通过，1 条 Coverage 不完整

`.data/diagnostics/replay-baseline-bound-11.json`：11 条全部执行、10 条保留。
第 15 条比例句中文化与复审通过，保持泛指准确性与成本分母，没有指定为邻近模型。
保留的 10 条中文检查、审计绑定、quote/content ID/citation ref/locator 不变检查均通过。

第 17 条在翻译前收到 Coverage 不完整响应，被 `self_contained_unavailable` 拒绝，
重要性锚点随之失效。这不是新比例预检拒绝，也不是译文失败。
脚本没有抛出的异常，但 telemetry 明确记录 Coverage **1 次失败**，不能用输出中的 `errors=0`
宣称无调用失败：21 次 Coverage 中 20 次 completed、1 次 incomplete（output stop reason 为 other），
失败调用未完成 function arguments。没有足够证据认定为 token 用尽，未调整 token 或重试预算。

- 耗时约 80.4 秒，52 次逻辑调用，成本估算 $0.840061。
- 文件 SHA256：`f9750c331077ecf168dd80bf93afbf1eba559e4efc34ae0db2822d2dcefe0ba9`。
- reader-language/analyzer 指纹与最终定向运行相同；输入仍是只读历史导出，不是共享 live SQLite。
- 没有重写历史日报或通知，没有生产配置改动、PR、提交、推送、合并或部署；主工作区干净。

### 本轮收口与剩余阻塞

已完成验收规则、最小实现、反例、两轮独立评审及其修复、调用失败诊断和预定评测尝试。
`eval-gate` 与 L2 的失败回归禁合并规则仍阻止后续 PR/CI/发布：

1. 正确的显式相对基线/括号参照表达仍会被语义 primary 拒绝，不能通过放宽必要条件直接接受。
2. 最终定向 43 项未完整执行；历史重放也因一次 Coverage incomplete 未达到 11/11。
3. 本轮先后的 error、timeout、incomplete 不是同一种已证实根因；原型安全评测无失败不代表传输稳定性已修复。

下一步应分开处理：先对两个正确比例表达核对等价判据及主审提示的歧义；再针对 Coverage 的
失败类别做受控诊断（优先保留 terminal/incomplete 原因等脱敏字段），不增加自动重试、不降低证据门槛。
有实质修复后再执行一次固定完整验证计划，不为获得绿灯而重复同版本评测。

## 本轮定向修复与验证（2026-09-26 后续）

### 等价判据修正

先以 6 个固定用例做 before：两条正例 1 条通过、1 条被 primary 拒绝，4 条负例全部拒绝。
定位到 shared rule 将“保持X%的准确率必须拒绝”写成无条件句，可能忽略译文前置或括号中的分母。
改为按完整译文判断：只有译文未提供分母才拒绝；明确的相对参照仍须原文支持，
“在基线实验中”这样的背景词不能当作比例分母，绝对准确率也不能改成相对值。
不改变 deterministic guard、quote-only 输入或任何模型/thinking/token/重试配置。

固定 3 次 after：两条正例 **6/6** 通过，4 类负例 **12/12** 拒绝；历史第 17 条原 quote/locator
的 Coverage 检查 **3/3** 支持，所有调用无失败。不是持续稳定性保证，也不替代全量回归。

- before：`.data/diagnostics/ratio-focus-before.json`，SHA256
  `57b120b4ee31b999be8bbbf715287a8a157e7b511c94b9ada7439a325f259e75`，成本估算 $0.155439。
- after：`.data/diagnostics/ratio-focus-after.json`，SHA256
  `9a18f3ed1db5ef319ddba858150f690f715966e649d557666c56326ab19b80c7`，成本估算 $0.600764。

### 诊断改进（不改变接受或重试策略）

- `invalid_json` 与提供商 `error` 终态分开；只保存固定标签，不保存 SSE 内容。
- incomplete 原因即使没有 usage 也进入统计；未知原因仍为 `other`，未报告原因为 `incomplete`，
  不伪造 token/费用，不把未知原因改标为 token 不足。
- 完成流后的 schema 拒绝记录 `completed_invalid_schema`，不再只能看到 `primary_unavailable`。
  usage 仍被保留，不增加重试、不放宽结构化输出校验。
- probe 的 terminal 类型复用生产 adapter 类型，补兼容与隐私测试。

### 45 项中间运行与独立评审

`evals/out/reader-ratios-reference-context.json` 完成 45 项，43 项符合预期。
16 个负例全部拒绝；两条原先误拒绝的参照表达通过。但 `cost-saving` 正例被拒绝，
`bounded-denominator-good` 因一次 primary 调用失败未通过。
后者 telemetry 显示 completed + function arguments done、无 stream/HTTP failure，
结合该版本运行路径定位为完成响应后的结构化 schema 校验失败，不是 API key 加载或网络超时。
旧运行尚没有新增 schema 标签，不回填伪造原始诊断。

- 耗时约 219.2 秒，成本估算 $1.343344。
- SHA256：`24441dc7def3eaad1eb2da0a4ddc2c7165ac5b7f693999511c34be8d5ee0a302`。

独立 review 第 1 轮 Warning 1：泛指准确性 + 显式后置“Orion 原有成本”被全句剩余文本检查误拦。
修复为保留已匹配指标的必要条件，但存在其他未解析指标时不做全句 remainder 否决；
新增正确混合分母和具名对象混入准确性分母的成对测试。
第 2 轮独立限定代码复查为 **Blocking 0、Warning 0**，确认混合分母及 schema 诊断修复；
这不是 Eval-Gate 放行或最终提示修改的独立背书。

### 节省比例的补充修正

对 `saves X% of the cost` / `loses X% of accuracy`，明确忠实译为节省/损失原有量的比例，
不适用“禁止把剩余量擅自换算为升降幅”的拒绝条件。仍禁止把 `at X% of cost` 写成降低 X%。
该提示补充发生在上述限定代码复查后；没有宣称 reviewer 已复核这个后续修改。
固定 3 次检查：正确节省/占比 **6/6** 通过，错误占比→降幅 **3/3** 拒绝，调用无失败。

`.data/diagnostics/cost-focus.json` SHA256：
`db04017e57ee1ef52829e424f88a20f814fbfb84915a2c9f42184786beb45996`，成本估算 $0.294730。

最终生产代码冻结后，本地 **14 文件、428 项测试通过**，TS7/TS6 typecheck、ESLint、diff 检查通过。
接下来执行固定 47 项（45 项加混合分母正反例）、原 11 条及 prototype-safety；
所有中间失败保留，不重跑同版本挑选通过结果，不用历史通过代替最终版本证据。

### 冻结版本 47 项：执行故障，不是质量通过

`evals/out/reader-ratios-release-candidate.json`：前 8 项正常，第 9 项 timeout；此后三角色大量
native `fetch failed`，没有 HTTP 状态或 SSE terminal，后续调用多为 1–2 毫秒即失败。
共走完 47 个计划用例，29 项不符预期，role telemetry 记录 62 次调用失败。
部分负例的 deterministic 拒绝仍符合预期，但其 Coverage 不可用，绝不能据此宣称安全评测完整。
运行耗时约 226.8 秒；已记录成本估算 $0.225665，不能将失败但未返回 usage 的调用视为零计费保证。

SHA256：`f50b1f2f7451bd487438f5afe5ad602352bc5901b72a3ad1df56f1d2ec90275c`。
这轮已明确失败，不能用于发布。随后暂停历史重放和 prototype-safety，先排查执行环境。

匿名 curl 与新 Node 24 进程对 Ark 返回预期 401、GitHub 返回 200；这只是连通性检查，
不是 key 验证。再以生产 `callStructured` 对三模型各做一次合成布尔请求，均成功：
analyzer 960ms、validator 1722ms、coverage 1028ms，无失败，成本估算 $0.008635。
说明恢复检查时 key 与模型可用；不能据此确定上一进程连续 fetch 失败的底层原因。

恢复检查：`.data/diagnostics/transport-recovery.json`，SHA256：
`67975cddc2e629e02d5b9e420d5511e85e7e95783bd4cff76785d21f4627ec40`。
基于已完成的恢复检查，额外安排**一次**独立完整验证（单独产物，不合并、覆盖旧结果），
用于确认恢复后的执行状态；若再失败，停止后续发布，不重复尝试取得绿灯。
这不是修改阈值或擦除语义失败，故障轮次永久保留，全部结果一同交接。

冻结版本指纹：

- reader-language：`7b6860468e4aaff8d8a949121391a8e96615351fe30236b59703f26ab79b4422`。
- analyzer：`5d99bd2e24ec01faff8e077cf319bbb67214f25a596ec4cf60ca7647be8c03dc`。
- llm：`3af53f352232c2609f99f514f208ff6b22fa38977bcffc3a1ac43e3d6dc3a211`。
- volcengine-responses：`9f89801716f4b06f2dd89e035f6a110dadb6ffcfecd9c5372aac785b2b938313`。

### 唯一恢复验证：45/47，2 次执行失败，停止发布

`evals/out/reader-ratios-recovery-verification.json`，退出码 1。
47 项全部尝试完成，45 项符合预期；17 个负例均拒绝、unsafe_accept=0。
两条显式参照正例、成本节省正例及新混合后置分母正例均通过；不能据此保证所有未来表达稳定。

| 未通过用例 | 受控原因 | 当前证据 |
|---|---|---|
| cost-share-good | primary_unavailable | validator 约 39.7 秒后失败，无 HTTP/SSE 终态；不是 judge_not_supported，也不是已确认的 schema 错误 |
| mixed-loss-share | self_contained_unavailable | Coverage 返回 incomplete，reason=other，未完成 function arguments；不能推断为 token 不足 |

90 次逻辑调用（validator 38、Coverage 47、analyzer 5），2 次失败，未增加重试。
耗时约 310.9 秒，记录成本估算 $1.425127（失败且无 usage 的调用费用未知）。
产物 SHA256：`2362be1158e74e5c5d5a54a3764180e0ab282b8ff4a7d85013542f29fddf54bb`。
production source 指纹与上节冻结版本一致，没有边跑边改。

本轮另执行完整 `npm test`：**203 个文件、1,929 项 Vitest 测试通过**，以及 **14 项 Node 运维测试通过**。
此前最终 typecheck（TS7/TS6）、受影响文件 ESLint 和 diff 检查通过。
这些确定性证据不能覆盖上述真实调用失败。

按恢复前约定，不再执行第三次同版本完整验证；暂停后续历史 11 条、prototype-safety、PR、CI、合并、部署。
旧 prototype-safety 收据与历史重放不用于为当前提示版本盖章。没有变更生产、改写历史报告、推送或提交；
修改留在 `fix/reader-ratio-semantics`，主工作区仍干净。

**下一步只集中排查调用失败**：补齐 native fetch 的受控底层 cause 分类（DNS/TLS/连接/超时等），
并结合提供商日志核对 incomplete 的实际原因；必要时做固定小样本的连接恢复对照。
现有记录不能确定连续快速 fetch 失败的根因，不能贸然归咎 key 失效、增加 token、扩大重试或更换模型。
不再继续调整已经通过本轮有效语义检查的比例规则；待执行稳定性有明确证据后再恢复完整验证。

## 2026-09-27：受控传输诊断与固定恢复对照

用户授权按诊断、小样本、同步主干、验证顺序继续。增加 `transport-diagnostics.ts`：
有界遍历 cause/AggregateError，仅输出固定 transport_ 分类，沿用 provider_stream_failures 聚合字段；
区分 DNS、TLS、连接、超时、客户端关闭、参数错误、取消、未知传输。没有改变重试、预算、
模型、thinking、比例 prompt 或判定门。原始异常仍按原路径抛出；聚合证据不保存原始错误字段。
未知 incomplete 继续记为 other，不把它猜成 token 不足。47 项 runner 的指纹补入 runtime 及新分类器。

固定的小样本实验（全部经过生产 callStructured；仅合成输入，不作发布质量证据）：

| 实验 | 结果 | 产物 SHA256 | 记录费用估算 |
|---|---|---|---|
| 同进程调用三角色 → 主动取消一次 validator → 再调用三角色 | 六次正常调用成功，主动取消被正确分类；取消后未出现连续 fetch 失败 | `56a0752f024471e6438a0af39a04dcbb960e188cae51372490741f86720a8986` | $0.017701 |
| 新进程调用三角色 | 3/3 成功 | `766d16fdc57263b83cbd2d704b927be633b2f49a046d6079ee9dc960cac70eed` | $0.008913 |
| cost-share-good / mixed-loss-share，各固定三次 | 6/6 支持，12 次调用无失败，未收到 incomplete | `805b21c0cd65f483ab6a5d2e87c23209c5bcb6fea2acedcd5db219d94efe81ed` | $0.192080 |

产物分别为 `.data/diagnostics/transport-sequence-reuse-20260927.json`、
`transport-sequence-fresh-20260927.json`、`transport-cases-20260927.json`，均仅本地保存。
最后一项有只读 SSE 观察器，只保留原因类型和固定白名单命中；原字节继续交生产解析器。
所有金额为 fallback 估算；主动取消后未返回 usage 的费用未知。

结论仅为**本轮未复现旧故障**：不能证明旧根因已修复，也不能凭短连接实验保证长调用可靠。
旧 incomplete 的具体原因已被旧版归一化丢失；本轮没有新事件可核对，不回填臆测。

`git fetch origin --prune` 后，确认 #355 仅修改不重叠文件，分支已 fast-forward 到 `00c9a7a`；
未提交修改完整保留。全量 `npm test` 为 **205 文件、1,985 项 Vitest + 14 项运维测试通过**；
TS7/TS6 typecheck、受影响文件 ESLint、diff 检查通过。

基于新诊断和以上固定对照，仅安排一次完整 47 项验证，输出
`evals/out/reader-ratios-transport-diagnostic-20260927.json`；不覆盖或合并此前失败记录。
本轮已观察到 negated-explanation 被正常完成调用的 Coverage 判为 quote_not_self_contained，
与此前的调用失败分开记录；完整结果及独立 review 待下节补充。

### 完整验证与独立审查结果

上述 47 项固定轮已结束，退出码 1：**46/47 符合 runner 预期**，17/17 负例拒绝，
5/5 实际生成译文通过。90 次请求（validator 38、Coverage 47、analyzer 5）均完成，
无执行失败、无重试。耗时约 217.84 秒，记录费用估算 $1.380421。
产物 SHA256：`9e78bea72fa16d182a55174626a4ba96f6784fc3e2dde9b9694744765cd7d019`。
原 prompt、analyzer、adapter 指纹与上一轮一致，新增 runtime 诊断和 runner 源码指纹已绑定到产物；
运行中未修改生产或评测代码。结果不覆盖此前任何轮次，也不表示旧故障根因被修复。

独立 pre-pr review（新上下文）结论：**生产代码 Blocking 0；Warning 1 待处理；发布证据未通过**。
独立运行相关 8 文件 174 项测试及 diff 检查通过。没有发现遥测泄漏、新增重试、白名单旁路或
quote-only 覆盖主拒绝的生产代码问题。

Warning：`check-reader-ratios.ts` 把 explanation 全部置为 expected=true，且把 parser fixture 的
`rejected=false` 直接映射到 expected=true，最终却以 `check.covered`（primary AND quote-only）评分。
确定性预检不拒绝只表示交回语义门；忠实翻译也不自动证明原 quote 可独立理解。
例如 negated-explanation 忠实保留“比例不等于绝对准确率”，但 source 未说明比较基线；
现有 quote-only 契约要求读者仅凭 quote 识别比较基线。因此本次差异首先是评测预期混用问题，
不能直接命名为翻译回归或 Coverage 误拒绝，更不能通过翻转旧预期、放宽 Coverage 或反复重跑取绿。

按 eval-gate，本轮停止历史 11 条、prototype-safety、PR/CI、合并和部署；没有提交或推送。
主工作区保持干净，任务工作区保留未提交代码和全部本地证据。

后续顺序：

1. 保留这轮原始结果，设计并独立审定 fixture 的三个维度：翻译等价、quote 自足性、组合接受。
   不再把 parser unit fixture 的放行边界当作发布质量标签；未知/有争议标签必须显式待定。
2. 测试应分别暴露各门的真实结果和执行状态，不能从 Coverage 拒绝反推 primary 是否正确，
   也不能把执行失败当作质量拒绝。补反例并独立 review 评测契约。
3. 新版评测单独留痕，不与旧 47 项混比；通过后再恢复历史重放及 prototype-safety。
   不修改模型、thinking、token、重试或引用安全边界作为本问题的绕过方案。
