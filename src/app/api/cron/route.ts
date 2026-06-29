/** POST /api/cron —— 定时管线触发端点（architecture「系统 cron 触发后走 Job Runner」）。
 *  鉴权：Authorization: Bearer ${CRON_SECRET}（恒定时间比较，避免计时侧信道）。
 *  容器内 supercronic 按 ops/crontab 定时 curl 本端点；长任务在容器进程内直接跑（非 serverless，无超时）。 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runScheduledPipeline } from "../../../lib/agents/scheduler.js";
import { getDb } from "../../../lib/db/index.js";
import { recoverOrphanedRuns } from "../../../lib/db/repos.js";
import { runLogger } from "../../../lib/runtime/logger.js";

export const dynamic = "force-dynamic";

function bearerOk(header: string | null, secret: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET 未配置，定时端点已禁用" }, { status: 503 });
  }
  if (!bearerOk(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const log = runLogger({ stage: "cron" });
  try {
    log.info("定时管线触发");
    const db = getDb();
    // 周期清扫孤儿 Run（Q2）：长驻 app 进程很少重启，openDb 的启动清扫不够；每日 cron 入口
    // 再扫一次 >staleMs 的孤儿。stale 阈值保证本轮即将创建的 run 不被误杀。
    const swept = recoverOrphanedRuns(db);
    if (swept > 0) log.info({ swept }, "周期清扫孤儿 Run");
    const summary = await runScheduledPipeline(db, {});
    log.info({ topics: summary.topics.length, errors: summary.errors.length }, "定时管线完成");
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error({ err: message }, "定时管线失败");
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
