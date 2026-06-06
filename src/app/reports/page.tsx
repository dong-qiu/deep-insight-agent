/** 报告库（B-1+2）：URL query 驱动的搜索 + 筛选 + 排序——纯服务端组件 + HTML GET 表单。
 *  无客户端 state、无 JS 依赖；浏览器原生提交即可触发重渲染。
 *  搜索：FTS5（标题/摘要/正文）；筛选：type/industry/date 区间；排序：date|importance × asc|desc。 */
import { getDb } from "../../lib/db/index.js";
import { queryReportIndex } from "../../lib/db/reports.js";
import { listTopics } from "../../lib/db/repos.js";

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
  // 拉所有 industry/topic 选项（topic 暂未直接筛但能给读者上下文）
  const topics = listTopics(db);
  const industries = [...new Set(topics.map((t) => t.industry))];

  const q = val(sp, "q");
  const type = val(sp, "type");
  const industry = val(sp, "industry");
  const from = val(sp, "from");
  const to = val(sp, "to");
  const sort = val(sp, "sort") || "date";
  const dir = val(sp, "dir") || "desc";

  let rows: ReturnType<typeof queryReportIndex> = [];
  let err: string | null = null;
  try {
    rows = queryReportIndex(db, { q, type, industry, from, to, sort, dir });
  } catch (e) {
    // FTS5 对 q 的 token 有自己语法（如裸 "-" 会解析报错）；退路 = 不带 q 重查 + 友好提示
    err = `搜索语法不合法："${q}"；已忽略 q 重新列出。`;
    rows = queryReportIndex(db, { type, industry, from, to, sort, dir });
  }
  const hasFilter = !!(q || type || industry || from || to);

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
          <article className="card" key={r.report_id}>
            <h3>
              <a href={`/reports/${r.report_id}`}>{r.title}</a>
            </h3>
            <p className="muted">
              {TYPE_LABEL[r.type] ?? r.type} · {r.industry} · {r.date} · 重要性 {r.importance}
            </p>
            <p>{r.summary || "（无摘要）"}</p>
          </article>
        ))
      )}
    </section>
  );
}
