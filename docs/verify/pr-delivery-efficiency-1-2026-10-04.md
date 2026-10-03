# PR 1：文档轻量 CI 与镜像发布判定实施收据

验收依据：[专属 spec](../plan/specs/pr-delivery-efficiency.md#pr-1文档轻量-ci-与发布判定)。这是提交前收据；候选与 main 的最终结果保存到对应 PR 摘要和 Actions，不追加候选提交补链接。

## 范围

基线 `065dd0cf7a8f06d4becd093da2f133fc552ce201`；独立 `feat/pr-delivery-docs-ci` worktree。仅复制主工作区 gitignored `.env.local`，权限 0600，已配置 DB_PATH/DATA_DIR 改为本 worktree 隔离路径；未复制数据、SQLite/WAL、报告或 `.env.development.local`，未修改其他会话的 roadmap/ADR 或文档。

新增无 npm 分类/文档检查/必需汇总/发布 admission 与实际 Git/CLI 反例，修改 CI 和镜像发布工作流。文档白名单经 `.dockerignore`、Dockerfile、Next 配置、TS 配置及源码调用点核对：两个目录不参与应用构建、运行或 Docker 上下文。完整验证仍串行 Docker，PR 3 才解除该依赖。必需检查名、保护规则、C5 build/E2E 身份、prototype release evidence 契约均保留。

发布先用只读 admission 核验源 CI API 身份和 attempt jobs、绑定 scope 产物并重新检查 Git 完整范围；完整代码还需原 CI/Docker 证明。只有 admitted full 路径的后续 job 获得 packages:write。文档跳过镜像构建/发布，没有生产部署。

## 本地验证

Node 24.19.0 / npm 11.17.0，独立干净 `npm ci` 成功，audit 0。TS6/TS7 app/tools 四项、lint、coverage 均通过：234 文件 / 2,366 用例。最终运维 Node 套件 147/147，其中本次 38 个测试包含分类、文档、身份、汇总和发布反例；实际 CLI 在无 npm fixture 中验证 docs/full 分流与拒绝路径。

`build:e2e` 通过，应用 build `21.779 s`、builds=1；`test:e2e:built` 6/6，通过身份校验且 additional_builds=0。`actionlint -shellcheck=''`、`git diff --check` 和本收据/spec 链接检查通过。Shellcheck 对既有及新 Node 单引号脚本的 SC2016 是字面量 JavaScript template expression；未把它当成 shell 展开。

本地 Docker daemon socket 不存在，没有启动或改动其他会话 Docker；候选 Actions 必须补齐原 Docker context secret、runtime assets、真实 HTTP/auth 和 readiness 验证，未完成前不合并。

## 独立审查

按 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md) 使用新上下文审查最终完整差异及验收标准。初审风险高，Blocking 0 / Warning 2：角括号 reference destination 的 inbound 删除断链遗漏，以及 Setext/slug 碰撞/代码示例 HTML 锚点误判。已规范化 reference destination、补标题支持和碰撞检测、排除 fenced/inline/indented code 中的 HTML anchors，增加实际反例。经两次定向修复复核，最终通过，Blocking 0 / Warning 0；reviewer 独立复跑 38/38，实际 spec/收据 2 文件 22 ms，diff 检查通过。PR 创建后再次独立核对远端 diff、候选 SHA、摘要和证据。

## 证据与限制

启动 [main CI 37137081561](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37137081561) 绑定基线并 success。上述本地结果不冒充候选 Actions 或主干验收；没有文档轻量构建证明。scope artifact 单独命名且保留 90 天，记录候选/实际测试 SHA、run ID/attempt、事件范围与分类，不是完整发布质量证明。

不改模型、prompt、引用 validator、来源、数据集、评分、依赖或 vendor。Eval-Gate skip 仅为 CI/ops 交付路径且 AI 输出/评测语义不变；A1 不验证此路径。历史与本地计时均为单次观察，队列另记，不宣称 P95 或受控比例。文档真实 PR/main 路径由下一项验收，PR 1 自身必须 full。

## 回退

正常 revert PR 回退 scope、必需门和 admission 工作流到完整 CI/原发布路径，回退本身须完整验证。无数据/schema 迁移；没有生产部署，镜像发布成功也不代表生产已上线。
