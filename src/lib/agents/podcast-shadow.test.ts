import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPodcastTranscriptShadow, type PodcastShadowSink } from "./podcast-shadow.js";
import type { Source, TranscriptAcquisitionFact } from "../types.js";
import type { PodcastProgramPageFetchResult, RawItem, TranscriptFetchResult } from "../sources/types.js";

const source: Source = {
  id: "pod", name: "Pod", type: "rss", endpoint: "https://pod.example/feed", topic_ids: ["t"],
  fetch_interval: "1h", backfill: null, enabled: true, transcript_mode: "observe", transcript_strategy: "relevant_only",
  transcript_max_items_per_run: 1, transcript_max_bytes_per_run: 1_000, transcript_timeout_budget_ms: 10_000,
  transcript_host_qps: 1, transcript_policy_version: "podcast-policy-v1",
};
const raw = (url: string, body = "notes"): RawItem => ({
  url, title: "Coding agent episode", author: null, published_at: null, body, body_kind: "show_notes",
  is_podcast_episode: true, transcript_url: `${url}.txt?signature=secret`, raw: `{"url":"${url}"}`,
});
const success: TranscriptFetchResult = {
  outcome: "success", stable_url: "https://pod.example/ep.txt", raw_payload: "raw transcript", cleaned_body: "clean body",
  bytes: 14, duration_ms: 5, content_type: "text/plain",
};
const programPage: PodcastProgramPageFetchResult = {
  outcome: "success", stable_url: "https://pod.example/ep", raw_payload: "<html>episode</html>",
  bytes: 20, duration_ms: 4, content_type: "text/html",
};

function memorySink(facts: Omit<TranscriptAcquisitionFact, "event_key">[], archives: unknown[]): PodcastShadowSink {
  return {
    append: (fact) => { facts.push(fact); },
    nextAttempt: () => 1,
    archive: (input) => { archives.push(input); return "archive/evidence.json"; },
  };
}

function terminal(facts: Omit<TranscriptAcquisitionFact, "event_key">[]) {
  return facts.filter((fact) => fact.stage === "terminal");
}

beforeEach(() => {
  process.env.TRANSCRIPT_FETCH = "1";
  process.env.TRANSCRIPT_SHADOW_FETCH = "1";
});

afterEach(() => {
  delete process.env.TRANSCRIPT_FETCH;
  delete process.env.TRANSCRIPT_SHADOW_FETCH;
});

describe("runPodcastTranscriptShadow", () => {
  it("仅向 shadow fact sink 写候选/决策/attempt/terminal，且受单轮项目预算限制", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const archives: unknown[] = [];
    const result = await runPodcastTranscriptShadow({
      source, raws: [raw("https://pod.example/ep-1"), raw("https://pod.example/ep-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, archives),
      now: () => "2026-09-13T00:00:00.000Z", fetcher: async () => success, programPageFetcher: async () => programPage,
    });
    expect(result).toEqual({ observed: 2, requested: 1, succeeded: 1, budget_limited: 1 });
    expect(facts.map((fact) => fact.stage)).toEqual(["candidate", "decision", "attempt", "terminal", "candidate", "decision", "terminal"]);
    expect(terminal(facts).map((fact) => fact.outcome)).toEqual(["success", "budget_limited"]);
    expect(terminal(facts)[0]).toMatchObject({ attempt: 1, execution_scope: "shadow", evidence_status: "verified", raw_ref: "archive/evidence.json" });
    expect(archives).toHaveLength(1);
  });

  it("拒绝非 observe 或无版本策略的 source，避免绕过 Source 契约", async () => {
    await expect(runPodcastTranscriptShadow({
      source: { ...source, transcript_mode: "enabled" }, raws: [], topics: [], sink: memorySink([], []),
    })).rejects.toThrow("podcast_shadow_requires_observe_mode");
    await expect(runPodcastTranscriptShadow({
      source: { ...source, transcript_policy_version: null }, raws: [], topics: [], sink: memorySink([], []),
    })).rejects.toThrow("transcript_policy_version_required");
    await expect(runPodcastTranscriptShadow({
      source: { ...source, transcript_max_items_per_run: undefined }, raws: [], topics: [], sink: memorySink([], []),
    })).rejects.toThrow("transcript_policy_fields_required");
  });

  it("双总熔断在 request-owning worker 内生效，任一关闭时直接调用也不能发起网络请求", async () => {
    for (const disabledGate of ["TRANSCRIPT_FETCH", "TRANSCRIPT_SHADOW_FETCH"] as const) {
      process.env.TRANSCRIPT_FETCH = "1";
      process.env.TRANSCRIPT_SHADOW_FETCH = "1";
      delete process.env[disabledGate];
      let transcriptRequests = 0;
      let programPageRequests = 0;
      await expect(runPodcastTranscriptShadow({
        source, raws: [raw("https://reader:secret@pod.example/ep?lang=en&token=secret")],
        topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink([], []),
        fetcher: async () => { transcriptRequests++; return success; },
        programPageFetcher: async () => { programPageRequests++; return programPage; },
      })).rejects.toThrow("podcast_shadow_fetch_disabled");
      expect(transcriptRequests).toBe(0);
      expect(programPageRequests).toBe(0);
    }
  });

  it("shadow facts use a credential-free canonical episode URL", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    await runPodcastTranscriptShadow({
      source, raws: [raw("https://reader:secret@pod.example/ep?lang=en&token=secret")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => success, programPageFetcher: async () => programPage,
    });
    expect(facts).toHaveLength(4);
    expect(facts.every((fact) => fact.canonical_episode_url === "https://pod.example/ep?lang=en")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("secret");
  });

  it("节目页失败按真实 transport outcome 终结，不把失败伪装成 success", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const archives: unknown[] = [];
    const result = await runPodcastTranscriptShadow({
      source, raws: [raw("https://pod.example/incomplete")], topics: [{ id: "t", keywords: ["coding agent"] }],
      sink: memorySink(facts, archives), fetcher: async () => success,
      programPageFetcher: async () => ({ outcome: "http_error", stable_url: "https://pod.example/incomplete", bytes: null, duration_ms: 1, reason_code: "http_404" }),
    });
    expect(result).toEqual({ observed: 1, requested: 1, succeeded: 0, budget_limited: 0 });
    expect(terminal(facts)[0]).toMatchObject({ outcome: "http_error", reason_code: "program_page_http_404", evidence_status: "failed", raw_ref: null });
    expect(archives).toHaveLength(0);
  });

  it("evidence archive 写失败也收敛为 terminal，不留下孤立 pending attempt", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const result = await runPodcastTranscriptShadow({
      source, raws: [raw("https://pod.example/archive-failure")], topics: [{ id: "t", keywords: ["coding agent"] }],
      sink: { ...memorySink(facts, []), archive: () => { throw new Error("disk full"); } },
      fetcher: async () => success, programPageFetcher: async () => programPage,
    });
    expect(result).toEqual({ observed: 1, requested: 1, succeeded: 0, budget_limited: 0 });
    expect(terminal(facts)[0]).toMatchObject({ outcome: "transient_error", reason_code: "shadow_archive_write_failed", evidence_status: "failed", raw_ref: null });
  });

  it("hard_negative 按策略跳过，节目页也计入同 host QPS", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const skipped = await runPodcastTranscriptShadow({
      source, raws: [{ ...raw("https://pod.example/trailer"), title: "Season preview", podcast_episode_type: "trailer" }],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => success, programPageFetcher: async () => programPage,
    });
    expect(skipped).toEqual({ observed: 1, requested: 0, succeeded: 0, budget_limited: 0 });
    expect(terminal(facts)[0]).toMatchObject({ outcome: "not_attempted", reason_code: "hard_negative_by_strategy" });

    const delays: number[] = [];
    const qpsSource = { ...source, transcript_max_items_per_run: 2, transcript_timeout_budget_ms: 10_000, transcript_host_qps: 0.5 };
    const sampled = await runPodcastTranscriptShadow({
      source: qpsSource, raws: [raw("https://pod.example/qps-1"), raw("https://pod.example/qps-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink([], []),
      // Production adapters invoke this gate once for robots and once for the payload.
      fetcher: async (url, opts) => { await opts?.beforeRequest?.(`${new URL(url).origin}/robots.txt`); await opts?.beforeRequest?.(url); return success; },
      programPageFetcher: async (url, opts) => { await opts?.beforeRequest?.(`${new URL(url).origin}/robots.txt`); await opts?.beforeRequest?.(url); return programPage; },
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(sampled.requested).toBe(2);
    expect(delays).toHaveLength(7);
    expect(delays.every((delay) => delay >= 1_900)).toBe(true);
  });

  it("节目页 bytes 进入源总配额，下一候选不越界请求", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    let transcriptRequests = 0;
    const result = await runPodcastTranscriptShadow({
      source: { ...source, transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 34 },
      raws: [raw("https://pod.example/bytes-1"), raw("https://pod.example/bytes-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => { transcriptRequests++; return success; }, programPageFetcher: async () => programPage,
    });
    expect(result).toEqual({ observed: 2, requested: 1, succeeded: 1, budget_limited: 1 });
    expect(transcriptRequests).toBe(1);
    expect(terminal(facts).map((fact) => fact.outcome)).toEqual(["success", "budget_limited"]);
  });

  it("size_limited 即使 adapter 未报告已读 bytes 也保守耗尽剩余配额", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    let transcriptRequests = 0;
    const limitedTranscript: TranscriptFetchResult = {
      outcome: "size_limited", stable_url: "https://pod.example/large", bytes: null, duration_ms: 1, reason_code: "response_size_limit",
    };
    const result = await runPodcastTranscriptShadow({
      source: { ...source, transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 100 },
      raws: [raw("https://pod.example/limit-transcript-1"), raw("https://pod.example/limit-transcript-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => { transcriptRequests++; return limitedTranscript; }, programPageFetcher: async () => programPage,
    });
    expect(result).toEqual({ observed: 2, requested: 1, succeeded: 0, budget_limited: 1 });
    expect(transcriptRequests).toBe(1);
    expect(terminal(facts).map((fact) => fact.outcome)).toEqual(["size_limited", "budget_limited"]);
    expect(terminal(facts)[0]?.bytes).toBe(100);
  });

  it("节目页 size_limited 同样耗尽剩余配额，不能让下一集继续请求", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    let transcriptRequests = 0;
    const limitedPage: PodcastProgramPageFetchResult = {
      outcome: "size_limited", stable_url: "https://pod.example/large-page", bytes: null, duration_ms: 1, reason_code: "response_size_limit",
    };
    const result = await runPodcastTranscriptShadow({
      source: { ...source, transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 100 },
      raws: [raw("https://pod.example/limit-page-1"), raw("https://pod.example/limit-page-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => { transcriptRequests++; return success; }, programPageFetcher: async () => limitedPage,
    });
    expect(result).toEqual({ observed: 2, requested: 1, succeeded: 0, budget_limited: 1 });
    expect(transcriptRequests).toBe(1);
    expect(terminal(facts)[0]).toMatchObject({ outcome: "size_limited", bytes: 100 });
  });

  it("节目页在 source deadline 后才返回时不能归档为 success", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const originalNow = Date.now;
    let clock = 0;
    Date.now = () => clock;
    try {
      const result = await runPodcastTranscriptShadow({
        source: { ...source, transcript_timeout_budget_ms: 10 }, raws: [raw("https://pod.example/deadline")],
        topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []), fetcher: async () => success,
        programPageFetcher: async () => { clock = 10; return programPage; },
      });
      expect(result).toEqual({ observed: 1, requested: 1, succeeded: 0, budget_limited: 1 });
      expect(terminal(facts)[0]).toMatchObject({ outcome: "budget_limited", reason_code: "source_timeout_budget_exhausted_after_program_page", evidence_status: "failed" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("source transport deadline 返回结构化 timeout 时归因为 budget_limited", async () => {
    const facts: Omit<TranscriptAcquisitionFact, "event_key">[] = [];
    const result = await runPodcastTranscriptShadow({
      source, raws: [raw("https://pod.example/gate-timeout")], topics: [{ id: "t", keywords: ["coding agent"] }], sink: memorySink(facts, []),
      fetcher: async () => ({ outcome: "timeout", stable_url: "https://pod.example/gate-timeout.txt", bytes: null, duration_ms: 1, reason_code: "source_timeout_budget_exhausted" }),
      programPageFetcher: async () => programPage,
    });
    expect(result).toEqual({ observed: 1, requested: 1, succeeded: 0, budget_limited: 1 });
    expect(terminal(facts)[0]).toMatchObject({ outcome: "budget_limited", reason_code: "source_timeout_budget_exhausted" });
  });
});
