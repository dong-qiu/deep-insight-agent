/**
 * Runtime controls for a single A1 quality topic. These are execution safeguards, not scoring
 * configuration: a deadline produces a terminal failed run and is never comparable evidence.
 */
/** 20 rich-body items completed in about 18m27s in the 2026-09 liveness diagnostic. Thirty
 * minutes leaves bounded headroom for a single legitimate relay tail without weakening the
 * 45-minute hard maximum or changing scoring semantics. */
export const DEFAULT_A1_TOPIC_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_A1_TOPIC_TIMEOUT_MS = 30 * 1000;
export const MAX_A1_TOPIC_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * One labelled consistency pair uses both the SDK retry policy and the application retry policy.
 * A total deadline prevents a single persistent transport failure from multiplying those retry
 * budgets into an unbounded A1 tail.  It is an execution safeguard, never a semantic label.
 */
export const DEFAULT_A1_JUDGE_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_A1_JUDGE_TIMEOUT_MS = 30 * 1000;
export const MAX_A1_JUDGE_TIMEOUT_MS = 10 * 60 * 1000;

/** The stand-alone display/quote benchmark has its own retry tree and bounded deadline. */
export const DEFAULT_A1_COVERAGE_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_A1_COVERAGE_TIMEOUT_MS = 30 * 1000;
export const MAX_A1_COVERAGE_TIMEOUT_MS = 10 * 60 * 1000;

export class A1TopicDeadlineExceededError extends Error {
  readonly topicId: string;
  readonly timeoutMs: number;

  constructor(topicId: string, timeoutMs: number) {
    super(`A1 quality topic ${topicId} exceeded its ${timeoutMs}ms deadline`);
    this.name = "A1TopicDeadlineExceededError";
    this.topicId = topicId;
    this.timeoutMs = timeoutMs;
  }
}

export class A1JudgeDeadlineExceededError extends Error {
  readonly caseIndex: number;
  readonly timeoutMs: number;

  constructor(caseIndex: number, timeoutMs: number) {
    super(`A1 consistency case ${caseIndex} exceeded its ${timeoutMs}ms deadline`);
    this.name = "A1JudgeDeadlineExceededError";
    this.caseIndex = caseIndex;
    this.timeoutMs = timeoutMs;
  }
}

export class A1CoverageDeadlineExceededError extends Error {
  readonly caseId: string;
  readonly timeoutMs: number;

  constructor(caseId: string, timeoutMs: number) {
    super(`A1 coverage case ${caseId} exceeded its ${timeoutMs}ms deadline`);
    this.name = "A1CoverageDeadlineExceededError";
    this.caseId = caseId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A quality topic did not produce a complete analyzer + validator result.  This is deliberately
 * distinct from a semantic `no_significant_event`: allowing the outer run to continue would turn
 * a transport/structured-output failure into an unlabelled hole in the quality population.
 */
export class A1QualityCaseFailedError extends Error {
  readonly caseIndex: number;
  readonly topicId: string;
  readonly upstreamError: string;

  constructor(caseIndex: number, topicId: string, cause: unknown) {
    const upstreamError = cause instanceof Error ? cause.message : String(cause);
    super(`A1 quality case ${caseIndex} (${topicId}) failed before a complete result: ${upstreamError}`);
    this.name = "A1QualityCaseFailedError";
    this.caseIndex = caseIndex;
    this.topicId = topicId;
    this.upstreamError = upstreamError;
  }
}

/**
 * A transport timeout is not a reason to omit a quality topic.  The caller publishes a failed
 * manifest bound to its checkpoint, allowing the exact incomplete topic to resume later.
 */
export function terminalA1QualityCaseFailure(caseIndex: number, topicId: string, cause: unknown): A1QualityCaseFailedError {
  return new A1QualityCaseFailedError(caseIndex, topicId, cause);
}

/** An omitted setting keeps the conservative default; an explicit invalid value must not weaken it. */
export function a1TopicTimeoutMs(raw = process.env.A1_TOPIC_TIMEOUT_MS): number {
  if (raw == null || raw.trim() === "") return DEFAULT_A1_TOPIC_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_A1_TOPIC_TIMEOUT_MS || value > MAX_A1_TOPIC_TIMEOUT_MS) {
    throw new Error(
      `A1_TOPIC_TIMEOUT_MS must be an integer between ${MIN_A1_TOPIC_TIMEOUT_MS} and ${MAX_A1_TOPIC_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** An explicit invalid value must not silently remove the bounded retry safeguard. */
export function a1JudgeTimeoutMs(raw = process.env.A1_JUDGE_TIMEOUT_MS): number {
  if (raw == null || raw.trim() === "") return DEFAULT_A1_JUDGE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_A1_JUDGE_TIMEOUT_MS || value > MAX_A1_JUDGE_TIMEOUT_MS) {
    throw new Error(
      `A1_JUDGE_TIMEOUT_MS must be an integer between ${MIN_A1_JUDGE_TIMEOUT_MS} and ${MAX_A1_JUDGE_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** An explicit invalid value must not silently remove the bounded coverage retry safeguard. */
export function a1CoverageTimeoutMs(raw = process.env.A1_COVERAGE_TIMEOUT_MS): number {
  if (raw == null || raw.trim() === "") return DEFAULT_A1_COVERAGE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_A1_COVERAGE_TIMEOUT_MS || value > MAX_A1_COVERAGE_TIMEOUT_MS) {
    throw new Error(
      `A1_COVERAGE_TIMEOUT_MS must be an integer between ${MIN_A1_COVERAGE_TIMEOUT_MS} and ${MAX_A1_COVERAGE_TIMEOUT_MS}`,
    );
  }
  return value;
}

/**
 * Abort the complete topic call tree at the deadline. The race returns the terminal error even
 * if a broken upstream SDK fails to settle promptly; downstream calls still receive the signal
 * so normal SDK paths cancel their network streams and stop incurring work.
 */
export async function runA1TopicWithDeadline<T>(
  topicId: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new A1TopicDeadlineExceededError(topicId, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const result = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound the whole retry tree for one labelled consistency pair.  A deadline aborts every nested
 * SDK/application retry through the supplied signal, then surfaces a case-specific execution
 * error.  Callers must record it as incomplete evidence rather than inventing a prediction.
 */
export async function runA1JudgeWithDeadline<T>(
  caseIndex: number,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new A1JudgeDeadlineExceededError(caseIndex, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const result = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound one standalone display/quote benchmark case.  A timed-out safety audit remains
 * fail-closed in production, while the A1 runner records the unavailable test as incomplete
 * rather than counting a timeout-caused rejection as a successful benchmark result.
 */
export async function runA1CoverageWithDeadline<T>(
  caseId: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new A1CoverageDeadlineExceededError(caseId, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const result = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
