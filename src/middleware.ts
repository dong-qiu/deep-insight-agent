/** Next 中间件（Edge）：统一鉴权门 + /api 限流。
 *  - matcher 排除静态资源 + NextAuth 自身，其余全过 middleware；
 *  - PUBLIC_PATHS 白名单（/login·/api/health·/api/cron[Bearer 在 handler 自查]）外，无 session 一律拦：
 *    页面 → 重定向 /login（带 from）；/api → 401 JSON；
 *  - Edge 安全模块（auth.ts 不碰 DB；rate-limit 是纯 Map）。审计/脱敏日志在 Node 侧路由处理。 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config.js";
import { isPublicPath } from "./lib/runtime/auth-paths.js";
import { isAdminOnlyPath } from "./lib/runtime/role-paths.js";
import { RateLimiter } from "./lib/runtime/rate-limit.js";

// middleware 跑在 Edge——用 Edge 安全的 authConfig 自建轻实例（只读 session/JWT 的 role），
// 绝不引入带 DB/crypto 的 auth.ts（那会把 better-sqlite3 拖进 Edge 包、构建失败）。
const { auth } = NextAuth(authConfig);

// 默认每 IP 每分钟 120（与 config.rateLimit 对齐由后续接入）。每个 Edge 实例独立计数。
const limiter = new RateLimiter({ limit: 120, windowMs: 60_000 });

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api")) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (!limiter.allow(`ip:${ip}`)) {
      return new NextResponse("Too Many Requests", { status: 429 });
    }
  }

  if (!isPublicPath(pathname) && !req.auth?.user) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", req.nextUrl);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // 角色分权（多账号）：已登录但非 admin 访问 admin-only 路径 → /api 返 403、页面回首页。
  // 服务端强制是分权的真闸门（UI 隐藏只是体验/纵深）；缺省最小权限（role 非 'admin' 即拦）。
  if (req.auth?.user && isAdminOnlyPath(pathname) && req.auth.user.role !== "admin") {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  return NextResponse.next();
});

// matcher：排除静态资源（_next/static、_next/image、favicon）和 NextAuth 自身（/api/auth/*）；其余全过。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
