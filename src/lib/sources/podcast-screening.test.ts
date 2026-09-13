import { describe, expect, it } from "vitest";
import { PODCAST_SCREENING_POLICY_VERSION, screenPodcastCandidate } from "./podcast-screening.js";
import type { RawItem } from "./types.js";

const topics = [{ id: "t_agent", keywords: ["coding agent", "software engineering"] }];
const episode = (overrides: Partial<RawItem> = {}): RawItem => ({
  url: "https://pod.example/ep", title: "Episode", author: "Host", published_at: null,
  body: "Show notes", body_kind: "show_notes", is_podcast_episode: true, raw: "{}", ...overrides,
});

describe("screenPodcastCandidate", () => {
  it("主题关键词命中时确定性 fetch，并给出命中 topic", () => {
    expect(screenPodcastCandidate(episode({ title: "How coding agents change teams" }), topics)).toMatchObject({
      policy_version: PODCAST_SCREENING_POLICY_VERSION, decision: "fetch", reason_code: "topic_keyword_match", matched_topic_ids: ["t_agent"],
    });
  });

  it("无关键词不是拒绝理由：信息充分时仍为 unknown / fetch", () => {
    expect(screenPodcastCandidate(episode({ title: "A conversation with a founder" }), topics)).toMatchObject({
      decision: "unknown", reason_code: "no_keyword_high_recall",
    });
  });

  it("仅标准 trailer 且无主题命中才可 hard_negative", () => {
    expect(screenPodcastCandidate(episode({ title: "Season preview", podcast_episode_type: "trailer" }), topics)).toMatchObject({
      decision: "hard_negative", reason_code: "trailer_without_topic_match",
    });
    expect(screenPodcastCandidate(episode({ title: "Coding agent preview", podcast_episode_type: "trailer" }), topics).decision).toBe("fetch");
  });

  it("候选 hash 对相同有效载荷稳定，且不暴露 transcript URL", () => {
    const first = screenPodcastCandidate(episode({ transcript_url: "https://cdn.example/t?signature=one" }), topics);
    const second = screenPodcastCandidate(episode({ transcript_url: "https://cdn.example/t?signature=two" }), topics);
    expect(first.candidate_hash).toBe(second.candidate_hash);
    expect(first.candidate_hash).not.toContain("signature");
  });
});
