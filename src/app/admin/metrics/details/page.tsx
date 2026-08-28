import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../../auth.js";
import { getDb } from "../../../../lib/db/index.js";
import { dashboardWindow } from "../../../../lib/db/p1-dashboard.js";
import { listMetricDetailsPage, type FactKind } from "../../../../lib/db/p1-metrics-facts.js";

export const dynamic = "force-dynamic";
const kinds: FactKind[] = ["funnel", "cost", "validator"];
function safeKind(value: string | undefined): FactKind { return kinds.includes(value as FactKind) ? value as FactKind : "funnel"; }
type DetailCursor = { cursor_version: 1; kind: FactKind; from: string; to: string; as_of: string; occurred_at: string; id: string };
function decodeCursor(value: string | undefined): DetailCursor | null {
  if (!value || value.length > 2048) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as DetailCursor;
    return cursor.cursor_version === 1 && kinds.includes(cursor.kind) && [cursor.from, cursor.to, cursor.as_of, cursor.occurred_at, cursor.id].every((part) => typeof part === "string") ? cursor : null;
  } catch { return null; }
}
function encodeCursor(value: DetailCursor): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

/** Read-only, deliberately sparse admin detail UI.  It never renders payloads,
 * hashes, errors, artifact identifiers, or storage locators. */
export default async function MetricsDetailsPage({ searchParams }: { searchParams: Promise<{ kind?: string; cursor?: string }> }) {
  const session = await auth(); if (session?.user?.role !== "admin") notFound();
  const params = await searchParams; const kind = safeKind(params.kind); const cursor = decodeCursor(params.cursor);
  if (params.cursor && (!cursor || cursor.kind !== kind)) notFound();
  const window = cursor ? { from: cursor.from, to: cursor.to } : dashboardWindow(); const as_of = cursor?.as_of ?? new Date().toISOString();
  const page = listMetricDetailsPage(getDb(), { kind, ...window, as_of, limit: 100, cursor: cursor ? { occurred_at: cursor.occurred_at, id: cursor.id } : null });
  const nextHref = page.next ? `/admin/metrics/details?kind=${kind}&cursor=${encodeCursor({ cursor_version: 1, kind, ...window, as_of, ...page.next })}` : null;
  return <section>
    <p><Link href="/admin/metrics">← P1 溯源驾驶舱</Link></p>
    <h2>受控指标明细</h2>
    <p className="muted">UTC 窗口最多 31 天；每页最多 100 条。诊断 payload、hash、对象定位符和错误正文不会显示。</p>
    <p>{kinds.map((value) => <Link key={value} href={`/admin/metrics/details?kind=${value}`}>{value}{value === kind ? "（当前）" : ""} </Link>)}</p>
    {page.items.length ? <table className="stats"><thead><tr><th>时间</th><th>Trace</th><th>阶段</th><th>管线</th><th>Topic</th><th>Source</th><th>类型</th></tr></thead><tbody>{page.items.map((item) => <tr key={String(item.event_id ?? item.entry_id ?? item.result_id)}><td>{String(item.occurred_at)}</td><td>{String(item.trace_id)}</td><td>{String(item.stage)}</td><td>{String(item.pipeline_version)}</td><td>{item.topic_id ? String(item.topic_id) : "—"}</td><td>{item.source_id ? String(item.source_id) : "—"}</td><td>{kind}</td></tr>)}</tbody></table> : <p className="muted">该窗口没有可见明细。</p>}
    {nextHref ? <p><Link href={nextHref}>下一页 →</Link></p> : null}
  </section>;
}
