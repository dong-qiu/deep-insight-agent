/** Next 中间件（Edge）：/admin 独立鉴权 + /api 限流。
 *  仅用 Edge 安全模块（auth.ts 不碰 DB；rate-limit 是纯 Map）。审计/脱敏日志在 Node 侧路由处理。 */
import { NextResponse } from "next/server";
import { auth } from "./auth.js";
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

  if (pathname.startsWith("/admin") && !req.auth?.user) {
    const url = new URL("/login", req.nextUrl);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = { matcher: ["/admin/:path*", "/api/:path*"] };
