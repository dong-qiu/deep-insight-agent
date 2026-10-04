# 退出后的浏览器认证保护

## 问题与范围

基线 origin/main `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`。D4 #404 的优化 CI 37168055623 登录用例在退出后保留 session cookie；本地合成浏览器重复 20 次有 4 次在退出/登录页后重新显示受保护内容。Auth.js beta.32 middleware 的 session 校验会给每个页面/API/POST 响应附加更新后的 session cookie，server action 另删除 cookie。需要确定性验证迟到响应及同一退出 POST 的写入冲突。

独立修复认证 middleware 的响应行为；不改页面、登录表单、角色策略、凭据撤销/只读 DB 检查、JWT 格式、schema、模型/reader/C2a、package/lockfile 或 CI。D4 浏览器测试仍属于 #404；修复保持单独 Draft PR，D4 在其分支基线上复验，未经授权不合并或部署。

## 最小行为

middleware 继续使用原 Auth.js session/JWT 当前凭据核验及原 public/worker/角色/限速规则，但不向浏览器续写或删除 session-token cookie（含 secure 和 chunk 变体）。它只判断当前请求的授权；session cookie 的写入由原认证端点/退出 action 承担。保留其他响应头、非 session cookie、重定向/状态。

因此普通页面/预取/POST 不再滚动续期 JWT；登录时有效期与显式 `/api/auth/session` 端点刷新机制不变。活跃用户若只访问页面且不刷新认证端点，将在登录 JWT 原期限到达时重新登录。这是消除只读授权响应 cookie 写入竞争的明确取舍，不增加服务端会话存储。

本切片不声称撤销已复制 JWT、逐设备服务端撤销，或中断已授权的在途内容。显式认证端点的并发状态变更不扩展为新的会话平台；D4 不人为清 cookie 或延时回避竞争。

## 验收

1. 使用真实 Auth.js 加解密/session/退出逻辑，证明修复前已授权 middleware 响应会续写 cookie；将已生成的 GET/RSC/POST 响应延后应用到已退出 cookie jar，不能恢复会话；普通与 secure/chunk session 都覆盖。
2. middleware 仍允许合法 viewer 普通页面；拒绝匿名保护页面/API、viewer admin 页面/API、凭据已撤销或 DB 查询失败的会话；非 session cookie/响应状态不受影响。
3. 真实构建应用的 HTTP 登录/退出/撤销 E2E 和 D4 四类浏览器用例通过；退出回归重复验证零自动重试，不靠固定 sleep，不手工 clear cookie。
4. lint、双版本 typecheck、coverage、构建、独立 Docker/优化 CI 与独立 pre-pr-ai-review。纯认证改动无 AI 输出语义变化，不跑无关 A1。

## 回退

正常 revert 独立修复 PR 会恢复 middleware session cookie 写入，也恢复已确认退出保护风险；不涉及数据迁移或依赖回退，不能将回退当作 D4 问题已解决。
