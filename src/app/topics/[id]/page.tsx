/** 主题页（product-definition 核心界面 line 235）：该主题的报告时间线、关键实体、重大事件标注。
 *  纯服务端组件 + 一个客户端深挖按钮（复用 settings 的 DeepDiveButton）。
 *  - 时间线：该主题全部报告按日期倒序，重要性 ≥4 标「重大」徽标；
 *  - 关键实体：跨报告聚合 entity_names，按出现频次降序取 Top；
 *  - 入口：对该主题触发深挖（analyze→validate→report-gen，type=deep_dive）。 */
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db/index.js";
import { queryReportIndex } from "../../../lib/db/reports.js";
import { getTopic } from "../../../lib/db/repos.js";
import { DeepDiveButton } from "../../settings/_components/deep-dive-button.js";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

/** 跨报告聚合实体 → [名称, 频次] 降序 Top N（同频次保持首次出现序，靠稳定排序）。 */
function topEntities(entityLists: string[][], limit = 15): Array<[string, number]> {
  const freq = new Map<string, number>();
  for (const names of entityLists) {
    for (const name of names) {
      const k = name.trim();
      if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const topic = getTopic(db, id);
  if (!topic) notFound();

  const reports = queryReportIndex(db, { topic: id, sort: "date", dir: "desc", limit: 500 });
  const entities = topEntities(reports.map((r) => r.entity_names));

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
        <DeepDiveButton topicId={topic.id} topicName={topic.name} enabled={topic.enabled} />
      </p>
      {topic.keywords.length ? <p className="muted">关键词：{topic.keywords.join(" / ")}</p> : null}

      {entities.length ? (
        <>
          <h3>关键实体</h3>
          <p>
            {entities.map(([name, n]) => (
              <span key={name} className="entity-tag">
                {name}
                {n > 1 ? <span className="muted"> ×{n}</span> : null}
              </span>
            ))}
          </p>
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
