/** 知识图谱（ADR-0012 S1·实体共现图）。按主题一张图：节点=实体、边=同条洞察共现。
 *  纯派生（零 LLM）。服务端只装配「候选图」+ 主题/时间窗筛选；口径/最小共现交客户端实时滑块。 */
import { buildTopicGraphData } from "../../lib/db/graph.js";
import { getDb } from "../../lib/db/index.js";
import { listTopics } from "../../lib/db/repos.js";
import { ForceGraph } from "./_components/force-graph.js";

export const dynamic = "force-dynamic";

type SP = { [k: string]: string | string[] | undefined };
const val = (sp: SP, k: string): string => {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

const DAYS = [
  { v: "0", label: "全部" },
  { v: "30", label: "近 30 天" },
  { v: "90", label: "近 90 天" },
  { v: "180", label: "近 180 天" },
];

export default async function GraphPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = getDb();
  const topics = listTopics(db);

  const topicId = val(sp, "topic") || topics[0]?.id || "";
  const days = Number(val(sp, "days") || "0");
  const since =
    days > 0
      ? new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19)
      : undefined;

  const data = topicId ? buildTopicGraphData(db, topicId, { since }) : null;
  const topicName = topics.find((t) => t.id === topicId)?.name ?? topicId;

  return (
    <section>
      <h2>关系图</h2>
      <p className="muted">
        实体共现图：圈=实体、连线=两实体在同一条洞察里被一起提及。看清一个主题里「谁和谁总绑在一起」。
        <br />
        <strong>口径</strong>：<em>频次</em>=按共现次数（hub 主导、看大势）；<em>关联强度</em>=按 Jaccard（压低 hub、浮出「异常紧密」的非显然对）。拖<em>最小共现</em>实时调密度。
      </p>

      {topics.length === 0 ? (
        <p className="muted">暂无主题。</p>
      ) : (
        <>
          <form
            method="get"
            className="card"
            style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}
          >
            <label>
              主题
              <br />
              <select name="topic" defaultValue={topicId}>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              时间窗
              <br />
              <select name="days" defaultValue={String(days)}>
                {DAYS.map((d) => (
                  <option key={d.v} value={d.v}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">应用</button>
          </form>

          {data ? (
            <ForceGraph key={`${topicId}-${days}`} data={data} topic={topicId} since={since} topicName={topicName} />
          ) : null}
        </>
      )}
    </section>
  );
}
