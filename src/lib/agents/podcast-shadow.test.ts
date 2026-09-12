import { describe, expect, it } from "vitest";
import { runPodcastTranscriptShadow, type PodcastShadowObservation } from "./podcast-shadow.js";
import type { Source } from "../types.js";
import type { RawItem, TranscriptFetchResult } from "../sources/types.js";

const source: Source = {
  id: "pod", name: "Pod", type: "rss", endpoint: "https://pod.example/feed", topic_ids: ["t"],
  fetch_interval: "1h", backfill: null, enabled: true, transcript_mode: "observe", transcript_strategy: "relevant_only",
  transcript_max_items_per_run: 1, transcript_max_bytes_per_run: 1_000, transcript_timeout_budget_ms: 1_000, transcript_host_qps: 1,
};
const raw = (url: string, body = "notes"): RawItem => ({
  url, title: "Coding agent episode", author: null, published_at: null, body, body_kind: "show_notes",
  is_podcast_episode: true, transcript_url: `${url}.txt?signature=secret`, raw: `{"url":"${url}"}`,
});
const success: TranscriptFetchResult = {
  outcome: "success", stable_url: "https://pod.example/ep.txt", raw_payload: "raw transcript", cleaned_body: "clean body",
  speaker_attribution: "unknown", bytes: 14, duration_ms: 5, content_type: "text/plain",
};

describe("runPodcastTranscriptShadow", () => {
  it("只经显式 shadow sink 写入，不创建 ContentItem，且受 sample budget 限制", async () => {
    const observations: PodcastShadowObservation[] = [];
    const archives: unknown[] = [];
    const result = await runPodcastTranscriptShadow({
      source, raws: [raw("https://pod.example/ep-1"), raw("https://pod.example/ep-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }],
      sink: { append: (item) => { observations.push(item); }, archive: (item) => { archives.push(item); } },
      now: () => "2026-09-13T00:00:00.000Z", fetcher: async () => success,
    });
    expect(result).toEqual({ observed: 2, requested: 1, succeeded: 1, budget_limited: 1 });
    expect(observations.map((item) => item.outcome)).toEqual(["success", "budget_limited"]);
    expect(archives).toHaveLength(1);
  });

  it("拒绝非 observe source，避免把 shadow 路径误接到 enabled 生产采集", async () => {
    await expect(runPodcastTranscriptShadow({
      source: { ...source, transcript_mode: "enabled" }, raws: [], topics: [], sink: { append() {}, archive() {} },
    })).rejects.toThrow("podcast_shadow_requires_observe_mode");
  });

  it("hard_negative 按策略跳过，且 shadow 对同 host 遵守源级 QPS", async () => {
    const observations: PodcastShadowObservation[] = [];
    const skipped = await runPodcastTranscriptShadow({
      source, raws: [{ ...raw("https://pod.example/trailer"), title: "Season preview", podcast_episode_type: "trailer" }],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: { append: (item) => { observations.push(item); }, archive() {} },
      fetcher: async () => success,
    });
    expect(skipped).toEqual({ observed: 1, requested: 0, succeeded: 0, budget_limited: 0 });
    expect(observations[0]).toMatchObject({ outcome: "policy_skipped", reason_code: "hard_negative_by_strategy" });

    const delays: number[] = [];
    const qpsSource = { ...source, transcript_max_items_per_run: 2, transcript_timeout_budget_ms: 5_000, transcript_host_qps: 0.5 };
    const sampled = await runPodcastTranscriptShadow({
      source: qpsSource, raws: [raw("https://pod.example/qps-1"), raw("https://pod.example/qps-2")],
      topics: [{ id: "t", keywords: ["coding agent"] }], sink: { append() {}, archive() {} }, fetcher: async () => success,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(sampled.requested).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1_900);
  });
});
