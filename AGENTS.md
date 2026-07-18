# Insight Agent 协作指南

本文件是 Claude Code 与 Codex 共用的仓库级指令。保持精简；较长的领域、流程和质量说明按任务需要读取 `skills/` 与 `docs/`。

## 项目目标

Insight Agent 是面向行业情报的多源洞察分析系统。核心链路是：

`Source -> ContentItem -> AnalysisBatch -> ValidationResult -> Report`

发布质量红线：报告中的引用必须可回溯到原文；引用一致性校验不得退化为只检查文本可达性。

## 文档导航

- 项目入口与本地运行：`README.md`
- 架构和数据模型：`docs/plan/architecture.md`
- 产品范围：`docs/concept/product-definition.md`
- 重大设计决策：`docs/develop/decisions.md`
- 里程碑状态：`docs/plan/roadmap.md`
- 部署与运维：`docs/launch/operations.md`
- 基础、领域、流程、质量细则：`skills/L0-foundation.md` 至 `skills/L3-quality.md`

只读取与当前任务相关的文档。涉及新功能、架构、AI 输出质量或生产部署时，先读取对应 spec、ADR 或质量规则。

## 常用命令

- 安装依赖：`npm ci`
- 本地开发：`npm run dev`
- 类型检查：`npm run typecheck`
- 单元/集成测试：`npm test`
- 覆盖率：`npm run test:coverage`
- 生产构建：`npm run build`
- AI 质量评测：`npm run eval:a1`

## 架构约束

- 依赖方向保持 `src/app -> src/lib/agents -> src/lib/sources`；不要从底层反向依赖 UI/API。
- 所有第三方内容抓取统一经过 `src/lib/sources/`；不得在页面或 agent 中散落外部抓取逻辑。
- SQLite schema 的事实源是 `src/lib/db/schema.ts`；实体契约同时对齐 `docs/plan/architecture.md`。
- 报告生成必须继续使用 validator 结果白名单；`blocked` 或没有校验记录的引用不得进入发布报告。
- 密钥只能来自环境变量；不得提交 `.env`、token、凭据、生产数据或个人数据。

## 变更工作流

- 新功能先确认或补充 `docs/plan/specs/` 下的验收标准。
- 重大架构或产品取舍先记录到 `docs/develop/decisions.md`。
- 修改 prompt、模型、校验逻辑、数据源或评测集时，必须使用仓库的 `eval-gate` skill：Claude Code 调用 `/eval-gate`，Codex 调用 `$eval-gate`。
- 纯重构只有在确认 AI 输出和评测口径不变后，才可使用 `Eval-Gate: skip (<原因>)`。
- 测试应与风险相称；至少运行受影响模块测试和 `npm run typecheck`。影响构建、路由或部署时再运行 `npm run build`。

## Git 与安全

- 保留用户已有的未提交改动，避免覆盖或格式化无关文件。
- `main` 走 feature branch -> review -> PR -> CI -> merge；不直接推送 `main`，不跳过 Git hooks。
- 不执行破坏性 Git、数据库、部署或文件删除操作，除非用户明确授权且目标已核实。
- 多 worktree/环境不得共享 live SQLite 数据库；使用快照或 seed 建立隔离环境。

## 部署核验

- 合入不等于上线；验证生产修复前先确认实际运行版本和镜像内容。
- code-only 重部署不要直接运行会覆盖生产 `.env.local` 的全量部署脚本；按 `skills/L2-workflow.md` 和运维手册执行。
- 避开每日管线窗口 `16:50-17:30 UTC`，防止重启孤儿化在途 Run。

## 双工具兼容

- `AGENTS.md` 是共享规则的唯一事实源；`CLAUDE.md` 只负责导入本文件并承载 Claude Code 专属补充。
- 共享技能只维护一份正文；`.agents/skills/` 与 `.claude/skills/` 通过 symlink 暴露给各自工具。
- 权限、模型、MCP 和 lifecycle hooks 属于工具运行配置，分别放在 `.codex/` 与 `.claude/`，不得在仓库配置中写入密钥。
- 通用强制门优先放在 `.githooks/` 和 CI，避免为两个工具维护重复 hook。
