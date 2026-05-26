import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db/index.js";
import { getReport } from "../../../lib/db/reports.js";
import { Markdown } from "../../_components/markdown.js";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = getReport(getDb(), id);
  if (!report) notFound();
  return (
    <section>
      <p className="muted">
        <a href="/reports">← 报告库</a>
      </p>
      <Markdown md={report.body_md} />
      <hr />
      <p className="muted">
        {report.type} · 纳入 {report.insight_ids.length} 洞察 / {report.citation_count} 引用 · 生成于{" "}
        {report.generated_at}
        {report.cost ? ` · 成本 $${report.cost.amount.toFixed(4)}` : ""}
      </p>
    </section>
  );
}
