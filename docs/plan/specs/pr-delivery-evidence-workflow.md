# PR 交付证据与收据归档流程

适用范围：[交付效率 spec](pr-delivery-efficiency.md#pr-2收据归档流程)。此流程只改变证据记录时机与载体，保留前置独立审查、PR 后最终 diff 复核、必需检查、分支最新要求、Eval-Gate 和模型/评测规则。

## 首次提交前

1. 从最新 `origin/main` 建立隔离分支/worktree，记录基线 SHA；按 AGENTS.md 复制所需 gitignored 配置、权限 0600、隔离数据库。保留其他会话文件。
2. 先写验收 spec，再实施。在专属 `docs/verify/*.md` 收据中写齐范围、本地验证命令与实际结果、限制、独立审查结论和回退。不能把尚未运行的候选 CI/main CI 写成已通过。
3. 冻结候选文件集合与内容，让新上下文 reviewer 按 [pre-pr-ai-review](../../../.agents/skills/pre-pr-ai-review/SKILL.md) 审查完整 base 到候选差异。修复问题并定向复核后才首次提交；提交后把实际 head SHA 绑定到审查摘要。
4. 使用正常 hooks 推送并创建 Draft PR。PR 摘要包含验收、风险、测试/Eval、审查结论及待补的 Actions 证据；创建后由独立 reviewer 核对远端完整 diff 与冻结内容和摘要一致。

## 候选 CI 后保持 head

优先更新 PR 摘要和 Actions summary/artifacts。仅为追加 CI URL 或首次 CI 结果，不改变候选 head，也不新增仓库收据提交。摘要更新不会替代审查或必需检查。

记录以下字段，不把 PR run 的 `head_sha` 误当实际测试 SHA：GitHub PR workflow 通常 checkout 临时 merge ref。scope 产物记录两者；完整代码的 prototype CI/Docker 产物也记录两者，且具有更强的完整验证含义。

| 字段 | 证据来源与要求 |
| --- | --- |
| 候选 SHA | PR 当前 head，必须等于冻结并审查的 head |
| 基线 / 范围 | PR base/head；main push before/after 完整范围 |
| 实际测试 SHA | 对应 run 的 scope `tested_commit`；full 还须与两份 prototype 证明一致 |
| run ID / attempt | CI Actions API 与产物的 id/attempt 一致；重跑记录新 attempt，不能混用 |
| workflow / 事件 / 仓库 | 可信本仓库 `.github/workflows/ci.yml`，区分 PR 和 main push |
| result / checks | run conclusion 与每个必需入口和所选下游结论；failure、cancel、未知及异常 skipped 都不通过 |
| scope / 证明等级 | `docs` 只证明文档检查；`full` 必须有应用与 Docker 实际成功及完整证明 |
| 时间 | job start/end、文档检查执行时间、初始调度及 job 间等待；区分执行与队列 |

完整独立审查针对冻结候选。若后续确有实现变化，更新验收和收据、审查相关差异并重跑受影响验证，再独立复核最终远端 diff。若仅修改文档，核对该差异的链接、结构、证据 SHA/run/result 和对原结论的影响，不因补链接无理由重做模型评测或全部审查；但 CI 仍按整个 PR 的 base/head 分类，代码 PR 最后一次只改文档也必须 full。命中 skills/hooks/workflows 或白名单外路径仍完整验证。

## Ready、合并与主干验收

确认候选 head 未变化、最新 main 已包含于分支、独立审查通过、所有必需检查成功且满足保护规则后，转 Ready，用匹配已审查 head 的正常 squash 合并。用户授权范围决定是否可合并；不使用 admin merge、绕过 hooks 或弱化保护。

合并后从 PR `mergeCommit` 获取实际 main SHA，找到精确对应的 main push CI，不以 PR CI、更新的 main run 或镜像发布结果替代。main CI 取消/失败时先解决并补齐该 SHA 的可信运行证据，不能填 success。重跑须核验同一 attempt 的完整身份与证据；缺失时发布应拒绝。

main CI 完成后，将合并 SHA、run ID/attempt、结果、scope、计时及发布行为追加到该 PR 的交付摘要，保留 Actions 可追溯链接。docs 路径应确认应用/Docker 下游正常 skipped、三个必需入口 success、没有 prototype 完整证明，发布 admission 明确返回 false、GHCR job skipped。full 路径应确认两项完整验证和证明成功，发布等候全部所需检查。镜像发布与生产部署分别记录；没有实际部署授权和核验，不写“生产已部署”。

## 保留期限与长期归档

本次现场 Actions 产物 `expires_at` 对应 90 天；新 scope artifact 在 workflow 中显式 `retention-days: 90`。原完整证据使用仓库默认期限，当前同为 90 天；保留设置可以改变，且人工删除/仓库删除可能提前使链接失效。每次交付记录实际 artifact ID、name、创建/过期时间、对应 run/attempt 和文件 SHA256；PR 摘要与 run 链接不等于永久保存了原文件。

需要长期留存时，在到期前下载并核验精确 run 的原产物，保存最小且不含密钥/个人或生产数据的证据：身份字段、实际结果、job 起止、原 artifact ID/过期时间、内容摘要和独立审查结论。必要的仓库归档使用 `docs/verify/**/*.md`，可在 fenced block 内保留允许公开的原 JSON 和 SHA256，经独立证据核对及文档轻量 CI 归档。只保存摘要或 hash 时须明说原产物仍会过期，不冒充长期完整证明。

完整发布 receipt 消费者仍要求原 schema 的 CI 和 Docker JSON、同一候选/测试 SHA、run ID/attempt 及全部 checks=pass。长期归档可保留原 JSON 字节和摘要供未来提取核验；仅有 Markdown 摘要或 docs scope，不能作为这些消费者的完整质量证据。若需外部持久库或新权限，另行按用户授权安排，本流程不创建外部存储。

## 本次三 PR 的归档边界

每项提交前收据随对应 PR 入库；新增候选/main 结果优先保存在该 PR 摘要和 Actions。后续顺序 PR 可引用已经完成的前一项证据，并标明来源；不会为了本次收口再创建第四个收据 PR。必须入库的未来纯文档归档走轻量路径。最终交付报告列出三个 PR、实际合并 SHA、main CI、验证等级、计时、风险和回退。

## 回退

通过正常文档 revert PR 回退本流程；不改变 CI 或发布证明契约，不涉及数据迁移或生产部署。
