/** admin-only 路径表（多账号分权的唯一服务端事实来源，middleware 强制）。
 *  viewer（受邀只读账号）可读 Brief / 报告 / 主题 / 报告库搜索；下列一律 admin：
 *   - 管理/配置面：/admin、/settings、/api/admin/*（源/主题 CRUD、Run 重跑、采集）
 *   - 烧钱端点：深挖触发、报告追问、PPT 导出（B 路径 LLM polish）——viewer 触发=别人替你烧 relay
 *  Edge 安全：纯字符串/正则，无 import。改这里 = 改分权，务必配套 role-paths.test.ts。 */

const ADMIN_PREFIXES = ["/admin", "/settings", "/api/admin"] as const;

// 烧钱端点不在 /api/admin 下（挂在 /api/topics、/api/reports），按精确形态匹配；
// `(\/|$)` 兼带子路径（如 deep-dive/status 轮询同样限 admin——viewer 无从触发深挖、无需轮询）。
const ADMIN_PATTERNS: RegExp[] = [
  /^\/api\/topics\/[^/]+\/deep-dive(\/|$)/, // 触发深挖 + 进度轮询
  /^\/api\/reports\/[^/]+\/followup(\/|$)/, // 报告追问
  /^\/api\/reports\/[^/]+\/pptx(\/|$)/, // PPT 导出（B 路径 LLM polish 烧钱）
];

/** 该路径是否仅 admin 可访问（viewer / 未授权角色会被 middleware 挡下）。 */
export function isAdminOnlyPath(pathname: string): boolean {
  if (ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  return ADMIN_PATTERNS.some((re) => re.test(pathname));
}
