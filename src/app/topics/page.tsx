/** 主题导航（IA「主题」主导航 · product-definition line 219）：已订阅主题一览，
 *  每个主题持续聚合演化。纯服务端组件，无客户端 state——列出 topic + 报告条数/最新报告日期，
 *  点进 = 主题页（时间线 / 关键实体 / 重大事件）。 */
import { getDb } from "../../lib/db/index.js";
import { topicReportStats } from "../../lib/db/reports.js";
import { listTopics } from "../../lib/db/repos.js";

export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const db = getDb();
  const topics = listTopics(db);
  const stats = topicReportStats(db);

  return (
    <section>
      <h2>主题</h2>
      <p className="muted">围绕主题持续聚合演化。点进看该主题的报告时间线、关键实体与重大事件。</p>

      {topics.length === 0 ? (
        <p className="muted">
          暂无主题。去 <a href="/settings">设置</a> 新建主题，或等首跑管线自举默认主题。
        </p>
      ) : (
        topics.map((t) => {
          const s = stats.get(t.id);
          return (
            <article className="card" key={t.id}>
              <h3>
                <a href={`/topics/${t.id}`}>{t.name}</a>
                {t.enabled ? null : <span className="muted"> · 停用中</span>}
              </h3>
              <p className="muted">
                {t.industry} · {t.language}
                {" · "}
                {s ? `${s.count} 份报告 · 最新 ${s.latestDate}` : "暂无报告"}
              </p>
              {t.keywords.length ? <p className="muted">关键词：{t.keywords.join(" / ")}</p> : null}
            </article>
          );
        })
      )}
    </section>
  );
}
