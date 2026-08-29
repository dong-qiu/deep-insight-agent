/** Next 中间件（Node.js runtime）：统一鉴权门 + /api 限流。
 *  - matcher 排除静态资源 + NextAuth 自身，其余全过 middleware；
 *  - PUBLIC_PATHS 白名单（/login·/api/health·/api/cron[Bearer 在 handler 自查]）外，无 session 一律拦：
 *    页面 → 重定向 /login（带 from）；/api → 401 JSON；
 *  - middleware 保持配置/会话解析轻量，不导入 DB；审计/脱敏日志在路由处理。 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config.js";
import { isPublicPath } from "./lib/runtime/auth-paths.js";
import { hasDispatchWorkerSecret } from "./lib/runtime/dispatch-auth.js";
import { isAdminOnlyPath } from "./lib/runtime/role-paths.js";
import { RateLimiter } from "./lib/runtime/rate-limit.js";

// middleware 显式跑在 Node.js runtime（自托管 Docker 部署）。仍用配置-only 轻实例只读 session/JWT role，
// 不引入带 DB/密码校验的 auth.ts，保持每个请求的鉴权前置路径轻量、可迁回 Edge。
const { auth } = NextAuth(authConfig);

/** Operational metrics deliberately use a uniform 404 at the network boundary.
 * Keep this narrow: the rest of the admin surface retains its documented 401/403. */
function isHiddenMetricsApi(pathname: string): boolean {
  return pathname === "/api/admin/metrics" || pathname.startsWith("/api/admin/metrics/");
}

// 默认每 IP 每分钟 120（与 config.rateLimit 对齐由后续接入）。每个应用进程独立计数。
const limiter = new RateLimiter({ limit: 120, windowMs: 60_000 });

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const trustedDispatchWorker = (pathname === "/api/internal/generation-dispatch"
    || pathname === "/api/internal/generation-dispatch/health")
    && hasDispatchWorkerSecret(req.headers.get("x-dispatch-worker-secret"), process.env.DISPATCH_WORKER_SECRET);

  if (pathname.startsWith("/api")) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (!trustedDispatchWorker && !limiter.allow(`ip:${ip}`)) {
      return new NextResponse("Too Many Requests", { status: 429 });
    }
  }

  if (!isPublicPath(pathname) && !trustedDispatchWorker && !req.auth?.user) {
    if (pathname.startsWith("/api")) {
      if (isHiddenMetricsApi(pathname)) return NextResponse.json({ error: "not_found" }, { status: 404 });
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
      if (isHiddenMetricsApi(pathname)) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  return NextResponse.next();
});

// matcher：排除静态资源（_next/static、_next/image、favicon）和 NextAuth 自身（/api/auth/*）；其余全过。
export const config = {
  // Next 15.5+ 支持 Node middleware；避免 next-auth/jose 的 Edge 压缩流兼容性告警。
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
