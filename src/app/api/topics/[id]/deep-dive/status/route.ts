/** GET /api/topics/[id]/deep-dive/status?since=<iso> —— 深挖进度查询（体验缺口 3.3）。
 *
 *  深挖是 202 fire-and-forget，之前用户只能去 /admin 数 Run 表。本路由给触发方一个轻量轮询面：
 *  把 analyze → validate → report-gen 三段 Run（按 since 锚定本次触发）归一成步进器状态 +
 *  产出报告链接，让 DeepDiveButton 原地渲染进度，不必跳走。
 *
 *  鉴权由 middleware 拦截（与同目录 POST 一致）。纯读、无副作用。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../../../lib/db/index.js";
import { latestReportForTopicSince } from "../../../../../../lib/db/reports.js";
import { getTopic, listRunsForTopicSince } from "../../../../../../lib/db/repos.js";
import type { Run } from "../../../../../../lib/types.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 步进器三段，按管线时序固定。validate 的 target 只带 batch_id，已在 repo 层经 batch 关联回主题。 */
const STEPS: { kind: Run["kind"]; label: string }[] = [
  { kind: "analyze", label: "分析" },
  { kind: "validate", label: "校验" },
  { kind: "report-gen", label: "生成报告" },
];

type StepState = "pending" | "running" | "done" | "failed";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  if (!getTopic(db, id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });

  const since = new URL(req.url).searchParams.get("since");
  if (!since) return NextResponse.json({ error: "missing_since" }, { status: 400 });
  // since 进 SQL 做字典序 `>=` 比较——非法值（非 ISO）会静默返回错误集 + 前端空转到超时，故先快失败。
  if (Number.isNaN(Date.parse(since))) {
    return NextResponse.json({ error: "invalid_since" }, { status: 400 });
  }

  const runs = listRunsForTopicSince(db, id, since); // started_at 升序
  // 单遍归集每段最新一条 Run（升序 → 后写覆盖即"最近一条"，同段重试以最后一条为准）。
  const latestByKind = new Map<Run["kind"], Run>();
  for (const r of runs) latestByKind.set(r.kind, r);
  const steps = STEPS.map((s) => {
    const last = latestByKind.get(s.kind);
    const state: StepState = last ? last.status : "pending";
    return { kind: s.kind, label: s.label, state };
  });

  const report = latestReportForTopicSince(db, id, since);
  const failed = steps.some((s) => s.state === "failed");
  // 完成 = 报告已落库（report-gen done 后 saveReport 同步完成，报告出现即终态）。
  const done = report != null;

  return NextResponse.json({ steps, report, done, failed });
}
