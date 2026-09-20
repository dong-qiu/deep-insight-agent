/** DCP 样本规模是评测证据的准入条件，而不是自动分数的替代品。 */
import type { Insight } from "../src/lib/types.js";
import { readerVisibleEvidenceKey } from "../src/lib/agents/report-gen.js";

export const DCP_SAMPLE_CONTRACT_VERSION = "reader-visible-v2";
export const DCP_MIN_TOPICS = 5;
export const DCP_MIN_CONSISTENCY_PAIRS = 100;
export const DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC = 10;
export const DCP_MIN_READER_VISIBLE_INSIGHTS = DCP_MIN_TOPICS * DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC;

export interface DcpTopicCount {
  topic_id: string;
  count: number;
}

export interface ReaderVisibleDuplicateEvidence {
  duplicate_insight_ids: string[];
  /** Same reader-facing statement bound to the same quote must not inflate DCP population,
   * including when it was accidentally copied into another topic. */
  duplicate_statement_quote_keys: string[];
}

export function readerVisibleDuplicateEvidence(insights: readonly Insight[]): ReaderVisibleDuplicateEvidence {
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  const evidence = new Set<string>();
  const duplicateEvidence = new Set<string>();
  for (const insight of insights) {
    if (ids.has(insight.id)) duplicateIds.add(insight.id);
    ids.add(insight.id);
    // An unbound candidate is already non-publishable. Do not manufacture a false de-dup key
    // from its full citation set; emit its own opaque key so repeated unbound IDs are still seen.
    const key = readerVisibleEvidenceKey(insight);
    if (evidence.has(key)) duplicateEvidence.add(key);
    evidence.add(key);
  }
  return {
    duplicate_insight_ids: [...duplicateIds].sort(),
    duplicate_statement_quote_keys: [...duplicateEvidence].sort(),
  };
}

/** Count only the exact objects admitted by production selectInsights(), preserving every
 * configured topic including a zero-visible one.  Unknown topic ids are intentionally retained
 * so the prerequisite can reject an inconsistent eval dataset rather than silently merging it. */
export function countReaderVisibleByTopic(topicIds: readonly string[], insights: readonly Insight[]): DcpTopicCount[] {
  const counts = new Map(topicIds.map((topicId) => [topicId, 0]));
  for (const insight of insights) counts.set(insight.topic_id, (counts.get(insight.topic_id) ?? 0) + 1);
  return [...counts].map(([topic_id, count]) => ({ topic_id, count }));
}

export function dcpSamplePrerequisite(input: {
  topics: number;
  consistencyPairs: number;
  readerVisibleInsightsByTopic: readonly DcpTopicCount[];
  duplicateInsightIds?: readonly string[];
  duplicateStatementQuoteKeys?: readonly string[];
}): string | null {
  const duplicateTopicIds = input.readerVisibleInsightsByTopic
    .map((item) => item.topic_id)
    .filter((topicId, index, all) => all.indexOf(topicId) !== index);
  const topicDeficits = input.readerVisibleInsightsByTopic
    .filter(({ count }) => count < DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC);
  if (input.topics >= DCP_MIN_TOPICS
    && input.consistencyPairs >= DCP_MIN_CONSISTENCY_PAIRS
    && input.readerVisibleInsightsByTopic.length >= DCP_MIN_TOPICS
    && duplicateTopicIds.length === 0
    && !(input.duplicateInsightIds?.length)
    && !(input.duplicateStatementQuoteKeys?.length)
    && topicDeficits.length === 0) return null;
  const readerVisibleInsights = input.readerVisibleInsightsByTopic.reduce((sum, item) => sum + item.count, 0);
  const perTopic = topicDeficits.length
    ? `，${topicDeficits.map(({ topic_id, count }) => `主题 ${topic_id}:${count}/${DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC} 未达标`).join("；")}`
    : "";
  const duplicates = duplicateTopicIds.length ? `，重复 topic_id：${[...new Set(duplicateTopicIds)].join("、")}` : "";
  const duplicateIds = input.duplicateInsightIds?.length ? `，重复 insight_id：${[...new Set(input.duplicateInsightIds)].join("、")}` : "";
  const duplicateEvidence = input.duplicateStatementQuoteKeys?.length ? `，重复 statement+bound_quote：${input.duplicateStatementQuoteKeys.length} 组` : "";
  return `真实评测样本量未达到 DCP 下限（主题 ${input.topics}/${DCP_MIN_TOPICS}，一致性对 ${input.consistencyPairs}/${DCP_MIN_CONSISTENCY_PAIRS}，reader-visible 洞察 ${readerVisibleInsights}/${DCP_MIN_READER_VISIBLE_INSIGHTS}${perTopic}${duplicates}${duplicateIds}${duplicateEvidence}）`;
}
