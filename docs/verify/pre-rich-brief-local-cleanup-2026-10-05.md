# 本地分支/worktree 清理逐项审核

> 2026-10-05 逐项审核与非强制执行收据；没有强制删除或移除 worktree。按收口计划第 6 项、AGENTS 与 branch-lifecycle-cleanup spec。默认 `npm run branches:cleanup` 只读预演已运行；绝不调用其 `--apply`（实现用 branch -D）。

最新已核验 main `1d8925f`，CI `37340831376` success（此前 `057f265` / `37339733574` 亦成功），实际生产 b199 的只读身份/内容核验见 [C1 记录](pre-rich-brief-c1-bounded-closeout-2026-10-05.md)。代码合入但未部署的生产行为分支不声称验收通过。其他会话持续更新分支，所以执行前逐项重查 PR merged/head、tip、占用/锁定/dirty。

主工作区六份未提交/未跟踪原件及其私有数据保留；S0/提取试验的原文、快照、标签保留。所有关联 worktree 均查到 `.env.local`，其中多个还含 `.data` 私有文件；Git status clean 不能证明可删除，本轮**不移除任何此类 worktree**。仅审计忽略文件路径/数量，不输出密钥内容。

排除三个指定分支：docs/refactor-parallel-execution、perf/c4b-a1-low-risk、refactor/d2-hotspot-pure-slice。原 insight-agent-c4b worktree 已由其他会话切换为 docs/c4b-closeout，其路径及私有文件同样保留，不能把改名当清理授权。D2 scope 分支在核验期间由其他会话推进/合入，保留其 worktree。

| 本地分支 | tip / 已合入 PR（head 精确匹配） | worktree/私有文件 | 本轮决定 |
|---|---|---|---|
| `ci/pr-delivery-parallel-docker` | `1cff2359c0bd707a99643bd90f61ed24a22ca535` / [#408](https://github.com/dong-qiu/deep-insight-agent/pull/408) | insight-agent-delivery-3；private/config 7 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `docs/brief-information-density-plan` | `21414ab702282a5fc3645cea15afe26f1e042c07` / 无 merged PR | insight-agent；private/config 75125 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `docs/c1-recovery-time-coverage-contract` | `02d08d9ba1614e20241023779415fc6d89ff4ac4` / [#390](https://github.com/dong-qiu/deep-insight-agent/pull/390) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |
| `docs/c4b-closeout` | `057f265b8df67f22a312ecebafabbb6ee8f2cba1` / 无 merged PR | insight-agent-c4b；private/config 7 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `docs/d2-scope-disposition` | `c1fab0eceddb73c1a19597c0b065a513bfd190d7` / [#416](https://github.com/dong-qiu/deep-insight-agent/pull/416) | insight-agent-d2-scope；private/config 1 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `docs/pr-delivery-evidence` | `05ce2195ba34c88afe231978c244561f23731835` / [#407](https://github.com/dong-qiu/deep-insight-agent/pull/407) | insight-agent-delivery-2；private/config 1 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `docs/refactor-parallel-execution` | `7342576d2560e6fc7d5af1b116459af521da35a6` / 无 merged PR | insight-agent-refactor-plan；private/config 1 文件 | 排除，保留 |
| `feat/backup-snapshot-interval` | `f1c5e27d3780696cf2f54a63af8f074000c33215` / [#393](https://github.com/dong-qiu/deep-insight-agent/pull/393) | insight-agent-backup-interval；private/config 1 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `feat/brief-density-extraction-probe` | `752cefd98696e9c4a7397d8290459c1de5bbd942` / 无 merged PR | insight-agent-brief-extraction-probe；private/config 9703 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `feat/brief-density-s0` | `e7e91533ddf2f83142647d0185b6588419b018bc` / 无 merged PR | insight-agent-brief-density；private/config 943 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `feat/c1-backup-integrity` | `0dcdd639d8428884953bed1fb88e5a20b5bc573c` / [#378](https://github.com/dong-qiu/deep-insight-agent/pull/378) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |
| `feat/c1-candidate-identity-audit` | `f3753d8513c621a2f2794a8ea2eac2121c432f34` / [#387](https://github.com/dong-qiu/deep-insight-agent/pull/387) | insight-agent-c1-identity-audit；private/config 1 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `feat/c1-durable-synthetic-registry` | `a23d7d8f84f4f857f303777e285b62d61e729a34` / [#392](https://github.com/dong-qiu/deep-insight-agent/pull/392) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |
| `feat/c1-registry-freshness-anchor` | `8177ff71e177d6e71cc2bcc111153616c1f0f134` / [#395](https://github.com/dong-qiu/deep-insight-agent/pull/395) | insight-agent-c1-restore-rehearsal；private/config 7 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `feat/c1-report-redaction-boundary` | `53ea3c049f295848e5898729195327e4bb424e95` / [#394](https://github.com/dong-qiu/deep-insight-agent/pull/394) | 无 worktree | 保留：影响生产永久删除边界，实际生产尚未部署，不按已完成生产验收清理 |
| `feat/c1-synthetic-recovery-core` | `b97603a878ac86c8338af948951a84f709c448e3` / [#391](https://github.com/dong-qiu/deep-insight-agent/pull/391) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |
| `feat/c1-synthetic-restore-rehearsal` | `30e4de6da007b53a587a111877616e8578b38e1d` / [#388](https://github.com/dong-qiu/deep-insight-agent/pull/388) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |
| `feat/pr-delivery-docs-ci` | `d2a3addab59c49fb643568545e3a547d2e6a01c1` / [#405](https://github.com/dong-qiu/deep-insight-agent/pull/405) | insight-agent-delivery-1；private/config 7 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `fix/c1-backup-wal-sidecars` | `d14c589600de42c2e70defca758e17d8d994de7c` / [#379](https://github.com/dong-qiu/deep-insight-agent/pull/379) | insight-agent-c1-backup；private/config 7 文件 | 保留：主/当前树、未提交材料或 private/config，不移除 |
| `perf/c4b-a1-low-risk` | `dc944d97c837414eed83ebff164e5f962d6eaa82` / [#415](https://github.com/dong-qiu/deep-insight-agent/pull/415) | 无 worktree | 排除，保留 |
| `test/c1-replay-time-boundary` | `1381903607fa7080da3e37a4216b2dae7b91ab2b` / [#389](https://github.com/dong-qiu/deep-insight-agent/pull/389) | 无 worktree | 拟逐项仅 branch -d；若 squash ancestry 拒绝则保留，不 force |

六个拟尝试的无 worktree 分支均有 merged PR 且本地 SHA 精确等于 merged head，merge commit 在已通过 CI 的 main 中；不涉及生产 rollout 或私有文件删除。已合入后本地未推进，不以 merge-base ancestry 假定 squash head 已被图合并。独立预审通过后，仍重新取实时信息，先确认无任何 worktree 占用，再执行非强制 `git branch -d`；拒绝则原样保留。远端删除只交 GitHub 仓库设置，本轮无远端 delete。

执行结果及最终保留清单将在本页追加。审核完成不等于实际删掉分支，所有失败/保留原因逐项留痕。

## 实际执行与最终清单

独立预审 Blocking 0 / Warning 0，六个候选的 merged/head/merge-in-main/无worktree均获独立复核。执行前再次确认 GitHub main 为 `1d8925f`、CI `37340831376` success，逐项重查 SHA 与占用后执行：

| 分支 | PR | 非强制结果 |
|---|---|---|
| `docs/c1-recovery-time-coverage-contract` | #390 | 已删除本地分支 |
| `feat/c1-backup-integrity` | #378 | Git -d 拒绝未图合并（squash）；原样保留 |
| `feat/c1-durable-synthetic-registry` | #392 | 已删除本地分支 |
| `feat/c1-synthetic-recovery-core` | #391 | 已删除本地分支 |
| `feat/c1-synthetic-restore-rehearsal` | #388 | 已删除本地分支 |
| `test/c1-replay-time-boundary` | #389 | 已删除本地分支 |

本轮本地分支删除 5、非强制拒绝保留 1、worktree 移除 0、远端手动删除 0。精确 SHA、命令、返回码和 stdout/stderr 在 gitignored `cleanup-nonforce-results.json`；没有改用 -D/force。其余表列分支/worktree因私有配置/材料、开放PR、排除范围、未部署生产行为或其他会话活动保留。仓库 `delete_branch_on_merge=true` 已只读核实。

并发状态说明：审核期间其他会话将 main 推至 #417；C4b 路径/分支由其推进，D2 scope 分支/worktree在后续元数据中不再出现。本轮所有变更命令只有上表六个 branch -d 及 S0 文档/同步，没有删除、重建或修改这些排除资源。初始盘点与最终实时列表均保留，不能把外部会话动作计为本轮清理。第6项的逐项审核/符合条件尝试已完成，保留项不等于强制清理授权。

Git 的五次成功均依据本地保留的 `origin/<branch>` tracking head 已合并而允许 -d，同时提示尚非 HEAD 图祖先；本轮另以 merged PR head/merge-in-main 的独立证据核验，不把该提示抹去。`feat/c1-backup-integrity` 无可用 tracking 判定且非图祖先，退出1后原样保留。没有强制删除，也没有手动删除 remote/tracking refs。

## 2026-10-06 最终保留项复核

必要安全修复#426已正常合入5539ec1，新main CI37503548677此时在跑；只读清理预演再次执行。现场生产17:30 UTC仍为b199，未部署新主干，见[C1最新身份](pre-rich-brief-c1-bounded-closeout-2026-10-05.md)。本轮新增删除0，实际五个本地删除/一个-d拒绝保留、worktree移除0/远端手动删除0不变。

最新worktree列表15个，其中14个含配置或私有目录，另一个为其他会话活动树，全部保留。S0、提取试验、主树及#426隔离树保留；其他会话的source-map完整安全树不操作。#420旧本地head精确匹配merged PR且现无worktree，经独立只读复核后选择保留：生产尚未更新，不把声明锁依赖误写为dev-only，也不把删除本地引用当生产安全验收。已有c1-backup-integrity的-d拒绝不重试强删，c1-report-redaction-boundary仍因生产未部署保留。

排除的docs/refactor-parallel-execution仍存在；perf/c4b-a1-low-risk及refactor/d2-hotspot-pure-slice本地引用已不在实时列表，这是外部状态，不计本轮操作，不重建/改动。主树六份原件hash6/6不变。所有具体status/HEAD/锁定/私有目录存在性和dry-run清单留owner-only gitignored记录，不读取配置内容或删除资料。合入后再以最新main CI核验清理时点，仅重复只读盘点；不批量apply。
