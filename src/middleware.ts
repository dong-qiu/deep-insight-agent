/** Next 中间件（Edge）：统一鉴权门 + /api 限流。
 *  - matcher 排除静态资源 + NextAuth 自身，其余全过 middleware；
 *  - PUBLIC_PATHS 白名单（/login·/api/health·/api/cron[Bearer 在 handler 自查]）外，无 session 一律拦：
 *    页面 → 重定向 /login（带 from）；/api → 401 JSON；
 *  - Edge 安全模块（auth.ts 不碰 DB；rate-limit 是纯 Map）。审计/脱敏日志在 Node 侧路由处理。 */
import { NextResponse } from "next/server";
import { auth } from "./auth.js";
import { isPublicPath } from "./lib/runtime/auth-paths.js";
import { RateLimiter } from "./lib/runtime/rate-limit.js";

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

  return NextResponse.next();
});

// matcher：排除静态资源（_next/static、_next/image、favicon）和 NextAuth 自身（/api/auth/*）；其余全过。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
