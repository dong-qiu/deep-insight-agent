/** 不需登录会话的路径白名单（暴露公网时唯一对外可读）：
 *  - /login          登录页本身
 *  - /api/health     容器健康探针/外部监控用，不含敏感数据
 *  - /api/cron       定时端点，自带 Bearer CRON_SECRET 鉴权（middleware 不重复挡）
 *  NextAuth 自身（/api/auth/*）由 middleware matcher 排除、不进本函数。 */
export const PUBLIC_PATHS = ["/login", "/api/health", "/api/cron"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
