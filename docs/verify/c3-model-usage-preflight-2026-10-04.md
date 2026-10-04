# C3 / TD-13 启动盘点与候选设计收据

日期：2026-10-04。范围：只读盘点、隔离工作区、候选契约与 SDK 可观测性合成反例。
**尚未实现用量持久化，不是 C3 完成收据，也不证明 C2b 可启动。**

## 基线与已有切片

fetch origin/main 后基线 `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`。
[C2a #406](https://github.com/dong-qiu/deep-insight-agent/pull/406) 于 2026-10-04 01:20:23 UTC 合入。
该 HEAD 的 [main CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37167709112) completed/success。
镜像发布 `37167919611` success，后续同 SHA 的 `37168316375` skipped；不据此判断生产版本。
没有生产 DB、云、部署或恢复访问。

main history 已含 C5 #396/#397、D5 #398/#403、C4a 065dd0c、C2a #406；旧清单的待实施状态不作事实。
已读 AGENTS、L0/L2/L3、technical-debt-remediation、C2a spec/收据、架构 Run/CostLedger/成本控制、
generation-provenance 的迁移规则、Volcengine provider spec/ADR-0031、eval-gate、pre-pr-ai-review，
以及独立 refactor-plan worktree 的 parallel-execution 协作计划；不合入其分支。

## 隔离与文件归属

新 worktree `/Users/dongqiu/Dev/code/insight-agent-c3`，分支 `feat/c3-model-usage-persistence`，
从上述最新 origin/main 创建。仅复制主工作区 gitignored `.env.local`，mode=0600，
DATA_DIR/DB_PATH 改为 C3 worktree 独立路径；不输出配置，不复制 .data/SQLite/WAL/原文/报告或 .env.development.local。

启动时 worktree metadata/status 盘点：

| 工作区后缀 | 分支 | HEAD | 未提交/归属 |
| --- | --- | --- | --- |
| 主工作区 | docs/brief-information-density-plan | 21414ab | ADR、roadmap 修改和日报规划/收据未跟踪；不修改 |
| auth-logout | fix/auth-logout-protection | 8a96b86 | middleware.ts、vitest.config.ts、认证 spec/test；不修改、不收口 |
| d4 | feat/d4-browser-smoke | 0a49e57 | 干净，open #404；浏览器/依赖/CI 仍由 D4 流程负责 |
| c1-backup | fix/c1-backup-wal-sidecars | d14c589 | 干净，不代表会话停止 |
| c1-identity-audit | feat/c1-candidate-identity-audit | f3753d8 | 干净，不代表会话停止 |
| c1-restore-rehearsal | feat/c1-registry-freshness-anchor | 8177ff7 | 干净；历史分支差异包含 schema.ts/architecture/ADR，必须交接 |
| refactor-plan | docs/refactor-parallel-execution | 7342576 | 干净；仅参考 |
| backup-interval | feat/backup-snapshot-interval | f1c5e27 | 干净；不复用 |
| brief-density | feat/brief-density-s0 | 5cce058 | 专属进度收据修改；不修改 |
| brief-extraction-probe | feat/brief-density-extraction-probe | 752cefd | 干净；不复用 |
| delivery-1/2/3 | feat/pr-delivery-docs-ci / docs/pr-delivery-evidence / ci/pr-delivery-parallel-docker | d2a3add / 05ce219 / 1cff235 | 干净；不修改 |

本机存在多个 Codex 进程，但进程存在不能可靠断言各 C1/D1 会话已停或文件已释放。
没有 D1 命名 worktree 不等于 D1 未启动。已发起 schema/migration 文件交接问题；未确认之前不改共享 DB 文件。
package/lock、CI、Docker、README、认证、浏览器和 vitest 配置本切片不改。
共享 roadmap/ADR 不修改；如需架构实体契约改动，先取得明确归属。
当前只新增 C3 专属 spec 与本收据，其他工作区状态不变。

## 调查结论与反例

见 [C3 候选 spec](../plan/specs/c3-model-usage-persistence.md)。现有 Run.cost 任务结束时才保存，预算从
Run 读；P1 cost_ledger 的 NOT NULL/default 0 token、append-only 与阶段聚合身份无法直接表达真实
attempt 的 unknown→partial→reported。建议最小独立调用观测表，保持预算和 P1 消费方原样，禁止三者相加。
这是候选关键设计，不声称已批准或实施；取消后有 lease 记消耗，lease 丢失仍拒写，不新增独立用量权限。

已执行一个纯合成可观测性反例：使用本机已安装 @anthropic-ai/sdk 0.127.0，自定义 fetch 第一次返回
503，retry-after-ms=1，第二次返回合成标准 Anthropic SSE；SDK maxRetries=1，一次 messages.stream
最终 usage=input 7/output 3，自定义 fetch 被调用 2 次。断言通过，真实 provider 网络请求=0。
脚本通过 Node 内联运行，未加载 .env，没有读 DB 或记录 request body/key。此反例只证明 SDK retry
可在 fetch 边界观测，不证明最终持久化、流式 observer、取消或迁移正确。

候选 spec 已列出 retry/replay/conflict、usage 后失败与取消、重启、missing/partial/unknown price、
真实 lease loss、fresh/v47/readonly 迁移、双累计、持久化故障和正常 SDK/取消/drain 的验收矩阵。
完整测试、实现、typecheck/lint/build/eval、最终 diff 审查、PR 与候选 CI 尚未执行。

## 独立方案评审

使用新的独立 reviewer 上下文，按 pre-pr-ai-review，只提供候选 spec/基线和相关必要代码，
不传环境、凭据、数据库、业务正文或无关日志。初轮 Blocking=0、Warning=4：
SDK 对持久化错误仍会 retry/包装、partial/replay 合并未明确、legacy 缺失字段归零、
Job 已收尾后 observer 故障边界。四项均已补进候选 spec，独立复查无新增明确契约缺口；
Blocking=0，未解决方案 Warning=0。关键设计/交接仍待用户确认，不等于最终实现通过。

reviewer 另独立运行 SDK 故障反例：maxRetries=1，自定义 fetch 每次只抛固定
usage_persistence_failed，fetch wrapper 调用=2，最终 APIConnectionError，真实 provider 网络请求=0。
据此契约规定 sticky fault 在每一次底层真实 transport 前检查，不能依赖错误类别阻止内部重试。
reviewer 复查仅复读修订文档，没有运行尚不存在的持久化测试。

两份 C3 专属文档的本地链接检查与 git diff --check 通过。当前未改任何 runtime/schema/migration、
package/lock、CI、认证/浏览器、共享 architecture/ADR/roadmap；候选设计未视为实施授权。

## 待交接与停止边界

1. C1/D1 确认 schema.ts、provenance migration runner/测试本切片串行交给 C3。
2. 独立方案审查后确认是否接受独立 model_usage_attempt 观测表；必要架构更新单独交接，
   不覆盖主工作区 ADR/roadmap 未提交内容。
3. 获得确认后先补真实路径反例，实施 additive v48、runtime 接线和 reader，再独立最终审查与 PR/CI。

Eval-Gate 尚未盖章；设计目标保持模型/provider/thinking/prompt/判断语义，但须最终 diff/回归证明后才能 skip。
C2b 暂不具备启动条件：C3 接线与持久化未完成，预算消费未知用量/估价及迁移防重复口径尚需专属设计。
本任务没有合并、部署、生产数据访问、历史修复或分支清理授权。
