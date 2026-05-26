import { getDb } from "../../lib/db/index.js";
import { listRuns } from "../../lib/db/repos.js";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { running: "运行中", done: "完成", failed: "失败" };

export default function AdminPage() {
  const runs = listRuns(getDb(), { limit: 50 });
  const failed = runs.filter((r) => r.status === "failed").length;
  const totalCost = runs.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);

  return (
    <section>
      <h2>管理看板</h2>
      <p className="muted">
        最近 {runs.length} 条运行 · 失败 {failed} · 估算成本 ${totalCost.toFixed(4)}
      </p>
      {runs.length === 0 ? (
        <p className="muted">暂无运行记录。采集/分析/校验/报告执行后会出现在这里。</p>
      ) : (
        runs.map((r) => (
          <article className="card" key={r.id}>
            <strong>{r.kind}</strong> · {STATUS_LABEL[r.status] ?? r.status}
            {r.duration_ms != null ? ` · ${r.duration_ms}ms` : ""}
            {r.cost ? ` · $${r.cost.amount.toFixed(4)} / ${r.cost.tokens} tok` : ""}
            <div className="muted">
              {r.id} · {r.started_at}
              {r.retry_of ? ` · 重试自 ${r.retry_of}` : ""}
            </div>
            {r.error ? (
              <div className="muted">
                ❌ {r.error.type}: {r.error.message}
              </div>
            ) : null}
          </article>
        ))
      )}
    </section>
  );
}
