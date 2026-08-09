# Spec: 合并后分支与 Worktree 收尾

> V1 · 状态：🟢 Implemented · 2026-08-09

## 目标

为短生命周期 PR 分支建立可重复、可审计的收尾方式：远程 head branch 由 GitHub 在 PR 合并后自动删除；本地 worktree 与分支只能在明确验证后清理。

## 非目标

- 本工具不删除 `main`、开放 PR、发布/维护分支或任何远程分支；GitHub 的仓库级远程自动删除没有命名空间例外，长期 release/maintenance 分支须另以保护规则保留。
- 不强制删除有改动、已锁定或当前正在使用的 worktree。
- 不以 `git branch --merged` 作为唯一依据；squash/rebase 合并时该图关系并不可靠。

## 验收标准

1. 仓库启用 GitHub 的 `delete_branch_on_merge`；远程短生命周期 head branch 不由本地脚本删除。
2. `npm run branches:cleanup` 默认只输出候选与跳过理由，不写入 Git 状态。
3. 候选必须同时满足：关联 PR 已 merged、分支 tip 未在 PR 合并后推进、不是默认分支。
4. 被 worktree 占用的分支只有在 worktree 非主树、未锁定、非当前目录且 `git status --porcelain` 为空时才可候选；执行时先移除 worktree，再删除分支。
5. `npm run branches:cleanup -- --apply` 才执行本地删除，并仍使用 Git 的默认 clean-worktree 保护。
6. 收尾流程要求 PR 合并后等待 `main` CI 与需要的生产部署核验完成，再执行本地清理。
