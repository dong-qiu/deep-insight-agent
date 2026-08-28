import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../../auth.js";
import { getDb } from "../../../../lib/db/index.js";
import { dashboardWindow } from "../../../../lib/db/p1-dashboard.js";
import { listMetricDetailsPage, type FactKind } from "../../../../lib/db/p1-metrics-facts.js";

export const dynamic = "force-dynamic";
const kinds: FactKind[] = ["funnel", "cost", "validator"];
function safeKind(value: string | undefined): FactKind { return kinds.includes(value as FactKind) ? value as FactKind : "funnel"; }

/** Read-only, deliberately sparse admin detail UI.  It never renders payloads,
 * hashes, errors, artifact identifiers, or storage locators. */
export default async function MetricsDetailsPage({ searchParams }: { searchParams: Promise<{ kind?: string; cursor?: string }> }) {
  const session = await auth(); if (session?.user?.role !== "admin") notFound();
  const params = await searchParams; const kind = safeKind(params.kind); const window = dashboardWindow();
  const page = listMetricDetailsPage(getDb(), { kind, ...window, as_of: new Date().toISOString(), limit: 100 });
  return <section>
    <p><Link href="/admin/metrics">← P1 溯源驾驶舱</Link></p>
    <h2>受控指标明细</h2>
    <p className="muted">UTC 窗口最多 31 天；每页最多 100 条。诊断 payload、hash、对象定位符和错误正文不会显示。</p>
    <p>{kinds.map((value) => <Link key={value} href={`/admin/metrics/details?kind=${value}`}>{value}{value === kind ? "（当前）" : ""} </Link>)}</p>
    {page.items.length ? <table className="stats"><thead><tr><th>时间</th><th>Trace</th><th>阶段</th><th>管线</th><th>Topic</th><th>Source</th><th>类型</th></tr></thead><tbody>{page.items.map((item) => <tr key={String(item.event_id ?? item.entry_id ?? item.result_id)}><td>{String(item.occurred_at)}</td><td>{String(item.trace_id)}</td><td>{String(item.stage)}</td><td>{String(item.pipeline_version)}</td><td>{item.topic_id ? String(item.topic_id) : "—"}</td><td>{item.source_id ? String(item.source_id) : "—"}</td><td>{kind}</td></tr>)}</tbody></table> : <p className="muted">该窗口没有可见明细。</p>}
  </section>;
}
