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

/** 实体 chip 去重：丢掉「文本已出现在本卡 highlights/摘要里」的实体——正文已点名，chip 再列一遍即重复噪声。
 *  haystack = highlights + summary 全文（小写），实体名作子串匹配命中即剔除。
 *  ≥2 字才参与（单字实体如 "AI" 易误命中任意正文）；过滤在 slice 之前，保留至多 ENTITY_MAX 个**非重复**实体。 */
function dedupEntities(r: ReportIndexEntry): string[] {
  const haystack = `${r.highlights.join(" ")} ${r.summary ?? ""}`.toLowerCase();
  return r.entity_names
    .filter((e) => {
      const name = e.trim().toLowerCase();
      if (!name) return false; // 空名丢弃
      if (name.length < 2) return true; // 单字不参与子串去重（易误命中任意正文），原样保留
      return !haystack.includes(name);
    })
    .slice(0, ENTITY_MAX);
}

/** 在 report 列表里已按某维度筛选时，要从卡片 meta 里隐藏的维度——避免每张卡重复显示恒定的筛选值。 */
export interface CardOmit {
  type?: boolean;
  industry?: boolean;
}

export function ReportCard({
  entry,
  showTypeLabel = false,
  omit,
}: {
  entry: ReportIndexEntry;
  showTypeLabel?: boolean;
  omit?: CardOmit;
}) {
  const r = entry;
  const entities = dedupEntities(r);
  const tags = r.tags.slice(0, TAG_MAX);
  // meta 维度按需拼装：报告库（showTypeLabel）默认 类型 · 行业 · 日期，但已被筛选的维度逐条重复=噪声，故抑制；
  // 首页 Brief（!showTypeLabel）由页头表明类型，只留日期。日期始终保留（同列表内最常变、定位用）。
  const metaParts: string[] = [];
  if (showTypeLabel && !omit?.type) metaParts.push(TYPE_LABEL[r.type] ?? r.type);
  if (showTypeLabel && !omit?.industry) metaParts.push(r.industry);
  metaParts.push(r.date);
  return (
    <article className="card">
      <h3>
        <a href={`/reports/${r.report_id}`}>{displayTitle(r)}</a>
      </h3>
      <p className="muted card-meta">
        {metaParts.join(" · ")}{" "}
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
