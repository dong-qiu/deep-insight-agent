# TD-10 独立 followup 显式任务控制收据

基线 `81dac77cd27f82d7b554694bf0a12cd82cd0920b`；协调者独占本切片，
隔离 worktree `insight-agent-refactor-coord-20261008`，端口3110、独立DB/DATA。
执行 [冻结 spec](../plan/specs/c2c-followup-task-control.md)。不复制live库或其他Session未提交代码。

真实 `answerFollowup` 支持显式signal/absolute deadline/可选兼容估价额度/caller ownership检查。
生成与并行judge共用取消；生成后、缓存构造（会DELETE过期行）、cache.set和返回前检查控制状态。
普通judge异常仍按原规则降级；控制故障不能吞成成功；先观察的取消原因保持，ownership优先。
预算观察生成的每次onCost回调；返回费用仍使用原gen.cost，不把重试回调改写成新的结果费用口径。
judge保持既有费用回调；非有限provider估价保持未知，遵循C2b未知继续边界。
临时预算身份只在内存，不创建Run/attempt或修改schema；已有父withTaskBudget继续继承，子额度不覆盖。
覆盖面是没有UsageJob的独立函数；嵌套Job记账、HTTP保存/audit、维护准入与迟到route提交不由本片保证。
不新增默认deadline、默认额度或HTTP断开行为，不提供全局/真实账单上界，也不能撤回已发送工作/费用。

## 实际验证

Node24.19.0/npm11.17.0；所有模型/网络为合成或fake fetch，无真实模型或生产访问。
11文件179测试通过：followup原6、专属控制15、真实SDK接线6，以及C2a/C2b/validator/cache实际回归。
TS7/TS6 app/tools与全仓lint通过。生产build在临时移开.env.local、清空ambient凭据并设置独立
DB/DATA后通过；验证期间配置0600，build结束恢复原位置。新增SDK测试与未知估价细节完成后
最终受审head/build及CI需重新绑定，先前build只为先前源码证据，不冒称最新head结果。

专属控制测试整mock callStructured，证明真实followup/validator控制调用；另外6项integration
执行真实followup→callStructured→Anthropic SDK→fake fetch，零外网，覆盖足额/缺省结果与费用、
0/生成触顶零judge transport、底层signal与不合作迟到响应、未知估价、父额度继承。
固定system/user/schema/maxTokens的缺省/足额比较，原support/not_support/普通故障降级回归通过。
并行已发sibling触顶后不写缓存/不复活结果；不宣称所有底层费用已收齐或全writer静默。

首次18项测试发现同时fence/cancel时取消遮蔽fence，已修入口catch重新核ownership并补反例。
原失败日志与修后179项日志分别保留，不skip/xfail、不改timeout、阈值或prompt。
私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/refactor-coordination-20261008-185052/coord/`，
目录0700、文件0600；最终index含源码、日志size/hash与commit，原证据不覆盖。

## 质量门与交付

协调者完整使用 [eval-gate](../../.agents/skills/eval-gate/SKILL.md) 和
[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。最终diff只添加可选控制与失败路径，
未改变模型/provider/thinking、prompt/schema、引用池、语义判断、缓存版本或正常并发/retry参数。
A1不执行本独立followup路径，不以它替代实际控制回归；本阶段真实预算0，未运行真实模型评测。
最终独立review与精确受审head验证后才能签Eval-Gate纯控制skip，不预签质量通过。

方案独立review三项Warning（cache构造隐式写、catch不能吞控制、生成成本不重复）均落实；
实施review新增两项要求（真实SDK接线、父预算继承）已补代码反例与边界。最终head复核尚待完成，
PR/tested merge/main CI绑定记录在PR摘要，由协调者核最新主干后按授权条件合入。

TD-10本阶段只完成本函数显式控制切片，整体仍部分；collection、HTTP组合根、全writer/fencing及
全局真实成本上界未证明。无历史数据变化，回退只撤回控制能力，不能删除既有事实或自动恢复工作。
safe_rollback=null、deployment blocked与#435硬阻断不变，无生产/模型/清理授权继承。
