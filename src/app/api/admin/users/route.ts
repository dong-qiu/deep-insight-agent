/** 用户管理 API（设置页用）：列出 / 新增·改 / 删 app_user。admin only——
 *  middleware isAdminOnlyPath 拦在 /api/admin/* 前 + forbidNonAdmin 二道闸（与烧钱端点同款纵深）。
 *  bootstrap admin（env ADMIN_*）不入库、不在此管理。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { deleteUser, listUsers, normEmail, upsertUser } from "../../../../lib/db/users.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  return NextResponse.json({ users: listUsers(getDb()) });
}

export async function POST(req: Request): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = normEmail(typeof body?.email === "string" ? body.email : ""); // S1：统一小写，PK/保留判定一致
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email", message: "邮箱格式不对" }, { status: 422 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "weak_password", message: "密码至少 6 位" }, { status: 422 });
  }
  if (process.env.ADMIN_EMAIL && email === normEmail(process.env.ADMIN_EMAIL)) {
    // 不允许在库里建与 bootstrap admin 同名的账号（大小写不敏感）——env admin 永远以 env 为准
    return NextResponse.json({ error: "reserved_email", message: "该邮箱是内置管理员，无需在此添加" }, { status: 409 });
  }
  // S2：受邀账号一律 viewer（只读分享场景）。内置 env admin 是唯一 admin——不从 UI/API 增设额外管理员，缩小被攻破面。
  upsertUser(getDb(), email, password, "viewer");
  return NextResponse.json({ status: "saved", email, role: "viewer" }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const email = normEmail(new URL(req.url).searchParams.get("email") ?? "");
  if (!email) return NextResponse.json({ error: "missing_email" }, { status: 422 });
  const removed = deleteUser(getDb(), email);
  return NextResponse.json({ status: removed ? "deleted" : "not_found", email }, { status: removed ? 200 : 404 });
}
