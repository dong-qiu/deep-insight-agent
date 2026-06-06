/** POST /api/admin/runs/[id]/retry —— 单 Run 重试（B-4 · 补 MVP 看板"失败下钻 + 重试"）。
 *
 *  - kind=ingest：target.source_id → 查源 → collectSource 重跑（内部 runJob 标 retry_of）；
 *  - 其他 kind（analyze/validate/report-gen）：需上游协作（窗口 / batch 引用），单 Run 无法独立
 *    重跑——返 501 + 文案，UI 引导整管线 /api/cron。
 *
 *  鉴权由 middleware 统一拦截；运行时为 nodejs（DB + 网络）。 */
import { NextResponse } from "next/server";
import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { getRun, getSource } from "../../../../../../lib/db/repos.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const orig = getRun(db, id);
  if (!orig) return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  if (orig.status !== "failed") {
    return NextResponse.json(
      { error: "not_failed", message: `Run 状态 ${orig.status}，仅 failed 可重试` },
      { status: 409 },
    );
  }

  if (orig.kind === "ingest") {
    const sourceId = (orig.target as { source_id?: string })?.source_id;
    if (!sourceId) {
      return NextResponse.json({ error: "missing_source_id_in_target" }, { status: 422 });
    }
    const source = getSource(db, sourceId);
    if (!source) {
      return NextResponse.json({ error: "source_deleted", source_id: sourceId }, { status: 410 });
    }
    try {
      const out = await collectSource(db, source, { retryOf: id });
      return NextResponse.json({
        status: "done",
        new_run_id: out.runId,
        fetched: out.fetched,
        inserted: out.inserted,
        updated: out.updated,
        skipped: out.skipped,
      });
    } catch (e) {
      // collectSource 内部 runJob 已落 failed Run + 触发告警；这里只汇报给 UI
      return NextResponse.json(
        { status: "failed", error: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }
  }

  // analyze / validate / report-gen：跨步状态依赖，单 Run 无法独立重跑
  return NextResponse.json(
    {
      error: "kind_not_retryable_alone",
      kind: orig.kind,
      message: `${orig.kind} 类 Run 依赖上游 batch / 窗口状态，无法单独重试；请通过 /api/cron 重跑整管线。`,
    },
    { status: 501 },
  );
}
