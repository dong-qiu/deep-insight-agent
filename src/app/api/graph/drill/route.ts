/** GET /api/graph/drill —— 知识图谱溯源（ADR-0012）。
 *  ?topic=&a=实体[&b=另一实体][&since=]
 *  - 只给 a（点节点）→ 提及该实体的洞察（headline=关于该实体的实质信息）。
 *  - 给 a+b（点边）→ 两实体同条共现的洞察。
 *  每条洞察附其所在已发布报告链接（report.insight_ids 反查；blocked 洞察无链接）。不触发 LLM。 */
import { type NextRequest, NextResponse } from "next/server";
import { insightsCooccurring, insightsMentioningEntity, reportLinkMap } from "../../../../lib/db/graph.js";
import { getDb } from "../../../../lib/db/index.js";

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
  const insights = b
    ? insightsCooccurring(db, topic, a, b, since)
    : insightsMentioningEntity(db, topic, a, since);
  const links = reportLinkMap(db, topic);
  const items = insights
    .sort((x, y) => y.importance - x.importance)
    .map((i) => {
      const rep = links.get(i.id);
      return {
        id: i.id,
        headline: i.headline || i.statement,
        statement: i.statement,
        importance: i.importance,
        multi_source: i.multi_source,
        quotes: i.citations.map((c) => c.quote).filter(Boolean),
        report_id: rep?.report_id ?? null,
        report_date: rep?.date ?? null,
      };
    });
  return NextResponse.json({ items });
}
