/** PUT/DELETE /api/admin/topics/[id]（B-3）。
 *  - PUT: 整体覆盖（除 id）；
 *  - DELETE: 物理删除，FK 违例（被 report/insight 引用）→ 409 + 友好文案。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db/index.js";
import { deleteTopic, getTopic, updateTopic } from "../../../../../lib/db/repos.js";
import { validateTopicInput } from "../../../../../lib/db/validate.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getTopic(db, id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const v = validateTopicInput(body, { existingId: id });
  if (!v.ok) return NextResponse.json({ error: "validation_failed", message: v.message }, { status: 422 });
  updateTopic(db, v.value);
  return NextResponse.json({ status: "updated", topic: v.value });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getTopic(db, id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  try {
    deleteTopic(db, id);
    return NextResponse.json({ status: "deleted", id });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: "fk_constraint", message: `该主题被 report / insight 引用，无法删除（建议改 enabled=false 停用）：${err.message.slice(0, 80)}` },
      { status: 409 },
    );
  }
}
