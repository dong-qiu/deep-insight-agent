# Daily Brief Wave 1：I 独立人评材料准备

日期：2026-10-07。状态：非作者材料核查完成，仅可交人工评阅；human pending；publish/action false。

本次只制作旧 I shadow 三项判断的独立人评材料，不运行模型、不改旧包、不签 human gold、不解锁发布或试验。负责人授权的全部 23 版独立盲读先封存，随后才读取 I 原件；任何盲读结果均未据此修订。

## 输入与版本边界

只读 cleanup 归档中 implications/run-v2 的 selected-premises、analysis-judgment-candidates、I-human-review-worklist 三个原件，逐件与归档 manifest 对照。manifest SHA-256 为 `d162f960836a2b6db87ff3ecfbfcc698ca3f5345321f6cbe03273d75d2694e68`。三原件 SHA-256 依次为：

- `57e0a5f46c26f038f2b8987edc0c394687223bbdad1036fc9654b169368ce659`
- `1841f2cf613fe01f8d8cf74f6e4391906f27b713fbd33ee68dcdb26a9ff93601`
- `c14b46325a004e48d89e3ee800fac46b461695f3870eb368f92862ae184f8751`

三项前提对应的完整已存正文分别为 UTF-16 `[0,36798)`、`[0,1782)`、`[0,27787)`。这仅指已存新闻综述或论文摘要，不等于链接网页、榜单或论文全文。原文与证据包只存 gitignored 私有目录，目录 0700、文件 0600，不进入 Git。

## 当前复核与历史保证

在本树 `41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1` 的纯函数上重核 source snapshot/revision、原始归档 hash 与 normalized body、quote 的连续 UTF-16 排他范围、citation/check identity、validation/audit/premise hash、白名单以及 audited reader statement 绑定。三项共 75 个结构检查通过，14 个材料引用 span 均逐字回切通过。

旧 reachability pass、consistency support、v6 display audit 的历史记录可由原件复核；当前语义 support 未重跑，仍为 unknown。原包没有完整的历史 Insight 派生字段，因此 projection 检查采用明确标记的 canonical reconstruction，不能声称重新载入了原始持久 reader metadata。没有建立新的 DB provenance 图，也没有补齐发布历史或 lineage。

首次本地 verifier 错将 envelope 的 structured_body_sha256 解释为 source_item_raw 的 hash；已依据 collector 与 reader-evidence 中的 content_hash 语义修正。错误输出单独保留在准备失败账本，未作为来源差异或旧标签修订。

## 来源观点与我们的判断

逐项全文核查后，一项摘要明确提出狭义诊断建议，已在私有材料中独立定位到精确版本和连续 span。它的范围仅是用廉价诊断阶梯约束小模型工具调用声明，不覆盖材料额外提出的团队权限、采用或团队契约判断，也不继承旧事实前提的 validator pass。

另外两项针对工具比较和完整费用试验的工作建议，在完整已存正文中未找到直接匹配的明确来源建议，保持 unknown。榜单名次、任务费用及邻近比较结果不视为来源对我们工作建议的背书。每项分别列出来源事实、必要限定、我们的假设、目标场景、适用条件、失效条件、验证动作及独立的失败/费用/未知账本。

## 人评与门禁

新材料按证据、逻辑、读者理解三轴提供共 18 个问题；没有答案、预设分数或 gold。所有人类响应和 reviewer 字段为空，材料审查不代表实际读者结果。新模型调用和来源网络请求均为零；历史调用费用和建议试验费用未知，不把来源中的 CPU 分钟或榜单成本当成本次成本。

私有包：`.data/rich-brief-wave1/I-review/human-pack.json`，SHA-256 `3bb8cdd32af80530370248bfc27609b4c0652a76cea5543c22a885ede2586769`；对应 Markdown SHA-256 `edebdd32dbf23fdfda0e50f9b368f909c4386d7730234e7b735570bd3fdb9f8c`。逐件输入回执、当前 binding recheck 与封存清单同目录保存。

独立 I 质量门、human event/importance、读者收益、历史发布/lineage、频率与阅读预算均 pending/unknown；analysis revisit 保持 blocked。非作者 A 已完整重读三份 I 专属正文，独立回切 14 个 span，并在其树上重放 75 个纯结构检查，全部通过；未发现阻塞材料问题。该审查只证明人评材料可供评阅，不签当前语义、重要性或读者收益。审查收据为私有 `I-nonauthor/review.json`，SHA-256 `f0ca0fb6a8c45fda0f8f589507bf8ccb242b34bbd3af2532e82afeb98a4d9c7b`；对应 Markdown SHA-256 `37f9dbeb9bf19444f228a2c58f43904b2531f44d91038ea8646dbaf5da49f2ef`。AI 质量门未执行，不盖 Eval-Gate pass。
