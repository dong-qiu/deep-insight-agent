import type { ContentItem, Topic } from "../src/lib/types.js";

export interface LocalEvalBuildOptions {
  minBody: number;
  perSource: number;
  maxItems: number;
  requiredSourceIds: string[];
  /** A fixed source pair per topic prevents a shared route from starving a later v2 topic. */
  requiredSourceIdsByTopic?: Record<string, readonly string[]>;
  /** A transcript cohort must not silently admit show-notes/article fallbacks. */
  bodyKind?: ContentItem["body_kind"];
  minimumSources: number;
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

/** Parse a JSON object such as {"t_code_agents":["src_a","src_b"]}. */
export function parseTopicSourceIds(raw: string | undefined, variableName: string): Record<string, string[]> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} 必须是 JSON object`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${variableName} 必须是 topic id 到 source id 数组的 JSON object`);
  }
  const result: Record<string, string[]> = {};
  for (const [topicId, sourceIds] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(topicId) || !Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string")) {
      throw new Error(`${variableName} 含无效 topic/source id`);
    }
    result[topicId] = parseSourceIds(sourceIds.join(","), `${variableName}.${topicId}`);
  }
  return result;
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
  // DCP 样本按整个 snapshot 计数，而不是每个 topic 各自计数。来源可以路由到宽、窄两个
  // topic，但同一 content item/URL 只能服务其中一个 case，不能靠复制输入虚增样本量。
  const selectedContentIds = new Set<string>();
  const selectedUrls = new Set<string>();

  for (const topic of topics) {
    const requiredForTopic = options.requiredSourceIdsByTopic?.[topic.id] ?? options.requiredSourceIds;
    // A fixed v2 pair is an allowlist, not merely a priority hint: otherwise a shared route may
    // consume a later topic's only viable source after its pair has already been selected.
    const fixedPair = options.requiredSourceIdsByTopic?.[topic.id];
    // A1 input cannot silently promote a collector fallback: a candidate must at least be marked
    // complete and carry a raw archive handle. prepare-controlled-v2-snapshot performs the byte-level
    // archive/body binding check before any controlled upload.
    const pool = contentForTopic(topic.id)
      .filter((item) => item.fetch_status === "ok" && Boolean(item.raw_ref.trim()))
      .filter((item) => item.body.length >= options.minBody)
      .filter((item) => !options.bodyKind || item.body_kind === options.bodyKind)
      .filter((item) => !fixedPair || fixedPair.includes(item.source_id));
    for (const item of pool) {
      if (required.has(item.source_id)) cohort[item.source_id].eligible++;
    }

    const perSource = new Map<string, number>();
    const items: ContentItem[] = [];
    const caseContentIds = new Set<string>();
    const caseUrls = new Set<string>();
    const add = (item: ContentItem): boolean => {
      if (items.length >= options.maxItems) return false;
      if (selectedContentIds.has(item.id) || selectedUrls.has(item.url)
        || caseContentIds.has(item.id) || caseUrls.has(item.url)) return false;
      const count = perSource.get(item.source_id) ?? 0;
      if (count >= options.perSource) return false;
      perSource.set(item.source_id, count + 1);
      caseContentIds.add(item.id);
      caseUrls.add(item.url);
      items.push(item);
      return true;
    };

    // Cohort members are selected first, in caller-declared order, so evidence is deterministic.
    for (const sourceId of requiredForTopic) {
      const candidate = pool.find((item) => item.source_id === sourceId);
      if (candidate) add(candidate);
    }
    for (const item of pool) add(item);

    if (items.length < 2 || perSource.size < options.minimumSources) {
      skipped.push({ topicId: topic.id, items: items.length, sources: perSource.size });
      continue;
    }
    cases.push({ topic, time_window: window, items });
    for (const item of items) {
      selectedContentIds.add(item.id);
      selectedUrls.add(item.url);
    }
    for (const sourceId of requiredForTopic) {
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

/** Return `topic_id:source_id` for every fixed pair member that did not enter that exact case. */
export function missingRequiredSourcesByTopic(
  result: LocalEvalBuildResult,
  requiredSourceIdsByTopic: Record<string, readonly string[]>,
): string[] {
  const caseSources = new Map(result.cases.map((entry) => [entry.topic.id, new Set(entry.items.map((item) => item.source_id))]));
  return Object.entries(requiredSourceIdsByTopic).flatMap(([topicId, sourceIds]) => {
    const selected = caseSources.get(topicId) ?? new Set<string>();
    return sourceIds.filter((sourceId) => !selected.has(sourceId)).map((sourceId) => `${topicId}:${sourceId}`);
  });
}
