/** 报告卡片（首页今日 Brief + 报告库共用）。
 *  headline 方案 + 两项轻量增强：
 *  - highlights 要点列表（空则回退 summary，治本前的旧报告靠 ops/backfill-highlights.mjs 回填）；
 *  - 重要性彩色徽标（替代灰字"重要性 N"，4–5 醒目）+ 里程碑标记（milestone_count>0）；
 *  - 实体 / 标签 chips（externalize entity_names / tags——一眼看出"讲的是谁 / 什么话题"）。
 *  纯服务端组件、零客户端 JS。 */
import type { ReportIndexEntry } from "../../lib/types.js";

const TYPE_LABEL: Record<ReportIndexEntry["type"], string> = {
  brief: "今日 Brief",
  deep_dive: "深度报告",
  initial_digest: "首版综述",
};

/** 重要性 → 徽标配色档：5 红、4 橙、3 中性、≤2 弱化（与卡片噪声区分，引导视线到高分）。 */
function impClass(importance: number): string {
  if (importance >= 5) return "imp-badge imp-5";
  if (importance >= 4) return "imp-badge imp-4";
  if (importance >= 3) return "imp-badge imp-3";
  return "imp-badge imp-low";
}

const ENTITY_MAX = 6; // chips 上限，防一行炸开（数组本已按重要性≈频次排序，取前缀即重点）
const TAG_MAX = 4;

/** 存储的 title 是规范字段（report-gen.ts：`${topic.name} · ${类型} · ${date}`），被 md/html/ppt/告警复用。
 *  但卡片里类型与日期已由页头语境 + meta 行承载，标题再带一遍纯属重复——展示层剥掉尾缀，只留主题名。
 *  按已知模板精确剥（非 split），旧报告模板不匹配时回退原标题，绝不误删主题名里的分隔符。 */
function displayTitle(r: ReportIndexEntry): string {
  const suffix = ` · ${TYPE_LABEL[r.type] ?? r.type} · ${r.date}`;
  return r.title.endsWith(suffix) ? r.title.slice(0, -suffix.length) : r.title;
}

export function ReportCard({
  entry,
  showTypeLabel = false,
}: {
  entry: ReportIndexEntry;
  showTypeLabel?: boolean;
}) {
  const r = entry;
  const entities = r.entity_names.slice(0, ENTITY_MAX);
  const tags = r.tags.slice(0, TAG_MAX);
  return (
    <article className="card">
      <h3>
        <a href={`/reports/${r.report_id}`}>{displayTitle(r)}</a>
      </h3>
      <p className="muted card-meta">
        {/* 类型/日期已从标题剥离，meta 行成为其唯一出处：首页 Brief 由页头表明类型，故只留日期；
            报告库混排多类型/多日期、无页头语境，保留 类型 · 行业 · 日期。行业代码不再与标题主题名重复展示。 */}
        {showTypeLabel ? (
          <>
            {TYPE_LABEL[r.type] ?? r.type} · {r.industry} · {r.date}
          </>
        ) : (
          <>{r.date}</>
        )}{" "}
        <span className={impClass(r.importance)}>重要性 {r.importance}</span>
        {r.milestone_count > 0 ? <span className="milestone-badge">里程碑</span> : null}
      </p>
      {r.highlights.length ? (
        <ul className="brief-highlights">
          {r.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      ) : (
        <p>{r.summary || "（无摘要）"}</p>
      )}
      {entities.length || tags.length ? (
        <p className="card-chips">
          {entities.map((e) => (
            <span className="entity-tag" key={`e-${e}`}>
              {e}
            </span>
          ))}
          {tags.map((t) => (
            <span className="tag-chip" key={`t-${t}`}>
              #{t}
            </span>
          ))}
        </p>
      ) : null}
    </article>
  );
}
