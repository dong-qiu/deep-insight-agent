/** 设置页（B-3）：主题 / 数据源 CRUD。
 *  - 顶部为只读模型对子；
 *  - 主题/数据源各自分块：① 列表（每行内嵌编辑表单 details + 删除按钮）；② 新建（折叠 details）。
 *  - 表单通过客户端组件（TopicForm/SourceForm）调 /api/admin/* 路由，成功后 router.refresh()。 */
import { getEffectiveModels, loadStaticConfig } from "../../lib/config/index.js";
import { getDb } from "../../lib/db/index.js";
import { listRecipients } from "../../lib/db/recipients.js";
import { getSourceBodyKinds, listSources, listTopics } from "../../lib/db/repos.js";
import { listUsers } from "../../lib/db/users.js";
import { facetLabel } from "../../lib/topics/facets.js";
import { DOMAIN_ORDER, sourceDomains, sourceForm } from "./source-display.js";
import { CollectButton } from "./_components/collect-button.js";
import { DeepDiveButton } from "./_components/deep-dive-button.js";
import { DeleteButton } from "./_components/delete-button.js";
import { RecipientAdmin } from "./_components/recipient-admin.js";
import { SettingsStatusProvider } from "./_components/settings-status.js";
import { SourceForm } from "./_components/source-form.js";
import { TopicForm } from "./_components/topic-form.js";
import { UserAdmin } from "./_components/user-admin.js";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const db = getDb();
  const sources = listSources(db);
  const bodyKinds = getSourceBodyKinds(db); // source_id → 已产出形态集（标转写用）
  const topics = listTopics(db);

  // 按域分组渲染（Step2c：源的域由其 topic 的 facets 派生）；无域的源归「未分类」兜底组，
  // 确保设置页（唯一 CRUD 入口）不会静默丢源。一源跨多域会在多组各出现一次。
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const sourceGroups = [
    ...DOMAIN_ORDER.map((g) => ({
      key: g.id,
      label: g.label,
      items: sources.filter((s) => sourceDomains(s, topicById).has(g.id)),
    })),
    { key: "__other__", label: "未分类", items: sources.filter((s) => sourceDomains(s, topicById).size === 0) },
  ].filter((g) => g.items.length > 0);
  const users = listUsers(db);
  const recipients = listRecipients(db);
  let models: { analyzer: string; validator: string } | null = null;
  try {
    models = getEffectiveModels(loadStaticConfig());
  } catch {
    models = null;
  }

  return (
    <SettingsStatusProvider>
    <section>
      <h2>设置</h2>

      {/* 长页面锚点导航：标题带计数，点击直达对应分区（零 JS 纯锚点）*/}
      <nav className="muted" style={{ margin: ".25rem 0 1rem" }}>
        <a href="#users">用户（{users.length}）</a>
        <a href="#recipients">收件人（{recipients.length}）</a>
        <a href="#topics">主题（{topics.length}）</a>
        <a href="#sources">数据源（{sources.length}）</a>
      </nav>

      {/* 只读模型对子：低频查看，折叠收起避免占据顶部最显眼位 */}
      <details style={{ margin: ".5rem 0" }}>
        <summary className="muted" style={{ cursor: "pointer" }}>
          模型对子{models ? `（分析 ${models.analyzer} · 校验 ${models.validator}）` : "（未就绪）"}
        </summary>
        {models ? (
          <p className="muted" style={{ marginTop: ".5rem" }}>
            分析 <code>{models.analyzer}</code> · 校验 <code>{models.validator}</code>。
            由环境变量 / config 配置（只读）；更换模型需改配置并重启服务。
          </p>
        ) : (
          <p className="muted" style={{ marginTop: ".5rem" }}>（模型配置未就绪：检查 ANTHROPIC_API_KEY 环境变量）</p>
        )}
      </details>

      <h3 id="users">用户 / 访问（{users.length}）</h3>
      <p className="muted">
        受邀账号——发邮箱+密码给可信的人即可登录。一律 <strong>viewer（只读）</strong>：能看 Brief/报告/主题，
        不能进配置、不能触发深挖/追问/导出。<strong>唯一管理员是内置账号</strong>（环境变量），不在此列、不可删/不可在此增设。
      </p>
      <UserAdmin initial={users} />

      <h3 id="recipients">邮件分发收件人（{recipients.length}）</h3>
      <p className="muted">
        每份 Brief / 报告推送会发到这里启用的邮箱（与飞书并行）。<strong>名单为空时回落到环境变量
        REPORT_EMAIL_TO</strong>（兜底）；只要库里有启用收件人，就以此名单为准。停用＝暂停发送但保留，删除＝移出名单。
        SMTP 发信账号仍由环境变量（SMTP_HOST/USER/PASS）配置。
      </p>
      <RecipientAdmin initial={recipients} />

      <h3 id="topics">主题（{topics.length}）</h3>
      {topics.length === 0 ? (
        <p className="muted">暂无主题（首次运行会从默认配置播种）。</p>
      ) : (
        topics.map((t) => (
          <div className="card" key={t.id}>
            <strong>{t.name}</strong>
            <code className="muted" style={{ marginLeft: ".5rem", fontSize: ".8rem" }}>{t.id}</code>
            <div className="muted">
              {(t.facets ?? []).map(facetLabel).join("·")} · {t.language} · brief {t.brief_schedule} · 关键词 {t.keywords.join("、")}
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

      <h3 id="sources">数据源（{sources.length}）</h3>
      {sources.length === 0 ? (
        <p className="muted">暂无数据源。</p>
      ) : (
        sourceGroups.map(({ key, label, items }) => {
          const offCount = items.filter((s) => !s.enabled).length;
          return (
            <div key={key} style={{ marginBottom: "1rem" }}>
              <h4 className="muted" style={{ margin: "1rem 0 .5rem", fontWeight: 600 }}>
                {label}（{items.length}
                {offCount ? ` · ${offCount} 已停用` : ""}）
              </h4>
              {items.map((s) => {
                const kinds = bodyKinds.get(s.id);
                const form = sourceForm(s, kinds);
                const hasTranscript = kinds?.has("transcript") ?? false;
                return (
                  <div className="card" key={s.id}>
                    <span aria-hidden title={form.label} style={{ marginRight: ".4rem" }}>{form.icon}</span>
                    <strong>{s.name}</strong>
                    <code className="muted" style={{ marginLeft: ".5rem", fontSize: ".8rem" }}>{s.id}</code>
                    <div className="muted">
                      {form.label}
                      {hasTranscript ? " · 有转写" : ""} · {s.type} · 每 {s.fetch_interval} · 主题{" "}
                      {s.topic_ids.join("、")}
                      {s.enabled ? "" : " · 已停用"}
                      <CollectButton sourceId={s.id} sourceName={s.name} enabled={s.enabled} />
                      <DeleteButton entity="sources" id={s.id} name={s.name} />
                    </div>
                    <details style={{ marginTop: ".5rem" }}>
                      <summary className="muted" style={{ cursor: "pointer", fontSize: ".85rem" }}>编辑</summary>
                      <SourceForm mode="edit" initial={s} topics={topics.map((t) => ({ id: t.id, name: t.name }))} />
                    </details>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ 新建数据源</summary>
        <SourceForm mode="create" topics={topics.map((t) => ({ id: t.id, name: t.name }))} />
      </details>
    </section>
    </SettingsStatusProvider>
  );
}
