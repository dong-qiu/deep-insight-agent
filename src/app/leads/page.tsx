/** 技术线索页：默认只呈现近期且未忽略的、由 pass 引用支撑的线索。 */
import { auth } from "../../auth.js";
import { getDb } from "../../lib/db/index.js";
import { listTechLeadEvidence, listTechLeads } from "../../lib/db/tech-leads.js";
import { listTopics } from "../../lib/db/repos.js";
import { LeadActions } from "./_components/lead-actions.js";
import { findGenerationTraceForEntity } from "../../lib/db/provenance.js";
import { ProvenanceTimeline } from "../reports/[id]/_components/provenance-timeline.js";

export const dynamic = "force-dynamic";
const KIND: Record<string, string> = { model: "模型", framework: "框架", paper: "论文", benchmark: "基准", tool: "工具", method: "方法", security: "安全", other: "技术动态" };

export default async function LeadsPage(): Promise<React.ReactElement> {
  const db = getDb();
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const leads = listTechLeads(db, { since });
  const names = new Map(listTopics(db).map((topic) => [topic.id, topic.name]));
  const isAdmin = (await auth())?.user?.role === "admin";
  return <section>
    <h2>技术线索</h2>
    <p className="muted">仅展示含成功校验引用的近期技术线索；推荐理由由新鲜度、证据和重要性确定性计算。</p>
    {!leads.length ? <p className="muted">暂无近期合格线索。系统不会用未校验内容凑推荐。</p> : leads.map((lead) => {
      const evidence = listTechLeadEvidence(db, lead.id);
      const traceId = isAdmin ? findGenerationTraceForEntity(db, { type: "tech_lead", locator: { kind: "id", id: lead.id } }) : null;
      return <article className="card lead-card" key={lead.id}>
        <div className="card-meta"><span className="tag-chip">{KIND[lead.kind]}</span><span className="imp-badge imp-4">{Math.round(lead.score)} 分</span><span className="muted">{names.get(lead.topic_id) ?? lead.topic_id}</span></div>
        <h3>{lead.title}</h3><p>{lead.summary}</p><p className="muted">{lead.score_detail.reason}</p>
        <details><summary>证据（{evidence.length}）</summary><ul>{evidence.map((item) => <li key={`${item.insight_id}:${item.citation_index}`}><a href={item.url} target="_blank" rel="noreferrer">{item.source_name}</a> · {item.observed_at.slice(0, 10)}<br />「{item.quote}」</li>)}</ul></details>
        {traceId ? <ProvenanceTimeline traceId={traceId} /> : null}
        <p><a className="ppt-btn ppt-btn-secondary" href={`/topics/${lead.topic_id}`}>查看主题并深挖</a>{isAdmin ? <LeadActions id={lead.id} status={lead.status} /> : null}</p>
      </article>;
    })}
  </section>;
}
