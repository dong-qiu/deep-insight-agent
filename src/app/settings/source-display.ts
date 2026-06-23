/** 设置页数据源「分组 + 形态 badge」的纯展示逻辑（与渲染分离，便于单测）。 */
import { DOMAIN_LABELS, DOMAIN_VALUES, type DomainValue, domainValueOf } from "../../lib/topics/facets.js";
import type { Source, Topic } from "../../lib/types.js";

/** 域分组顺序与友好标签（Step2c：源不再自带 industry，按域分组）。来自受控词表 DOMAIN_VALUES。 */
export const DOMAIN_ORDER = DOMAIN_VALUES.map((d) => ({ id: d, label: DOMAIN_LABELS[d] }));

/** 源的「域」= 其 topic_ids 对应 topic 的 facets 的 domain 值并集（Step2c：源的分类由 topic 派生、不自存）。
 *  一源跨多域 → 在多组各出现一次（诚实）；无 topic/无域 → 空集（page.tsx 归「未分类」）。 */
export function sourceDomains(s: Source, topicById: Map<string, Topic>): Set<DomainValue> {
  const out = new Set<DomainValue>();
  for (const tid of s.topic_ids) {
    for (const f of topicById.get(tid)?.facets ?? []) {
      const v = domainValueOf(f);
      if (v) out.add(v);
    }
  }
  return out;
}

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
