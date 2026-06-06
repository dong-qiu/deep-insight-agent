/** PUT/DELETE /api/admin/sources/[id]（B-3）。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db/index.js";
import { deleteSource, getSource, updateSource } from "../../../../../lib/db/repos.js";
import { validateSourceInput } from "../../../../../lib/db/validate.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getSource(db, id)) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const v = validateSourceInput(body, { existingId: id });
  if (!v.ok) return NextResponse.json({ error: "validation_failed", message: v.message }, { status: 422 });
  updateSource(db, v.value);
  return NextResponse.json({ status: "updated", source: v.value });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getSource(db, id)) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  try {
    deleteSource(db, id);
    return NextResponse.json({ status: "deleted", id });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: "fk_constraint", message: `该数据源被 content_item 引用，无法删除（建议改 enabled=false 停用）：${err.message.slice(0, 80)}` },
      { status: 409 },
    );
  }
}
