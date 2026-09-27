# B1 认证保护：限速与撤销分开交付

日期：2026-09-27；承接 [技术债治理 B1 / TD-03](technical-debt-remediation.md)。

## 当前边界

当前部署为单应用容器、自托管 Node.js、Auth.js Credentials + JWT；环境变量管理员与
SQLite `app_user` 账号共存。`/api/auth/*` 被 middleware 的通用 API 限流排除。
middleware 只验证 JWT，不查用户当前状态，因此改密/降权/删除后旧会话目前仍可能有效。

本任务不改模型、评测、报告发布规则，不新增 Redis、认证服务或 schema 迁移。
两个切片独立 review / PR；B1a 完成不能代替 B1b。

## B1a：登录尝试限速（本切片）

- 入口在 Credentials `authorize`，HTTP 登录与服务器 `signIn` 走同一守卫；在打开 DB 和
  scrypt 之前准入，不能只依赖 UI 或被认证路由排除的 middleware。
- 每个规范化邮箱（trim + 小写）固定 60 秒窗口，最多 5 次密码校验。成功清除该账号计数；
  错误、账号不存在及校验异常均不返还额度。管理员不豁免。
- 全进程 60 秒最多 60 次密码校验，成功也不返还全局额度；换邮箱不能无限触发 scrypt。
  账号已被拦截的请求不继续消耗全局校验额度。
- 不信任客户端 IP 或任意 `X-Forwarded-For`，本切片不靠 IP 作为安全边界。
  内存中仅使用邮箱摘要，最多保留 120 个账号桶；过期清理，容量满时拒绝，不淘汰活跃桶。
- 被拦截请求不延长窗口；到期自动恢复，无永久锁号。明确这是进程内预算，重启清零，
  多实例前必须换共享状态；定向攻击仍可暂时阻塞某账号，轮换账号耗尽全局预算可暂时影响新登录。
  已登录会话及 worker 不受影响；不将本实现称为完整抗 DDoS。
- 缺失或非字符串凭据返回通用认证失败，不调用 DB；不记录密码、邮箱或请求头。
- 使用 Auth.js 的 `CredentialsSignin` 安全错误码 `rate_limited`，保持框架的重定向/JSON 协议
  （不承诺 HTTP 429）；登录页提示稍后重试。错误码不透露账号是否存在。
- 5 / 60 秒、60 / 60 秒是内部小规模部署的初始保护预算，不是模型质量阈值或已实测的最佳参数。
  参考 [OWASP 登录限速建议](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling)
  的账号维度、有限锁定及可用性权衡；不引入新的可调环境变量体系。

### B1a 验收用例

1. 前 5 次校验允许，第 6 次（包括正确密码）在 DB/hash 前被拦；到期恢复。
2. 邮箱大小写/空白共用桶；修改转发头不能绕过；不同账号独立。
3. 成功只重置本账号失败预算，不能重置全局预算；轮换邮箱达到全局限额仍被拦。
4. 重复被拦不延长窗口；过期桶回收；满容量拒绝新增但不清除已有锁定。
5. 账号不存在、错误密码、内部校验异常不会返还额度；非字符串/缺失输入不进入 DB。
6. 真实隔离 DB 验证 env admin 与 DB viewer 都受同一守卫且公开用户结构不变。
7. production build 的真实 HTTP 路径：CSRF + callback，错误达到限额后正确密码仍无 session；
   未受限 viewer / admin 仍可登录、访问各自允许的 API；viewer 不获得管理员权限。
8. 既有认证/角色测试、完整类型检查、lint、build 和 E2E 通过；无需真实模型 A1。

## B1b：旧会话撤销（下一独立切片，尚未实现）

先确定服务端当前凭据版本的表示及校验入口，再实现；不把密码/密码哈希写进公开 session。
必须覆盖 middleware 的普通页面/API，不能只在 admin handler 增加检查。

验收至少包括：改密后旧 cookie 拒绝、降权后旧管理员权限拒绝、删除后旧 cookie 拒绝、
删除再建同邮箱旧 cookie 不复活、bootstrap 密码轮换、旧 token 缺少版本信息、
客户端 session update 不能改角色/版本、DB 不可用时 fail closed；同时验证合法会话正常读取。
使用真实登录 cookie + 受保护 API/页面证明撤销，不以单独 token 函数测试代替。
若更改 middleware 引入 DB 的架构边界，先补 ADR、Node/Docker 构建与失败路径验收。

## 发布与回退

B1a 无存量数据迁移，回退代码恢复旧行为。不得靠重启清空计数作为正常登录手段。
先完成独立审查及 PR CI；本切片不会自动撤销所有现存登录，不把 B1b 写成已解决。
