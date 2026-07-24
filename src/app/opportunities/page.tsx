/** 技术规划页：事实、待验证假设和人工决策刻意分层呈现。 */
import { auth } from "../../auth.js";
import { getDb } from "../../lib/db/index.js";
import { listOpportunityLeads, listTechnologyOpportunities, listTopicDirections } from "../../lib/db/planning.js";
import { listTechLeadEvidence } from "../../lib/db/tech-leads.js";
import { listTopics } from "../../lib/db/repos.js";
import { OpportunityActions } from "./_components/opportunity-actions.js";
import { DirectionWorkbench } from "./_components/direction-workbench.js";

export const dynamic = "force-dynamic";
const LANE: Record<string, string> = { core: "核心方向", adjacent: "相邻机会", horizon: "方向校准", challenge: "反证 / 风险" };
const EFFECT: Record<string, string> = { reinforce: "强化", expand: "扩展", challenge: "挑战", new_direction: "新方向候选" };
const LANE_ORDER = ["core", "adjacent", "horizon", "challenge"] as const;

export default async function OpportunitiesPage(): Promise<React.ReactElement> {
  const db = getDb();
  const opportunities = listTechnologyOpportunities(db);
  const isAdmin = (await auth())?.user?.role === "admin";
  const topics = listTopics(db);
  const directionList = listTopicDirections(db, { includeRetired: isAdmin });
  const directions = new Map(directionList.map((direction) => [direction.id, direction]));
  const topicNames = new Map(topics.map((topic) => [topic.id, topic.name]));
  return <section>
    <h2>技术规划机会</h2>
    <p className="muted">候选由已校验技术线索确定性映射而来。它们是研究 / PoC / 立项输入，不是项目批准；“待验证假设”与原始事实严格分开。</p>
    {!opportunities.length ? <p className="muted">暂无机会候选。新一轮通过校验的技术线索会自动进入匹配或方向校准队列。</p> : LANE_ORDER.map((lane) => {
      const inLane = opportunities.filter((opportunity) => opportunity.lane === lane);
      if (!inLane.length) return null;
      return <section className="opportunity-lane" key={lane}>
        <h3>{LANE[lane]}</h3>
        <p className="muted">{lane === "horizon" ? "未命中当前方向、但达到高价值阈值的校准信号；不会自动新建方向。" : lane === "challenge" ? "可能约束或反证现有方向的信号；需要人工判断其适用边界。" : "方向内候选，按可验证性、证据、重要性和时机排序。"}</p>
        {inLane.map((opportunity) => {
      const direction = opportunity.direction_id ? directions.get(opportunity.direction_id) : null;
      const leads = listOpportunityLeads(db, opportunity.id);
      const evidence = leads.flatMap((lead) => listTechLeadEvidence(db, lead.id));
      return <article className="card lead-card opportunity-card" key={opportunity.id}>
        <div className="card-meta"><span className="tag-chip">{LANE[opportunity.lane]}</span>{opportunity.mapping_state === "stale" ? <span className="tag-chip">规则已更新 · 待复核</span> : null}<span className="imp-badge imp-4">{Math.round(opportunity.priority_score)} 分</span><span className="muted">{topicNames.get(opportunity.topic_id) ?? opportunity.topic_id} · {direction?.name ?? "待校准方向"} · {EFFECT[opportunity.planning_effect]}</span></div>
        <h3>{opportunity.title}</h3>
        <p><strong>待验证假设：</strong>{opportunity.hypothesis.replace(/^待验证假设：/, "")}</p>
        <p><strong>建议验证：</strong>{opportunity.proposed_validation}</p>
        <p className="muted">{opportunity.score_detail.reason} · 当前状态：{opportunity.status}</p>
        <details><summary>可追溯事实证据（{evidence.length}）</summary><ul>{evidence.map((item) => <li key={`${item.lead_id}:${item.insight_id}:${item.citation_index}`}><a href={item.url} target="_blank" rel="noreferrer">{item.source_name}</a> · {item.observed_at.slice(0, 10)}<br />「{item.quote}」</li>)}</ul></details>
        <details><summary>不确定性（{opportunity.uncertainties.length}）</summary><ul>{opportunity.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></details>
        {isAdmin ? <p><OpportunityActions id={opportunity.id} status={opportunity.status} /></p> : null}
      </article>;
        })}
      </section>;
    })}
    <details className="card"><summary>当前方向档案（{directions.size}）</summary>{[...directions.values()].map((direction) => <section key={direction.id}><h4>{direction.name}</h4><p className="muted">{direction.objective} · {direction.status} · {direction.horizon} · v{direction.version}</p><p>关键问题：{direction.key_questions.join("；")}</p></section>)}</details>
    {isAdmin ? <DirectionWorkbench directions={directionList} topics={topics} /> : null}
  </section>;
}
