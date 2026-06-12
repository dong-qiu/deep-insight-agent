/** /api/reports/[id]/followup —— 报告页内追问（A4）。spec followup-qa.md / ADR-0002。
 *
 *  POST：就该报告提一个问题，**同步**返回受限于报告引用池的可溯源回答（~5-10s）。
 *        追问是单次快调用、远低于网关超时，故同步（不同于 deep-dive 的 202 异步）。
 *  GET ：返回该报告的历史问答（页面初载展示 = 多轮读路径已就位）。
 *
 *  鉴权由 middleware 统一拦截（matcher 覆盖 /api/*，仅排除 api/auth）；本路由内再加每用户限流。
 *  单用户 MVP：actor 记 "admin"（auth.ts 的用户 id），限流按来源 IP。 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { answerFollowup } from "../../../../../lib/agents/followup.js";
import { appendAudit } from "../../../../../lib/db/audit.js";
import { listFollowups, saveFollowup } from "../../../../../lib/db/followup.js";
import { getDb } from "../../../../../lib/db/index.js";
import { getReport } from "../../../../../lib/db/reports.js";
import { runLogger } from "../../../../../lib/runtime/logger.js";
import { RateLimiter } from "../../../../../lib/runtime/rate-limit.js";
import type { FollowupQA } from "../../../../../lib/types.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RATE_LIMIT = Math.max(1, Number(process.env.FOLLOWUP_RATE_LIMIT) || 30);
const limiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60 * 60 * 1000 }); // 每窗口（1h）每 key 上限

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const report = getReport(db, id);
  if (!report) return NextResponse.json({ error: "report_not_found" }, { status: 404 });
  if (report.status !== "done") {
    return NextResponse.json(
      { error: "report_not_ready", message: `报告 ${id} 状态为 ${report.status}，完成后才能追问` },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "empty_question" }, { status: 400 });
  if (question.length > 500) {
    return NextResponse.json({ error: "question_too_long", message: "问题请控制在 500 字内" }, { status: 400 });
  }

  if (!limiter.allow(`followup:${clientKey(req)}`)) {
    return NextResponse.json(
      { error: "rate_limited", message: `追问过于频繁（每小时上限 ${RATE_LIMIT} 次），稍后再试` },
      { status: 429 },
    );
  }

  const log = runLogger({ stage: "followup" });
  try {
    const result = await answerFollowup(db, report, question);
    const now = new Date().toISOString();
    const qaId = `fup_${randomUUID().slice(0, 8)}`;
    const qa: FollowupQA = {
      id: qaId,
      report_id: id,
      thread_id: qaId, // v1 单轮：线程即自身（多轮升级时由请求携带 thread_id 归并）
      turn_index: 0,
      question,
      answer_md: result.answer_md,
      citations_used: result.citations_used,
      validation: result.validation,
      cost: result.cost,
      status: "done",
      created_at: now,
    };
    saveFollowup(db, qa);
    appendAudit(db, {
      actor: "admin",
      action: "followup_asked",
      target: id,
      detail: { question: question.slice(0, 200), answerable: result.answerable, cost: result.cost },
    });
    log.info({ reportId: id, citations: result.citations_used.length, cost: result.cost.amount }, "追问完成");
    return NextResponse.json(qa, { status: 200 });
  } catch (e) {
    const message = (e as Error).message;
    log.error({ reportId: id, err: message }, "追问失败");
    appendAudit(db, { actor: "admin", action: "followup_failed", target: id, detail: { message } });
    return NextResponse.json({ error: "followup_failed", message }, { status: 500 });
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getReport(db, id)) return NextResponse.json({ error: "report_not_found" }, { status: 404 });
  return NextResponse.json({ report_id: id, followups: listFollowups(db, id) });
}
