/** 待分析项选择：从主题窗口候选池按「相关度优先 + 来源多样」选 ≤ limit 条喂 analyzer。
 *  纯算法（keywordTokens/relevanceScore/rankAndDiversify）+ DB 读取选择器（selectAnalysisItems）。
 *  从 scheduler.ts 抽出（单一职责·行为中性）；编排端只调 selectAnalysisItems。 */
import { listContentForTopic } from "../db/repos.js";
import type { DB } from "../db/index.js";
import type { ContentItem, Topic } from "../types.js";
import { archetypeProfile } from "../topics/archetype.js";

/** 把关键词拆成可匹配 token：英文按词、≥3 字符；CJK 片段 ≥2 字符。
 *  整短语子串匹配过脆（中文关键词永不命中英文摘要、英文长短语少见原样出现，曾把 arXiv 研究全过滤掉），
 *  按 token 命中可让英文研究摘要靠 software/agent/retrieval/inference 等词被识别为相关。 */
export function keywordTokens(keywords: string[]): string[] {
  const toks = new Set<string>();
  for (const kw of keywords) {
    for (const t of kw.toLowerCase().split(/[\s/]+/)) {
      const minLen = /[a-z]/.test(t) ? 3 : 2;
      if (t.length >= minLen) toks.add(t);
    }
  }
  return [...toks];
}

/** 相关度 = 命中的不同关键词 token 数（title+body 小写子串匹配）。 */
function relevanceScore(item: ContentItem, tokens: string[]): number {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  return tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

/** 纯函数：从候选池按「相关度优先 + 来源多样」选出 ≤ limit 条用于分析。
 *  - 全量按相关度（token 命中数）降序，同分保持 recency；默认**不硬过滤 0 命中**（软策略，deep_vertical）——
 *    研究源（如 arXiv）即便措辞不同也多能命中 token；万一全 0 也由来源多样化兜底纳入；
 *  - 每源最多 ceil(limit/3) 条，避免高产源（如 OpenAI 全历史 backlog）独占切片淹没相关内容；
 *  - 名额没填满则放开每源上限补齐。
 *
 *  ADR-0010：`opts.relevanceFloor`（horizontal_pulse 主题给）= **相关性硬下限**——命中 token 数 < floor 的
 *  候选先滤掉再排选（砍纯噪声）。两条保护：① **滤空回退**（全被滤则退回软策略，避免 0 条 → `skipped-no-content`/空 brief）；
 *  ② cap+兜底在**已滤池**上进行（兜底不会捞回被滤离题项，故无需「跳兜底」、也不损 brief 厚度）。
 *  软策略（无 floor）下「候选 ≤ limit 整池返回」短路保留（行为不变）。 */
export function rankAndDiversify(
  candidates: ContentItem[],
  keywords: string[],
  limit: number,
  opts: { relevanceFloor?: number } = {},
): ContentItem[] {
  const { relevanceFloor } = opts;
  if (relevanceFloor === undefined && candidates.length <= limit) return candidates; // 软策略短路（护研究源）
  const tokens = keywordTokens(keywords);
  let scored = candidates.map((it, i) => ({ it, s: relevanceScore(it, tokens), i }));
  if (relevanceFloor !== undefined) {
    const kept = scored.filter((x) => x.s >= relevanceFloor);
    scored = kept.length > 0 ? kept : scored; // floor 保护：滤空则回退软策略（不产 0 条）
  }
  const ranked = scored.sort((a, b) => b.s - a.s || a.i - b.i);

  const perSourceCap = Math.max(2, Math.ceil(limit / 3));
  const bySource = new Map<string, number>();
  const out: ContentItem[] = [];
  // review #8c：用 Set<id> 取代 out.includes(it) 的 O(n) 线性扫描——批补齐阶段命中率高时收益明显
  const takenIds = new Set<string>();
  for (const { it } of ranked) {
    if (out.length >= limit) break;
    const c = bySource.get(it.source_id) ?? 0;
    if (c >= perSourceCap) continue;
    bySource.set(it.source_id, c + 1);
    takenIds.add(it.id);
    out.push(it);
  }
  if (out.length < limit) {
    for (const { it } of ranked) {
      if (out.length >= limit) break;
      if (!takenIds.has(it.id)) {
        takenIds.add(it.id);
        out.push(it);
      }
    }
  }
  return out;
}

/** 取某主题窗口内候选（recency 前 candidatePool 条）→ 相关+多样选 ≤ limit 条喂给 analyzer。
 *  ADR-0010：按 topic.archetype 取 profile.relevanceFloor 驱动 rankAndDiversify（horizontal_pulse 砍纯噪声）；
 *  **冷启动（initial_digest 首报）豁免硬下限**（用软策略给足份量，避免新横向主题首报被掐空）。 */
export function selectAnalysisItems(
  db: DB,
  topic: Topic,
  opts: { since: string; limit?: number; candidatePool?: number; coldStart?: boolean },
): ContentItem[] {
  const limit = opts.limit ?? 15;
  // 候选池放大到覆盖 F1 后全行业量（每源 ≤50 × 源数），避免高产源按 recency 把研究源（arXiv）
  // 挤出候选窗口、scoring 根本看不到它。打分是内存子串匹配，候选多也廉价。
  const candidates = listContentForTopic(db, topic.id, {
    since: opts.since,
    limit: opts.candidatePool ?? 800,
  });
  // ADR-0010：冷启动豁免硬下限（首报用软策略）；否则按 archetype profile 取 relevanceFloor。
  const relevanceFloor = opts.coldStart ? undefined : archetypeProfile(topic.archetype).relevanceFloor;
  return rankAndDiversify(candidates, topic.keywords, limit, { relevanceFloor });
}
