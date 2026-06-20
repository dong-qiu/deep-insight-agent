/** 设置页数据源「分组 + 形态 badge」的纯展示逻辑（与渲染分离，便于单测）。 */
import type { Industry, Source } from "../../lib/types.js";

/** 行业分组顺序与友好标签。satisfies 只防 id 写错（typo → 编译报错），**不**保证穷举
 *  Industry；新增枚举但漏配此表的源不会消失，会落进 page.tsx 的「其他」兜底组（真正的安全网）。 */
export const INDUSTRY_ORDER = [
  { id: "ai-swe", label: "AI 软件工程" },
  { id: "ai-security", label: "AI 安全" },
] as const satisfies readonly { id: Industry; label: string }[];

export interface SourceForm {
  icon: string;
  label: string;
}

/** 从 source 派生「内容形态」badge。
 *  - arxiv → 论文；GitHub Atom → 仓库（type+endpoint 精确判定，先行）。
 *  - 播客：优先按该源「已产出形态」实测（transcript/show_notes 只由播客采集链路产生），
 *    name 关键字仅作冷启动（尚未采集过内容）的回退——这样 badge 与「有转写」标记同源，
 *    不会出现「资讯 · 有转写」的自相矛盾。
 *  - 其余 → 资讯。 */
export function sourceForm(s: Source, kinds?: ReadonlySet<string>): SourceForm {
  if (s.type === "arxiv") return { icon: "📄", label: "论文" };
  if (s.type === "rss" && /github\.com\/.*\.atom/.test(s.endpoint)) return { icon: "🐙", label: "仓库" };
  if (kinds?.has("transcript") || kinds?.has("show_notes") || s.name.includes("播客")) {
    return { icon: "🎙️", label: "播客" };
  }
  return { icon: "📰", label: "资讯" };
}
