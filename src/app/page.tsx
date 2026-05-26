import { getDb } from "../lib/db/index.js";
import { listReportIndex } from "../lib/db/reports.js";

export const dynamic = "force-dynamic";

export default function Home() {
  const briefs = listReportIndex(getDb()).filter((r) => r.type === "brief").slice(0, 10);
  return (
    <section>
      <h2>今日 Brief</h2>
      {briefs.length === 0 ? (
        <p className="muted">
          暂无 Brief。后端定时生成后会出现在这里（全部报告见 <a href="/reports">报告库</a>）。
        </p>
      ) : (
        briefs.map((r) => (
          <article className="card" key={r.report_id}>
            <h3>
              <a href={`/reports/${r.report_id}`}>{r.title}</a>
            </h3>
            <p className="muted">
              {r.date} · {r.industry} · 重要性 {r.importance}
            </p>
            <p>{r.summary || "（无摘要）"}</p>
          </article>
        ))
      )}
    </section>
  );
}
