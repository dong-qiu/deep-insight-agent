import { getDb } from "../../lib/db/index.js";
import { listRuns } from "../../lib/db/repos.js";
import { aggregateByKind } from "../../lib/runtime/run-stats.js";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { running: "运行中", done: "完成", failed: "失败" };

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTarget(target: Record<string, unknown>): string {
  const parts = Object.entries(target)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(" · ") : "（无 target）";
}

export default function AdminPage() {
  const runs = listRuns(getDb(), { limit: 50 });
  const stats = aggregateByKind(runs);
  const failed = runs.filter((r) => r.status === "failed").length;
  const totalCost = runs.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);

  return (
    <section>
      <h2>管理看板</h2>
      <p className="muted">
        最近 {runs.length} 条运行 · 失败 {failed} · 估算成本 ${totalCost.toFixed(4)}
      </p>

      {stats.length === 0 ? null : (
        <article className="card">
          <p className="muted" style={{ margin: 0 }}>按管线段分</p>
          <table className="stats">
            <thead>
              <tr>
                <th>kind</th>
                <th>total</th>
                <th>done</th>
                <th>failed</th>
                <th>running</th>
                <th>cost</th>
                <th>avg</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.kind}>
                  <td><code>{s.kind}</code></td>
                  <td>{s.total}</td>
                  <td>{s.done}</td>
                  <td className={s.failed > 0 ? "audit-reason" : undefined}>{s.failed}</td>
                  <td>{s.running}</td>
                  <td>${s.costUSD.toFixed(4)}</td>
                  <td>{fmtDuration(s.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      )}

      {runs.length === 0 ? (
        <p className="muted">暂无运行记录。采集/分析/校验/报告执行后会出现在这里。</p>
      ) : (
        runs.map((r) => (
          <article className="card" key={r.id}>
            <strong>{r.kind}</strong> · {STATUS_LABEL[r.status] ?? r.status}
            {r.duration_ms != null ? ` · ${fmtDuration(r.duration_ms)}` : ""}
            {r.cost ? ` · $${r.cost.amount.toFixed(4)} / ${r.cost.tokens} tok` : ""}
            <div className="muted">
              {r.id} · {r.started_at}
              {r.retry_of ? ` · 重试自 ${r.retry_of}` : ""}
            </div>
            {r.error ? (
              <div className="muted">
                ❌ <strong>{r.error.type}</strong>: {r.error.message}
              </div>
            ) : null}
            <details className="audit" style={{ marginTop: "0.5rem" }}>
              <summary>详情</summary>
              <p className="muted" style={{ marginBottom: "0.25rem" }}>
                target：<code>{fmtTarget(r.target)}</code>
              </p>
              {r.cost ? (
                <p className="muted" style={{ marginBottom: "0.25rem" }}>
                  成本：${r.cost.amount.toFixed(6)} · {r.cost.tokens.toLocaleString()} tok
                </p>
              ) : (
                <p className="muted" style={{ marginBottom: "0.25rem" }}>成本：—（确定性环节或未调 LLM）</p>
              )}
              {r.error?.stack ? (
                <details>
                  <summary className="muted">完整错误堆栈</summary>
                  <pre className="audit-row" style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", overflowX: "auto" }}>
                    {r.error.stack}
                  </pre>
                </details>
              ) : null}
            </details>
          </article>
        ))
      )}
    </section>
  );
}
