/** Real followup → callStructured → Anthropic SDK → synthetic fetch, zero network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODELS } from "../runtime/llm.js";
import { withTaskBudget } from "../runtime/task-budget.js";
vi.mock("../runtime/alert.js", () => ({ notifyBudget: vi.fn() }));
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

let db: DB;
const savedModels = { ...MODELS };
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
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("LLM_MAX_RETRIES", "0"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "0");
  vi.stubEnv("VALIDATOR_RETRIES", "0"); vi.stubEnv("VALIDATOR_THINKING", "0");
  MODELS.followup = "claude-sonnet-4-6"; MODELS.validator = "claude-opus-4-7";
});
afterEach(() => { closeDb(); Object.assign(MODELS, savedModels); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });


function sse(input: unknown, missingUsage = false) {
  return [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: MODELS.followup, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: missingUsage ? {} : { output_tokens: 3 } },
    { type: "message_stop" },
  ].map((v) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`).join("");
}
const answer = { answerable: true, answer_md: "test-first 改善回归 [1]。", claims: [{ ref: 1, claim: "test-first 降低回归缺陷" }] };
const response = (input: unknown, missing = false) => new Response(sse(input, missing), { headers: { "content-type": "text/event-stream" } });
function transport() {
  const fetch = vi.fn().mockImplementationOnce(async () => response(answer))
    .mockImplementation(async () => response({ consistency: "support", consistency_reason: "ok", rationale: "synthetic" }));
  vi.stubGlobal("fetch", fetch); return fetch;
}

describe("independent followup actual SDK control wiring", () => {
  it.each([undefined, 1])("default/adequate cap %s preserves result and accounts SDK cost once", async (cap) => {
    const fetch = transport();
    const r = await answerFollowup(db, report(), "?", { taskBudgetUsd: cap });
    expect(fetch).toHaveBeenCalledTimes(2); expect(r.validation.consistent).toBe(1);
    expect(r.cost.amount).toBeCloseTo((7 * 3 + 3 * 15 + 7 * 15 + 3 * 75) / 1_000_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
  });
  it("zero and generation crossing cap prevent actual SDK judge dispatch", async () => {
    const fetch = transport();
    await expect(answerFollowup(db, report(), "?", { taskBudgetUsd: 0 })).rejects.toThrow("task_budget_exceeded");
    expect(fetch).not.toHaveBeenCalled();
    await expect(answerFollowup(db, report(), "?", { taskBudgetUsd: (7 * 3 + 3 * 15) / 1_000_000 })).rejects.toThrow("task_budget_exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consistency_cache").get()).toEqual({ n: 0 });
  });
  it("actual fetch receives cancellation and uncooperative late response cannot start judge", async () => {
    const controller = new AbortController();
    let ready!: () => void, late!: (r: Response) => void; let signal: AbortSignal | undefined;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const fetch = vi.fn((_url, init) => { signal = init?.signal; ready(); return new Promise<Response>((resolve) => { late = resolve; }); });
    vi.stubGlobal("fetch", fetch);
    const work = answerFollowup(db, report(), "?", { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow("cancelled");
    await entered; controller.abort(); await rejected; expect(signal?.aborted).toBe(true);
    late(response(answer)); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetch).toHaveBeenCalledTimes(1); expect(db.prepare("SELECT COUNT(*) AS n FROM consistency_cache").get()).toEqual({ n: 0 });
  });
  it("missing provider estimate remains unknown without creating a budget error or fake amount", async () => {
    const fetch = vi.fn(async () => response({ answerable: false, answer_md: "not covered", claims: [] }, true));
    vi.stubGlobal("fetch", fetch);
    const r = await answerFollowup(db, report(), "?", { taskBudgetUsd: 1 });
    expect(r.answerable).toBe(false); expect(r.cost.amount).toBeNaN(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("existing parent budget is inherited, a child cap cannot override it", async () => {
    const fetch = transport();
    await expect(withTaskBudget(db, { taskBudgetUsd: 0 }, () => answerFollowup(db, report(), "?", { taskBudgetUsd: 1 }))).rejects.toThrow("task_budget_exceeded");
    expect(fetch).not.toHaveBeenCalled();
  });
});
