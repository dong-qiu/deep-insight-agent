# C5 / TD-17：CI 构建复用收据

本切片仅 C5，验收见 [spec](../plan/specs/ci-build-reuse.md)。实施前已读取独立计划 worktree 中的 `technical-debt-parallel-execution.md` 与 `technical-debt-preflight-2026-10-03.md`。

## 工作区与范围

- fetch 后从 `origin/main` @ `bbd827688f9d9d8073bfecc596ffbf4742a4b83b` 新建 `fix/c5-reuse-ci-e2e-build` / `insight-agent-c5`。
- 保留其他 worktree 和未提交改动；复制的 gitignored `.env.local` 权限 0600，DATA_DIR/DB_PATH 指向本 worktree。未复制原有数据、SQLite/WAL、报告或 `.env.development.local`。
- 仅修改 CI/E2E 入口、增加构建收据与反例、同步 README 和专属 spec/收据。没有改 dependency、lockfile、runtime/types、vendor、应用、AI、schema、共享 roadmap/ADR。
- 主干已有 CI [37124916833](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37124916833) success；本切片不涉及生产版本变化、部署、恢复、历史回填或清理。

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

PR/CI 结果待记录；Docker 验证由保留的下游 CI 作业执行，本地没有冒称容器验证完成。

## 收口边界

C5 本地实现与反例已完成；独立审查通过，待 PR CI（包含 Docker）核验。D5 未开始，TD-18 未关闭。无生产发布，本切片可通过回退 CI 到重复构建路径回退，不涉及数据迁移。
