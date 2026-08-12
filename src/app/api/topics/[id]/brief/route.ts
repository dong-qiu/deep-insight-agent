/** POST /api/topics/[id]/brief —— 管理员对单一主题受理一次标准 Daily Brief。
 *
 * 这是登记 API，不做采集、模型调用或报告写入；受理后的 dispatch 只能由独立 worker claim 并执行。
 * 同一 topic 的同一 UTC 日期由 scheduled scope key 去重，因此不会因重复点击生成多份日报。
 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../lib/db/index.js";
import { createScheduledTraceRequest, hashIdempotencyKey } from "../../../../../lib/db/provenance.js";
import { getTopic } from "../../../../../lib/db/repos.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idempotencyKeyPattern = /^[\x21-\x7e]{8,128}$/;

function scheduledBriefConfig(): { windowHours: number; items: number } {
  // 与 runScheduledPipeline 的正常日报配置完全一致；值会被写入 dispatch payload 后冻结。
  const configuredWindowHours = Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const configuredItems = Number(process.env.PIPELINE_ITEMS_PER_TOPIC ?? 15);
  return {
    windowHours: Number.isFinite(configuredWindowHours) && configuredWindowHours > 0 ? configuredWindowHours : 168,
    items: Number.isInteger(configuredItems) && configuredItems > 0 ? configuredItems : 15,
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const actor = await requireAdminActor(); // handler 二道闸，middleware 之外仍 fail-closed
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const key = req.headers.get("Idempotency-Key");
  if (!key || !idempotencyKeyPattern.test(key)) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret || !process.env.DISPATCH_WORKER_SECRET) {
    return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  }

  const { id } = await params;
  const db = getDb();
  const topic = getTopic(db, id);
  if (!topic) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  if (!topic.enabled) {
    return NextResponse.json({ error: "topic_disabled", message: `主题 ${id} 已停用，启用后再生成日报` }, { status: 409 });
  }

  const now = new Date();
  const { windowHours, items } = scheduledBriefConfig();
  let result;
  try {
    result = createScheduledTraceRequest(db, {
      topicId: id, reportType: "brief", period: now.toISOString().slice(0, 10), windowHours, items, now,
      triggerKind: "api", actorId: actor.id, idempotencyKeyHash: hashIdempotencyKey(key, secret),
    });
  } catch {
    return NextResponse.json({ error: "dispatch_unavailable" }, { status: 503 });
  }
  if (result.kind === "conflict") {
    return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  }
  return NextResponse.json(
    {
      trace_id: result.traceId, request_id: result.requestId,
      status: result.kind === "accepted" ? "accepted" : "replayed", replayed: result.kind === "replayed",
      report_type: "brief",
    },
    { status: result.kind === "accepted" ? 202 : 200 },
  );
}
