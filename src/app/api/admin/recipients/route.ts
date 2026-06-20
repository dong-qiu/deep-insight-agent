/** 邮件分发收件人 API（设置页用）：列出 / 新增 / 启停 / 删 email_recipient。admin only——
 *  middleware isAdminOnlyPath 拦在 /api/admin/* 前 + forbidNonAdmin 二道闸（与 users 同款纵深）。
 *  收件人入库后，报告推送邮件渠道（notifyEmail）即以本表启用项为准，不再依赖 env REPORT_EMAIL_TO。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import {
  deleteRecipient,
  listRecipients,
  setRecipientEnabled,
  upsertRecipient,
} from "../../../../lib/db/recipients.js";
import { normEmail } from "../../../../lib/db/users.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  return NextResponse.json({ recipients: listRecipients(getDb()) });
}

export async function POST(req: Request): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { email?: unknown; label?: unknown } | null;
  const email = normEmail(typeof body?.email === "string" ? body.email : "");
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim() : null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email", message: "邮箱格式不对" }, { status: 422 });
  }
  upsertRecipient(getDb(), email, label);
  return NextResponse.json({ status: "saved", email }, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { email?: unknown; enabled?: unknown } | null;
  const email = normEmail(typeof body?.email === "string" ? body.email : "");
  if (!email) return NextResponse.json({ error: "missing_email" }, { status: 422 });
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "missing_enabled" }, { status: 422 });
  }
  const ok = setRecipientEnabled(getDb(), email, body.enabled);
  return NextResponse.json({ status: ok ? "updated" : "not_found", email }, { status: ok ? 200 : 404 });
}

export async function DELETE(req: Request): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const email = normEmail(new URL(req.url).searchParams.get("email") ?? "");
  if (!email) return NextResponse.json({ error: "missing_email" }, { status: 422 });
  const removed = deleteRecipient(getDb(), email);
  return NextResponse.json({ status: removed ? "deleted" : "not_found", email }, { status: removed ? 200 : 404 });
}
