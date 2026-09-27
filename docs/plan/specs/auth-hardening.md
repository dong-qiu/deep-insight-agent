# B1 认证保护：限速与撤销分开交付

日期：2026-09-27；承接 [技术债治理 B1 / TD-03](technical-debt-remediation.md)。

## 实施基线（B1a）

当前部署为单应用容器、自托管 Node.js、Auth.js Credentials + JWT；环境变量管理员与
SQLite `app_user` 账号共存。`/api/auth/*` 被 middleware 的通用 API 限流排除。
middleware 只验证 JWT，不查用户当前状态，因此改密/降权/删除后旧会话目前仍可能有效。

本任务不改模型、评测、报告发布规则，不新增 Redis、认证服务或 schema 迁移。
两个切片独立 review / PR；B1a 完成不能代替 B1b。

## B1a：登录尝试限速（已合入并部署）

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

## B1b：旧会话撤销（当前实施切片）

先确定服务端当前凭据版本的表示及校验入口，再实现；不把密码/密码哈希写进公开 session。
必须覆盖 middleware 的普通页面/API，不能只在 admin handler 增加检查。

验收至少包括：改密后旧 cookie 拒绝、降权后旧管理员权限拒绝、删除后旧 cookie 拒绝、
删除再建同邮箱旧 cookie 不复活、bootstrap 密码轮换、旧 token 缺少版本信息、
客户端 session update 不能改角色/版本、DB 不可用时 fail closed；同时验证合法会话正常读取。
使用真实登录 cookie + 受保护 API/页面证明撤销，不以单独 token 函数测试代替。
若更改 middleware 引入 DB 的架构边界，先补 ADR、Node/Docker 构建与失败路径验收。

### B1b 实施契约（ADR-0037）

- 保留 JWT，不加会话表或迁移。内部 token 绑定 HMAC-SHA256 版本：账号类型、规范化邮箱、角色、
  当前带随机盐的密码哈希（bootstrap 为环境密码），密钥为当前 AUTH_SECRET（兼容 NEXTAUTH_SECRET）。
  token 内只有不可逆的版本标记；公开 session、用户列表均不包含版本、密码或哈希。
- 版本从本次实际验证密码的同一账号快照产生，不在异步 JWT 回调中重新读取后给旧密码签新版本。
  回调仍核对当前状态；登录后立即改密的竞态只能导致拒绝，不得使旧凭据获得新权限。
- middleware 与服务端/API 使用同一 Node JWT 核对回调。每次核对打开短生命周期的只读 DB，
  不调用带迁移/协调副作用的 getDb，不缓存用户状态；查库失败、身份/角色/版本不匹配均返回无会话。
  public/cron/worker 的既有授权方式不变；不把 DB 依赖带进 Edge runtime。
- 首次上线，旧 JWT 缺少版本一律失效，需要重新登录。客户端 session update 不能改版本、角色或身份。
- 官方账号更新入口 upsert 每次生成新随机盐，因此改密、降权、删除再建（即使复用密码）均撤销旧会话。
  角色单独变化也使当前版本不匹配。不得把凭据状态指纹当作持久撤销日志：恢复旧 DB 快照、
  回填旧哈希/角色或将 bootstrap 密码改回旧值时，必须同时轮换 AUTH_SECRET，防止旧 token 再次匹配。
- 只保证后续授权检查拒绝，不承诺中断已通过检查的在途响应或已授权后台任务；无逐设备登出管理。

### B1b 补充反例

1. 同一密码再次 upsert 和删后重建均改变版本；env/DB 同名影子账号不能复用身份。
2. 在 authorize 与 JWT callback 之间更新凭据，旧快照不能重新绑定新版本；缺 AUTH_SECRET 拒绝。
3. readonly 查询不创建缺失数据库，不初始化 schema，不运行恢复；查询异常连接也关闭，随后可恢复。
4. 真实 HTTP：改密/删除走 admin API，旧 cookie 对报告列表 API 为 401、报告页跳登录、session API 无用户；
   直接 SQL 降权反例另外验证不依赖更新 API“顺手”旋转密码，降权后重新登录得到 viewer。
5. 同一隔离 DB 重启服务仅轮换 bootstrap 密码（保持 AUTH_SECRET），旧管理员 cookie 被拒绝、新密码可登录。
6. 真实加密旧版 cookie（缺版本）、DB 表暂时不可读、客户端 update 注入；不得将单纯 mock 回调当作 HTTP 证据。

## 发布与回退

B1a 无存量数据迁移，回退代码恢复旧行为。不得靠重启清空计数作为正常登录手段。
先完成独立审查及 PR CI。B1a 不撤销现存登录；B1b 则要求旧版无版本 token 重新登录，
上线前须明确告知该影响，且不在生产用改密/删真实用户的方式做破坏性验证。
回退到 B1a 会丢失撤销保护；若因故回退，应同时轮换 AUTH_SECRET，不能让旧授权 cookie 重新有效。
