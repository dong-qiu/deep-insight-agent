/** POST /api/admin/sources —— 新建数据源（B-3）。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db/index.js";
import { getSource, insertSource } from "../../../../lib/db/repos.js";
import { validateSourceInput } from "../../../../lib/db/validate.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const v = validateSourceInput(body);
  if (!v.ok) return NextResponse.json({ error: "validation_failed", message: v.message }, { status: 422 });
  const db = getDb();
  if (getSource(db, v.value.id)) {
    return NextResponse.json({ error: "source_id_exists", id: v.value.id }, { status: 409 });
  }
  insertSource(db, v.value);
  return NextResponse.json({ status: "created", source: v.value }, { status: 201 });
}
