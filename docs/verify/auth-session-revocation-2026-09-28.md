# 技术债 B1b：旧会话撤销验证

基线：`1ebd9461bffc6912bb4200cc6afac45d8b444213`；分支 `fix/auth-session-revocation`。
范围：[B1b spec](../plan/specs/auth-hardening.md)、[ADR-0037](../develop/decisions.md#adr-0037-jwt-绑定当前凭据状态node-中间件只读核对撤销)。
本切片尚未合入、部署；生产已运行 B1a，不能把以下本地证据称为生产撤销已生效。

## 实现与安全边界

- Credentials 登录从实际验密的同一快照派生 HMAC 版本；authNodeConfig 给 middleware 与完整 auth
  使用同一个核对回调。当前账号身份、角色、版本必须同时匹配。
- 独立只读连接不创建数据库、不初始化/迁移、不恢复或播种，查询失败也关闭；不缓存用户状态。
- 改密、role-only 降权、删除、同邮箱同密码重建、bootstrap 密码轮换均拒绝后续旧会话请求。
- 客户端 session update 不能改身份/角色/版本；公开 session、公开用户信息不带版本、密码或哈希。
- 缺版本的旧 JWT 首次上线后需重新登录。现有原文/报告白名单、模型、provider、thinking 与评测口径不变。
- 状态指纹不是持久撤销日志：旧 DB/旧哈希/旧 bootstrap 密码恢复可能使状态再次匹配，必须轮换 AUTH_SECRET。
  新增反例测试明确证明该边界；运维手册已写入恢复、主动回退、自动回退时的维护隔离与轮换验收。
- 每次认证增加短生命周期只读连接/账号查询（middleware 与 handler 可能各读一次），不宣称零成本或多实例扩展能力。
- 不承诺中断已经通过授权的在途响应/任务，无逐设备撤销 UI。没有 schema 迁移或新依赖。

## 本地验证

Node `24.19.0`，独立 worktree，所需 gitignored 配置已复制并 chmod 600、隔离 DB_PATH/DATA_DIR；无数据复制。
测试仅使用临时/内存 DB、人造凭据；新 HTTP E2E 关闭告警渠道，不调用模型或生产服务。

| 验证 | 结果 |
|---|---|
| `npm run test:coverage`（最终版） | 216 个 Vitest 文件 / 2,181 tests；随后 Node 运维 24/24，全部通过 |
| 覆盖率 | statements 76.62%、branches 69.23%、functions 76.93%、lines 80.51%；阈值未修改 |
| `npm run typecheck` | TS7/TS6 的应用/工具共 4 项检查通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过；保留既有 middleware → proxy 弃用提示 |
| `ALERT_WEBHOOK= npx vitest run --config vitest.e2e.config.ts` | 使用最终 production build，5 文件 / 5 tests 通过 |
| `git diff --check` | 通过 |

真实 HTTP E2E 不是直接调用替身 handler：使用 CSRF → Credentials callback → 加密 cookie → middleware/API。
改密/删除走 admin API；降权直接修改隔离 DB 的 role，避免靠密码重盐“顺便”完成撤销。
验证旧 cookie 的报告 API 401、报告页跳登录、session API 无用户；新密码/重建账号可正常读取，viewer 仍为 admin API 403。
还验证客户端 update 注入、真实加密旧版无版本 cookie、临时重命名用户表触发查询失败、恢复后合法会话可读、
同库且同 AUTH_SECRET 重启仅更换 bootstrap 密码时旧管理员 cookie 拒绝。

首轮 HTTP 测试因测试辅助函数只接受绝对 Location 地址失败；修正为按测试 base 解析相对/绝对重定向后，
保持 307 与 `/login` 断言不变并完整重跑。另按实际 Auth.js env 优先级对齐 `AUTH_SECRET ?? NEXTAUTH_SECRET`，
补充显式空主 key 拒绝、仅缺失主 key 才使用 legacy alias 的反例，最终测试/build 均已重跑。

## Pre-PR AI Review

- 基线：`origin/main` @ `1ebd9461bffc6912bb4200cc6afac45d8b444213`
- 范围：认证、只读 DB、Node middleware、session 配置、HTTP/单元测试、Docker CI、spec/ADR/运维说明
- 风险级别：高（认证、原生模块、部署边界）
- reviewer：`session_revocation_review`，独立全新上下文，只读；未读取配置凭据或生产数据。
- 结论：第二轮定向复查通过。

### Blocking

无。

### Warning

已解决 1 项：spec 的恢复/回退 AUTH_SECRET 轮换前置条件没有同步到实际运维手册。
现已覆盖 §6 恢复/全卷、§8 主动及自动回退，区分认证密钥与 redaction registry 历史 HMAC，
明确维护隔离、重建容器（非 restart）、旧 cookie 拒绝/新登录成功后才恢复外部访问。
workflow 不自动轮换密钥或隔离流量，这些仍是 operator 的执行前置条件，不冒充自动化保证。

### 独立证据

- 最终 4 文件 / 40 tests、真实 session-revocation HTTP E2E 1/1、diff check 均通过。
- 独立用真实函数验证“旧哈希恢复会复活 → 轮换 secret 后拒绝”，之后该反例纳入正式测试。
- Docker CI 新增 admin 200、reader 200、改密后 reader 401；不再以仅返回隐藏 404 作为已认证证据。
- Docker 执行结果待 PR CI，不把本地 Next build/HTTP 结果写成 Docker 已通过；创建 PR 后再核对最终 diff。

Blocking：0；Warning：0（原 1 项已修正）。不涉及 AI 语义，无需真模型 A1，不产生新的模型 baseline/DCP。

## 发布交接

1. PR CI，尤其 standalone Docker 真实认证/撤销检查必须通过，再考虑合入。
2. 上线前通知旧会话重新登录，按运维手册安排跨 B1b 安全边界的维护隔离与回退准备，避开每日管线窗。
3. 生产只验证正常登录/权限/运行版本/worker，不对真实用户改密/降权/删除来造反例。
4. B1a 的合入、镜像及生产核验另见 [B1a 记录](auth-login-throttle-2026-09-27.md)；其旧分支仅完成清理候选审核，未在本轮删除。
