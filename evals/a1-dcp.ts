/** DCP 样本规模是评测证据的准入条件，而不是自动分数的替代品。 */
import type { Insight } from "../src/lib/types.js";

export const DCP_SAMPLE_CONTRACT_VERSION = "reader-visible-v1";
export const DCP_MIN_TOPICS = 5;
export const DCP_MIN_CONSISTENCY_PAIRS = 100;
export const DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC = 10;
export const DCP_MIN_READER_VISIBLE_INSIGHTS = DCP_MIN_TOPICS * DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC;

export interface DcpTopicCount {
  topic_id: string;
  count: number;
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
    && topicDeficits.length === 0) return null;
  const readerVisibleInsights = input.readerVisibleInsightsByTopic.reduce((sum, item) => sum + item.count, 0);
  const perTopic = topicDeficits.length
    ? `，${topicDeficits.map(({ topic_id, count }) => `主题 ${topic_id}:${count}/${DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC} 未达标`).join("；")}`
    : "";
  const duplicates = duplicateTopicIds.length ? `，重复 topic_id：${[...new Set(duplicateTopicIds)].join("、")}` : "";
  return `真实评测样本量未达到 DCP 下限（主题 ${input.topics}/${DCP_MIN_TOPICS}，一致性对 ${input.consistencyPairs}/${DCP_MIN_CONSISTENCY_PAIRS}，reader-visible 洞察 ${readerVisibleInsights}/${DCP_MIN_READER_VISIBLE_INSIGHTS}${perTopic}${duplicates}）`;
}
