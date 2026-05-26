import { getEffectiveModels, loadStaticConfig } from "../../lib/config/index.js";
import { getDb } from "../../lib/db/index.js";
import { listSources, listTopics } from "../../lib/db/repos.js";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const db = getDb();
  const sources = listSources(db);
  const topics = listTopics(db);
  let models: { analyzer: string; validator: string } | null = null;
  try {
    models = getEffectiveModels(loadStaticConfig());
  } catch {
    models = null; // ANTHROPIC_API_KEY 未配时配置加载会抛
  }

  return (
    <section>
      <h2>设置</h2>

      <h3>模型对子</h3>
      {models ? (
        <p className="muted">
          分析 <code>{models.analyzer}</code> · 校验 <code>{models.validator}</code>
        </p>
      ) : (
        <p className="muted">（模型配置未就绪：检查 ANTHROPIC_API_KEY 环境变量）</p>
      )}

      <h3>主题（{topics.length}）</h3>
      {topics.length === 0 ? (
        <p className="muted">暂无主题（首次运行会从默认配置播种）。</p>
      ) : (
        topics.map((t) => (
          <div className="card" key={t.id}>
            <strong>{t.name}</strong>
            <div className="muted">
              {t.industry} · {t.language} · brief {t.brief_schedule} · 关键词 {t.keywords.join("、")}
              {t.enabled ? "" : " · 已停用"}
            </div>
          </div>
        ))
      )}

      <h3>数据源（{sources.length}）</h3>
      {sources.length === 0 ? (
        <p className="muted">暂无数据源。</p>
      ) : (
        sources.map((s) => (
          <div className="card" key={s.id}>
            <strong>{s.name}</strong>
            <div className="muted">
              {s.type} · {s.industry} · 每 {s.fetch_interval} · 主题 {s.topic_ids.join("、")}
              {s.enabled ? "" : " · 已停用"}
            </div>
          </div>
        ))
      )}

      <p className="muted">源 / 主题的增删改（写接口 + 表单）于后续子增量补。</p>
    </section>
  );
}
