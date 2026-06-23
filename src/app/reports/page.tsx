/** 报告库（B-1+2）：URL query 驱动的搜索 + 筛选 + 排序——纯服务端组件 + HTML GET 表单。
 *  无客户端 state、无 JS 依赖；浏览器原生提交即可触发重渲染。
 *  搜索：FTS5（标题/摘要/正文）；筛选：主题/类型/领域(domain)/来源/标签/实体/日期区间；
 *  排序：date|importance × asc|desc。来源/标签/实体下拉只列实际出现过的值（distinctIndexValues）。 */
import { getDb } from "../../lib/db/index.js";
import { distinctIndexValues, queryReportIndex } from "../../lib/db/reports.js";
import { listSources, listTopics } from "../../lib/db/repos.js";
import { domainValueOf, facetLabel, lensValueOf } from "../../lib/topics/facets.js";
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
  // 领域(domain)筛选选项：取主题实际持有的 domain facets（rowToTopic 已派生、非空），去重保序。
  // 每项 = { value: 裸 domain 值（URL 参数 + 匹配用）, label: 人类标签 }。
  const domainOptions: { value: string; label: string }[] = [];
  const seenDomain = new Set<string>();
  // 视角(lens)筛选选项：同理取主题实际持有的 lens facets（ADR-0010 后续 lens 轴）。
  const lensOptions: { value: string; label: string }[] = [];
  const seenLens = new Set<string>();
  for (const t of topics) {
    for (const f of t.facets ?? []) {
      const dv = domainValueOf(f);
      if (dv && !seenDomain.has(dv)) {
        seenDomain.add(dv);
        domainOptions.push({ value: dv, label: facetLabel(f) });
      }
      const lv = lensValueOf(f);
      if (lv && !seenLens.has(lv)) {
        seenLens.add(lv);
        lensOptions.push({ value: lv, label: facetLabel(f) });
      }
    }
  }
  const sourceName = new Map(listSources(db).map((s) => [s.id, s.name]));
  const sourceOptions = distinctIndexValues(db, "source_ids").map((id) => ({
    id,
    name: sourceName.get(id) ?? id, // 源已删除则回退显示 id，不丢可筛性
  }));
  const tagOptions = distinctIndexValues(db, "tags");
  const entityOptions = distinctIndexValues(db, "entity_names");

  const q = val(sp, "q");
  const type = val(sp, "type");
  const domain = val(sp, "domain");
  const lens = val(sp, "lens");
  const topic = val(sp, "topic");
  const source = val(sp, "source");
  const tag = val(sp, "tag");
  const entity = val(sp, "entity");
  const from = val(sp, "from");
  const to = val(sp, "to");
  // 有搜索词且未显式选排序 → 默认按相关度（bm25）；否则按日期。relevance 仅在有 q 时生效（见 queryReportIndex）。
  const sort = val(sp, "sort") || (q ? "relevance" : "date");
  const dir = val(sp, "dir") || "desc";
  // select 显示值：无 q 时 relevance 选项不渲染（见下方 JSX），故映射回 date 让选中态显式、不靠浏览器兜底。
  const sortSelectValue = sort === "relevance" && !q ? "date" : sort;

  // 查询已在 queryReportIndex 内消毒（永不抛错、永不静默丢 q），此处无需再 try/catch 兜底。
  const rows = queryReportIndex(db, { q, type, domain, lens, topic, source, tag, entity, from, to, sort, dir });

  // 次级筛选（非搜索/排序）是否生效——决定「更多筛选」面板默认展开 + 是否显示「清空」。
  const secondaryActive = !!(type || domain || lens || topic || source || tag || entity || from || to);
  const hasFilter = !!q || secondaryActive;

  // 生效筛选 → 可移除 chips。移除链接 = 当前参数去掉该项（排序 sort/dir 始终保留，不作为 chip）。
  const sourceLabel = new Map(sourceOptions.map((s) => [s.id, s.name]));
  const topicLabel = new Map(topics.map((t) => [t.id, t.name]));
  const allParams: Record<string, string> = { q, type, domain, lens, topic, source, tag, entity, from, to, sort, dir };
  const hrefWithout = (omitKey: string): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(allParams)) {
      if (k === omitKey || !v) continue;
      // 去掉某筛选后，若排序仍是依赖它的 relevance（删 q）则一并回落，避免无 q 的 relevance 空转
      if (omitKey === "q" && k === "sort" && v === "relevance") continue;
      params.set(k, v);
    }
    const s = params.toString();
    return s ? `/reports?${s}` : "/reports";
  };
  const chips: Array<{ key: string; label: string }> = [];
  if (q) chips.push({ key: "q", label: `搜索：${q}` });
  if (type) chips.push({ key: "type", label: TYPE_LABEL[type] ?? type });
  if (domain) {
    // 标签优先取当前主题下拉项；若筛的 domain 当前无主题持有（仍合法），回退 facetLabel 取词表标签。
    const domainLabel = domainOptions.find((o) => o.value === domain)?.label ?? facetLabel(`domain:${domain}`);
    chips.push({ key: "domain", label: domainLabel });
  }
  if (lens) {
    const lensLabel = lensOptions.find((o) => o.value === lens)?.label ?? facetLabel(`lens:${lens}`);
    chips.push({ key: "lens", label: lensLabel });
  }
  if (topic) chips.push({ key: "topic", label: `主题：${topicLabel.get(topic) ?? topic}` });
  if (source) chips.push({ key: "source", label: `来源：${sourceLabel.get(source) ?? source}` });
  if (tag) chips.push({ key: "tag", label: `#${tag}` });
  if (entity) chips.push({ key: "entity", label: entity });
  if (from) chips.push({ key: "from", label: `从 ${from}` });
  if (to) chips.push({ key: "to", label: `至 ${to}` });

  return (
    <section>
      <h2>报告库</h2>

      <form method="get" className="report-search">
        {/* 主搜索：醒目全宽框 + 排序 + 操作。次级筛选收进 details，降低首屏认知负荷。 */}
        <div className="report-search-bar">
          <input
            type="search"
            name="q"
            placeholder="搜索标题 / 摘要 / 正文"
            defaultValue={q}
            aria-label="搜索"
          />
          <select name="sort" defaultValue={sortSelectValue} aria-label="排序字段">
            {q ? <option value="relevance">相关度</option> : null}
            <option value="date">按日期</option>
            <option value="importance">按重要性</option>
          </select>
          <select name="dir" defaultValue={dir} aria-label="排序方向">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
          <button type="submit" className="ppt-btn">搜索</button>
          {hasFilter ? <a href="/reports" className="ppt-btn-link">清空</a> : null}
        </div>

        <details className="report-filter-more" open={secondaryActive}>
          <summary>更多筛选</summary>
          <div className="report-filter-grid">
            <select name="type" defaultValue={type} aria-label="类型">
              <option value="">全部类型</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select name="domain" defaultValue={domain} aria-label="领域">
              <option value="">全部领域</option>
              {domainOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {lensOptions.length ? (
              <select name="lens" defaultValue={lens} aria-label="视角">
                <option value="">全部视角</option>
                {lensOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : null}
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
            {/* 标签/实体可达上百项 → 用原生 datalist 提供零 JS 输入即筛（取代超长 select 滚动地狱）。
                提交值即输入文本，与 tag/entity 的精确匹配口径一致。 */}
            {tagOptions.length ? (
              <input name="tag" list="tag-options" defaultValue={tag} placeholder="标签" aria-label="标签" />
            ) : null}
            {entityOptions.length ? (
              <input name="entity" list="entity-options" defaultValue={entity} placeholder="实体" aria-label="实体" />
            ) : null}
            <input type="date" name="from" defaultValue={from} aria-label="开始日期" />
            <input type="date" name="to" defaultValue={to} aria-label="结束日期" />
          </div>
        </details>
        <datalist id="tag-options">
          {tagOptions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <datalist id="entity-options">
          {entityOptions.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      </form>

      {chips.length ? (
        <p className="filter-chips">
          {chips.map((c) => (
            <a className="filter-chip" key={c.key} href={hrefWithout(c.key)} aria-label={`移除筛选 ${c.label}`}>
              {c.label} <span aria-hidden>✕</span>
            </a>
          ))}
        </p>
      ) : null}

      <p className="muted">
        共 {rows.length} 条
        {hasFilter ? "（已筛选）" : ""}
        {q ? `· 含「${q}」` : ""}
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
            // 按主题筛选时领域也恒定（一主题的 domain facets 固定）→ 一并抑制，与 domain 筛选同等去噪
            omit={{ type: !!type, domain: !!domain || !!topic }}
            key={r.report_id}
          />
        ))
      )}
    </section>
  );
}
