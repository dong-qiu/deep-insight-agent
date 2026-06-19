import type { Run } from "../../lib/types.js";
import { getDb } from "../../lib/db/index.js";
import { listRuns, listSources } from "../../lib/db/repos.js";
import { getBudgetStatus, type BudgetStatus } from "../../lib/runtime/cost-guard.js";
import { aggregateByKind, aggregateDailyCost, aggregateSourceHealth, type SourceHealth } from "../../lib/runtime/run-stats.js";
import { RetryButton } from "./_components/retry-button.js";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { running: "运行中", done: "完成", failed: "失败" };

/** 源健康判定 → 状态文案 + .dash-badge/.dash-dot 颜色类（停用置灰、连续失败红、无采集/高失败率橙）。 */
function sourceVerdict(h: SourceHealth): { label: string; cls: "ok" | "alert" | "exceeded" | "off" } {
  if (!h.enabled) return { label: "停用", cls: "off" };
  if (h.consecutiveFails >= 3) return { label: `连续失败 ${h.consecutiveFails}`, cls: "exceeded" };
  if (h.total === 0) return { label: "无采集记录", cls: "alert" };
  if (h.successRate < 0.5) return { label: "高失败率", cls: "alert" };
  return { label: "正常", cls: "ok" };
}

function SourceHealthCard({ health }: { health: SourceHealth[] }) {
  if (health.length === 0) return null;
  const problems = health.filter((h) => h.enabled && (h.consecutiveFails >= 3 || h.total === 0 || h.successRate < 0.5)).length;
  return (
    <article className="card">
      <p className="muted dash-card-head">
        <span>数据源健康 · {health.length} 源</span>
        {problems > 0 ? <span className="dash-badge alert">⚠️ {problems} 需关注</span> : <span className="dash-badge ok">全部正常</span>}
      </p>
      <table className="stats">
        <thead>
          <tr><th>源</th><th>状态</th><th>成功率</th><th>最近成功</th><th>近期错误</th></tr>
        </thead>
        <tbody>
          {health.map((h) => {
            const v = sourceVerdict(h);
            return (
              <tr key={h.source_id}>
                <td>
                  <span className={`dash-dot ${v.cls}`} /> {h.name}
                  {h.type ? <span className="muted"> · {h.type}</span> : null}
                </td>
                <td><span className={`dash-badge ${v.cls}`}>{v.label}</span></td>
                <td>{h.total > 0 ? `${Math.round(h.successRate * 100)}% (${h.ok}/${h.total})` : "—"}</td>
                <td className="muted">{h.lastSuccessAt ? h.lastSuccessAt.slice(0, 10) : "从未"}</td>
                <td className="muted">{h.lastError ? `${h.lastError.type}: ${h.lastError.message.slice(0, 40)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}

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

const KINDS: Run["kind"][] = ["ingest", "analyze", "validate", "report-gen"];
const STATUSES: Run["status"][] = ["running", "done", "failed"];
const PAGE_SIZE = 50;

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const kindF = KINDS.includes(sp.kind as Run["kind"]) ? (sp.kind as Run["kind"]) : undefined;
  const statusF = STATUSES.includes(sp.status as Run["status"]) ? (sp.status as Run["status"]) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const db = getDb();
  // 概览聚合用近 50 条（不随筛选变，恒为最近概况）；时序图用近 30 天全量
  const runs = listRuns(db, { limit: 50 });
  const runsForTimeseries = listRuns(db, { limit: 2000 });
  const stats = aggregateByKind(runs);
  const failed = runs.filter((r) => r.status === "failed").length;
  const totalCost = runs.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);
  const daily = aggregateDailyCost(runsForTimeseries, { days: 30 });
  const dailyTotal = daily.reduce((s, d) => s + d.costUSD, 0);
  const dailyMax = Math.max(...daily.map((d) => d.costUSD), 0.001); // 防 0 除
  const budget = getBudgetStatus(db);
  // 数据源健康：近 500 条 ingest Run 叠加 source 清单（独立查询，避免被 50 条详情截断）
  const sourceHealth = aggregateSourceHealth(listRuns(db, { kind: "ingest", limit: 500 }), listSources(db));
  // 运行记录（可筛选 + 分页）：多取 1 条判有无下一页
  const pageRuns = listRuns(db, { kind: kindF, status: statusF, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  const hasNext = pageRuns.length > PAGE_SIZE;
  const shownRuns = pageRuns.slice(0, PAGE_SIZE);
  // 分页链接保留当前筛选
  const pageHref = (p: number): string => {
    const q = new URLSearchParams();
    if (kindF) q.set("kind", kindF);
    if (statusF) q.set("status", statusF);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/admin?${s}` : "/admin";
  };

  return (
    <section>
      <h2>管理看板</h2>
      <p className="muted">
        最近 {runs.length} 条运行 · 失败 {failed} · 估算成本 ${totalCost.toFixed(4)}
      </p>

      <BudgetCard status={budget} />

      <SourceHealthCard health={sourceHealth} />

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

      <h3 className="dash-runs-title">运行记录</h3>
      <form className="dash-filter" method="get">
        <select name="kind" defaultValue={kindF ?? ""} aria-label="按管线段筛选">
          <option value="">全部段</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select name="status" defaultValue={statusF ?? ""} aria-label="按状态筛选">
          <option value="">全部状态</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button type="submit">筛选</button>
        {kindF || statusF ? <a href="/admin" className="muted dash-filter-clear">清除</a> : null}
        <span className="muted dash-filter-page">第 {page} 页</span>
      </form>

      {shownRuns.length === 0 ? (
        <p className="muted">{kindF || statusF || page > 1 ? "当前筛选/页无运行记录。" : "暂无运行记录。采集/分析/校验/报告执行后会出现在这里。"}</p>
      ) : (
        shownRuns.map((r) => (
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

      {page > 1 || hasNext ? (
        <nav className="dash-pager" aria-label="运行记录分页">
          {page > 1 ? <a href={pageHref(page - 1)}>← 上一页</a> : <span className="muted">← 上一页</span>}
          <span className="muted">第 {page} 页</span>
          {hasNext ? <a href={pageHref(page + 1)}>下一页 →</a> : <span className="muted">下一页 →</span>}
        </nav>
      ) : null}
    </section>
  );
}
