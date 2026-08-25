import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "../../../auth.js";
import { getDb } from "../../../lib/db/index.js";
import { dashboardWindow, readIntegrityDashboardStatus, readP1DashboardMetrics, type IntegrityDashboardStatus, type P1DashboardMetrics } from "../../../lib/db/p1-dashboard.js";

export const dynamic = "force-dynamic";

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function sectionUnavailable(label: string): ReactNode {
  return <article className="card"><h3>{label}</h3><p className="muted">诊断读模型暂不可用；报告阅读和发布不受影响。</p></article>;
}

export default async function MetricsDashboard() {
  if ((await auth())?.user?.role !== "admin") notFound();
  const window = dashboardWindow();
  let metrics: P1DashboardMetrics | null = null;
  let integrity: IntegrityDashboardStatus | null = null;
  try { metrics = readP1DashboardMetrics(getDb(), window); } catch { /* isolated diagnostic failure */ }
  try { integrity = readIntegrityDashboardStatus(getDb(), window); } catch { /* isolated diagnostic failure */ }

  return (
    <section>
      <p><Link href="/admin">← 管理看板</Link></p>
      <h2>P1 溯源驾驶舱</h2>
      <p className="muted">UTC 时间窗：{window.from.slice(0, 10)} 至 {window.to.slice(0, 10)}。仅消费追加事实与完整性投影。</p>

      {metrics ? <>
        <article className="card">
          <h3>漏斗</h3>
          {metrics.funnel.length ? <table className="stats"><thead><tr><th>阶段</th><th>收到 trace</th><th>到达 trace</th><th>转化</th><th>终态事件</th></tr></thead><tbody>{metrics.funnel.map((row) => <tr key={row.stage}><td><code>{row.stage}</code></td><td>{row.received_traces}</td><td>{row.reached_traces}</td><td>{row.conversion_pct == null ? "—" : `${row.conversion_pct.toFixed(1)}%`}</td><td>{row.terminal_events}</td></tr>)}</tbody></table> : <p className="muted">该时间窗没有漏斗事实。</p>}
          {metrics.funnel_loss_reasons.length ? <p className="muted">首次终态流失：{metrics.funnel_loss_reasons.map((row) => `${row.reason_code} ${row.traces}`).join(" · ")}</p> : null}
        </article>
        <article className="card">
          <h3>成本</h3>
          {metrics.costs.length ? <table className="stats"><thead><tr><th>UTC 日</th><th>管线/阶段</th><th>Provider / Model</th><th>币种</th><th>已知成本（minor）</th><th>已知条目</th><th>未知成本条目</th></tr></thead><tbody>{metrics.costs.map((row) => <tr key={`${row.bucket_date}:${row.pipeline_version}:${row.stage}:${row.provider}:${row.model}:${row.currency}`}><td>{row.bucket_date}</td><td>{row.pipeline_version} / {row.stage}</td><td>{row.provider} / {row.model}</td><td>{row.currency || "—"}</td><td>{row.known_cost_minor}</td><td>{row.known_cost_entries}</td><td className={row.unknown_cost_entries ? "bad" : undefined}>{row.unknown_cost_entries}</td></tr>)}</tbody></table> : <p className="muted">该时间窗没有成本事实。</p>}
        </article>
        <article className="card">
          <h3>阶段时延</h3>
          <p className="muted">完成 {metrics.latency_diagnostics.completed_traces} · 进行中 {metrics.latency_diagnostics.in_progress_traces} · 负时钟 {metrics.latency_diagnostics.negative_clock_samples} · 缺失时钟 {metrics.latency_diagnostics.missing_clock_samples}。</p>
          {metrics.latency.length ? <table className="stats"><thead><tr><th>转换</th><th>样本</th><th>P50</th><th>P95</th><th>P99</th></tr></thead><tbody>{metrics.latency.map((row) => <tr key={row.transition}><td>{row.transition}</td><td>{row.samples}</td><td>{duration(row.p50_ms)}</td><td>{duration(row.p95_ms)}</td><td>{duration(row.p99_ms)}</td></tr>)}</tbody></table> : <p className="muted">尚无可完成的时延样本。</p>}
        </article>
        <article className="card">
          <h3>Validator 原因</h3>
          {metrics.validator_reasons.length ? <table className="stats"><thead><tr><th>Validator</th><th>规则版本</th><th>原因</th><th>严重度</th><th>结果数</th><th>去重 trace</th></tr></thead><tbody>{metrics.validator_reasons.map((row) => <tr key={`${row.validator}:${row.rule_version}:${row.reason_code}:${row.severity}`}><td>{row.validator}</td><td>{row.rule_version}</td><td><code>{row.reason_code}</code></td><td>{row.severity}</td><td>{row.results}</td><td>{row.traces}</td></tr>)}</tbody></table> : <p className="muted">该时间窗没有 validator 结果。</p>}
        </article>
      </> : sectionUnavailable("指标")}

      {integrity ? <article className="card">
        <h3>受控完整性状态</h3>
        <p className="muted">每日 Merkle 汇总：{integrity.latest_daily_root ? `${integrity.latest_daily_root.utc_date} · ${integrity.latest_daily_root.status}` : "尚无汇总"}</p>
        {integrity.recent_events.length ? <table className="stats"><thead><tr><th>事件</th><th>严重度</th><th>时间</th></tr></thead><tbody>{integrity.recent_events.map((row) => <tr key={`${row.event_type}:${row.created_at}`}><td><code>{row.event_type}</code></td><td>{row.severity}</td><td>{row.created_at}</td></tr>)}</tbody></table> : <p className="muted">该时间窗没有受控完整性事件。</p>}
      </article> : sectionUnavailable("受控完整性状态")}
    </section>
  );
}
