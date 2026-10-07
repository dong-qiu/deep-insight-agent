/** Real followup + SQLite control regressions; only model transport is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整模块 mock：followup 直接调 callStructured（role=followup），validator.judgeConsistency 也调它（role=validator）。
// consistencyCacheVersion 读 MODELS.validator，故 mock 须带 MODELS。
vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
  MODELS: { analyzer: "claude-sonnet-4-6", validator: "claude-opus-4-7", followup: "claude-sonnet-4-6" },
}));

import { callStructured } from "../runtime/llm.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { closeDb, openDb, type DB } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import type { AnalysisBatch, ContentItem, Report, Source, Topic } from "../types.js";
import { answerFollowup } from "./followup.js";

const QUOTE = "test-first 把回归缺陷降了 38%";
const UNCERTAIN_QUOTE = "团队反馈良好";
const BODY = `一篇关于工程实践的文章。${QUOTE}，团队反馈良好。`;

function source(): Source {
  return {
    id: "src1", name: "机器之心", type: "rss", endpoint: "https://x.com/feed",
    topic_ids: ["t1"], fetch_interval: "6h", backfill: null, enabled: true,
  };
}
function topic(): Topic {
  return {
    id: "t1", name: "AI 工程", keywords: [], language: "zh",
    brief_schedule: "daily", enabled: true,
  };
}
function contentItem(id = "ci_1", body = BODY): ContentItem {
  return {
    id, source_id: "src1", url: `https://x.com/${id}`, title: "t", author: null,
    published_at: "2026-06-01T00:00:00Z", fetched_at: "2026-06-01T00:00:00Z", language: "zh",
    topic_ids: ["t1"], tags: ["test"], body, body_kind: "article", raw_ref: `raw://${id}`,
    content_hash: `h_${id}`, fetch_status: "ok",
  };
}
function batch(): AnalysisBatch {
  return {
    id: "ab_1", topic_id: "t1", time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
    status: "done", no_significant_event: false,
    insights: [
      {
        id: "ins_1", topic_id: "t1", type: "aggregation", event_id: null,
        statement: "test-first 降低回归缺陷", importance: 4, importance_basis: "多源",
        citations: [
          { content_item_id: "ci_1", quote: QUOTE, locator: { paragraph_index: 0, char_start: 0, char_end: 10 } },
          { content_item_id: "ci_2", quote: UNCERTAIN_QUOTE, locator: { paragraph_index: 0, char_start: 0, char_end: 8 } },
        ],
        source_count: 1, multi_source: false,
        time_window: { start: "2026-06-01T00:00:00Z", end: "2026-06-02T00:00:00Z" },
        confidence: null, language: "zh",
      },
    ],
  };
}
function report(): Report {
  return {
    id: "rep_1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-06-02T00:00:00Z",
    title: "AI 工程 · brief", body_md: "# AI 工程 · brief\n\n## 1. test-first 降低回归缺陷 [1]\n",
    body_html: "", insight_ids: ["ins_1"], event_ids: [], prev_report_id: null,
    citation_count: 1, cost: { tokens: 0, amount: 0 },
  };
}

/** 生成调用（role=followup）的返回。 */
const gen = (data: unknown) =>
  ({ data, usage: {}, cost: { tokens: 100, amount: 0.001 } }) as unknown as Awaited<ReturnType<typeof callStructured>>;
/** 一致性调用（role=validator）的返回。 */
const judge = (consistency: string, reason = "ok") =>
  ({ data: { consistency, consistency_reason: reason, rationale: "r" }, usage: {}, cost: { tokens: 50, amount: 0.0005 } }) as unknown as Awaited<ReturnType<typeof callStructured>>;

let db: DB;
beforeEach(() => {
  process.env.VALIDATOR_RETRY_BACKOFF_MS = "0"; // 测试不等退避
  db = openDb(":memory:");
  insertSource(db, source());
  insertTopic(db, topic());
  insertContentItem(db, contentItem());
  insertContentItem(db, contentItem("ci_2"));
  saveAnalysisBatch(db, batch());
  saveValidationResult(db, "ab_1", {
    checks: [
      { insight_id: "ins_1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "ins_1", citation_index: 1, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict: "flagged" },
    ],
    report: { total: 2, pass: 1, blocked: 0, flagged: 1, errored: 0, consistency_failure_rate: 0, flagged_rate: 0.5, insights_total: 1, insights_includable: 1, releasable: true },
  });
  vi.mocked(callStructured).mockReset();
});
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.useRealTimers(); });


const generated = { answerable: true, answer_md: "test-first 降低回归 [1]。", claims: [{ ref: 1, claim: "test-first 降低回归缺陷" }] };
const cacheCount = () => (db.prepare("SELECT COUNT(*) AS n FROM consistency_cache").get() as { n: number }).n;
function successfulTransport() {
  vi.mocked(callStructured).mockImplementation(async (opts) => {
    const r = opts.role === "followup" ? gen(generated) : judge("support");
    opts.onCost?.(r.cost);
    return r;
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe("explicit independent followup control", () => {
  it("pre-cancel, expired/invalid deadline and zero/invalid cap start no model or cache writer", async () => {
    successfulTransport();
    const controller = new AbortController(); controller.abort();
    for (const opts of [{ signal: controller.signal }, { deadlineAt: 0 }, { deadlineAt: NaN }, { taskBudgetUsd: 0 }, { taskBudgetUsd: -1 }]) {
      await expect(answerFollowup(db, report(), "?", opts)).rejects.toThrow();
    }
    expect(callStructured).not.toHaveBeenCalled(); expect(cacheCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
  });
  it.each(["cancel", "fence"])("%s after generation prevents expired cache DELETE and judge", async (mode) => {
    db.prepare("INSERT INTO consistency_cache VALUES (?, ?, ?, ?)").run("expired", "support", "ok", "2000-01-01");
    const controller = new AbortController(); let lost = false;
    vi.mocked(callStructured).mockImplementation(async () => {
      if (mode === "cancel") controller.abort(); else lost = true;
      return gen(generated);
    });
    await expect(answerFollowup(db, report(), "?", { signal: controller.signal,
      assertWrite: () => { if (lost) throw new Error("test_fence_lost"); } })).rejects.toThrow(mode === "fence" ? "test_fence_lost" : "cancelled");
    expect(cacheCount()).toBe(1); expect(callStructured).toHaveBeenCalledTimes(1);
  });
  it.each(["resolve", "reject"])("cancel stops waiting for uncooperative generation, late %s has no cache/output", async (completion) => {
    const pending = deferred<Awaited<ReturnType<typeof callStructured>>>();
    const controller = new AbortController();
    vi.mocked(callStructured).mockReturnValue(pending.promise);
    const work = answerFollowup(db, report(), "?", { signal: controller.signal });
    const rejection = expect(work).rejects.toThrow("cancelled");
    controller.abort(); await rejection;
    expect(vi.mocked(callStructured).mock.calls[0][0].signal?.aborted).toBe(true);
    if (completion === "resolve") pending.resolve(gen(generated)); else pending.reject(new Error("late-provider"));
    await flush(); expect(cacheCount()).toBe(0); expect(callStructured).toHaveBeenCalledTimes(1);
  });
  it("absolute deadline in a judge rejects late cache set and consumes late rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<typeof callStructured>>>();
    vi.mocked(callStructured).mockImplementation(async (opts) => opts.role === "followup" ? gen(generated) : pending.promise);
    const work = answerFollowup(db, report(), "?", { deadlineAt: Date.now() + 50 });
    const rejection = expect(work).rejects.toThrow("task_deadline_exceeded");
    await flush(); expect(callStructured).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50); await rejection;
    pending.reject(new Error("late-judge")); await flush();
    expect(cacheCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("generation cost at cap rejects before cache constructor or judge and creates no Run", async () => {
    successfulTransport();
    await expect(answerFollowup(db, report(), "?", { taskBudgetUsd: .001 })).rejects.toThrow("task_budget_exceeded");
    expect(callStructured).toHaveBeenCalledTimes(1); expect(cacheCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
  });
  it("generation retry costs consume the cap while the returned cost keeps its existing contract", async () => {
    vi.mocked(callStructured).mockImplementation(async (opts) => {
      const r = opts.role === "followup" ? gen(generated) : judge("support");
      if (opts.role === "followup") opts.onCost?.(r.cost); // Earlier paid generation attempt.
      opts.onCost?.(r.cost);
      return r;
    });
    const baseline = await answerFollowup(db, report(), "?");
    db.prepare("DELETE FROM consistency_cache").run();
    const controlled = await answerFollowup(db, report(), "?", { taskBudgetUsd: 1 });
    expect(controlled).toEqual(baseline);
    expect(controlled.cost.amount).toBeCloseTo(.0015);
    db.prepare("DELETE FROM consistency_cache").run();
    vi.mocked(callStructured).mockClear();
    await expect(answerFollowup(db, report(), "?", { taskBudgetUsd: .002 })).rejects.toThrow("task_budget_exceeded");
    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(cacheCount()).toBe(0);
  });
  it("judge budget fault remains sticky rather than degrading to a successful answer/cache", async () => {
    successfulTransport();
    await expect(answerFollowup(db, report(), "?", { taskBudgetUsd: .0015 })).rejects.toThrow("task_budget_exceeded");
    expect(callStructured).toHaveBeenCalledTimes(2); expect(cacheCount()).toBe(0);
  });
  it("already-started sibling returns after cap without writing cache or reviving output", async () => {
    const pending = deferred<Awaited<ReturnType<typeof callStructured>>>();
    let firstCost!: () => void;
    let siblingCost!: () => void;
    let judges = 0;
    vi.mocked(callStructured).mockImplementation(async (opts) => {
      if (opts.role === "followup") {
        const r = gen({ ...generated, claims: [{ ref: 1, claim: "A" }, { ref: 1, claim: "B" }] });
        opts.onCost?.(r.cost); return r;
      }
      if (++judges === 1) {
        // Delay the first callback until both branches crossed the original checkpoint.
        await Promise.resolve();
        firstCost = () => opts.onCost?.(judge("support").cost);
        firstCost(); return judge("support");
      }
      siblingCost = () => opts.onCost?.(judge("support").cost);
      return pending.promise;
    });
    const work = answerFollowup(db, report(), "?", { taskBudgetUsd: .0015 });
    await expect(work).rejects.toThrow("task_budget_exceeded");
    expect(judges).toBe(2); expect(cacheCount()).toBe(0);
    siblingCost(); pending.resolve(judge("support")); await flush();
    expect(cacheCount()).toBe(0); expect(callStructured).toHaveBeenCalledTimes(3);
  });
  it("a cached sibling cannot turn an ownership failure into a successful response", async () => {
    successfulTransport(); await answerFollowup(db, report(), "?");
    vi.mocked(callStructured).mockClear(); let lost = false;
    vi.mocked(callStructured).mockImplementation(async (opts) => {
      if (opts.role === "followup") return gen({ ...generated, claims: [...generated.claims, { ref: 1, claim: "different" }] });
      lost = true; return judge("support");
    });
    await expect(answerFollowup(db, report(), "?", { assertWrite: () => { if (lost) throw new Error("test_fence_lost"); } })).rejects.toThrow("test_fence_lost");
    expect(callStructured).toHaveBeenCalledTimes(2); expect(cacheCount()).toBe(1);
  });
  it("fencing takes precedence over simultaneous budget and cancellation", async () => {
    const controller = new AbortController(); let lost = false;
    vi.mocked(callStructured).mockImplementation(async (opts) => {
      opts.onCost?.(gen(generated).cost); lost = true; controller.abort(); return gen(generated);
    });
    await expect(answerFollowup(db, report(), "?", { signal: controller.signal, taskBudgetUsd: .001,
      assertWrite: () => { if (lost) throw new Error("test_fence_lost"); } })).rejects.toThrow("test_fence_lost");
    expect(cacheCount()).toBe(0);
  });
  it("first cancellation reason wins over later deadline and budget", async () => {
    const controller = new AbortController();
    vi.mocked(callStructured).mockImplementation(async (opts) => { controller.abort(); opts.onCost?.(gen(generated).cost); return gen(generated); });
    await expect(answerFollowup(db, report(), "?", { signal: controller.signal, deadlineAt: Date.now() + 500, taskBudgetUsd: .001 })).rejects.toThrow("cancelled");
  });
  it("default and adequate cap preserve exact payload, result, single accounting and cache hit", async () => {
    successfulTransport();
    const baseline = await answerFollowup(db, report(), "?");
    const payload = vi.mocked(callStructured).mock.calls.map(([o]) => ({ role: o.role, system: o.system, user: o.user, maxTokens: o.maxTokens, schema: o.schema }));
    db.prepare("DELETE FROM consistency_cache").run(); vi.mocked(callStructured).mockClear();
    const controlled = await answerFollowup(db, report(), "?", { taskBudgetUsd: 1 });
    expect(controlled).toEqual(baseline); expect(controlled.cost.amount).toBeCloseTo(.0015);
    expect(vi.mocked(callStructured).mock.calls.map(([o]) => ({ role: o.role, system: o.system, user: o.user, maxTokens: o.maxTokens, schema: o.schema }))).toEqual(payload);
    vi.mocked(callStructured).mockClear();
    const cached = await answerFollowup(db, report(), "?", { taskBudgetUsd: 1 });
    expect(cached.cost.amount).toBeCloseTo(.001); expect(callStructured).toHaveBeenCalledTimes(1);
  });
  it("ordinary judge failure still degrades with unchanged validation", async () => {
    vi.stubEnv("VALIDATOR_RETRIES", "0");
    vi.mocked(callStructured).mockImplementation(async (opts) => { if (opts.role === "followup") return gen(generated); throw new Error("provider-unavailable"); });
    const r = await answerFollowup(db, report(), "?");
    expect(r.validation.errored).toBe(1); expect(r.citations_used).toHaveLength(1); expect(cacheCount()).toBe(0);
  });
});
