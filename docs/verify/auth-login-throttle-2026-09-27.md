# 技术债 B1a：登录限速验证

基线：`5f8efa0da00e5658182c659dbfdc728c7f7f832c`；分支 `fix/auth-login-throttle`。
范围：[B1a spec](../plan/specs/auth-hardening.md)。B1b 会话撤销尚未实现，不把本批当作 TD-03 全部关闭。

## 实现与边界

- 在 Auth.js Credentials `authorize` 中准入，DB 获取、同步 SQLite/scrypt 校验均在守卫之后。
- 规范化邮箱摘要桶：5 次 / 60 秒；全局密码校验预算：60 次 / 60 秒；容量 120 个桶。
  失败/异常不退款，成功仅清本账号；拒绝不延长窗口；不信任 IP 转发头。
- Auth.js 安全错误码 `rate_limited`，登录页给出稍后重试提示；非字符串/空输入不进入 DB。
- 管理员不豁免；已有会话不受新登录限速影响。进程重启清零，不适用于无需共享状态的多实例防护。
- 保留短时账号/全局拒绝服务风险，未宣称完整抗 DDoS；未引入持久锁号、新依赖或 schema 迁移。
- 同时刷新 A 批已上线证据及架构文档原先错误的“session 落 SQLite / 使用 rate-limit-flexible”描述。

## 验证结果

Node `24.19.0`；新 worktree 仅复制 `.env.local`，权限 600，DB_PATH/DATA_DIR 已隔离，不复制数据。
测试使用内存/临时 SQLite；新 E2E 关闭告警 webhook，使用人造账号，不调用模型或生产服务。

| 验证 | 结果 |
|---|---|
| 限速 / authorize / users 定向测试 | 3 文件、31 tests 通过 |
| `npm run test:coverage` | 214 个 Vitest 文件、2,162 tests 通过；Node 运维测试 24/24 通过 |
| 覆盖率 | statements 76.51%、branches 69.10%、functions 76.77%、lines 80.41%；未修改阈值 |
| `npm run typecheck` | TS7/TS6 的应用及工具共 4 项检查通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过；保留仓库既有 middleware → proxy 弃用提示 |
| `ALERT_WEBHOOK= npx vitest run --config vitest.e2e.config.ts` | 4 文件 / 4 tests 通过，复用本次 production build，各自临时 DB |
| `git diff --check` | 通过 |

真实 HTTP 测试以 CSRF → Credentials callback → cookie → 受保护 API 验证：前五次错误密码失败；
第六次即便密码正确也拒绝；大小写/空白和不同转发头不绕过；其他账号正常；管理员也受限；
已登录管理员仍访问 admin API，viewer 的 admin API 请求为 403，普通报告 API 为 200。
到期恢复、全局额度与容量耗尽用可控时钟单测验证；未将这些写成真实等待一分钟的 HTTP 观测。

测试开发曾因 helper 直接导入 `next-auth` 触发其 `next/server` 的 Vitest 模块解析错误；
将框架错误适配保留在 `auth.ts`、纯守卫使用普通错误后，单测与真实 Auth.js E2E 均通过。
没有通过 mock Auth.js 认证流程掩盖该问题。

## Pre-PR AI Review

- 基线：`origin/main` @ `5f8efa0da00e5658182c659dbfdc728c7f7f832c`
- 范围：B1a 认证入口、限速器、登录反馈、测试、spec、A 批收口证据
- 风险级别：中（认证）
- 独立 reviewer：`auth_throttle_review`，全新上下文、只读审查；未访问凭据或生产数据。
- 结论：通过。

### Blocking

无。

### Warning

无。

### Suggestion 与处理

- `users.ts` 的“管理员不会被锁死”旧注释容易被误解为限速豁免，已澄清为 env 优先权和短时限速的区别。

### 独立证据

- 5 文件 38 tests（额外含 auth-guard）、新真实 HTTP E2E 1/1、双版本应用/工具 typecheck、diff check 全通过。
- 只读核对 PR #359 及 CI/镜像/部署的 GitHub 元数据一致；运行时生产检查由主执行会话完成，不宣称 reviewer 再次访问生产。
- 不影响 AI 输出路径，无模型 A1 / baseline 变更；没有把认证测试称为模型质量证明。

Blocking：0；Warning：0。提交后仍需核对最终 PR diff 与本摘要一致，并等 CI。

## 交接

本记录为本地验证及独立审查收据，不代替合入或生产部署。下一切片 B1b 先明确旧会话撤销的
凭据版本和中间件校验契约，再实现改密/降权/删除后的真实 API 拒绝测试。
