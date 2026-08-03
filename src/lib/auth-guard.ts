/** 路由处理器内的二道鉴权闸（与 middleware `isAdminOnlyPath` 互为独立防线，纵深防御）。
 *  烧钱/管理端点在 handler 顶部调用：非 admin → 403。即便将来 middleware matcher 改动、或框架
 *  路径归一回归导致 middleware 的路径匹配被绕过，这层仍挡住「未授权花 relay 的钱」——资产是真金白银，值得双闸。
 *  仅在 Node runtime 的 route handler 用（import 了 NextAuth `auth()`，不可进 Edge middleware）。 */
import { NextResponse } from "next/server";
import { auth } from "../auth.js";

export interface AdminActor { id: string; role: "admin" }

/** 管理动作的可信 actor；无会话 id 的 bootstrap 兼容路径明确标为 shared-admin，绝不伪造个人身份。 */
export async function requireAdminActor(): Promise<AdminActor | null> {
  const session = await auth();
  if (session?.user?.role !== "admin") return null;
  const user = session.user as typeof session.user & { id?: string | null };
  return { id: user.id ?? user.email ?? "shared-admin-unattributed", role: "admin" };
}

/** 非 admin → 返回 403 响应（调用方应直接 return 它）；admin → null（放行）。 */
export async function forbidNonAdmin(): Promise<NextResponse | null> {
  return await requireAdminActor() ? null : NextResponse.json({ error: "forbidden" }, { status: 403 });
}
