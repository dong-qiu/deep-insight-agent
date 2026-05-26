import { getDb } from "../../lib/db/index.js";
import { listReportIndex } from "../../lib/db/reports.js";

// 读 SQLite，按请求渲染（不在 build 期静态生成）
export const dynamic = "force-dynamic";

export default function ReportsPage() {
  const rows = listReportIndex(getDb());
  return (
    <section>
      <h2>报告库</h2>
      {rows.length === 0 ? (
        <p className="muted">暂无报告。后端管线产出后会出现在这里。</p>
      ) : (
        rows.map((r) => (
          <article className="card" key={r.report_id}>
            <h3>
              <a href={`/reports/${r.report_id}`}>{r.title}</a>
            </h3>
            <p className="muted">
              {r.type} · {r.industry} · {r.date} · 重要性 {r.importance}
            </p>
            <p>{r.summary || "（无摘要）"}</p>
          </article>
        ))
      )}
    </section>
  );
}
