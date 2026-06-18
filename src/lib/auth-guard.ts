/** 路由处理器内的二道鉴权闸（与 middleware `isAdminOnlyPath` 互为独立防线，纵深防御）。
 *  烧钱/管理端点在 handler 顶部调用：非 admin → 403。即便将来 middleware matcher 改动、或框架
 *  路径归一回归导致 middleware 的路径匹配被绕过，这层仍挡住「未授权花 relay 的钱」——资产是真金白银，值得双闸。
 *  仅在 Node runtime 的 route handler 用（import 了 NextAuth `auth()`，不可进 Edge middleware）。 */
import { NextResponse } from "next/server";
import { auth } from "../auth.js";

/** 非 admin → 返回 403 响应（调用方应直接 return 它）；admin → null（放行）。 */
export async function forbidNonAdmin(): Promise<NextResponse | null> {
  const role = (await auth())?.user?.role;
  return role === "admin" ? null : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
