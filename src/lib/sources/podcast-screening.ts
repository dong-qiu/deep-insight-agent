/** Deterministic, high-recall podcast transcript pre-screen.
 *
 * This module deliberately has no DB or agent dependency.  It can therefore be run identically
 * in production decision logging and an isolated shadow collector.  Unknown is an affirmative
 * fetch decision: only a standardized trailer with sufficient negative evidence is skippable.
 */
import { createHash } from "node:crypto";
import type { Topic } from "../types.js";
import type { RawItem } from "./types.js";

export const PODCAST_SCREENING_POLICY_VERSION = "podcast-screen-v1";

export interface PodcastScreeningDecision {
  /** Version of the deterministic screening rules used for this decision. */
  policy_version: typeof PODCAST_SCREENING_POLICY_VERSION;
  candidate_hash: string;
  decision: "fetch" | "unknown" | "hard_negative";
  reason_code: "topic_keyword_match" | "trailer_without_topic_match" | "missing_topic_profile" | "insufficient_metadata" | "no_keyword_high_recall";
  matched_topic_ids: string[];
}

function lower(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase();
}

function candidateHash(raw: RawItem): string {
  // The hash is an opaque fact identity; do not place signed transcript URLs in diagnosable rows.
  return createHash("sha256").update(JSON.stringify({
    url: raw.url, title: raw.title, author: raw.author, published_at: raw.published_at,
    body: raw.body, is_podcast_episode: raw.is_podcast_episode ?? false,
    podcast_episode_type: raw.podcast_episode_type ?? null,
    has_transcript: Boolean(raw.transcript_url),
  })).digest("hex");
}

/** Classify a podcast episode against the source's configured topics without an LLM.
 *
 * `hard_negative` is intentionally much narrower than “no keyword”: it is only a standardized
 * trailer and only after all configured topic keywords have failed to match.  Any missing or
 * ambiguous evidence stays `unknown`, preserving recall during a canary.
 */
export function screenPodcastCandidate(raw: RawItem, topics: Pick<Topic, "id" | "keywords">[]): PodcastScreeningDecision {
  const candidate_hash = candidateHash(raw);
  if (!topics.length) return { policy_version: PODCAST_SCREENING_POLICY_VERSION, candidate_hash, decision: "unknown", reason_code: "missing_topic_profile", matched_topic_ids: [] };

  const corpus = lower([raw.title, raw.author, raw.body].filter(Boolean).join("\n"));
  if (corpus.trim().length < 8) {
    return { policy_version: PODCAST_SCREENING_POLICY_VERSION, candidate_hash, decision: "unknown", reason_code: "insufficient_metadata", matched_topic_ids: [] };
  }
  const matched_topic_ids = topics.filter((topic) => topic.keywords.some((keyword) => {
    const normalized = lower(keyword).trim();
    return normalized.length > 1 && corpus.includes(normalized);
  })).map((topic) => topic.id);
  if (matched_topic_ids.length) {
    return { policy_version: PODCAST_SCREENING_POLICY_VERSION, candidate_hash, decision: "fetch", reason_code: "topic_keyword_match", matched_topic_ids };
  }
  if (raw.podcast_episode_type === "trailer") {
    return { policy_version: PODCAST_SCREENING_POLICY_VERSION, candidate_hash, decision: "hard_negative", reason_code: "trailer_without_topic_match", matched_topic_ids: [] };
  }
  return { policy_version: PODCAST_SCREENING_POLICY_VERSION, candidate_hash, decision: "unknown", reason_code: "no_keyword_high_recall", matched_topic_ids: [] };
}
