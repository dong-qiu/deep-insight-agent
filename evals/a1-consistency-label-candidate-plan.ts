/** Pure planning helpers for the diagnostic-only v2 consistency-label candidate generator. */
export const LABEL_CANDIDATE_SOURCE_CHARS = 2_400;
export const LABEL_CANDIDATE_COUNT = 100;
export const LABEL_CANDIDATES_PER_TOPIC = 20;
export type CandidateIntent = "support" | "uncertain" | "exaggeration" | "out_of_context" | "misattribution";

export interface CandidateSelectionItem {
  id: string;
  topic_id: string;
  source_id: string;
}

/** Each 20-item quality topic contributes eight diagnostic negative candidates, for 40/100 total. */
const INTENTS_PER_TWENTY: readonly CandidateIntent[] = [
  "support", "support", "support", "support", "support", "support",
  "uncertain", "uncertain", "uncertain", "uncertain", "uncertain", "uncertain",
  "exaggeration", "exaggeration", "exaggeration",
  "out_of_context", "out_of_context", "out_of_context",
  "misattribution", "misattribution",
];

export function plannedCandidateIntent(index: number): CandidateIntent {
  return INTENTS_PER_TWENTY[index % INTENTS_PER_TWENTY.length]!;
}

/**
 * A v2 quality population can be larger than the 100-pair consistency set. Keep the latter
 * stable and balanced by taking twenty per topic. For expanded topics, source round-robin avoids
 * silently taking only the first source's entries; the caller records this selection in its
 * diagnostic-only manifest, never in the blind reviewer handoff.
 */
export function selectConsistencyCandidateItems<T extends CandidateSelectionItem>(items: readonly T[]): T[] {
  const topics = new Map<string, T[]>();
  for (const item of items) {
    const group = topics.get(item.topic_id) ?? [];
    group.push(item);
    topics.set(item.topic_id, group);
  }
  if (topics.size !== 5) throw new Error(`v2 consistency candidate 要求恰有 5 个 topic，当前 ${topics.size}`);

  const selected: T[] = [];
  for (const [topicId, topicItems] of topics) {
    if (topicItems.length < LABEL_CANDIDATES_PER_TOPIC) {
      throw new Error(`topic ${topicId} 至少需要 ${LABEL_CANDIDATES_PER_TOPIC} 条质量输入，当前 ${topicItems.length}`);
    }
    if (topicItems.length === LABEL_CANDIDATES_PER_TOPIC) {
      selected.push(...topicItems);
      continue;
    }
    const bySource = new Map<string, T[]>();
    for (const item of topicItems) {
      const group = bySource.get(item.source_id) ?? [];
      group.push(item);
      bySource.set(item.source_id, group);
    }
    const sourceIds = [...bySource.keys()].sort((a, b) => a.localeCompare(b));
    const offsets = new Map(sourceIds.map((sourceId) => [sourceId, 0]));
    const topicSelected: T[] = [];
    while (topicSelected.length < LABEL_CANDIDATES_PER_TOPIC) {
      let progressed = false;
      for (const sourceId of sourceIds) {
        const sourceItems = bySource.get(sourceId)!;
        const offset = offsets.get(sourceId)!;
        if (offset >= sourceItems.length) continue;
        topicSelected.push(sourceItems[offset]!);
        offsets.set(sourceId, offset + 1);
        progressed = true;
        if (topicSelected.length === LABEL_CANDIDATES_PER_TOPIC) break;
      }
      if (!progressed) throw new Error(`topic ${topicId} 无法选出 ${LABEL_CANDIDATES_PER_TOPIC} 条候选`);
    }
    selected.push(...topicSelected);
  }
  if (selected.length !== LABEL_CANDIDATE_COUNT) {
    throw new Error(`v2 consistency candidate 必须选出 ${LABEL_CANDIDATE_COUNT} 条，当前 ${selected.length}`);
  }
  if (new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new Error("v2 consistency candidate 选择中含重复 item id");
  }
  return selected;
}

/** Preserve verbatim source text while preferring a sentence boundary near the configured limit. */
export function labelSourceWindow(body: string, limit = LABEL_CANDIDATE_SOURCE_CHARS): string {
  if (body.length <= limit) return body;
  const floor = Math.floor(limit * 0.7);
  const slice = body.slice(0, limit);
  const boundaries = [...slice.matchAll(/[.!?。！？](?:\s|$)/gu)].map((match) => match.index! + match[0].length);
  const boundary = boundaries.filter((index) => index >= floor).at(-1);
  return body.slice(0, boundary ?? limit);
}

/** Escape third-party excerpt data only when embedding it in the generator prompt. */
export function escapeCandidatePromptData(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
