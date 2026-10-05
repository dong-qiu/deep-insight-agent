# C5 / TD-17：CI 构建复用收据

本切片仅 C5，验收见 [spec](../plan/specs/ci-build-reuse.md)。实施前已读取独立计划 worktree 中的 `technical-debt-parallel-execution.md` 与 `technical-debt-preflight-2026-10-03.md`。

## 工作区与范围

- fetch 后从 `origin/main` @ `bbd827688f9d9d8073bfecc596ffbf4742a4b83b` 新建 `fix/c5-reuse-ci-e2e-build` / `insight-agent-c5`。
- 保留其他 worktree 和未提交改动；复制的 gitignored `.env.local` 权限 0600，DATA_DIR/DB_PATH 指向本 worktree。未复制原有数据、SQLite/WAL、报告或 `.env.development.local`。
- 仅修改 CI/E2E 入口、增加构建收据与反例、同步 README 和专属 spec/收据。没有改 dependency、lockfile、runtime/types、vendor、应用、AI、schema、共享 roadmap/ADR。
- 主干已有 CI [37124916833](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37124916833) success；本切片不涉及生产版本变化、部署、恢复或历史回填；合入后仅审核本地分支清理候选。

## 行为与失败边界

`build:e2e` 开始先作废旧收据，调用原 `npm run build`；成功、构建前后输入相同且输出完整后才写入 `.next/e2e-build-receipt.json`。`test:e2e:built` 先验证收据，失败直接停止，成功才启动现有 Vitest E2E。本地 `test:e2e` 仍先调用构建入口。

身份包括 worktree realpath、HEAD、Node、GitHub run/attempt/tested SHA、源码（含参与构建类型检查的 evals）及 public/vendor/新增配置/环境文件/lockfile 的内容摘要，以及 NEXT_* / NODE_ENV、NODE_OPTIONS/NODE_PATH、Babel/Browserslist 的环境摘要。不保存环境值或文件内容。缺失/损坏/超过一小时/未来时间的收据，源码或配置/运行身份变化，产物缺失/替换，构建失败/信号退出/期间输入变化均拒绝。

产物摘要覆盖 `.next` 的生产输出；cache、trace、收据和 standalone 不参与摘要。E2E 启动的是 `next start`，读取 server/static 和根 manifests；Docker 使用独立 standalone 构建与运行门，保持原配置。

## 本地验证与计时

环境：macOS arm64，Node 24.19.0、npm 11.17.0，独立 `npm ci` 成功，audit 0 漏洞。开始曾用机器默认 Node 25 安装，已在 Node 24 下重新执行干净 npm ci，以下验证均为 Node 24。

- C5 定向 Node 测试：32/32，通过实际 verify CLI 验证拒绝与放行，并覆盖源码/配置/环境/HEAD/worktree/产物身份反例。
- 递归运维 Node 测试：109/109，通过；新套件自动进入 test/coverage 共用清单。
- `npm run typecheck`：TS7 和 TS6 的 app/tools 检查全部通过。
- `npm run lint`、`git diff --check`：通过。
- 原入口等价路径：先 build，再 E2E 内部 build，再调用原 Vitest E2E，全部 6 文件/6 用例通过。
- 新 CI 入口：`build:e2e` 后 `test:e2e:built`，全部 6 文件/6 用例通过。
- 本地默认 `npm run test:e2e`：自动构建一次，全部 6 文件/6 用例通过。

| 单次本地路径 | 首次 build | E2E 内部 build | 校验及 E2E | 应用 build 次数 |
| --- | ---: | ---: | ---: | ---: |
| 原 verify 等价入口 | 21.439 s | 13.743 s | 5.360 s | 2 |
| 新 CI 入口 | 13.187 s | 0 | 5.015 s | 1 |

本地默认入口总计 17.558 s，收据中的 build 为 12.199 s。旧路径首次构建为空 `.next`，且与 typecheck/lint 并行；后续构建为热缓存。新路径同机器/依赖/源码内容，但缓存及并行负载不同。这些是功能与阶段计时收据，**不是受控 CI before/after、加速比例或 P95**；历史 CI 观察也不充当受控基线。

## Eval 与审查

按 eval-gate 核对：合法输入的 AI 输出与评测口径不变，改动不执行模型、prompt、validator、coverage/来源逻辑。未运行 A1；它不覆盖此构建入口。提交使用 `Eval-Gate: skip (C5 CI build reuse only; AI output and eval semantics unchanged)`。

独立 Pre-PR AI Review：通过，风险级别中，Blocking 0 / Warning 0。审查独立复跑最终 32 个用例及 diff 检查。初审指出新增构建配置/evals 类型检查输入遗漏与 NODE_OPTIONS 遗漏，均已加拒绝反例并修复；修正输入清单后显式排除生成的 .next，最终再次复跑构建、两条 E2E 入口、lint 和 Node 套件。

## PR 与主干验收

- 实现 PR [#396](https://github.com/dong-qiu/deep-insight-agent/pull/396)，候选 `bb55b70583ceb7ce39a927c9499a101f3aa04b46`。
- PR CI [37129819605](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37129819605)：4 项检查全部 success，包括完整 verify 与独立 Docker。coverage 执行 231 文件 / 2,345 用例通过，运维 Node 109 用例通过，真实应用 E2E 6/6 通过。
- CI 日志确认 `build_ms=53072, builds=1`，紧接的 E2E 记录 `build_ms=53072, additional_builds=0`。主验证和 E2E 确实复用同次产物。
- Docker 作业包含构建上下文、镜像构建、dispatch worker/runtime assets、真实 HTTP/auth 与 dispatch readiness、prototype Docker evidence，全部通过。本地没有执行容器验证，以上为 Actions 证据。
- PR 创建后独立复核最终 7 文件 diff 与前置审查一致，Blocking 0 / Warning 0，无凭据、构建产物或 D5 变更。
- 按用户授权，于 `2026-10-03T14:42:04Z` 转为 Ready 并 squash 合入，主干提交 `8723db8500fc265eefa951e288eb2d143468b6ff`。
- 合并后主干 CI [37130548182](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37130548182)：success；eval-gate、verify 和独立 Docker 全部通过，main 的 PR advisory 按设计 skipped。核验绑定上述合并 SHA，不以 PR CI 代替主干结果。

| CI 阶段观察 | 旧 main 37124916833 | C5 PR 37129819605 |
| --- | ---: | ---: |
| verify 总耗时 | 172 s | 221 s |
| next build | 35 s | 54 s |
| E2E（旧入口含内部 build） | 31 s | 10 s |
| verify 应用 build 次数 | 2 | 1 |
| 独立 Docker 作业 | 145 s | 204 s |

不同源码、缓存及 runner 负载下的运行仅作现场观察，不是受控 before/after 或 P95；本轮确认构建次数减少，不宣称 CI 总耗时加速。

## 发布与清理边界

C5 只调整验证入口，无运行时行为、schema 或配置变化，不需要生产部署；没有执行部署、恢复或生产诊断。GitHub 仓库 `delete_branch_on_merge=true`，远程短生命周期 head 由 GitHub 删除。主干 CI 通过后，已运行 `npm run branches:cleanup` dry-run 审核候选。实现分支 HEAD 与 PR 合并时 head 一致，未在合并后推进；本地实现分支为删除候选。远程实现 head 已通过 `git ls-remote --heads` 确认不存在。本次未执行 `--apply`，保留本地分支及当前 worktree，不清理其他会话。

## 收口边界

C5 实现、反例、独立审查、PR CI 与合并后主干 CI 全部完成；PR #396 已合入，TD-17 关闭。完成收据通过专属文档 PR 保存，未修改其他会话占用的 roadmap/ADR 或计划。D5 未开始，TD-18 未关闭。无生产发布，本切片可通过回退 CI 到重复构建路径回退，不涉及数据迁移。
