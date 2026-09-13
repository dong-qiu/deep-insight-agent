/** Immutable raw-evidence envelope for a successfully acquired public podcast transcript.
 *
 * The collector that eventually writes this envelope must first pass source policy, screening,
 * quota, and acquisition-fact gates. Keeping the envelope construction in `sources/` makes those
 * later paths share one evidence shape without letting a raw fetch bypass the source layer. */
import { createHash } from "node:crypto";
import type { RawItem, TranscriptFetchResult } from "./types.js";

const EPHEMERAL_QUERY_KEY = /^(?:sig(?:nature)?|token|expires?|policy|key-pair-id|awsaccesskeyid|x-amz-.+|x-goog-.+|se|sp|sr|st|ske|skt|sktid|skv|sks)$/i;

/** Removes provider authorization parameters while retaining semantic parameters such as
 * `lang=en`. This is an evidence identity, not the fetch URL. */
export function stableEvidenceUrl(input: string): string {
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (EPHEMERAL_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

export interface PodcastProgramPageEvidence {
  stable_url: string;
  content_type: string | null;
  raw_payload: string;
}

export interface PodcastTranscriptEvidenceInput {
  adapter_version: string;
  fetched_at: string;
  episode: RawItem;
  program_page: PodcastProgramPageEvidence;
  transcript: Extract<TranscriptFetchResult, { outcome: "success" }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns the exact bytes that must be raw-archived before the resulting ContentItem is reader
 * eligible. RSS metadata, the program page, and the downloaded transcript remain independently
 * inspectable even after signed transport URLs expire. */
export function podcastTranscriptEvidenceEnvelope(input: PodcastTranscriptEvidenceInput): string {
  return JSON.stringify({
    schema_version: "podcast-transcript-evidence-v1",
    adapter_version: input.adapter_version,
    fetched_at: input.fetched_at,
    episode: {
      url: stableEvidenceUrl(input.episode.url),
      title: input.episode.title,
      published_at: input.episode.published_at,
      rss_item: input.episode.raw,
    },
    program_page: {
      stable_url: stableEvidenceUrl(input.program_page.stable_url),
      content_type: input.program_page.content_type,
      raw_payload_sha256: sha256(input.program_page.raw_payload),
      raw_payload: input.program_page.raw_payload,
    },
    transcript: {
      stable_url: stableEvidenceUrl(input.transcript.stable_url),
      content_type: input.transcript.content_type,
      bytes: input.transcript.bytes,
      duration_ms: input.transcript.duration_ms,
      raw_payload_sha256: sha256(input.transcript.raw_payload),
      cleaned_body_sha256: sha256(input.transcript.cleaned_body),
      raw_payload: input.transcript.raw_payload,
    },
  });
}
