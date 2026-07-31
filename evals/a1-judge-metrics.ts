/** A1 校验器标注集的端到端计分。
 *
 * 调用/解析失败不是“跳过的样本”：它不能为发布校验提供结论，因此在准确率和
 * not_support 召回率中按未命中计。完成率单独输出，便于区分分类错误与可用性问题。 */
export type ConsistencyLabel = "support" | "not_support" | "uncertain";

export interface JudgeStats {
  attempted: number;
  judged: number;
  correct: number;
  errors: number;
  negTotal: number;
  negRecalled: number;
}

export function emptyJudgeStats(): JudgeStats {
  return { attempted: 0, judged: 0, correct: 0, errors: 0, negTotal: 0, negRecalled: 0 };
}

/** 记录一次标注样本；`predicted=null` 表示经生产等价重试后仍无有效结论。 */
export function recordJudgeAttempt(
  stats: JudgeStats,
  expected: ConsistencyLabel,
  predicted: ConsistencyLabel | null,
): void {
  stats.attempted++;
  if (expected === "not_support") stats.negTotal++;
  if (predicted == null) {
    stats.errors++;
    return;
  }
  stats.judged++;
  if (predicted === expected) stats.correct++;
  if (expected === "not_support" && predicted === "not_support") stats.negRecalled++;
}

export function judgeAccuracy(stats: JudgeStats): number {
  return stats.attempted ? stats.correct / stats.attempted : 0;
}

export function judgeNegativeRecall(stats: JudgeStats): number {
  return stats.negTotal ? stats.negRecalled / stats.negTotal : 0;
}

export function judgeCompletion(stats: JudgeStats): number {
  return stats.attempted ? stats.judged / stats.attempted : 0;
}
