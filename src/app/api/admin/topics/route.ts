/** POST /api/admin/topics —— 新建主题（B-3）。鉴权由 middleware 拦截。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db/index.js";
import { getTopic, insertTopic } from "../../../../lib/db/repos.js";
import { validateTopicInput } from "../../../../lib/db/validate.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const v = validateTopicInput(body);
  if (!v.ok) return NextResponse.json({ error: "validation_failed", message: v.message }, { status: 422 });
  const db = getDb();
  if (getTopic(db, v.value.id)) {
    return NextResponse.json({ error: "topic_id_exists", id: v.value.id }, { status: 409 });
  }
  insertTopic(db, v.value);
  return NextResponse.json({ status: "created", topic: v.value }, { status: 201 });
}
