/** GET /api/graph/drill —— 知识图谱溯源（ADR-0012 砖③）。
 *  ?topic=&a=实体[&b=另一实体][&since=]
 *  只给 a → 提及该实体的洞察（点节点）；给 a+b → 两实体同条共现的洞察（点边）。
 *  返回洞察的 statement + 引用（锚回原文），不触发任何 LLM。 */
import { type NextRequest, NextResponse } from "next/server";
import { insightsCooccurring, insightsMentioningEntity } from "../../../../lib/db/graph.js";
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
  const items = insights
    .sort((x, y) => y.importance - x.importance)
    .map((i) => ({
      id: i.id,
      headline: i.headline || i.statement,
      statement: i.statement,
      importance: i.importance,
      multi_source: i.multi_source,
      quotes: i.citations.map((c) => c.quote).filter(Boolean),
    }));
  return NextResponse.json({ items });
}
