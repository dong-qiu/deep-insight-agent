import { getDb } from "../../lib/db/index.js";
import { listRuns } from "../../lib/db/repos.js";
import { getBudgetStatus, type BudgetStatus } from "../../lib/runtime/cost-guard.js";
import { aggregateByKind, aggregateDailyCost } from "../../lib/runtime/run-stats.js";
import { RetryButton } from "./_components/retry-button.js";

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

// 颜色由 CSS .dash-badge.{verdict} 决定；这里只给文案。
const VERDICT_LABEL: Record<BudgetStatus["verdict"], string> = {
  ok: "正常",
  alert: "⚠️ 接近上限",
  exceeded: "⛔ 已触顶",
};

/** 单维度预算用量行：spent / limit + 百分比进度条。limit 缺失（未配）显「未设」。
 *  near（橙）阈值用生效的 alertPct，与告警/徽标判定口径一致（非硬编码 80）。 */
function BudgetRow({ label, spent, limit, ratio, alertPct }: { label: string; spent: number; limit?: number; ratio?: number; alertPct: number }) {
  if (limit == null) {
    return <p className="muted dash-note">{label}：${spent.toFixed(2)} · 未设上限</p>;
  }
  const pct = Math.min((ratio ?? 0) * 100, 100);
  const over = (ratio ?? 0) >= 1;
  const near = !over && (ratio ?? 0) * 100 >= alertPct;
  return (
    <div className="dash-budget-row">
      <p className="muted label">
        {label}：${spent.toFixed(2)} / ${limit.toFixed(2)}（{Math.round((ratio ?? 0) * 100)}%）
      </p>
      <div className="dash-bar">
        <i className={over ? "over" : near ? "near" : ""} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BudgetCard({ status }: { status: BudgetStatus }) {
  const noLimits = status.daily == null && status.monthly == null;
  return (
    <article className="card">
      <p className="muted dash-card-head">
        <span>成本预算</span>
        {!noLimits ? <span className={`dash-badge ${status.verdict}`}>{VERDICT_LABEL[status.verdict]}</span> : null}
      </p>
      {noLimits ? (
        <p className="muted dash-note">
          未设成本预算上限——配置 <code>COST_LIMIT_DAILY</code> / <code>COST_LIMIT_MONTHLY</code>（USD）后,
          触顶将自动熔断定时管线、告警推送，并在此显示用量。
        </p>
      ) : (
        <>
          <BudgetRow label="今日" spent={status.spentToday} limit={status.daily} ratio={status.dailyRatio} alertPct={status.alertPct} />
          <BudgetRow label="本月" spent={status.spentMonth} limit={status.monthly} ratio={status.monthlyRatio} alertPct={status.alertPct} />
          {status.reason ? <p className={`muted dash-reason dash-badge ${status.verdict}`}>{status.reason}</p> : null}
        </>
      )}
    </article>
  );
}

export default function AdminPage() {
  const db = getDb();
  // 看板用近 50 条详情；时序图用近 30 天全量（独立查询，避免 50 条把时序图截掉）
  const runs = listRuns(db, { limit: 50 });
  const runsForTimeseries = listRuns(db, { limit: 2000 });
  const stats = aggregateByKind(runs);
  const failed = runs.filter((r) => r.status === "failed").length;
  const totalCost = runs.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);
  const daily = aggregateDailyCost(runsForTimeseries, { days: 30 });
  const dailyTotal = daily.reduce((s, d) => s + d.costUSD, 0);
  const dailyMax = Math.max(...daily.map((d) => d.costUSD), 0.001); // 防 0 除
  const budget = getBudgetStatus(db);

  return (
    <section>
      <h2>管理看板</h2>
      <p className="muted">
        最近 {runs.length} 条运行 · 失败 {failed} · 估算成本 ${totalCost.toFixed(4)}
      </p>

      <BudgetCard status={budget} />

      {stats.length === 0 ? null : (
        <article className="card">
          <p className="muted dash-card-title">按管线段分</p>
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
                  <td className={s.failed > 0 ? "bad" : undefined}>{s.failed}</td>
                  <td>{s.running}</td>
                  <td>${s.costUSD.toFixed(4)}</td>
                  <td>{fmtDuration(s.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      )}

      <article className="card">
        <p className="muted dash-card-title">
          近 30 天成本时序 · 累计 ${dailyTotal.toFixed(4)} · 峰值 ${dailyMax.toFixed(4)}
        </p>
        {dailyTotal === 0 ? (
          /* review #4：全 0 时显占位文案，不渲染 30 个灰柱（视觉噪音）*/
          <p className="muted dash-note">
            近 30 天暂无成本数据——管线尚未运行或仅跑确定性段（采集/报告生成不调 LLM）。
          </p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${daily.length * 18} 80`}
              width="100%"
              height="80"
              preserveAspectRatio="none"
              className="dash-chart"
              aria-label="近 30 天成本柱状图"
              role="img"
            >
              {daily.map((d, i) => {
                const h = Math.max((d.costUSD / dailyMax) * 70, d.costUSD > 0 ? 1 : 0);
                const x = i * 18 + 2;
                const y = 80 - h - 2;
                return (
                  <g key={d.date}>
                    <title>{`${d.date} · $${d.costUSD.toFixed(4)} · ${d.runCount} Run`}</title>
                    <rect x={x} y={y} width={14} height={h} fill="#2563eb" opacity={d.costUSD > 0 ? 0.85 : 0.2} />
                  </g>
                );
              })}
            </svg>
            <p className="muted dash-chart-foot">
              {daily[0]?.date} → {daily[daily.length - 1]?.date}（悬停柱体看当日明细）
            </p>
          </>
        )}
      </article>

      {runs.length === 0 ? (
        <p className="muted">暂无运行记录。采集/分析/校验/报告执行后会出现在这里。</p>
      ) : (
        runs.map((r) => (
          <article className="card" key={r.id}>
            <strong>{r.kind}</strong> · {STATUS_LABEL[r.status] ?? r.status}
            {r.duration_ms != null ? ` · ${fmtDuration(r.duration_ms)}` : ""}
            {r.cost ? ` · $${r.cost.amount.toFixed(4)} / ${r.cost.tokens} tok` : ""}
            <div className="muted dash-run-meta">
              {r.id} · {r.started_at}
              {r.retry_of ? ` · 重试自 ${r.retry_of}` : ""}
            </div>
            {r.error ? (
              <div className="muted">
                ❌ <strong>{r.error.type}</strong>: {r.error.message}
                {r.status === "failed" ? <RetryButton runId={r.id} kind={r.kind} /> : null}
              </div>
            ) : null}
            <details className="audit dash-detail">
              <summary>详情</summary>
              <p className="muted">
                target：<code>{fmtTarget(r.target)}</code>
              </p>
              {r.cost ? (
                <p className="muted">
                  成本：${r.cost.amount.toFixed(6)} · {r.cost.tokens.toLocaleString()} tok
                </p>
              ) : (
                <p className="muted">成本：—（确定性环节或未调 LLM）</p>
              )}
              {r.error?.stack ? (
                <details>
                  <summary className="muted">完整错误堆栈</summary>
                  <pre className="audit-row dash-stack">{r.error.stack}</pre>
                </details>
              ) : null}
            </details>
          </article>
        ))
      )}
    </section>
  );
}
