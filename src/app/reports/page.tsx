/** 报告库（B-1+2）：URL query 驱动的搜索 + 筛选 + 排序——纯服务端组件 + HTML GET 表单。
 *  无客户端 state、无 JS 依赖；浏览器原生提交即可触发重渲染。
 *  搜索：FTS5（标题/摘要/正文）；筛选：主题/类型/行业/来源/标签/实体/日期区间；
 *  排序：date|importance × asc|desc。来源/标签/实体下拉只列实际出现过的值（distinctIndexValues）。 */
import { getDb } from "../../lib/db/index.js";
import { distinctIndexValues, queryReportIndex } from "../../lib/db/reports.js";
import { listSources, listTopics } from "../../lib/db/repos.js";
import { ReportCard } from "../_components/report-card.js";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

function val(sp: { [k: string]: string | string[] | undefined }, key: string): string {
  const v = sp[key];
  return typeof v === "string" ? v : "";
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const db = getDb();
  // 筛选下拉选项：主题/行业来自配置表；来源/标签/实体只列「实际出现在已有报告里」的值，
  // 避免给出永远 0 命中的选项。来源在索引里存的是源 id，join source 表映射为展示名。
  const topics = listTopics(db);
  const industries = [...new Set(topics.map((t) => t.industry))];
  const sourceName = new Map(listSources(db).map((s) => [s.id, s.name]));
  const sourceOptions = distinctIndexValues(db, "source_ids").map((id) => ({
    id,
    name: sourceName.get(id) ?? id, // 源已删除则回退显示 id，不丢可筛性
  }));
  const tagOptions = distinctIndexValues(db, "tags");
  const entityOptions = distinctIndexValues(db, "entity_names");

  const q = val(sp, "q");
  const type = val(sp, "type");
  const industry = val(sp, "industry");
  const topic = val(sp, "topic");
  const source = val(sp, "source");
  const tag = val(sp, "tag");
  const entity = val(sp, "entity");
  const from = val(sp, "from");
  const to = val(sp, "to");
  const sort = val(sp, "sort") || "date";
  const dir = val(sp, "dir") || "desc";

  const filters = { type, industry, topic, source, tag, entity, from, to, sort, dir };
  let rows: ReturnType<typeof queryReportIndex> = [];
  let err: string | null = null;
  try {
    rows = queryReportIndex(db, { q, ...filters });
  } catch (e) {
    // FTS5 对 q 的 token 有自己语法（如裸 "-" 会解析报错）；退路 = 不带 q 重查 + 友好提示
    err = `搜索语法不合法："${q}"；已忽略 q 重新列出。`;
    rows = queryReportIndex(db, filters);
  }
  const hasFilter = !!(q || type || industry || topic || source || tag || entity || from || to);

  return (
    <section>
      <h2>报告库</h2>

      <form method="get" className="report-filter">
        <input
          type="search"
          name="q"
          placeholder="搜索标题 / 摘要 / 正文（FTS5）"
          defaultValue={q}
          aria-label="搜索"
        />
        <select name="type" defaultValue={type} aria-label="类型">
          <option value="">全部类型</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select name="industry" defaultValue={industry} aria-label="行业">
          <option value="">全部行业</option>
          {industries.map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
        <select name="topic" defaultValue={topic} aria-label="主题">
          <option value="">全部主题</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {sourceOptions.length ? (
          <select name="source" defaultValue={source} aria-label="来源">
            <option value="">全部来源</option>
            {sourceOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        ) : null}
        {tagOptions.length ? (
          <select name="tag" defaultValue={tag} aria-label="标签">
            <option value="">全部标签</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        ) : null}
        {entityOptions.length ? (
          <select name="entity" defaultValue={entity} aria-label="实体">
            <option value="">全部实体</option>
            {entityOptions.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        ) : null}
        <input type="date" name="from" defaultValue={from} aria-label="开始日期" />
        <input type="date" name="to" defaultValue={to} aria-label="结束日期" />
        <select name="sort" defaultValue={sort} aria-label="排序字段">
          <option value="date">按日期</option>
          <option value="importance">按重要性</option>
        </select>
        <select name="dir" defaultValue={dir} aria-label="排序方向">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <button type="submit" className="ppt-btn">应用</button>
        {hasFilter ? (
          <a href="/reports" className="ppt-btn-link">清空</a>
        ) : null}
      </form>

      {err ? <p className="export-ppt-err">{err}</p> : null}

      <p className="muted">
        共 {rows.length} 条
        {hasFilter ? "（已筛选）" : ""}
      </p>

      {rows.length === 0 ? (
        <p className="muted">
          {hasFilter
            ? "没有匹配的报告，调整筛选条件重试。"
            : "暂无报告。后端管线产出后会出现在这里。"}
        </p>
      ) : (
        rows.map((r) => (
          <ReportCard
            entry={r}
            showTypeLabel
            // 按主题筛选时行业也恒定（一主题归属唯一行业）→ 一并抑制，与 industry 筛选同等去噪
            omit={{ type: !!type, industry: !!industry || !!topic }}
            key={r.report_id}
          />
        ))
      )}
    </section>
  );
}
