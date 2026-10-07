# Daily Brief Wave 1：离线准备切片

日期：2026-10-07。承接 [Daily Brief 总规格](daily-brief-rich-insight-freshness.md) 的 T03/T04、F 与 I 准备工作。本切片不解锁正式提取、正式留出、阅读卡评测或生产启用。

## 接口与范围

F 保持已冻结的 `createForwardJournal`、`appendForwardEvent`、`readForwardJournal`、`assembleForwardClocks` 接口；来源、版本、正文、run、attempt 和资源 hash 必须绑定。完整行为与冻结收据见 [F 工程记录](../../verify/daily-brief-wave1-forward-clocks-2026-10-07.md)。成功采集仅提供本次观察；来源首次可获取、终身首次采集和读者打开时间缺证据时保持 unknown。采集与分析使用独立分母，所有失败及成本未知保留。

C1 仅交付未接线的 `ShadowRequestBudget` 纯离线工具。每个臂分别持有实例，构造参数为 arm ID、冻结协议 SHA-256、请求/token/USD 微单位/时间上限。`reserve` 在请求发出前登记请求 ID、操作、输入 hash、可证明上限的证据 hash 和 token/费用上限；未结算请求一直占用完整预留。`settle` 接受带回执 hash 的已知成本，或明确 unknown；不能改写终态。未知或非法终态、超限、超时均停止继续预留并取消 signal。取消后允许补入真实终态，保留尝试分母。限额不可因调用者修改原配置或公开 getter 而改变。空 ledger 的状态为 not_executed。

工具只检查结构、整数费用算术和控制流，不能证明传入 hash 的证据真实性，也没有调用 provider/SDK、检查实际价目、拦截 SDK 重试或写入 DB 的入口。未来 runner 必须证明每次 transport 请求的上限，覆盖拆批、修复、validator 与重试，再在每次实际 dispatch 前调用守卫。未完成这些接线前，不能声称已经控制正式运行成本。具体正式限额与停止规则仍待 T03 后冻结的 T04，测试中的数值仅为合成边界用例。

I 只交付独立人评材料的版本和结构核查记录，见 [I 准备记录](../../verify/daily-brief-wave1-I-review-2026-10-07.md)。历史 validator pass 与当前语义未知分开；来源明确影响与我们的条件性判断分别定位。AI 材料审查不替代人工裁决或实际理解试测。

所有新原文、快照、配置、收据与人评材料保留在 gitignored 私有目录；本切片只提交工具、合成测试及不含原文的规格/验证记录。共享 schema、analyzer、validator 和 report-gen 不在本切片改动范围。

## 切片完成门

- F 按精确资源重放，覆盖成功/失败、阶段顺序、版本漂移、UTC 边界、权限与 symlink、正文与发布产物绑定；unknown 不补成首钟或零成本。
- 预算覆盖并发预留、已知终态释放、失败未知、非法终态、费用精度、上限违约、终态不可重写、不可变限额、取消与超时；臂之间独立记账。
- 运行 F、已有 freshness 与预算的受影响测试、`npm run typecheck`、lint；最终 diff 经非作者 pre-pr-ai-review，PR CI 通过后才合入。
- 按 eval-gate 真实路径分类：本切片没有 prompt、模型、来源适配器、校验语义或评测集变更，不运行 A1、不声称 AI 质量通过，也不使用纯重构 skip 冒签新功能。

## 后续门保持原状态

23 个版本的 T03 人工金标、来源家族终核和 T04 尚未完成。C1 旧预检四项阻断仍保留；共享 analyzer shadow 接口另行走真实默认 A1 与候选实验门。正式新留出只能在 T04 冻结后从未见来源家族的前瞻窗口开启。B1 保持 no-go，#360 不构成生产准入。P/C/I/F 的探索收益不能互相代证；部署与生产开关需另行获得授权。
