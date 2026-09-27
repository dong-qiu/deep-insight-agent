# 日报失败诊断与中文结论守卫

## 范围

内部原型的小范围修复；不更换模型、不调整 Coverage thinking/token 预算、不放宽引用门槛。
历史失败不伪回填：2026-09-25 产业日报留下了 14 候选全拒绝的异常，但无对应批次审计；
旧容器已替换，现存 json-file 日志不覆盖该时段，不能确定逐条拒绝根因。

## 验收标准

1. 生产 `runAnalysis` 的缓存 miss 与全量路径均收集候选诊断；成功和失败均落独立的
   `analysis_coverage_diagnostics` revision，与同 trace 的既有 `analyze/completed` 或 `analyze/failed`
   事件在同一事务写入并通过 output_refs 关联；不新增事件类型或数据库迁移。
   只保存受控终态/原因码、翻译阶段枚举、候选 ID 的哈希、前后审计及 prompt 哈希和计数；不保存 claim/quote/body、
   evidence excerpt、未受控错误文本或完整 audit JSON。没有诊断时不伪造记录。
2. 写入仍受 dispatch fencing 保护；失败不得生成成功 batch/report，不得覆盖原失败信号。
   诊断记录不参与 publication whitelist，也不把缺失历史记录宣称为 complete。
3. 中文主题的纯非中文结论不能直接发布。先按原门审计原 claim，仅对已通过的非中文
   claim 使用 analyzer 模型做一次有界中文改写（最多 1024 输出 token，无上层递归重试）。
   正常中文、英文及 mixed 主题不增加此调用。
4. 改写不得修改绑定 quote、locator、来源、数值或范围；改写后必须重新通过原有稳定 token、
   原子绑定、primary + independent Coverage 及重要性锚点检查。译文 primary 还接收转义后的原始 claim，
   同时判定事实等价；原始 claim 不是支持证据，不能补足 quote。独立 quote-only Coverage 输入不变。
   事实改换、删除限定或扩写均拒绝，失败不回退英文。
   原始未通过的 claim 不得借翻译被修好后发布。保留改写前后哈希和复核证据。
5. 首版语言检查只可靠检测“完全没有汉字”的结论，不声称解决所有混合语言/翻译质量问题；
   不能用该机械检查代替事实审计。专名与数字可保留英文。
6. 输出/缓存版本升级，使旧英文结论缓存不能继续复用。既有历史报告不原地重写。
7. 回归覆盖：全拒绝仍可诊断、部分记录后异常、租约失效、敏感文本不落诊断、正常路径无额外调用、
   改写成功、仍为英文、语义扩张、原始主张不支持、超时与取消、引用不变、读者审计哈希一致。
8. 运行受影响测试、typecheck，以及生产同 provider/model/thinking/token 配置的 prototype-safety；
   补真实模型的中文改写定向检查。小样本不声明完整 baseline/DCP，人评与上线验收独立。

## 相关契约

### 比例语义补充（2026-09-26）

- 中文修复和译文 primary 等价检查必须区分：准确性的保留比例与绝对准确率、
  剩余成本比例与成本降幅、相对百分比与百分点。即使数字相同，改变分母/关系/单位也拒绝。
- quote 或上下文未明确比较基线时，不能根据邻近模型名猜测分母，更不能声称原始准确率是 100%。
  明确给出的绝对准确率/成本降幅/百分点应正常保留，避免把所有比例一概拒绝。
- 使用成对的合成正反例测试以及真实模型定向 before/after；原文 quote、locator、来源引用不变。
  拒绝反例必须能归因于 primary 或确定性预检，不能把 Coverage 不可用/拒绝当作译文主审正确。
- 本补充不改变 quote-only Coverage 的输入、判定、thinking、预算、重试或缓存；其同输入波动另行诊断。
  更新 analyzer 输出缓存版本使新生成路径不复用旧翻译；历史报告和既有审计不原地重写。
- 原始案例证明仅加 prompt 仍会接受“保持了X%的准确率”。对英文明确的
  `keeps/retains/preserves X% of [the/original/baseline] accuracy` 与中文明确绝对准确率形式，
  在译文 primary 前增加有界确定性分母检查，记录 `translation_ratio_denominator_lost`。
  独立 quote-only Coverage 继续执行且不能覆盖该拒绝；其他措辞仍交语义门，不声称通用比例解析。
  确定性检查只处理单一准确性指标、无否定/解释标记的明确句式；不同主体/多指标或否定解释
  必须交回 primary 而非直接拒绝，且不得因此跳过语义门放行。
  译文含显式相对参照（含括号中的基线说明）时也交回 primary，不凭绝对形式子串强判分母丢失。
  primary 也必须按完整译文判断：前置“相对于基线”或括号“以基线为参照”可明确百分比的分母，
  不得截取“准确率为X%”就否决。原文仍必须支持该相对关系；仅有“在基线实验中”背景描述不算分母。
  对原文明示的 saves/loses 比例，应允许忠实译为节省/损失原有成本/准确性的比例；
  不得把“禁止将剩余量擅自换算成降幅”扩大成禁止原文直接给出的节省/损失关系。
- 未指明基线的有界比例句增加独立必要条件：仅对英文单一指标的
  `retain/keep/preserve N% of [the/original] accuracy`（含进行时）与
  `at N% of [the/original] cost`，且没有比较、否定、解释或多主体标记的句子启用。
  指标后必须是句末、标点或 at/and 连接；后置 `of Orion`、`achieved by Orion` 等不能按前缀
  误判泛指。损失/节省等其他谓词不适用本预检，继续交语义门。
  同一句有任意泛指比例关系未被该语法解析时，整句交回语义门，不能用已匹配的半句做全句剩余文本检查。
  另有具名/后置分母的未解析指标时，可检查已匹配指标的泛指格式，但不作全句剩余文本否决，
  避免把另一个指标合法的“原有”等修饰误当成新增基线；未解析关系仍须 primary 验证。
  译文应使用可验证的泛指分母形式，例如“保留原有准确性的N%”“成本为原有成本的N%”；
  指代“其”、具名模型或其他无法在该有界格式中确认的分母均保守拒绝，记录
  `translation_ratio_baseline_unverified`，不声称所有拒绝均是事实矛盾。
  按指标分别验证，不把成本的显式对象当作准确性的对象。原文明示 comparison/baseline、
  否定解释或多指标/多主体结构仍由语义门判断，不能根据邻近模型名自动放行。
  符合格式也只是必要条件，仍须 primary 与独立 Coverage 同时通过；不增加 LLM 调用或重试。
  验收覆盖：路由目标冒充分母、代词分母、具名对象混入泛指短语、正确泛指、显式前置/后置比较、
  部分指标具名、否定解释、多主体、数字边界、非翻译路径不受影响。

### 流式失败诊断补充

- 区分解析失败 `invalid_json` 与提供商 `error` 终态，只存代码控制的原因标签，不记录事件正文。
- `incomplete` 的受控原因与 usage 是否存在无关；无 usage 也记录原因，但不虚构 token/费用。
- 完成流后仍不能通过结构化 schema 的响应，记录 `completed_invalid_schema`，与传输失败区分。
- 不新增重试、不改变失败关闭或 token/thinking 设置。旧记录不回填推断原因。
- incomplete 诊断仅增加固定原因白名单（含 content_filter）、reason 的 missing/string/invalid 形状、
  content_filter 对象是否存在，以及 usage 对象是否存在和实际返回的非负安全整数 input/output/reasoning tokens。
  不保存过滤详情、未知 reason 文本、响应/请求 ID；缺失 token 保持缺失，不解释为零。
  过滤对象存在不等于已确认过滤根因；token 数接近预算也不能单独证明截断原因。
  每角色/阶段最多保存最先 16 个脱敏 incomplete 观测，另计溢出数；写入与读出均重新投影。
  定向诊断通过本地 attempt 序号、时间、输入/prompt hash 关联，不可用于提供商工单精确检索。
- native fetch / reader 异常增加固定的 DNS、TLS、连接、超时、客户端关闭、参数错误、取消和未知传输分类；
  有界检查嵌套 cause / AggregateError，不持久化原始 message、code、地址或事件正文。
  沿用 provider_stream_failures 聚合字段，transport_ 前缀与 SSE 终态区分；仅作诊断，不参与重试决策。
  验收包含未知/伪造 code、循环 cause、复合错误、取消与超时，以及分类后请求次数不增加。

### 比例定向评测分维度（2026-09-27）

- 原 47 项单标签结果永久保留，新版契约独立版本化，不能与旧通过率直接比较。
- 分别记录译文等价的人工/独立审定标签、翻译主审（证据支持 AND 等价）的实际结论、
  quote-only 自足结论和最终组合接受。主审并非纯翻译分类器，不得把主审拒绝都叫翻译错误。
- 生产验证函数返回合并 Coverage 前的只读主审摘要（claim_id/supports/reason），不增加调用，
  不改变 prompt、白名单、缓存版本或接受逻辑；摘要不带正文和 evidence，现有持久化结构不变。
- 每个维度独立标注 true/false/pending 及依据。parser 的 rejected=false 只代表预检交回语义门，
  不得作为主审或组合接受的标签。泛指基线契约有争议时显式 pending，不得静默计作通过。
- 新增明确自足与明确缺少上下文的成对合成样本，覆盖“忠实翻译但引用不自足”；
  独立 reviewer 在不看运行结果的情况下复核标签，冻结后再跑一次定向真模型验证。
- 报告分开统计各维度已标注数量、正确/错误、pending、执行失败；pending 不计入正确率，
  不声称全量标签闭合。执行/响应契约失败不能计为语义拒绝，即使组合门已安全关闭。
- 测试验证主审结果不被 Coverage 覆盖、主拒绝不能被 Coverage 支持掩盖、任一角色故障阻断，
  以及未知标签和缺失观测不产生成功结论。新评测仍不替代 prototype-safety 或 baseline/DCP。
- 用户选择保持现有规则、争议样本待定且不作为发布通过证据。默认只运行所有维度已审定的
  固定子集；产物显式列出全量清单、选中清单、pending及其依据，设置 publication_ready=false、
  promotable=false。子集通过只能称 scoped evidence，不能称旧47项通过或全标签闭合。
  可显式运行包含 pending 的诊断模式，但该模式存在 pending 时不得退出为通过。

这是 `report-quality-review-trace.md` 的失败路径补充：诊断只用于管理员复盘，非完整 LLM 重放。
中文结论是经审计的 reader_statement；statement 继续保留绑定原文，原文不是翻译结果。
