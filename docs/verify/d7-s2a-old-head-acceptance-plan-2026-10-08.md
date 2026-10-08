# TD-20：S2a 旧 head 真实质量缺口的专项验收方案

本专项真实模型预算为 **0**，本文件只交付专项验收准备，未发出真实模型请求。原 [#430](https://github.com/dong-qiu/deep-insight-agent/pull/430)
的真实质量 Blocking 保留，不由 [#438](https://github.com/dong-qiu/deep-insight-agent/pull/438)、新 main CI 或合入授权补签。
依据 [S2 spec](../plan/specs/d7-s2-id-capacity.md)、[原收据](d7-s2-id-capacity-2026-10-07.md)、
[L3](../../skills/L3-quality.md)、[eval-gate](../../.agents/skills/eval-gate/SKILL.md)。

## 对象冻结

- 受验代码只接受 `235045d6424640d79c79874a403749c6bd17b823`，tree 与已合入
  `eb2bd4d6a096331d888f938391749a42aa16625b` 相等；不能换成当前 main。
- 原 base `473e2eeae119b600b63abd78ce886301bd882235`；原 candidate CI
  `37572630559 / attempt 1`，tested merge `57e6e7aaeeb5566f4029604e2cb9321c8c45125d`。
  这些仅是确定性工程证据，真实模型质量依然缺证。
- 仅 Topic/Source 自动 ID 后缀 16→128 位进入该 head；candidate/batch/event 仍为旧生成器。
  Source 身份进入模型，Topic 仅改变完整输入 hash。后续 S2b 四身份结果不得移植。

## 冻结必要验证

1. 在独立干净旧-head worktree，按其原 `a1-prototype-safety-config.ts` 固定选择，
   执行原有真实安全路径；不得修改 dataset、model/provider/thinking/prompt、阈值或选择清单。
   准备阶段重新枚举该版本选样 ID、原字节及 canonical hash，确认 1 quality / 12 judge /
   14 display / 8 quote-only；不以现 main 的 config hash代替旧版本。
2. 从既有冻结合成正文与短历史 event 制作两臂：Source=`src_feed_abcd` 与
   `src_feed_` 加 32 个 `a`。Topic、正文、时间窗、历史 event、schema/system/maxTokens
   全相同；`analysis_generation` 的完整 serialized 请求精确只替换 Source
   （每次出现 +28 ASCII bytes）。
   两臂走旧 head 的真实 `analyze → coverage → validateBatch`，记录每次 transport 身份、
   输出 citation 原文/ContentItem 绑定、旧 event 白名单、新派生 event 归属。
   coverage primary/countercheck 与 validator 继续使用原参数及语义，分别保存实际 payload、
   完整执行与引用绑定；其输入含各臂自然产生的模型输出，不要求两臂请求字节相等。
   Topic 新旧消费者及 hash 变化复用旧 head 确定性测试，不能将 Topic 误称 prompt A/B。
3. 原 prototype safety 完整执行；support、uncertain、三类 not_support 均出现，
   display 与 quote-only 的 unsafe_accept=0。false_reject 只记趋势，无新增阈值。
   身份错绑、执行不完整、质量门失败或未知终态保持未验收；不得自动扩样或重跑。
   两臂无输出时明确非空关联分支未观测，不由零输出补签它；该诊断不证明统计质量等价、
   ≥50组事件准确率、baseline/DCP/人工通过或正式发布。

## 执行前仍须准备与授权

现 [#437 的 S2b guard](../plan/specs/d7-s2b-evaluation-guard.md) 可复用计数/取消协议，
但其 child 硬编码新 `batch_[32hex]`，且四臂混入 event 容量变化，**不可直接对旧 head 裸跑**。
旧 head 还没有 `evals/a1-attempt-diagnostics.ts` 或
`src/lib/runtime/model-call-observer.ts`，现 S2b preload/child 动态依赖两者；
这是一项具体工程前置，不能把已有 guard 记为旧 head 已可执行。
执行前须独立冻结外部 S2a harness：生产模块仅动态加载精确旧 head，工具 head/tree 单独绑定；
工具须提供完全外置的旧版本 bridge、接受其真实格式与两臂输入，不能 patch 旧生产模块
或评测口径。bridge缺失/版本错配在发送前拒绝；需要证明实际fetch及operation归属、SDK隐藏
retry全部被计数，不能仅观察logical calls。新 harness 先以
无网 mock transport 验证实际 fetch计数、保守 retry 计数、deadline、首原因、迟到回调及
sticky incomplete，并独立 review；通过后在零请求 prepare 中绑定输入/config/source/guard/lock。
准备不是许可，配套专项方案须由批准者确认后才运行。

待申请预算建议为一次 cold/no-resume、两 Source臂与原 safety共用 **100 actual HTTP attempts**、
其中至多 **20 retries**、共同 **45分钟**窗口；首次/SDK/application/coverage请求均计入，
达到 cap 前拒绝下一 fetch，deadline中止在途，未知或取消不得产通过收据。
这些数字为申请上限，当前没有剩余预算/attempt；不沿用 TD-14 或 S2b 已使用授权。
Coding Plan可信费用/余额未核，attempt/time cap不是金额硬上限；实际模型配置按旧 head
有效配置冻结，endpoint/key不入日志。需要真钱时一次申请明确 provider额度风险、T0窗口、
操作者与失败处置，未经批准保持0调用。

原始模型文本、请求、日志、checkpoint仅保存在新专属0700/0600私有目录，非覆盖索引逐文件
size/hash；公共PR仅保存精确 head/guard/input/config/hash与聚合结果。原有质量缺口继续
绑定235045d，不将未来收据写为旧历史时点已通过。TD-20整体仍部分完成。
