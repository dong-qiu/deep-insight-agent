import Link from "next/link";
import type { Run } from "../../lib/types.js";
import { getDb } from "../../lib/db/index.js";
import { batchTopicMap, listRuns, listSources, listTopics, sourceContribution } from "../../lib/db/repos.js";
import { listRecentReports, reportStatusCounts, type RecentReport } from "../../lib/db/reports.js";
import { getBudgetStatus, type BudgetStatus } from "../../lib/runtime/cost-guard.js";
import { aggregateByKind, aggregateDailyCost, aggregateSourceHealth, groupRunsIntoRounds, type SourceHealth } from "../../lib/runtime/run-stats.js";
import { RetryButton } from "./_components/retry-button.js";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { running: "运行中", done: "完成", failed: "失败" };

/** 报告状态 → 文案 + 颜色类（生命周期视图 · spec line 301）。 */
const REPORT_STATUS: Record<string, { label: string; cls: "ok" | "alert" | "exceeded" | "off" }> = {
  done: { label: "完成", cls: "ok" },
  generating: { label: "生成中", cls: "alert" },
  failed: { label: "失败", cls: "exceeded" },
  draft: { label: "草稿", cls: "off" },
  archived: { label: "归档", cls: "off" },
  deleted: { label: "删除", cls: "off" },
};

// 报告类型中文（生命周期表的「类型」列；与 report-gen 标题里的"今日 Brief/深度报告"口径一致）
const REPORT_TYPE_CN: Record<string, string> = { brief: "简报", deep_dive: "深挖", initial_digest: "综述" };

function ReportLifecycleCard({ counts, recent, topicNames }: { counts: Record<string, number>; recent: RecentReport[]; topicNames: Map<string, string> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const order = ["done", "generating", "failed", "draft", "archived", "deleted"];
  return (
    <article className="card">
      <p className="muted dash-card-head">
        <span>报告生命周期 · 共 {total}</span>
        <span>
          {order.filter((s) => counts[s]).map((s) => (
            <span key={s} className={`dash-badge ${REPORT_STATUS[s].cls} dash-status-pill`}>{REPORT_STATUS[s].label} {counts[s]}</span>
          ))}
        </span>
      </p>
      <table className="stats">
        <thead><tr><th>报告</th><th>类型</th><th>状态</th><th>引用</th><th>成本</th><th>生成于</th></tr></thead>
        <tbody>
          {recent.map((r) => {
            const m = REPORT_STATUS[r.status] ?? { label: r.status, cls: "off" as const };
            // 报告名简化：只显主题名（类型/日期已是单独列，标题里的"· 类型 · 日期"是重复）；fallback 原标题
            const name = topicNames.get(r.topic_id) ?? r.title;
            return (
              <tr key={r.id}>
                <td title={r.title}>{r.status === "done" ? <a href={`/reports/${r.id}`}>{name}</a> : name}</td>
                <td className="muted">{REPORT_TYPE_CN[r.type] ?? r.type}</td>
                <td><span className={`dash-dot ${m.cls}`} /> {m.label}</td>
                <td>{r.citation_count}</td>
                <td className="muted">{r.cost?.amount ? `$${r.cost.amount.toFixed(4)}` : "—"}</td>
                <td className="muted">{r.generated_at.slice(0, 10)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}

/** 源健康判定 → 状态文案 + .dash-badge/.dash-dot 颜色类（停用置灰、连续失败红、无采集/高失败率橙）。 */
function sourceVerdict(h: SourceHealth): { label: string; cls: "ok" | "alert" | "exceeded" | "off" } {
  if (!h.enabled) return { label: "停用", cls: "off" };
  if (h.consecutiveFails >= 3) return { label: `连续失败 ${h.consecutiveFails}`, cls: "exceeded" };
  if (h.total === 0) return { label: "无采集记录", cls: "alert" };
  if (h.successRate < 0.5) return { label: "高失败率", cls: "alert" };
  return { label: "正常", cls: "ok" };
}

function SourceHealthCard({ health, contribution }: { health: SourceHealth[]; contribution: Map<string, number> }) {
  if (health.length === 0) return null;
  const problems = health.filter((h) => h.enabled && (h.consecutiveFails >= 3 || h.total === 0 || h.successRate < 0.5)).length;
  return (
    <article className="card">
      <p className="muted dash-card-head">
        <span>数据源健康 · {health.length} 源</span>
        {problems > 0 ? <span className="dash-badge alert">⚠️ {problems} 需关注</span> : <span className="dash-badge ok">全部正常</span>}
      </p>
      <table className="stats dash-health">
        <colgroup>
          <col className="c-src" /><col className="c-status" /><col className="c-rate" /><col className="c-last" /><col className="c-contrib" /><col className="c-err" />
        </colgroup>
        <thead>
          <tr><th>源</th><th>状态</th><th>成功率</th><th>最近成功</th><th title="近 30 天被已上报报告引用的洞察数（揪常年 0 贡献源）">贡献</th><th>近期错误</th></tr>
        </thead>
        <tbody>
          {health.map((h) => {
            const v = sourceVerdict(h);
            const errText = h.lastError ? `${h.lastError.type}: ${h.lastError.message}` : "";
            const contrib = contribution.get(h.source_id) ?? 0;
            return (
              <tr key={h.source_id}>
                <td title={`${h.name}${h.type ? ` · ${h.type}` : ""}`}>
                  <span className={`dash-dot ${v.cls}`} /> {h.name}
                  {h.type ? <span className="muted"> · {h.type}</span> : null}
                </td>
                <td><span className={`dash-badge ${v.cls}`}>{v.label}</span></td>
                <td>{h.total > 0 ? `${Math.round(h.successRate * 100)}% (${h.ok}/${h.total})` : "—"}</td>
                <td className="muted">{h.lastSuccessAt ? h.lastSuccessAt.slice(0, 10) : "从未"}</td>
                <td className={contrib === 0 && h.enabled ? "dash-zero-contrib" : "muted"} title="近 30 天被已上报报告引用的洞察数">{contrib}</td>
                <td className="muted" title={errText}>{errText || "—"}</td>
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

// 管线段中文化 + 图标（运行记录可理解性）
const KIND_LABEL: Record<Run["kind"], string> = {
  ingest: "📥 采集", analyze: "🔍 分析", validate: "✅ 校验", "report-gen": "📝 报告生成",
};

/** 时间本地化（钉北京时区，生产 EC2 跑 UTC，避免读出 UTC 误导）+ 相对时间。 */
function fmtTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  const local = new Date(t).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const d = nowMs - t;
  const rel = d < 0 ? "" : d < 60_000 ? "刚刚" : d < 3_600_000 ? `${Math.floor(d / 60_000)}分钟前`
    : d < 86_400_000 ? `${Math.floor(d / 3_600_000)}小时前` : `${Math.floor(d / 86_400_000)}天前`;
  return rel ? `${local} · ${rel}` : local;
}

/** 仅 HH:MM（北京时区）——轮次区间的结束时刻。 */
function fmtHm(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
}

interface RunLookups { topics: Map<string, string>; sources: Map<string, string>; batchTopic: Map<string, string> }

/** 把 target 的内部 ID 解析成人话：topic_id / 经 batch_id → 主题名；source_id → 源名。内部 id 不外露。 */
function resolveTarget(target: Run["target"], lk: RunLookups): string {
  const parts: string[] = [];
  const topicId = target.topic_id ?? (target.batch_id ? lk.batchTopic.get(target.batch_id) : undefined);
  if (topicId) parts.push(`主题：${lk.topics.get(topicId) ?? topicId}`);
  if (target.source_id) parts.push(`源：${lk.sources.get(target.source_id) ?? target.source_id}`);
  return parts.join(" · ");
}

function RunCard({ r, nowMs, lk }: { r: Run; nowMs: number; lk: RunLookups }) {
  const ctx = resolveTarget(r.target, lk);
  return (
    <article className="card">
      <strong>{KIND_LABEL[r.kind] ?? r.kind}</strong> · {STATUS_LABEL[r.status] ?? r.status}
      {r.duration_ms != null ? ` · ${fmtDuration(r.duration_ms)}` : ""}
      {r.cost ? ` · $${r.cost.amount.toFixed(4)}` : ""}
      <div className="muted dash-run-meta">
        {ctx ? `${ctx} · ` : ""}{fmtTime(r.started_at, nowMs)}
        {r.retry_of ? " · 重试" : ""}
      </div>
      {r.error ? (
        <div className="muted">
          ❌ <strong>{r.error.type}</strong>: {r.error.message}
          {r.status === "failed" ? <RetryButton runId={r.id} kind={r.kind} /> : null}
        </div>
      ) : null}
      <details className="audit dash-detail">
        <summary>详情</summary>
        <p className="muted">运行 ID：<code>{r.id}</code>{r.retry_of ? <> · 重试自 <code>{r.retry_of}</code></> : null}</p>
        <p className="muted">
          {r.cost ? `成本 $${r.cost.amount.toFixed(6)} · ${r.cost.tokens.toLocaleString()} tokens` : "成本 —（确定性环节或未调 LLM）"}
        </p>
        <p className="muted">target（原始）：<code>{fmtTarget(r.target)}</code></p>
        {r.error?.stack ? (
          <details>
            <summary className="muted">完整错误堆栈</summary>
            <pre className="audit-row dash-stack">{r.error.stack}</pre>
          </details>
        ) : null}
      </details>
    </article>
  );
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
const RUN_WINDOW = 2000;     // 单一取数窗口：所有视图从这一批派生（带 started_at 索引，开销可忽略）
const ROUNDS_PER_PAGE = 7;   // 浏览模式：每页 7 轮（≈一周日度轮次），轮次原子不腰斩
const FLAT_PAGE = 50;        // 筛选模式：每页 50 条

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const kindF = KINDS.includes(sp.kind as Run["kind"]) ? (sp.kind as Run["kind"]) : undefined;
  const statusF = STATUSES.includes(sp.status as Run["status"]) ? (sp.status as Run["status"]) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const db = getDb();
  const nowMs = Date.now();
  // 单一数据源：一次取近 RUN_WINDOW 条（带 started_at 索引），所有视图从它派生，作用域统一。
  // 已知边界：超出窗口的更早轮次翻不到（windowFull 时文案标注）；窗口最末那一轮的更早 Run 可能落窗外、
  // 致末轮计数略偏小——较旧版"每页边界腰斩"已缩到"仅末轮"，影响极小，暂不为此放大取数。
  const allRuns = listRuns(db, { limit: RUN_WINDOW });
  const windowFull = allRuns.length >= RUN_WINDOW;
  const since30 = new Date(nowMs - 30 * 86_400_000).toISOString();

  // 概览（近似 30 天：recentRuns 按滚动 30×24h 切，与日历桶时序图边界差 <1 天，可忽略）
  const recentRuns = allRuns.filter((r) => r.started_at >= since30);
  const stats = aggregateByKind(recentRuns);
  const failed = recentRuns.filter((r) => r.status === "failed").length;
  const totalCost = recentRuns.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);
  const daily = aggregateDailyCost(allRuns, { days: 30 });
  const dailyTotal = daily.reduce((s, d) => s + d.costUSD, 0);
  const dailyMax = Math.max(...daily.map((d) => d.costUSD), 0.001); // 防 0 除
  const budget = getBudgetStatus(db);
  // 源健康：从同一 allRuns 取 ingest 子集（不再单独查）
  const sources = listSources(db);
  const sourceHealth = aggregateSourceHealth(allRuns.filter((r) => r.kind === "ingest"), sources);
  // 按源贡献（ADR-0008 决定⑦ 切片4）：近 30 天已上报报告里被引用的洞察数（读时聚合，揪常年 0 贡献源）
  const contribSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const contribution = sourceContribution(db, contribSince);
  // 报告生命周期：全状态计数 + 近 15 份（含 draft/generating/failed 瞬态）
  const reportCounts = reportStatusCounts(db);
  const recentReports = listRecentReports(db, 15);
  const topicNames = new Map(listTopics(db).map((t) => [t.id, t.name])); // 复用给生命周期报告名 + 运行记录 target 解析

  // 运行记录：浏览模式=按轮次翻页（轮次原子、不腰斩）；筛选模式=平铺按条翻页（查找）。
  const filterActive = !!(kindF || statusF);
  const matched = filterActive
    ? allRuns.filter((r) => (!kindF || r.kind === kindF) && (!statusF || r.status === statusF))
    : allRuns;
  const allRounds = filterActive ? [] : groupRunsIntoRounds(allRuns);
  const flatRuns = filterActive ? matched.slice((page - 1) * FLAT_PAGE, page * FLAT_PAGE) : [];
  const pageRounds = filterActive ? [] : allRounds.slice((page - 1) * ROUNDS_PER_PAGE, page * ROUNDS_PER_PAGE);
  const hasNext = filterActive ? matched.length > page * FLAT_PAGE : allRounds.length > page * ROUNDS_PER_PAGE;
  const totalUnits = filterActive ? matched.length : allRounds.length; // 总条数 / 总轮数
  const totalPages = Math.max(1, Math.ceil(totalUnits / (filterActive ? FLAT_PAGE : ROUNDS_PER_PAGE)));
  const isEmpty = (filterActive ? flatRuns : pageRounds).length === 0;

  // target 解析：只对实际渲染的 run；batch_id 精确查
  const renderedRuns = filterActive ? flatRuns : pageRounds.flatMap((r) => r.runs);
  const batchIds = [...new Set(renderedRuns.map((r) => r.target.batch_id).filter((b): b is string => !!b))];
  const lk: RunLookups = {
    topics: topicNames,
    sources: new Map(sources.map((s) => [s.id, s.name])),
    batchTopic: batchTopicMap(db, batchIds),
  };
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
        近 30 天 · {recentRuns.length} 次运行 · 失败 {failed} · 估算成本 ${totalCost.toFixed(4)}
      </p>

      <BudgetCard status={budget} />

      <SourceHealthCard health={sourceHealth} contribution={contribution} />

      {stats.length === 0 ? null : (
        <article className="card">
          <p className="muted dash-card-title">按管线段分（近 30 天）</p>
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

      <ReportLifecycleCard counts={reportCounts} recent={recentReports} topicNames={topicNames} />

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
        <span className="muted dash-filter-page">
          {filterActive ? `命中 ${matched.length} 条` : `共 ${totalUnits} 轮`}{windowFull ? "（仅近期窗口）" : ""} · 第 {page}/{totalPages} 页
        </span>
      </form>

      {isEmpty ? (
        <p className="muted">{filterActive || page > 1 ? "当前筛选/页无运行记录。" : "暂无运行记录。采集/分析/校验/报告执行后会出现在这里。"}</p>
      ) : filterActive ? (
        // 筛选模式 = 查找：平铺命中的 Run
        flatRuns.map((r) => <RunCard key={r.id} r={r} nowMs={nowMs} lk={lk} />)
      ) : (
        // 浏览模式：按管线轮次分组（轮次原子、按轮翻页），一眼看出"这轮干了啥/哪步断了"
        pageRounds.map((round) => (
          <article className="card dash-round" key={round.start}>
            <details>
              <summary>
                <strong>📅 {fmtTime(round.start, nowMs)}{round.end !== round.start ? ` → ${fmtHm(round.end)}` : ""}</strong>
                <span className="muted">
                  {" "}· 采集{round.counts.ingest} 分析{round.counts.analyze} 校验{round.counts.validate} 生成{round.counts["report-gen"]}
                  {" · "}{round.failed > 0 ? <span className="dash-badge exceeded">⚠️ {round.failed} 失败</span> : <span className="dash-badge ok">全部完成</span>}
                  {round.costUSD > 0 ? ` · $${round.costUSD.toFixed(2)}` : ""}
                </span>
              </summary>
              <div className="dash-round-runs">
                {round.runs.map((r) => <RunCard key={r.id} r={r} nowMs={nowMs} lk={lk} />)}
              </div>
            </details>
          </article>
        ))
      )}

      {page > 1 || hasNext ? (
        <nav className="dash-pager" aria-label="运行记录分页">
          {page > 1 ? <Link href={pageHref(page - 1)} scroll={false}>← 上一页</Link> : <span className="muted">← 上一页</span>}
          <span className="muted">第 {page}/{totalPages} 页{filterActive ? "（按条）" : "（按轮次）"}</span>
          {hasNext ? <Link href={pageHref(page + 1)} scroll={false}>下一页 →</Link> : <span className="muted">下一页 →</span>}
        </nav>
      ) : null}
    </section>
  );
}
