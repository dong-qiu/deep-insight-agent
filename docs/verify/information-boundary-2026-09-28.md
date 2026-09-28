# B2 信息边界验证收据

日期：2026-09-28。基线：`a8865ecf98a0287521a2474996c9863125ebee26`。
切片：TD-08；[验收规范](../plan/specs/information-boundary.md)。

## 变更与保留边界

- 应用 logger 在参数、child/setBindings 和最终 JSON 三处建立诊断边界；受控类型/原因码替代未知错误正文。
- Run insert/finish、失败 webhook、报告/原文归档失败、现有 catch 日志及 API 失败响应采用安全诊断副本。
- 保留原始异常重抛及重试、拆批、fencing、成功返回值；模型/prompt、抓取、引用判定、报告正文不变。
- 数字 token 用量仍保留；同名字符串不获豁免。未删除或重写历史日志、Run、报告及数据库。
- Docker 上下文默认拒绝、按构建输入放行；允许目录内再排除本地凭据、DB、缓存和 agent 配置。

## 本地验证

Node `24.19.0`，独立 worktree、隔离临时/内存 SQLite，仅人造敏感串；未读取真实密钥作测试。

| 命令 / 场景 | 结果 |
|---|---|
| `npm run test:coverage` | 219 文件、2200 项 Vitest + 24 项 Node 运维测试通过 |
| 全局覆盖率 | statements 76.93%、branches 69.67%、functions 77.16%、lines 80.87%；门槛不变 |
| `npm run typecheck` | TS7 / TS6 应用与工具检查通过 |
| `npm run lint`；`git diff --check` | 通过 |
| `npm run build` | 生产构建通过 |
| `ALERT_WEBHOOK= npx vitest run --config vitest.e2e.config.ts` | 6 项 HTTP E2E 通过 |
| `node ops/check-docker-context.mjs` | 本机 Docker daemon 未运行；真实 COPY/export + 完整镜像构建由 CI 核验，尚未记为通过 |

关键反例覆盖：

- 深层数组、大小写/分隔符凭据、SMTP_PASS、request/response/raw body、promptText、URL、认证头、PEM。
- Error 的无标记私密 message/cause/stack、toJSON、自定义 child serializer、孙级 logger 与 setBindings。
- 真实 SQLite Run 原始行、runJob 原样重抛、失败 webhook 实际 payload。
- 缓存损坏/SQLite trigger 失败、报告写失败/缺失路径、原文归档中断；均保持原来的失败/不可见状态。
- cron/PPT/重试/删除 API 错误；真实登录后 PPT HTTP 500 与服务端日志不泄露人造 SQL 标识及 stack。
- Docker 脚本只拷贝 `.dockerignore` 至自有临时上下文，构造 22 个应保留和 33 个应排除文件；
  不把工作区的真实秘密送入构建器，CI 随后另做真实项目镜像构建。

## 独立审查与 Eval-Gate

初轮独立 reviewer 发现并要求修复三类 Blocking：字段别名遗漏、子 logger 序列化前边界遗漏、
现有 catch 出口遗漏；另要求避免提前字符串化丢失原因码。已修复并补反例。
第二轮独立复核通过：Blocking 0、Warning 0；reviewer 独立重跑 9 文件 / 147 项定向测试，
并核对 child/toJSON/serializer、最终 JSON、SQLite 反例与 AI diff。最后一处 P1 指标错误日志
也已改为传原始 Error 至诊断边界，不改变休眠开关或指标写入行为；此修复后已重跑上述全部本地验证。

Eval-Gate 使用 `skip`：AI 面 diff 仅诊断副本/日志，不修改模型输入、来源获取、重试与验收口径。
未运行真实模型 A1，不将无关 A1 波动作为此切片的通过证明；全量确定性回归覆盖现有 AI 与发布测试。

## 状态与回退

PR [#363](https://github.com/dong-qiu/deep-insight-agent/pull/363) 已创建。
首轮 CI 的应用验证全部通过，但真实 Docker 测试发现 `!ops/` 会连带放行未枚举的子文件：
人造 `ops/aws/config.sh` 进入上下文。已在放行父目录后重新排除 `ops/**`、`vendor/**`，
再逐项放行所需文件；补充未枚举运维脚本/其他 vendor 反例。此处不降级测试或删除失败样本。
修复后 Docker 与完整 CI 尚待重跑；最终结果见 PR 回执。未合入、未生产发布。
无 schema/迁移。生产发布需另行确认，核对运行版本/镜像，避开每日管线窗口；回退只回退代码。
不得宣称历史数据泄露已清理。第三方框架自身 stdout、一次性运维工具以及任意无标记自由文本
不由本切片保证识别；新诊断出口继续使用安全摘要，不打印原始 SDK 错误。
