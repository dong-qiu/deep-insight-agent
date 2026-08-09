# Insight Agent

[![CI](https://github.com/dong-qiu/deep-insight-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dong-qiu/deep-insight-agent/actions/workflows/ci.yml)

**持续追踪一个行业主题，并将公开信息转化为可回溯的研究简报、深度报告与技术规划候选。**

Insight Agent 面向需要长期追踪技术与行业变化的研究者、技术和产品从业者。它围绕配置的主题采集公开来源，经过分析与独立校验后生成报告；`blocked` 或没有校验记录的引用不会进入报告，`flagged` 引用会带状态标签展示（如“待核实”或“校验失败·待重试”），读者可以回到原文核查结论。

> 当前状态：MVP 已完成；技术线索与技术规划 V1 已上线，正在进行真实数据 dogfood。范围与后续计划见 [路线图](docs/plan/roadmap.md)。

## 为什么使用它

- **主题持续追踪**：按主题持续采集与归并，而不是一次性搜索后丢弃上下文。
- **可溯源的报告**：引用同时经过原文可达性与“引用是否支持结论”的一致性校验；每条发布洞察至少有一条成功校验的引用，`flagged` 引用会显式带状态标签。
- **从情报到研究候选**：从通过校验的事实证据派生技术线索，再由人工映射为研究、PoC 或立项候选；系统不会自动立项。
- **可自托管**：Next.js 应用、任务调度和 SQLite 数据均可通过 Docker Compose 在单机持久化运行。

## 当前能力与边界

| 已具备 | 当前边界 |
|---|---|
| RSS、arXiv 与播客 show notes 等公开来源采集 | 视频字幕 / ASR 与社交平台官方 API 仍在后续评估 |
| 每日 Brief、主题报告、报告库检索筛选、实体共现图 | 完整语义知识图谱与趋势预测尚未实现 |
| 采集 → 分析 → 校验 → 报告的可观察流水线 | 当前以单管理员、共享数据空间为主 |
| 技术线索、技术机会与技术方向工作台 | 技术规划 V1 正在 dogfood，候选必须由人工推进 |
| 邮件 / Webhook 报告推送、失败告警与预算熔断 | 更多推送渠道和精细规则仍在迭代 |

## 工作方式

```text
Source → ContentItem → AnalysisBatch → ValidationResult → Report
                                      └→ TechLead → TechnologyOpportunity → 人工研究 / PoC / 立项评审
```

数据源抓取统一经过 `src/lib/sources/`；报告生成按 validator 结果白名单处理引用：展示 `pass` 与带状态的 `flagged`，排除 `blocked` 和无校验记录。完整的数据模型和部署架构见 [架构文档](docs/plan/architecture.md)。

## 快速开始

### 前置条件

- Node.js `>=20.9 <21`
- npm `>=10 <11`
- 用于运行分析与评测的 Anthropic API Key 或兼容中转站配置

### 本地运行

```bash
git clone https://github.com/dong-qiu/deep-insight-agent.git
cd deep-insight-agent

cp .env.example .env.local
# 在 .env.local 中至少配置 AUTH_SECRET、ADMIN_EMAIL、ADMIN_PASSWORD；
# 运行分析/评测前再配置 ANTHROPIC_API_KEY。

npm ci
npm run seed
npm run dev
```

打开 <http://localhost:3000>，使用 `.env.local` 中的管理员账号登录。`seed` 会写入默认主题和数据源；在“设置”中可继续调整主题、来源与收件人。

环境变量说明、模型中转站限制和运行配置见 [.env.example](.env.example) 与[运维手册](docs/launch/operations.md)。不要提交 `.env.local`、API Key、生产数据库或个人数据。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动本地开发服务 |
| `npm run seed` | 写入默认主题与数据源 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行单元与集成测试 |
| `npm run test:coverage` | 生成测试覆盖率 |
| `npm run build` | 生成生产构建 |
| `npm run eval:a1` | 运行 A1 AI 质量评测（需要模型配置） |
| `npm run eval:opportunity-map` | 评估技术机会映射 |
| `npm run db:snapshot` / `npm run db:restore` | 导出或恢复本地 SQLite 快照 |
| `npm run branches:cleanup` | 只读列出可清理的已合并 PR 本地分支与 worktree |
| `npm run branches:cleanup -- --apply` | 清理经审核的本地候选；远程分支由 GitHub 合并后自动删除 |

修改 prompt、模型、校验逻辑、数据源或评测集前，必须运行 [`eval-gate`](.claude/skills/eval-gate/SKILL.md)，并在 PR 中附上相对基线的指标和可复查产物。

## Docker 部署

```bash
cp .env.example .env.local
# 填写 ANTHROPIC_API_KEY、AUTH_SECRET、ADMIN_EMAIL、ADMIN_PASSWORD、CRON_SECRET

# Apple Silicon 使用 TARGETARCH=arm64；x86_64 可省略该变量。
TARGETARCH=arm64 docker compose up -d --build
```

Compose 会启动：

- `app`：Web 应用与任务执行器；
- `cron`：按 `ops/crontab` 调用定时管线；
- `insight-data`：保存 SQLite 数据库、报告和备份的持久卷。

健康检查为 `GET /api/health`。生产部署、备份恢复、告警和排障步骤请遵循 [运维手册](docs/launch/operations.md)；代码合入不等于已发布到生产。

## 文档导航

| 文档 | 内容 |
|---|---|
| [产品定义](docs/concept/product-definition.md) | 用户问题、产品范围、已实现能力与后续边界 |
| [架构设计](docs/plan/architecture.md) | 数据流、模块职责、数据模型与部署架构 |
| [路线图](docs/plan/roadmap.md) | 里程碑、当前 dogfood 与后续计划 |
| [功能规格](docs/plan/specs/) | 各功能验收标准与约束 |
| [质量标准](docs/verify/eval-criteria.md) | AI 输出评测口径与基线门槛 |
| [运维手册](docs/launch/operations.md) | 部署、备份、监控、告警与故障排查 |

## 贡献与质量流程

1. 阅读 [AGENTS.md](AGENTS.md) 和受影响功能的 spec；从功能分支开始修改，不直接推送 `main`。
2. 创建或更新 PR 前，运行共享的 `pre-pr-ai-review` skill（Codex：`$pre-pr-ai-review`；Claude Code：`/pre-pr-ai-review`）；它会输出可带入 PR 的风险、测试和评测证据摘要。
3. 运行与改动相称的测试及 `npm run typecheck`；涉及 AI 高风险改动时按 `eval-gate` 运行对应评测。
4. 使用 PR 模板说明变更、验证、风险和发布影响。`main` 只通过 PR 合入，且必须通过 CI、Eval-Gate trailer 和 Docker 构建。

详细的协作约束、引用安全红线和双工具兼容规则以 [AGENTS.md](AGENTS.md) 为准。

## 安全

不要在 issue、PR、日志或提交中包含 API Key、密码、生产数据或个人数据。发现潜在凭据泄露或引用安全问题时，先停止公开扩散并联系维护者处理；相关代码改动必须走正常 PR 与质量门。
