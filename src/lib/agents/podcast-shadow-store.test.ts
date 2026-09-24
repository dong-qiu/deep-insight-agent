import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPodcastShadowStore } from "./podcast-shadow-store.js";
import type { Source } from "../types.js";
import type { PodcastProgramPageFetchResult, RawItem, TranscriptFetchResult } from "../sources/types.js";

const source: Source = {
  id: "pod-store", name: "Store Pod", type: "rss", endpoint: "https://pod.example/feed", topic_ids: ["t"],
  fetch_interval: "1h", backfill: null, enabled: true, transcript_mode: "observe", transcript_strategy: "relevant_only",
  transcript_max_items_per_run: 1, transcript_max_bytes_per_run: 1_000, transcript_timeout_budget_ms: 1_000,
  transcript_host_qps: 1, transcript_policy_version: "podcast-policy-v1",
};
const episode: RawItem = {
  url: "https://pod.example/episode", title: "Episode", author: null, published_at: null, body: "notes",
  body_kind: "show_notes", is_podcast_episode: true, transcript_url: "https://pod.example/transcript", raw: "<item>rss-v1</item>",
};
const transcript: Extract<TranscriptFetchResult, { outcome: "success" }> = {
  outcome: "success", stable_url: "https://pod.example/transcript", raw_payload: "same transcript", cleaned_body: "same transcript",
  bytes: 15, duration_ms: 1, content_type: "text/plain",
};
const page = (raw_payload: string): Extract<PodcastProgramPageFetchResult, { outcome: "success" }> => ({
  outcome: "success", stable_url: "https://pod.example/episode", raw_payload, bytes: raw_payload.length, duration_ms: 1, content_type: "text/html",
});

afterEach(() => { delete process.env.DATA_DIR; });

describe("createPodcastShadowStore", () => {
  it("archive identity covers the entire evidence envelope, not transcript bytes alone", () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "podcast-shadow-store-"));
    const store = createPodcastShadowStore(source);
    const first = store.sink.archive({ source_id: source.id, episode, transcript, program_page: page("<html>v1</html>") }) as string;
    const second = store.sink.archive({ source_id: source.id, episode, transcript, program_page: page("<html>v2</html>") }) as string;
    store.close();
    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(join(process.env.DATA_DIR!, "podcast-shadow", first), "utf8"))).toMatchObject({ program_page: { raw_payload: "<html>v1</html>" } });
    expect(JSON.parse(readFileSync(join(process.env.DATA_DIR!, "podcast-shadow", second), "utf8"))).toMatchObject({ program_page: { raw_payload: "<html>v2</html>" } });
  });
});
