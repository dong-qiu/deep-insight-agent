import type { ContentItem, Topic } from "../src/lib/types.js";

export interface LocalEvalBuildOptions {
  minBody: number;
  perSource: number;
  maxItems: number;
  requiredSourceIds: string[];
}

export interface LocalEvalCase {
  topic: Topic;
  time_window: { start: string; end: string };
  items: ContentItem[];
}

export interface SourceCohortStat {
  eligible: number;
  selected: number;
  topics: string[];
}

export interface LocalEvalBuildResult {
  cases: LocalEvalCase[];
  skipped: Array<{ topicId: string; items: number; sources: number }>;
  cohort: Record<string, SourceCohortStat>;
}

export function parseSourceIds(raw: string | undefined, variableName: string): string[] {
  if (!raw?.trim()) return [];
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error(`${variableName} 只能包含逗号分隔的 source id`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${variableName} 不可重复`);
  return ids;
}

/**
 * 从按 topic 分组的本地 ContentItem 中构造 A1 输入。
 *
 * 指定 requiredSourceIds 时，先为每个候选源保留一条，再按通常的多源/每源上限补齐。
 * 这避免近期内容排序让指定源悄然被 MAX_ITEMS 挤出，而不改变未指定 cohort 的历史选择规则。
 */
export function buildLocalEvalCases(
  topics: Topic[],
  contentForTopic: (topicId: string) => ContentItem[],
  window: { start: string; end: string },
  options: LocalEvalBuildOptions,
): LocalEvalBuildResult {
  const required = new Set(options.requiredSourceIds);
  const cohort: Record<string, SourceCohortStat> = Object.fromEntries(
    options.requiredSourceIds.map((id) => [id, { eligible: 0, selected: 0, topics: [] }]),
  );
  const cases: LocalEvalCase[] = [];
  const skipped: LocalEvalBuildResult["skipped"] = [];

  for (const topic of topics) {
    const pool = contentForTopic(topic.id).filter((item) => item.body.length >= options.minBody);
    for (const item of pool) {
      if (required.has(item.source_id)) cohort[item.source_id].eligible++;
    }

    const perSource = new Map<string, number>();
    const items: ContentItem[] = [];
    const add = (item: ContentItem): boolean => {
      if (items.length >= options.maxItems) return false;
      const count = perSource.get(item.source_id) ?? 0;
      if (count >= options.perSource) return false;
      perSource.set(item.source_id, count + 1);
      items.push(item);
      return true;
    };

    // Cohort members are selected first, in caller-declared order, so evidence is deterministic.
    for (const sourceId of options.requiredSourceIds) {
      const candidate = pool.find((item) => item.source_id === sourceId);
      if (candidate) add(candidate);
    }
    for (const item of pool) add(item);

    if (items.length < 2 || perSource.size < 2) {
      skipped.push({ topicId: topic.id, items: items.length, sources: perSource.size });
      continue;
    }
    cases.push({ topic, time_window: window, items });
    for (const sourceId of options.requiredSourceIds) {
      if (items.some((item) => item.source_id === sourceId)) {
        cohort[sourceId].selected++;
        cohort[sourceId].topics.push(topic.id);
      }
    }
  }

  return { cases, skipped, cohort };
}

export function missingRequiredSources(result: LocalEvalBuildResult): string[] {
  return Object.entries(result.cohort)
    .filter(([, stat]) => stat.selected === 0)
    .map(([sourceId]) => sourceId);
}
