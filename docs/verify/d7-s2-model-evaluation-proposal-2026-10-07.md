# D7 S2 真模型验证申请（尚未授权/未执行）

当前预算0，真实模型请求0。Source/event改变请求身份，因此确定性回归不能代替AI质量证据。
当前专业建议：保持0调用，先确认实际provider额度/费用上限并验证下述计数和中止守卫，再申请专项授权。
100次请求和45分钟仅为待确认的执行上限，不等价于已获授权或费用硬上限。
依据 [L3](../../skills/L3-quality.md)、[当前评测口径](eval-criteria.md#内部原型适用范围)及
[eval-gate](../../.agents/skills/eval-gate/SKILL.md)，产品仍为已认证内部prototype。
下列是建议的最小专项验证；不是擅自缩减正式A1，更不建立可比baseline/DCP/人评结论。

## 建议的必要范围

1. 原样执行仓库既有 `npm run eval:a1:prototype-safety`：1个质量主题、12个一致性pair、14个display用例（9 reject + 5 accept）、8个quote-only用例（4 reject + 4 accept）。
   沿用 `a1-prototype-safety-config.ts` 的固定ID清单、原数据及原判断门，不改选样配置；必须覆盖support/uncertain及三种not_support，完整执行、display/quote unsafe_accept均0。
2. 补身份诊断：从相同固定输入独立比较旧/新Source和历史event身份，运行真实analyze→coverage→validator。
   两种Source长度、两种历史event长度各形成2×2的4个固定case。执行前冻结同一正文及历史陈述的合成输入和摘要；
   Source取`src_feed_abcd`或`src_feed_`加32个`a`，历史event取`evt_batch_abcd1234_0`或`evt_batch_`加32个`a`加`_0`。
   每case核对请求仅有指定身份替换；有输出时所有citation必须精确绑定同一输入及原文，复用event必须精确属于该case历史白名单；
   新事件按原规则派生，不得串入其他case的event/candidate/audit。无显著事件响应仅证明该case未产生输出，不冒称关联分支覆盖。
   未知event拒绝由已有确定性反例证明；真实响应若未产生未知ID，记录“未观测到该分支”，不能宣称真实模型覆盖。
   输入正文/Topic语义及model/provider/thinking/prompt相同；仅实例ID按已审计公式替换，原dataset文件不改。
   该4-case诊断不能独立证明统计质量等价、≥50组事件对齐准确率或正式准入；任何错绑、其他不一致或unsafe_accept保持阻塞，不自动扩样重跑。

正式完整A1现有默认集为5质量主题、121一致性pair、43display、8quote-only。与baseline配置/数据/来源分段可比性须按原规则核验；
不能把上述prototype receipt填入正式指标列，不更改baseline或阈值。完整正式评测需要另一次明确预算授权。

## 请求、重试及时间的硬边界

- 建议全任务合计最多100次实际provider HTTP尝试，包含首次、SDK/application重试、拒答拆批及coverage内部请求；不是仅计logical calls。
- 重试尝试累计最多20次，且计入100次总额；现有单调用retry配置不放宽、不改模型/参数。
- 授权后由操作者确认开始时间 `T0`，在 `[T0,T0+45分钟]` 内执行；不自动恢复checkpoint或重开失败运行。
- 必须先实现并以合成transport测试验证独占eval harness的实际fetch计数、retry计数、AbortSignal墙钟与sticky incomplete守卫，再发任何真实请求。
  到上限前拒绝下一fetch；到截止时中止在途。部分执行/取消/超限均不产通过章。当前未实现这个guard，不能直接裸跑上述npm脚本。
- 配置冻结为当时worktree的既有model/provider/thinking等有效配置；不打印key/endpoint/env正文，不通过换模型减费。

费用/额度未知，现有Coding Plan金额不可核实；100请求不等价于美元或token上限，取消前已发送请求仍可能计费。
授权须包含对该额度风险的接受；若需要金额硬上限，先取得provider可信计费/额度约束，再执行。
没有该授权时继续零调用，保留未验收和源码push门阻塞；不设EVAL_GATE_ACK、不伪签skip/pass/scoped。
