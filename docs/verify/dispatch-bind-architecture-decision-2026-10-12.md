# Dispatch-bind：原架构 owner 新决定收据

## 执行单与结论

- 唯一作者：原 ADR-0045 架构 owner、本 Dev-Agent-重构聊天；主控本片精确决定 SHA256 `c375c39fc6631de980e52ce286987a12a5a43217f8f897ebadc09f65c316f360`。
- 范围：decisions.md 加性 ADR-0046、architecture.md 加性单节、本新收据；不带原 native worktree 旧 dirty 内容，不改源码/DB/旧合同。
- 基线：fresh remote main `541d2264685c6a44b48af3186466b981523d76ae`，新 `codex/dispatch-bind-architecture-20261012`；原 3eb/e7 分支保留。
- 决定：**接受冻结新增 profile 与单步绑定方向作为架构决定；实现、canonical DB 语义认领与真实验收仍待前置。**
- 本窄片上限25分钟，启动2026-10-12 01:10:50 UTC；新12小时全局截止2026-10-12 13:07:32 UTC，不改变其他线期限。

## 冻结来源

[PR482 spec 固定候选](https://github.com/dong-qiu/deep-insight-agent/blob/6869854f93cac8194fa9f269551fc8e1e4080496/docs/plan/specs/r3-r6-dispatch-bind-contract-2026-10-12.md)
head `6869854f93cac8194fa9f269551fc8e1e4080496`，实际 UTF-8 spec SHA256
`bb8be05684af3d0dea36a8d2eff3eba6b405c9db4d7ba904ec7cc9f94ceb7936`。
在启动观察中 PR482 为 OPEN；本收据用 immutable 来源，不声明该候选已 main 发布，不接管 R3 worktree 或合入窗口。

新增选择详见 [ADR-0046](../develop/decisions.md#adr-0046-dispatch-bind-使用独立新-profile-与单步绑定终态)：
独立新 root/header3、默认 v2 保留、单 terminals CHECK 增量、八键 marker/catalog/F、ordinal0 固定 SELECT/空 COMMIT/ACK、
unknown0cap 与普通取消、binding_completed 不是业务终态或 lease-release。旧算法不第三重审。

仍待独立决定/实证：canonical SELECT（usage仅begin、root/child/currentclock）、真实 fixture/schema/setup；core/六候选源码用途与两个依赖 build 窄窗。
任何实际 SQLite 与 expected manifest/F 差异必须停并精确回报，不降低指纹规则。不能因架构接受称已移交 provenance/schema 文件。

## 审查、验证与证据

本轮使用 pre-pr-ai-review，高风险新增架构文档由两位 fresh 独立非作者只审三份新增 delta、冻结来源和原字节保全，最多两轮。
最终结论及 source/head/blob/CI 身份在 PR 追加；本提交前记录不冒称审查或 CI 已完成。
本地仅格式/链接/事实/指纹检查，候选真实 CI按仓库 scope 分类；文档检查不证明 SQLite fixture 已执行、源码实现或 build/runtime 资格。
Eval 不适用：只做架构文档，没有 AI 输出/prompt/模型/来源/评测集变更。

新私有 root 保存主控引用、冻结合同原文hash、原 tracked 前缀、native九文件hash/HEAD/index、diff/sourcefreeze、独立review及正常Git/远端证据；
不提交 secret/原文/DB/日志，不修改旧封存。原 native 九项（含两 dirty 文档）、其他owner/config/data保持，clean不是移交。
本片允许显式三文件正常提交/推送/创建并attach PR，但不合并。本片未执行 SQL/native/模型/VM/恢复/生产/清理；
safe_rollback=null、deployment blocked、hold/#435及真实模型/恢复/P1/prepare/matrix消费0保持。
