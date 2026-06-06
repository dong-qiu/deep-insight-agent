/** POST /api/admin/sources/[id]/collect —— 数据源按需立即抓取（C-3 · data-collection AC8）。
 *
 *  spec 明确："对指定源发起按需触发，能立即执行一次抓取，不等定时周期"。
 *  - 复用 collectSource（runJob 内置：落 Run + 失败告警）；
 *  - 同步返回（单源抓取通常 < 30s，OK 走同步）；超时由 SafeFetch 兜底；
 *  - 鉴权由 middleware 拦截；runtime=nodejs。 */
import { NextResponse } from "next/server";
import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { getSource } from "../../../../../../lib/db/repos.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const source = getSource(db, id);
  if (!source) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  if (!source.enabled) {
    return NextResponse.json(
      { error: "source_disabled", message: `源 ${id} 已停用，启用后再抓取` },
      { status: 409 },
    );
  }
  try {
    const out = await collectSource(db, source);
    return NextResponse.json({
      status: "done",
      source_id: id,
      run_id: out.runId,
      fetched: out.fetched,
      inserted: out.inserted,
      updated: out.updated,
      skipped: out.skipped,
    });
  } catch (e) {
    return NextResponse.json(
      { status: "failed", error: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
}
