import { describe, expect, it } from "vitest";
import {
  A1CoverageDeadlineExceededError,
  A1JudgeDeadlineExceededError,
  A1TopicDeadlineExceededError,
  A1QualityCaseFailedError,
  DEFAULT_A1_COVERAGE_TIMEOUT_MS,
  DEFAULT_A1_JUDGE_TIMEOUT_MS,
  DEFAULT_A1_TOPIC_TIMEOUT_MS,
  a1CoverageTimeoutMs,
  a1JudgeTimeoutMs,
  a1TopicTimeoutMs,
  runA1CoverageWithDeadline,
  runA1JudgeWithDeadline,
  runA1TopicWithDeadline,
  terminalA1QualityCaseFailure,
} from "./a1-run-control.js";

describe("A1 topic run controls", () => {
  it("uses a bounded default and rejects a timeout setting that could silently weaken it", () => {
    expect(a1TopicTimeoutMs(undefined)).toBe(DEFAULT_A1_TOPIC_TIMEOUT_MS);
    expect(DEFAULT_A1_TOPIC_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(a1TopicTimeoutMs("30000")).toBe(30_000);
    expect(() => a1TopicTimeoutMs("29999")).toThrow("A1_TOPIC_TIMEOUT_MS");
    expect(() => a1TopicTimeoutMs("not-a-number")).toThrow("A1_TOPIC_TIMEOUT_MS");
  });

  it("bounds the full retry tree for one labelled judge without manufacturing a verdict", async () => {
    expect(a1JudgeTimeoutMs(undefined)).toBe(DEFAULT_A1_JUDGE_TIMEOUT_MS);
    expect(DEFAULT_A1_JUDGE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(a1JudgeTimeoutMs("30000")).toBe(30_000);
    expect(() => a1JudgeTimeoutMs("29999")).toThrow("A1_JUDGE_TIMEOUT_MS");
    expect(() => a1JudgeTimeoutMs("600001")).toThrow("A1_JUDGE_TIMEOUT_MS");

    let receivedSignal: AbortSignal | undefined;
    await expect(runA1JudgeWithDeadline(17, 5, (signal) => new Promise((_, reject) => {
      receivedSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }))).rejects.toMatchObject({
      name: "A1JudgeDeadlineExceededError", caseIndex: 17, timeoutMs: 5,
    } satisfies Partial<A1JudgeDeadlineExceededError>);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBeInstanceOf(A1JudgeDeadlineExceededError);
  });

  it("makes an unavailable standalone coverage audit incomplete instead of a synthetic rejection", async () => {
    expect(a1CoverageTimeoutMs(undefined)).toBe(DEFAULT_A1_COVERAGE_TIMEOUT_MS);
    expect(DEFAULT_A1_COVERAGE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(a1CoverageTimeoutMs("30000")).toBe(30_000);
    expect(() => a1CoverageTimeoutMs("29999")).toThrow("A1_COVERAGE_TIMEOUT_MS");
    expect(() => a1CoverageTimeoutMs("600001")).toThrow("A1_COVERAGE_TIMEOUT_MS");

    let receivedSignal: AbortSignal | undefined;
    await expect(runA1CoverageWithDeadline("quote-case-4", 5, (signal) => new Promise((_, reject) => {
      receivedSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }))).rejects.toMatchObject({
      name: "A1CoverageDeadlineExceededError", caseId: "quote-case-4", timeoutMs: 5,
    } satisfies Partial<A1CoverageDeadlineExceededError>);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBeInstanceOf(A1CoverageDeadlineExceededError);
  });

  it("aborts the nested operation and returns a topic-specific terminal error at the deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    await expect(runA1TopicWithDeadline("topic-a", 5, (signal) => new Promise((_, reject) => {
      receivedSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }))).rejects.toMatchObject({
      name: "A1TopicDeadlineExceededError", topicId: "topic-a", timeoutMs: 5,
    } satisfies Partial<A1TopicDeadlineExceededError>);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBeInstanceOf(A1TopicDeadlineExceededError);
  });

  it("does not abort a topic that completes before its deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    await expect(runA1TopicWithDeadline("topic-a", 1000, async (signal) => {
      receivedSignal = signal;
      return "done";
    })).resolves.toBe("done");
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("turns an upstream request timeout into a terminal, resumable quality-case failure", () => {
    const error = terminalA1QualityCaseFailure(3, "t_agent_security", new Error("Request timed out."));
    expect(error).toBeInstanceOf(A1QualityCaseFailedError);
    expect(error).toMatchObject({ caseIndex: 3, topicId: "t_agent_security", upstreamError: "Request timed out." });
    expect(error.message).toContain("failed before a complete result");
  });
});
