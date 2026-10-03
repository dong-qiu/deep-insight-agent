# PR 交付效率优化验收标准

本 spec 管理三个顺序交付的 PR。每项必须独立分支、前置独立审查、Draft 后远端 diff 复核、正常 squash 合并，并核验实际合并 SHA 的 main CI 后才开始下一项。共享 roadmap/ADR、生产、Dependabot 和其他切片不在范围内。

## 现场与证据边界

启动基线为 `065dd0cf7a8f06d4becd093da2f133fc552ce201`；[main CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37137081561) 成功。保护要求 `typecheck · test · build`、`docker build`、`eval-gate (trailer)`，strict=true，enforce_admins=true。开放 Dependabot PR 和其他会话的工作区只读保留。

[C5](../../verify/c5-ci-build-reuse-2026-10-03.md) 的一次应用构建、E2E 复用和身份校验必须保留；[D5](../../verify/d5-build-dependency-convergence-2026-10-03.md) 保持关闭。历史耗时不是受控基线。本次记录执行时间和排队时间，不推断 P95 或受控加速比例。

## PR 1：文档轻量 CI 与发布判定

- 使用无需 npm 的 Git 全量差异分类：PR 的 base/head 全范围，main push 的 before/after 全范围；PR 最后一次提交仅文档但整体含代码时执行完整验证。
- 白名单仅 `docs/verify/**/*.md` 和 `docs/plan/specs/**/*.md` 中不参与运行或构建的普通文件。删除可分类，重命名检查两端；symlink、gitlink、类型变化、未知状态、空范围、异常 SHA/祖先关系、Git 或解析失败均不得轻量通过。其他路径和混合改动完整验证。
- 文档路径执行本地链接/锚点、基本 Markdown 格式及收据结构检查；独立审查核验引用 SHA、Actions run 与结果。新交付收据包含范围、本地验证、独立审查、证据与限制、回退五节。其他 verify 文档至少有标题和分节，不把结构检查当成事实核验。
- 原有必需检查入口始终执行且名字不变。汇总严格检查 scope 和选中的下游成功；未选中的下游必须 skipped，失败、取消、未知或意外 skipped 都阻断。禁止 workflow paths-ignore。
- 文档轻量不生成 prototype CI/Docker 证明。现有 release receipt 消费者仍要求同一候选/测试 SHA、run ID/attempt 的完整 CI 与 Docker 证明，契约不变。
- 镜像发布仅接受可信仓库 `.github/workflows/ci.yml` 的成功 main push run、精确 SHA、attempt 与所需成功 jobs，并校验绑定的 scope 产物。代码还需现有完整 CI/Docker 产物。文档仅记录发布跳过，不登录 GHCR、不构建、不 push；缺证、身份错配、不可信来源及任一下游失败均拒绝发布。PR/fork 不增加写权限。
- PR 1 自身修改 CI/ops，必须完整验证；分类、汇总和发布判断有有效反例及使用实际 Git/CLI 的集成测试。合并后核验真实 main CI 和发布行为，文档检查目标执行小于 60 秒，排队另记；由 PR 2 的真实文档提交补充 main 文档路径验收。

## PR 2：收据归档流程

- 专属流程文档位于 `docs/plan/specs/pr-delivery-evidence-workflow.md`，本项仅文档路径，不重构 CI。
- 首次提交前写齐 spec、实施、本地验证和独立审查；冻结候选后优先更新 PR 摘要和 Actions 证据，不为追加 CI URL 修改 head。
- 证据记录候选 SHA、实际测试 SHA、run ID、attempt、结果；main 完成结果保存在交付摘要和可追溯证据。须入库的归档走轻量路径；本次不另开第四个收据 PR。
- 说明 Actions 保留期限、长期归档办法和信任边界。完整独立审查针对冻结候选；后续文档差异复核相关证据，保留 PR 后最终 diff 复核、模型/评测要求和质量门。
- 核验真实文档 PR/main 必需检查成功、没有完整构建证明或镜像发布；执行与排队计时分开。

## PR 3：应用与 Docker 并行

- 先证明 Docker checkout/上下文/运行验证独立，不消费 verify 产物，再解除串行依赖；同一 `github.sha`，合并和发布仍等待两项全部成功。
- 保留 Docker secret context、runtime assets、HTTP/auth、dispatch readiness、完整 prototype 证据及 C5 构建复用。不跨 PR/main 复用，不改生产推广。
- 测试两项的失败、取消、skipped 汇总均阻断，身份不符拒绝发布。记录真实两项 job 起止、重叠和等待，计算并行收益与 runner 费用分别说明；不作 P95 或受控比例声明。

## 验证与结果登记

CI/ops 项执行干净 npm ci、TS6/TS7、lint、覆盖率、一次应用 build/E2E 与 Actions Docker。文档项执行轻量检查和独立证据审查；按仓库规则补本地 typecheck。无模型、prompt、validator、来源、数据集、评分、依赖升级或 vendor 变化，Eval-Gate skip 只适用于此范围。

各 PR 的提交前收据分别为 `docs/verify/pr-delivery-efficiency-{1,2,3}-2026-10-04.md`；PR/main 最终结果追加 PR 摘要、Actions summary/artifacts 和本 session 最终交付，不为合并结果追加候选提交。

| PR | 范围 | 提交前验收 | 集成验收位置 |
| --- | --- | --- | --- |
| 1 | 分类、轻量验证、必需门、镜像 admission | PR 1 专属收据 | PR 摘要、CI/发布 Actions |
| 2 | 证据归档流程 | PR 2 专属收据 | PR 摘要、文档 CI/发布 Actions |
| 3 | Docker 与应用并行 | PR 3 专属收据 | PR 摘要、完整 CI/发布 Actions |

## 回退

分别通过正常 revert PR 回退流程、并行依赖或 scope/admission 变更；回退 CI 需完整验证。无生产部署、数据或 schema 迁移。轻量路径发生疑问时停止合并并修复，不能绕过保护。
