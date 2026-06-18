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
import { runPipelineForTopic } from "../../../../../lib/agents/scheduler.js";
import { getDb } from "../../../../../lib/db/index.js";
import { getTopic, hasRunningRun } from "../../../../../lib/db/repos.js";
import { runLogger } from "../../../../../lib/runtime/logger.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
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
  // review follow-up #2 防并发：同 topic 已有 analyze running → 409 拒收，
  // 避免用户连点产生 2 条 deep-dive 双倍 ~$1-4 成本。
  if (hasRunningRun(db, "analyze", "topic_id", id)) {
    return NextResponse.json(
      {
        error: "already_running",
        message: `主题 ${id} 已有 analyze Run 在跑——等当前轮结束再触发，或去 /admin 看进度。`,
      },
      { status: 409 },
    );
  }

  const startedAt = new Date().toISOString();
  const log = runLogger({ stage: "deep-dive" });
  log.info("用户触发主题深挖（fire-and-forget）");

  // fire-and-forget：不 await。失败由 runJob 内部 finishRun(failed) + notifyFailure 兜底，
  // void Promise 在 Node runtime 下事件循环挂着直到完成。
  void runPipelineForTopic(db, id).then(
    (report) => log.info({ reportId: report.id }, "主题深挖完成"),
    (e) => log.error({ err: (e as Error).message }, "主题深挖失败"),
  );

  return NextResponse.json(
    {
      status: "started",
      topic_id: id,
      topic_name: topic.name,
      started_at: startedAt,
      message:
        "深挖管线已启动（预计 5-15 分钟）。完成后新报告出现在 /reports；进度在 /admin 看 analyze / validate / report-gen 三个 Run。",
    },
    { status: 202 },
  );
}
