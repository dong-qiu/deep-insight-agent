/** GET /api/graph/drill —— 知识图谱溯源（ADR-0012）。
 *  ?topic=&a=实体[&b=另一实体][&since=]
 *  - 只给 a（点节点）→ 提及该实体的**报告**（可点进 /reports/[id]，按实体导航报告库）。
 *  - 给 a+b（点边）→ 两实体同条共现的**洞察**（statement+引证，精确解释「为何相连」）。
 *  不触发任何 LLM。 */
import { type NextRequest, NextResponse } from "next/server";
import { insightsCooccurring } from "../../../../lib/db/graph.js";
import { getDb } from "../../../../lib/db/index.js";
import { queryReportIndex } from "../../../../lib/db/reports.js";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const topic = sp.get("topic");
  const a = sp.get("a");
  const b = sp.get("b");
  const since = sp.get("since") ?? undefined;
  if (!topic || !a) {
    return NextResponse.json({ error: "topic 和 a 必填" }, { status: 400 });
  }
  const db = getDb();

  if (b) {
    // 边：两实体同条共现的洞察（精确解释连接）
    const items = insightsCooccurring(db, topic, a, b, since)
      .sort((x, y) => y.importance - x.importance)
      .map((i) => ({
        id: i.id,
        headline: i.headline || i.statement,
        statement: i.statement,
        importance: i.importance,
        multi_source: i.multi_source,
        quotes: i.citations.map((c) => c.quote).filter(Boolean),
      }));
    return NextResponse.json({ kind: "insights", items });
  }

  // 节点：提及该实体的报告（可点进）。复用报告库索引；since（datetime）取日期部分作 from 下界。
  const from = since ? since.slice(0, 10) : undefined;
  const reports = queryReportIndex(db, { topic, entity: a, from }).map((r) => ({
    report_id: r.report_id,
    title: r.title,
    date: r.date,
    type: r.type,
  }));
  return NextResponse.json({ kind: "reports", reports });
}
