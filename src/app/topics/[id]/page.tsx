/** 主题页（product-definition 核心界面 line 235）：焦点演化、实体热度趋势、报告时间线。
 *  纯服务端组件 + 一个客户端深挖按钮（复用 settings 的 DeepDiveButton）。
 *  - 焦点演化（ADR-0005 ①）：≥3 篇报告时按时间展示每期焦点标签的漂移；<3 篇降级隐藏；
 *  - 实体热度趋势（ADR-0005 ②）：跨报告聚合 entity_names，sparkline + ↑↓→ 趋势 + 覆盖报告数；
 *  - 报告时间线：该主题全部报告按日期倒序，重要性 ≥4 标「重大」徽标；
 *  - 入口：对该主题触发深挖（analyze→validate→report-gen，type=deep_dive）。 */
import { notFound } from "next/navigation";
import { auth } from "../../../auth.js";
import { getDb } from "../../../lib/db/index.js";
import { type EntityTrend, entityTrends, queryReportIndex, topicEvolution } from "../../../lib/db/reports.js";
import { getTopic } from "../../../lib/db/repos.js";
import { DeepDiveButton } from "../../settings/_components/deep-dive-button.js";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

// 演化轨迹需至少 N 篇报告才有「演化」可言（ADR-0005 选项 5），否则降级隐藏。
const EVOLUTION_MIN_REPORTS = 3;

// Unicode 块字符 sparkline——零依赖、随文本渲染（外层 .sparkline 钉等宽字体防错位）。
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";
function sparkline(buckets: number[]): string {
  const max = Math.max(...buckets, 1);
  return buckets.map((v) => SPARK_BLOCKS[Math.min(7, Math.round((v / max) * 7))]).join("");
}

const TREND_GLYPH: Record<EntityTrend["trend"], string> = { up: "↑", down: "↓", flat: "→" };
const TREND_LABEL: Record<EntityTrend["trend"], string> = { up: "升温", down: "降温", flat: "平稳" };

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isAdmin = (await auth())?.user?.role === "admin"; // 深挖烧钱 → 仅 admin 可触发（middleware 同步硬拦）
  const db = getDb();
  const topic = getTopic(db, id);
  if (!topic) notFound();

  const reports = queryReportIndex(db, { topic: id, sort: "date", dir: "desc", limit: 500 });
  const evolution = topicEvolution(reports); // 内部按日期升序（过去→现在）
  const trends = entityTrends(reports);
  const milestoneReports = reports.filter((r) => r.milestone_count > 0); // 里程碑时间线（ADR-0006）

  return (
    <section>
      <p className="report-header muted">
        <a href="/topics">← 主题</a>
      </p>

      <h2>
        {topic.name}
        {topic.enabled ? null : <span className="muted"> · 停用中</span>}
      </h2>
      <p className="muted">
        {topic.industry} · {topic.language} · brief {topic.brief_schedule}
        {isAdmin ? <DeepDiveButton topicId={topic.id} topicName={topic.name} enabled={topic.enabled} /> : null}
      </p>
      {topic.keywords.length ? <p className="muted">关键词：{topic.keywords.join(" / ")}</p> : null}

      {evolution.length >= EVOLUTION_MIN_REPORTS ? (
        <>
          <h3>焦点演化</h3>
          <p className="muted evo-hint">每期焦点标签随时间的漂移（← 早 · 近 →）</p>
          <ol className="evo-track">
            {evolution.map((p) => {
              const focus = p.focus_tags.length ? p.focus_tags : p.focus_entities;
              return (
                <li className="evo-point" key={p.report_id}>
                  <a className="evo-date" href={`/reports/${p.report_id}`}>
                    {p.date.slice(5)}
                    {p.major ? (
                      <span className="evo-major" title="重大">
                        ★
                      </span>
                    ) : null}
                  </a>
                  <span className="evo-focus">
                    {/* topicEvolution 已过滤空焦点点，focus 必非空 */}
                    {focus.map((f) => (
                      <span key={f} className="entity-tag">
                        {f}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      {trends.length ? (
        <>
          <h3>关键实体</h3>
          <p className="muted">跨报告热度（数字 = 出现的报告数，非提及次数）</p>
          <ul className="entity-trends">
            {trends.map((e) => (
              <li key={e.name} className="entity-trend">
                <span className="entity-tag">{e.name}</span>
                <span className="sparkline" aria-hidden="true">
                  {sparkline(e.buckets)}
                </span>
                <span className={`trend trend-${e.trend}`} title={TREND_LABEL[e.trend]}>
                  {TREND_GLYPH[e.trend]}
                </span>
                {e.total > 1 ? <span className="muted">×{e.total}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {milestoneReports.length ? (
        <>
          <h3>里程碑</h3>
          <p className="muted">主题里的重大新事件节点（最高重要性 · 新事件 · 非追加进展）</p>
          {milestoneReports.map((r) => (
            <article className="card milestone-card" key={r.report_id}>
              <h4>
                <a href={`/reports/${r.report_id}`}>{r.title}</a>
                <span className="milestone-badge">里程碑{r.milestone_count > 1 ? ` ×${r.milestone_count}` : ""}</span>
              </h4>
              <p className="muted">
                {TYPE_LABEL[r.type] ?? r.type} · {r.date}
              </p>
              <p>{r.summary || "（无摘要）"}</p>
            </article>
          ))}
        </>
      ) : null}

      <h3>报告时间线</h3>
      {reports.length === 0 ? (
        <p className="muted">
          该主题暂无报告。{topic.enabled ? "点上方「深挖」生成首份，或等定时管线产出。" : "启用后再深挖。"}
        </p>
      ) : (
        reports.map((r) => (
          <article className="card" key={r.report_id}>
            <h4>
              <a href={`/reports/${r.report_id}`}>{r.title}</a>
              {r.importance >= 4 ? <span className="major-badge">重大</span> : null}
              {r.milestone_count > 0 ? <span className="milestone-badge">里程碑</span> : null}
            </h4>
            <p className="muted">
              {TYPE_LABEL[r.type] ?? r.type} · {r.date} · 重要性 {r.importance}
            </p>
            <p>{r.summary || "（无摘要）"}</p>
          </article>
        ))
      )}
    </section>
  );
}
