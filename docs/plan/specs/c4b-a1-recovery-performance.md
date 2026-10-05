# C4b / TD-14：A1 恢复可信度与重复读取

日期：2026-10-05。起点 `64f365682c2a6a4ffa6198f3bb4c57d1e1ab589c`。
用户已确认本切片 eval 文件交接，并要求按零付费方案推进。只交付一个小优化，TD-14 保持部分完成。

2026-10-06 收口状态：**C4b 本轮零付费切片完成；TD-14 部分完成**。
实现已按用户授权通过 [PR #415](https://github.com/dong-qiu/deep-insight-agent/pull/415) 合入，
合并后的主干 CI 成功；最终合入、性能门 warning 与保留范围见[专属收据](../../verify/c4b-a1-recovery-performance-2026-10-05.md#2026-10-06合入核验与本轮收口)。

## 范围与前置证据

- C4a、C2a、C3、C2b、D1、D4 已合入；该起点 main CI 37324076876 成功。没有生产核验授权。
- D2 #414 拥有 alert facade/channel、专属测试与文档；启动时未合入，交付复核已合入
  `92d684bb5dd1428058e07b6c8341b67e3ec074a8`，main CI 37330189460 成功；候选对齐该主干。
  本切片不修改这些或其他 Session worktree。
- 修改范围仅 eval 的恢复身份、checkpoint、真实 run-a1 接线、专属测量/测试和本 spec/收据。
  runtime、agents、package/lock、CI、schema、baseline、dataset、roadmap/ADR 保持既有职责。
- 已有 9 份本地 A1 manifest 的白名单聚合观察均缺 C4a timing/effective_config；不是当前配置完整计时。
  历史 liveness/capacity 诊断分别观察过候选审计数量、重试放大，不能当当前配置性能基线。
- 当前默认配置只作现场观察：Responses provider；analyzer deepseek-v4-flash / validator deepseek-v4-pro /
  coverage glm-5.2；validator thinking off / coverage thinking on；独立并发 1。未调用模型。
- 实际恢复路径先读 checkpoint 验 manifest hash，再读同文件解析。只减少这一重复 source read；
  同一 Buffer 验 hash + parse 同时消除两次读取间文件替换窗口。不承诺模型请求或整体耗时显著下降。

## 恢复可信度前置契约

1. 版本化 checkpoint；除完整 EvalConfig、质量数据集与连续分块输入 hash 外，新增恢复身份 digest。
   身份覆盖已验证的源码 commit/dirty 内容指纹（含评测/判断/schema/参数代码与 lockfile）、
   已有有效配置/截止，以及额外运行条件白名单（包括实际 Anthropic/Responses 配置、retry、
   prompt cache、coverage backfill）。只保存 digest，不保存端点、原始环境或凭据。
   白名单读取是观测，不重新解析、不改变模块常量/getter 读取时机或正常调用参数。
2. commit、status、staged/unstaged diff、untracked 列表及其每份字节必须可取得；独立记录完整性标志，
   不把 `<unavailable>` 的 digest 当完整身份。无法取得完整源码身份的冷运行仍可执行并留下不可恢复的 checkpoint；恢复入口拒绝身份缺失。
   旧 v1、缺字段、源码/配置/provider/model/prompt/输入/判断身份变化均拒绝，绝不自动升级旧文件。
   源码绑定刻意保守：无关文档或提交变化也可能拒绝恢复；不删除旧产物、不自动触发付费重跑。
3. 完整主题必须包含全部引用的终态校验，且无 `pass + not_evaluated` 或 report.errored。
   合法不可达引用的 `fail + not_evaluated + blocked` 是确定性终态，与基础设施失败区分。
   support / uncertain / not_support 保持原 verdict，质量失败不能变 pass。
4. analyzer chunk 的 coverage 审计发生基础设施错误、截断或待定时，不写可复用 chunk。
   除嵌套 countercheck/reader-language repair 的 unavailable/invalid 外，检查真实 role operation 的
   provider 终态增量：schema 合法的 max_tokens/max_output_tokens（包括空 no_significant_event）仍不完整。
   成功恢复的普通 retry 不自动判失败；每个 chunk/completed 均须有经这些守卫产生的 execution_complete 证据。
   利用已有 `onStage` 观测单条 model_output 失败：analyzer 拆批最终丢弃失败 leaf 不能作为成功空结果；
   父批解析失败后全部子调用成功仍可完成。语言修复的 `source_claims` 同样检查完整性。
   合法语义拒绝仍是完成判断。无法证明完整性的外来 checkpoint 拒绝整个恢复源。
5. 新运行在 validator 未完成时停止并发布 failed/not_evaluated；最后已完整审计的 analyzer chunks
   可保留为 partial，但不保存未完成 validator 为 completed。用户显式恢复该 partial 时仍执行 validator；
   未完成引用安全检查不得跳过。运行不自动恢复、不切模型/provider、不扩大样本或重跑。
6. 源 checkpoint 只接受终态 failed manifest 对其确切字节的 hash 绑定。新 run 独立原子发布，
   源目录/文件保持不变；重复显式恢复不追加源结果或减少后续必需基准。

## 最小可比测量

- 先实现上述保护并冻结安全候选，再以同一源码的显式 test-only import hook 选择安全两读/单读策略。
  两读参照调用现行两个 public helper，并在第二读验证相同 hash；单读调用实际 runner 接线。
  历史 v1 的不完整复用行为不能作为质量等价基线。
- 输入为合成固定 checkpoint、topic/ContentItem、模型边界响应；所有模型/HTTP 边界拒绝真实网络。
  冻结公共源码及两种读策略、输入字节/hash、模型/provider/prompt/协议/参数、fixture 范围、并发、timeout/retry、
  Node/npm、输出目录、无 Job 模式与恢复/cache 条件。真实模型次数与费用均 0。
- 主 runner 回归实际执行 run-a1 的 setup → quality → consistency → 两类 coverage → 聚合/门禁/发布，
  只替换模型边界。另以真实 analyzer/validator/SDK 的 mock transport 验证实际生产接线和控制契约，
  非空候选实际调用 validator，不能用 empty-yield 证明该接线。子进程合成 env 不继承凭据；阻断 load-env 和真实 fetch。
- 外层单调墙钟从 spawn 前到子进程 close，包含模块加载、末尾发布、退出与 observer 开销；
  C4a main/phase wall 原边界保留：不含模块加载及最后 progress/manifest 发布 I/O。
  并行阶段取起止差，不能累加子调用 latency。
- 先验证真实进程成功、失败、取消终态与产物可读，然后固定环境交错重复读策略样本。
  进程冷启动与恢复 source 文件的 OS 页缓存分别说明；不主动 flush 系统缓存。
  仅 source checkpoint 读取计数比较 2→1，新产物写入/hash 保留，不把它们当重复恢复读取。
- 记录 n、整体/阶段/setup wall、source read 次数/bytes、模型 logical calls、实际 transport 与重试数、
  exit/signal 与 execution/auto_gate/baseline 状态。mock wall 不是模型服务延迟；单次不称 P95。
  SDK attempt 与逻辑 latency 分开；旧 role.requests 不保证覆盖 SDK retry，不能用 requests-calls 推重试数。
- 固定模型边界返回值的结果、checks、coverage、review queue、CSV、checkpoint/manifest hashes 与门禁
  逐字段比较；仅运行 ID、时戳、计时等运行特有元数据归一化。随机 batch/candidate ID 用有序双射保留跨文件引用；
  manifest 的 insight ID digest 先验证原值，再由归一化 ID 重算，产物 hash 独立验证。源码/配置/恢复源身份不归一化。
  不放宽失败/不可比/争议标签，不将更快失败当成功提速。无可辨识 wall 收益时如实报告。

## 反例与验收

- 冷运行、合法完整主题恢复、partial chunk 恢复、显式重复恢复；新模型请求只来自尚未完成工作。
- 每个身份字段缺失/变化、非 failed manifest、错误 hash、checkpoint 缺失/损坏/截断/部分写入、非法序列；
  同一读取 Buffer 验 hash 与解析，替换文件的反例不能混入未绑定字节。
- validator infrastructure error、缺失/重复 checks、coverage unavailable/truncated、质量失败与 uncertain、
  不可比、取消/deadline；失败 checkpoint 不保存不完整完成标记，迟到回调不能复活产物。
- 同一并行阶段多次 progress 不重复累计；原 C2a 取消/lease、C3 用量、C2b 预算及正式门回归保持。
- 优化前后对满足可信度契约的相同固定输入结果/判断/产物/门禁等价；失败可退回安全两读策略，
  两读备选也必须绑定已验证 Buffer，不能重新引入验证/解析不一致。

## 质量门与授权边界

按 eval-gate 对最终 diff 决定证据，不预先盖 observation-only/pure-I/O skip。
本切片恢复完整性/身份拒绝属于评测设施的确定性失败关闭变化，使用真实 runner 与真实 SDK 的合成反例；
模型/provider/prompt、成功 AI 判断、评分、数据集、阈值、baseline、人评和发布白名单均不改变。
不声称 mock 提供真实模型质量或可比 baseline。若实现需要改变成功 AI 语义，停止该扩展并另取授权。

真实模型授权当前为 0；未来可选一次 1 topic / 12 pair / 14 display / 8 quote 诊断，须先证明覆盖实际
fetch/retry 的硬请求限制与 sticky incomplete 终态，再单独确认最多 80 请求和 45 分钟窗口。
Coding Plan 金额/额度未知，无 Job A1 不受 C2b 自动保护，请求数上限不等价于金额上限。
本 PR 不实现或运行这个付费实验，不把它当 before/after。

方案和最终 diff 独立 review；定向真实路径回归、双编译器 typecheck、lint、必要 coverage/CI。
零生产访问/迁移/修复/部署/清理。实施阶段的停止点为正常 hooks 创建 PR、精确核对最终候选 full CI
及交付产物后等待合并授权；随后用户已授权合并，本轮按上述收口状态结束。
