# PR 2：交付证据与收据归档流程实施收据

验收：[交付效率 spec](../plan/specs/pr-delivery-efficiency.md#pr-2收据归档流程)；流程：[交付证据流程](../plan/specs/pr-delivery-evidence-workflow.md)。此为提交前收据，候选/main 最终结果保存在 PR 摘要和 Actions，不追加 head 补链接。

## 范围

PR 1 [#405](https://github.com/dong-qiu/deep-insight-agent/pull/405) 已正常 squash 合入 `f390343df6ce604f5e8cbc2b79879b151c11410d`，对应 [main CI 37142631268](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37142631268) attempt 1 全部必需门和完整应用/Docker success；[镜像发布 37142970591](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37142970591) 只读 admission 和代码 GHCR job 均 success。先核验完上述实际 SHA 和发布行为，再从最新 main 的同一 SHA 建立本项独立 `docs/pr-delivery-evidence` worktree。

只新增交付流程文档、本收据，并在专属 spec 记录范围与前项结果。不修改 CI、hooks、skills、应用、依赖、模型/评测、共享 roadmap/ADR 或其他会话文件。配置从主 worktree 复制，权限 0600，DB_PATH/DATA_DIR 显式隔离；未复制数据、SQLite/WAL、报告或 `.env.development.local`。

## 本地验证

本项全部文件在已核验不参与构建/运行的 Markdown 白名单。PR 1 的实际文档 checker 验证链接/锚点、基本格式和五节收据结构，3 文件通过，单次 37.653 ms；`git diff --check` 通过。Node24.19.0/npm11.17.0 干净 `npm ci` 成功、audit 0；TS6/TS7 app/tools 四项通过。没有运行新的应用 build/E2E 或 Docker；typecheck 和文档检查不是完整 build/Docker 证明。

## 独立审查

按 pre-pr-ai-review 使用新上下文审查整个文档候选，最终通过，风险低，Blocking 0 / Warning 0。reviewer 独立文档检查 3 文件 25.281 ms、diff/未跟踪文件格式通过；只读 API 核实前项 merge SHA、main CI/发布身份和结果、原必需保护、327 s 及 90 天期限。保留前置审查和 PR 后远端 diff 复核；后者仍需在 Draft 创建后执行。

## 证据与限制

PR 1 main 应用 job 143 s、Docker job 162 s，串行；CI 从创建到最后必需 job 结束 327 s，其中初始调度 3 s。它是单次观察，不是 P95 或受控基线。新的 scope 证明只表示分类与身份，不能代替 prototype 完整 CI/Docker schema。

流程要求首次提交前收齐 spec/实施/本地验证/独立审查，CI 结果优先写 PR 摘要和 Actions；main 结果绑定实际 merge SHA。Actions 当前保留 90 天，新 scope 显式 90 天，长期归档需要保存实际原证据或明确摘要限制。此 PR 不创建外部存储、不改质量门、不部署生产；候选与 main 应走 docs 路径并跳过 GHCR，但通过真实 CI 后才登记完成。Eval 不适用，AI 输出/评测语义不变。

## 回退

正常文档 revert PR 回退交付流程与本项文档。无 CI 行为、模型、schema 或数据迁移；无生产部署。
