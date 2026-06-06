/** 设置页（B-3）：主题 / 数据源 CRUD。
 *  - 顶部为只读模型对子；
 *  - 主题/数据源各自分块：① 列表（每行内嵌编辑表单 details + 删除按钮）；② 新建（折叠 details）。
 *  - 表单通过客户端组件（TopicForm/SourceForm）调 /api/admin/* 路由，成功后 router.refresh()。 */
import { getEffectiveModels, loadStaticConfig } from "../../lib/config/index.js";
import { getDb } from "../../lib/db/index.js";
import { listSources, listTopics } from "../../lib/db/repos.js";
import { CollectButton } from "./_components/collect-button.js";
import { DeepDiveButton } from "./_components/deep-dive-button.js";
import { DeleteButton } from "./_components/delete-button.js";
import { SourceForm } from "./_components/source-form.js";
import { TopicForm } from "./_components/topic-form.js";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const db = getDb();
  const sources = listSources(db);
  const topics = listTopics(db);
  let models: { analyzer: string; validator: string } | null = null;
  try {
    models = getEffectiveModels(loadStaticConfig());
  } catch {
    models = null;
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
            <code className="muted" style={{ marginLeft: ".5rem", fontSize: ".8rem" }}>{t.id}</code>
            <div className="muted">
              {t.industry} · {t.language} · brief {t.brief_schedule} · 关键词 {t.keywords.join("、")}
              {t.enabled ? "" : " · 已停用"}
              <DeepDiveButton topicId={t.id} topicName={t.name} enabled={t.enabled} />
              <DeleteButton entity="topics" id={t.id} name={t.name} />
            </div>
            <details style={{ marginTop: ".5rem" }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: ".85rem" }}>编辑</summary>
              <TopicForm mode="edit" initial={t} />
            </details>
          </div>
        ))
      )}
      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ 新建主题</summary>
        <TopicForm mode="create" />
      </details>

      <h3>数据源（{sources.length}）</h3>
      {sources.length === 0 ? (
        <p className="muted">暂无数据源。</p>
      ) : (
        sources.map((s) => (
          <div className="card" key={s.id}>
            <strong>{s.name}</strong>
            <code className="muted" style={{ marginLeft: ".5rem", fontSize: ".8rem" }}>{s.id}</code>
            <div className="muted">
              {s.type} · {s.industry} · 每 {s.fetch_interval} · 主题 {s.topic_ids.join("、")}
              {s.enabled ? "" : " · 已停用"}
              <CollectButton sourceId={s.id} sourceName={s.name} enabled={s.enabled} />
              <DeleteButton entity="sources" id={s.id} name={s.name} />
            </div>
            <details style={{ marginTop: ".5rem" }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: ".85rem" }}>编辑</summary>
              <SourceForm mode="edit" initial={s} topics={topics.map((t) => ({ id: t.id, name: t.name }))} />
            </details>
          </div>
        ))
      )}
      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ 新建数据源</summary>
        <SourceForm mode="create" topics={topics.map((t) => ({ id: t.id, name: t.name }))} />
      </details>
    </section>
  );
}
