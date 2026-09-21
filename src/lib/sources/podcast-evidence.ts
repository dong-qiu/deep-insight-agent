/** Immutable raw-evidence envelope for a successfully acquired public podcast transcript.
 *
 * The collector that eventually writes this envelope must first pass source policy, screening,
 * quota, and acquisition-fact gates. Keeping the envelope construction in `sources/` makes those
 * later paths share one evidence shape without letting a raw fetch bypass the source layer. */
import { createHash } from "node:crypto";
import type { RawItem, TranscriptFetchResult } from "./types.js";

/**
 * Parameters used to authenticate a transport URL must not become an evidence identity. Keep
 * this deliberately narrower than "anything containing key": URLs often have meaningful
 * business parameters such as `monkey` or `keyboard`, while the listed forms are established
 * credential names used by signed-CDN and API URLs.
 */
const EPHEMERAL_QUERY_KEY = /^(?:sig(?:nature)?|token|expires?|policy|key-pair-id|awsaccesskeyid|x-amz-[a-z0-9_-]+|x-goog-[a-z0-9_-]+|se|sp|sr|st|ske|skt|sktid|skv|sks|api[_-]?key|x-api-key|authorization|auth(?:entication|orization)?|access[_-]?token|x-auth-token|client[_-]?secret|secret|password|passwd|credential|bearer|session(?:[_-]?id)?)$/i;
// Short Azure SAS query names (`se`, `sp`, `sr`, `st`, etc.) are safe to recognise as URL
// parameters, but are too ambiguous to treat as arbitrary HTML/JSON field names.
const CREDENTIAL_FIELD = "(?:sig(?:nature)?|token|expires?|policy|key-pair-id|awsaccesskeyid|x-amz-[a-z0-9_-]+|x-goog-[a-z0-9_-]+|api[_-]?key|x-api-key|authorization|auth(?:entication|orization)?|access[_-]?token|x-auth-token|client[_-]?secret|secret|password|passwd|credential|bearer|session(?:[_-]?id)?)";
const CREDENTIAL_FIELD_VALUE = new RegExp(
  `(^|[^A-Za-z0-9_</-]|\\\\n)(["']?)(${CREDENTIAL_FIELD})\\2(?![A-Za-z0-9_-])(\\s*(?:=|:)\\s*)(?:(['"])[^'"]*\\5|(?:Bearer\\s+)?[^\\s<>&,;]+)`,
  "gi",
);
const EMBEDDED_HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;
const EMBEDDED_ESCAPED_HTTP_URL = /https?:(?:\\\/){2}[^\s"'<>]+/gi;
const CREDENTIAL_XML_ELEMENT = new RegExp(`<((?:[A-Za-z][A-Za-z0-9_.-]*:)?${CREDENTIAL_FIELD})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1\\s*>`, "gi");

/** Removes provider authorization parameters while retaining semantic parameters such as
 * `lang=en`. This is an evidence identity, not the fetch URL. */
export function stableEvidenceUrl(input: string): string {
  const url = new URL(input);
  // A URL's userinfo is another credential channel. It is never a stable episode identity and
  // must not be copied into the immutable evidence envelope.
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (EPHEMERAL_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/**
 * Evidence is retained for inspection, not as a credential store. Source payloads can embed a
 * signed CDN URL or an API-style attribute, so cleaning only the envelope's top-level identity
 * is insufficient. Preserve all non-credential text while making URL and field-form secrets
 * unusable before serialising the archive.
 */
function redactEvidencePayload(rawPayload: string): string {
  const redactUrl = (candidate: string, escaped = false): string => {
    try {
      const normalized = escaped ? candidate.replace(/\\\//g, "/").replace(/\\+$/, "") : candidate;
      return stableEvidenceUrl(normalized);
    } catch {
      // An incomplete URL-like substring is content, not a reliable credential boundary.
      return candidate;
    }
  };
  const withoutUrlCredentials = rawPayload
    .replace(EMBEDDED_ESCAPED_HTTP_URL, (candidate) => redactUrl(candidate, true))
    .replace(EMBEDDED_HTTP_URL, (candidate) => redactUrl(candidate));
  const withoutXmlCredentials = withoutUrlCredentials.replace(
    CREDENTIAL_XML_ELEMENT,
    (_match, tag: string, attributes?: string) => `<${tag}${attributes ?? ""}><redacted></${tag}>`,
  );
  return withoutXmlCredentials.replace(
    CREDENTIAL_FIELD_VALUE,
    (_match, prefix: string, keyQuote: string, key: string, separator: string, valueQuote?: string) => {
      const quote = valueQuote ?? "";
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}${quote}<redacted>${quote}`;
    },
  );
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

/** Returns the credential-redacted bytes that must be raw-archived before the resulting
 * ContentItem is reader eligible. RSS metadata, the program page, and the downloaded transcript
 * remain independently inspectable even after signed transport URLs expire. */
export function podcastTranscriptEvidenceEnvelope(input: PodcastTranscriptEvidenceInput): string {
  const episodePayload = redactEvidencePayload(input.episode.raw);
  const programPagePayload = redactEvidencePayload(input.program_page.raw_payload);
  const transcriptPayload = redactEvidencePayload(input.transcript.raw_payload);
  return JSON.stringify({
    schema_version: "podcast-transcript-evidence-v1",
    adapter_version: input.adapter_version,
    fetched_at: input.fetched_at,
    episode: {
      url: stableEvidenceUrl(input.episode.url),
      title: input.episode.title,
      published_at: input.episode.published_at,
      rss_item_source_sha256: sha256(input.episode.raw),
      rss_item_archived_sha256: sha256(episodePayload),
      rss_item: episodePayload,
    },
    program_page: {
      stable_url: stableEvidenceUrl(input.program_page.stable_url),
      content_type: input.program_page.content_type,
      source_payload_sha256: sha256(input.program_page.raw_payload),
      archived_payload_sha256: sha256(programPagePayload),
      raw_payload: programPagePayload,
    },
    transcript: {
      stable_url: stableEvidenceUrl(input.transcript.stable_url),
      content_type: input.transcript.content_type,
      bytes: input.transcript.bytes,
      duration_ms: input.transcript.duration_ms,
      source_payload_sha256: sha256(input.transcript.raw_payload),
      archived_payload_sha256: sha256(transcriptPayload),
      cleaned_body_sha256: sha256(input.transcript.cleaned_body),
      raw_payload: transcriptPayload,
    },
  });
}
