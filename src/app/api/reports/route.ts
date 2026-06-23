import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";
import { queryReportIndex } from "../../../lib/db/reports.js";

export const dynamic = "force-dynamic";

/** GET /api/reports?q=&type=&domain=&topic=&source=&tag=&entity=&from=&to=&sort=&dir=
 *  —— 报告库统一查询入口。
 *  - q: FTS5（标题/摘要/正文）；无效语法走 fallback（不带 q 重查 + warn 字段）；
 *  - domain: ADR-0010 Step2b 分类筛选（取代 industry，匹配 facets 含 domain:<值>）；
 *  - 其他参数白名单 + 参数化 SQL（防注入），见 db/reports.ts queryReportIndex。 */
export function GET(req: Request) {
  const db = getDb();
  const sp = new URL(req.url).searchParams;
  const opts = {
    q: sp.get("q") ?? undefined,
    type: sp.get("type") ?? undefined,
    domain: sp.get("domain") ?? undefined,
    topic: sp.get("topic") ?? undefined,
    source: sp.get("source") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    entity: sp.get("entity") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    sort: sp.get("sort") ?? undefined,
    dir: sp.get("dir") ?? undefined,
  };
  try {
    const items = queryReportIndex(db, opts);
    return NextResponse.json({ count: items.length, items });
  } catch (e) {
    // FTS5 token 不合法（如裸 "-"）→ fallback 去 q 重查 + warn
    const items = queryReportIndex(db, { ...opts, q: undefined });
    return NextResponse.json({
      count: items.length,
      items,
      warn: `q="${opts.q}" 语法不合法，已忽略：${(e as Error).message.slice(0, 80)}`,
    });
  }
}
