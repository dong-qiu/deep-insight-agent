/** POST /api/topics/[id]/deep-dive —— 用户触发某主题的"主题深挖"（C-1 · 补 MVP 核心场景）。
 *
 *  product-definition § "MVP 包含 · 报告" 明确写"每日 brief + 主题深挖报告"，cron 只跑 brief，
 *  之前没有任何 UI/API 让用户对指定主题发起 deep_dive。本路由补齐：
 *
 *  - 鉴权由 middleware 拦截（与其他 /api/admin 一致）；
 *  - **同步会跑 5-15 min**——超过任何浏览器/curl 默认超时；本路由用 fire-and-forget：
 *    立即返 202 + topic_id + started_at + Run/Report 出现路径，调用方监控 /admin、/reports；
 *  - 单步失败由 runJob 落 failed Run + notifyFailure；不阻塞响应。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../lib/db/index.js";
import { createDeepDiveTraceRequest, hashIdempotencyKey } from "../../../../../lib/db/provenance.js";
import { getTopic } from "../../../../../lib/db/repos.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await forbidNonAdmin(); // 二道闸：烧钱端点，非 admin 直接 403
  if (denied) return denied;
  const { id } = await params;
  const db = getDb();
  const topic = getTopic(db, id);
  if (!topic) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  if (!topic.enabled) {
    return NextResponse.json(
      { error: "topic_disabled", message: `主题 ${id} 已停用，启用后再深挖` },
      { status: 409 },
    );
  }
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret || !process.env.DISPATCH_WORKER_SECRET) {
    return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  }
  let result;
  try {
    result = createDeepDiveTraceRequest(db, { topicId: id, idempotencyKeyHash: hashIdempotencyKey(key, secret), planning: true });
  } catch {
    return NextResponse.json({ error: "dispatch_unavailable" }, { status: 503 });
  }
  if (result.kind === "conflict") {
    return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  }
  return NextResponse.json(
    { trace_id: result.traceId, request_id: result.requestId, status: "accepted", replayed: result.kind === "replayed" },
    { status: result.kind === "accepted" ? 202 : 200 },
  );
}
