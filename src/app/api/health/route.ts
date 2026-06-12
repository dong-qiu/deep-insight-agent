/** GET /api/health —— 存活探针（Docker HEALTHCHECK / 反向代理用）。
 *  轻量查一次库以确认 DB 可达，不触发任何 LLM 调用。
 *  附带数据新鲜度（data.stale）供外部监控读取——但 status 仍只反映"app + DB 活没活"：
 *  数据陈旧 ≠ 容器不健康（否则会误触发容器重启）。
 *  并借这条每 30s 的 healthcheck 心跳（独立于 supercronic）做陈旧主动告警（maybeAlertStale 自带去重）。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";
import { checkStaleness, maybeAlertStale } from "../../../lib/runtime/staleness.js";

export const dynamic = "force-dynamic";

const round1 = (x: number | null): number | null => (x == null ? null : Math.round(x * 10) / 10);

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb();
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM report").get() as { c: number };
    const s = checkStaleness(db);
    maybeAlertStale(s); // 心跳触发的陈旧告警（去重 + fire-and-forget，不阻塞探针）
    return NextResponse.json({
      status: "ok",
      reports: c,
      data: {
        stale: s.stale,
        reason: s.reason,
        reportAgeHours: round1(s.reportAgeHours),
        contentAgeHours: round1(s.contentAgeHours),
        latestReportAt: s.latestReportAt,
        thresholdHours: s.thresholdHours,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
