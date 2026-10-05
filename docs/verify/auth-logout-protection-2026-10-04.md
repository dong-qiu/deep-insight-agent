# 退出认证保护：独立修复收据

基线 `origin/main` @ `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`，独立 `fix/auth-logout-protection` / `insight-agent-auth-logout`。用户授权在独立修复后复验 D4；仍不合并、不部署、不接生产、不清理其他工作区。验收见 [spec](../plan/specs/auth-logout-protection.md)。

## 根因与范围

Auth.js beta.32 的 [middleware 实现](https://github.com/nextauthjs/next-auth/blob/next-auth%405.0.0-beta.32/packages/next-auth/src/lib/index.ts) 在 session 核验后为 GET、RSC 和 POST 响应追加更新后的 session cookie；[退出 action](https://github.com/nextauthjs/next-auth/blob/next-auth%405.0.0-beta.32/packages/next-auth/src/lib/actions.ts) 独立写删除 cookie。实际库的受控响应顺序反例证明：退出后应用此前已授权响应，会恢复普通/secure/chunk JWT。D4 曾确认退出后重新显示受保护内容，并非只有 URL 断言错误。

修复仅在原 middleware 授权后移除其 session-token Set-Cookie，包括 secure 与 chunk；其他 cookie/headers/status、当前凭据只读核对、角色/公开路径/worker/限速逻辑保留。认证 endpoints/actions 仍负责原会话写入。普通页面不再滚动续期 JWT，显式认证端点刷新和登录有效期不变；仅浏览页面的长期会话到原 JWT 期限后需重新登录。这一行为取舍在 spec 明确，不引入 session 表、schema 或全设备撤销。

六个文件：middleware、真实 Auth.js 回归、既有 HTTP 撤销 E2E 增量、Vitest 内联 Auth.js 的两行配置及专属 spec/receipt。没有 package/lockfile、CI、页面、model/reader/validator/C2a 改动；无依赖升级。Vitest 默认外置 Auth.js 无法解析其 extensionless next/server，引入针对 next-auth 的既有 inlining 选项，实际库不 mock；其他依赖外置规则不变。

## 反例与验证

测试先行：完整有效夹具在未修代码下 4/5 失败，四个迟到响应确实复活普通或 secure/chunk session；原授权策略用例通过。修后四个反例与原授权用例 5/5。仅模拟当前账号查询，真实运行 Auth.js JWT 加解密、session、CSRF 与 signout；positive control 保留原 Auth.js wrapper，确认确实产生 session 更新 cookie。另真实 Next HTTP 登录/退出及迟到页面响应验证 server Set-Cookie 删除，不手工清 jar。

初次夹具运行有 module resolution 错误，已由最小 Vitest 配置解决；另普通 HTTP 夹具误加无 _rsc hash 的 RSC 请求，Next 16.3.8 正常 canonical 307，已改真实普通页面路径，不放宽授权断言。它们是夹具问题，未当作产品故障。

| 检查 | 本地实际结果 |
| --- | --- |
| 受影响 middleware/session-jwt/auth-reader/auth-guard | 4 文件 / 27 项通过 |
| npm run typecheck | TS7 / TS6 app/tools 通过 |
| npm run lint | 通过 |
| npm run test:coverage | 239 文件 / 2,407 项；ops 150/150，无跳过；S 78.63%、B 71.12%、F 78.70%、L 82.61%，原门通过 |
| build:e2e / test:e2e:built | 实际一次 12,855ms；HTTP 6 文件 / 7 项通过，additional_builds=0 |
| D4 外部浏览器 driver | 同一已验证真实修复 build，四类 Chromium 5/5；同一登录用例重复 20/20，零自动重试，无手工清 cookie |
| npm ci | 成功，0 漏洞，lockfile 无漂移 |
| Docker | 本机 daemon 不可用；最终候选独立 Docker CI 待补，不冒充通过 |

浏览器验证不新增本分支依赖：在本 worktree 先 C5 verify，再使用 D4 的固定 Playwright binary/config，fixture 启动本 worktree 的 .next/node_modules，客户端 seed 使用与基线相同的 DB 契约。命令如下；最终 D4 整合后另跑其自己的 built 入口和 CI。

```sh
NEXT_TELEMETRY_DISABLED=1 node ops/e2e-build.mjs verify
NEXT_TELEMETRY_DISABLED=1 ../insight-agent-d4/node_modules/.bin/playwright test --config ../insight-agent-d4/tests/browser/playwright.config.ts
NEXT_TELEMETRY_DISABLED=1 ../insight-agent-d4/node_modules/.bin/playwright test --config ../insight-agent-d4/tests/browser/playwright.config.ts --grep '登录、viewer' --repeat-each 20
```

环境 Node 24.19.0 / npm 11.17.0。linked worktree 仅复制 .env.local 并 chmod 0600，DATA_DIR/DB_PATH 为本工作区；无生产数据/SQLite/WAL/报告或 .env.development.local 复制。所有认证数据/账号/cookie 为合成；browser 服务运行干净临时目录与白名单环境，无原配置文件/模型/抓取调用。fixtures finally 关闭自有浏览器/服务与临时 DB，不终止其他会话。失败材料只有合成断言/DOM；不保存 cookie-bearing trace。

## 审查、Eval 与交付

pre-pr-ai-review 的新上下文独立审查已完成：认证边界按高风险审查，Blocking 0、Warning 0，代码审查通过；独立 reviewer 核对六文件、真实 Auth.js 回归、cookie 匹配范围与 JWT 到期取舍，并独立运行 diff 检查。最终 CI/Docker 仍待补。纯认证/测试及必要 Vitest 接线，无 AI 语义路径变化，Eval-Gate 不适用，不跑无关 A1。最终 head/base/tested SHA、run/attempt、full application/Docker 及 artifacts 身份/hash/有效期在独立 Draft PR 摘要保存，CI 后不为链接再改 head。

回退为正常 revert 独立修复，恢复已确认风险，无数据迁移。D4 保持单独 PR；在本修复分支基线上验证，不把未合入 Draft 写成主干 TD-16 已关闭。未覆盖任意旧 JWT 重放/逐设备撤销、显式认证端点并发状态变更或生产；browser P95 未测。
