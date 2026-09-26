# Legacy Coverage WIP 最小收口

## 范围

从 `wip/legacy-coverage-volcengine-2026-09`（`dfdfe87`）只提取仍有价值的反例和
读路径版本边界，不整体合并旧分支。播客 shadow、provider canary 已分别由 #347、#349
吸收；保留 #351 的计费后 fail-closed 和 #352 的中文结论与诊断。

## 验收标准

1. 原文仅说 data，草稿却新增“合成数据”限定的案例预期为 reject；不能以最终投影为原文
   为由免除原始 claim 审查。加入 synthetic data、artificially generated data、中文原文
   三种支持正例。单测只证明 primary 拒绝不能被 quote-only 通过覆盖；语义效果以真实模型验证。
2. 上述四例进入 prototype-safety 子集；更新 fixture 字节指纹，不改历史 baseline、不声明 DCP
   或前后可比。不引入特定词面的 synthetic 正则拒绝规则，不改变模型、prompt、token 或 thinking。
3. 新生成报告、图谱/侧栏及技术线索证据的持久化审计仅接受明确支持的 `display-coverage-v6`。
   缺失、空、v5、WIP v9、未知未来版本均拒绝，即使其 decision 形状、哈希和 validator 结果
   看似合法。版本仅是额外必要条件，不替代现有引用绑定、哈希、countercheck 和 validator 白名单。
4. v6 中已审查并哈希绑定的中文 reader_statement 继续显示；不重写历史报告、不迁移/删除历史
   审计、不触发模型重审。以后支持新版本必须显式更新兼容策略和回归，不按版本大小自动放行。
5. 测试覆盖共享审计工具、报告选择、真实 `runReportGen → DB → buildReport`、图谱及实体/边侧栏；
   仅确定性读路径改动不能以 A1 代替集成回归。

## 不移植

- v9 双 claim 架构及其 fixtures：独立 Coverage 继续只接收 quote 与 locator。
- 旧 provider/播客实现和旧 Eval-Gate 章：已被更完整的主干实现替代。
- WIP 清理前先确认本次提取完成并保留可恢复的提交记录；不把整个 WIP 标记为已合并。
