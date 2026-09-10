export interface LatencyLadderCase<T = unknown> {
  topic: { id: string };
  items: T[];
}

/** Parse an ascending, non-duplicated item-count ladder such as `4,8,12,20`. */
export function parseLatencyLadderCounts(raw: string | undefined): number[] {
  const text = raw?.trim() || "4,8,12,20";
  const counts = text.split(",").map((part) => Number(part.trim()));
  if (!counts.length || counts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("A1_LADDER_ITEM_COUNTS 必须是正整数、逗号分隔的序列");
  }
  if (counts.some((count, index) => index > 0 && count <= counts[index - 1]!)) {
    throw new Error("A1_LADDER_ITEM_COUNTS 必须严格递增，且不可重复");
  }
  return counts;
}

/** An explicit fixed window permits replaying a failed chunk without copying source bodies. */
export function parseLatencyLadderOffset(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 0;
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("A1_LADDER_ITEM_OFFSET 必须是非负整数");
  }
  return offset;
}

/** Refuse an undersized candidate instead of quietly treating a lower item count as the rung. */
export function selectLatencyLadderCase<T, TCase extends LatencyLadderCase<T>>(
  cases: readonly TCase[],
  topicId: string | undefined,
  counts: readonly number[],
  itemOffset = 0,
): TCase {
  const selected = topicId ? cases.find((entry) => entry.topic.id === topicId) : cases[0];
  if (!selected) throw new Error(topicId ? `A1_LADDER_TOPIC_ID 未找到：${topicId}` : "quality dataset 为空");
  const largest = counts.at(-1)!;
  if (selected.items.length < itemOffset + largest) {
    throw new Error(`无法运行：选择的 topic 只有 ${selected.items.length} 条，无法从 offset=${itemOffset} 运行到阶梯 ${largest} 条`);
  }
  return selected;
}
