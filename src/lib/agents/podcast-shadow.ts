/** Isolated observe-mode sampler for podcast transcripts.
 *
 * Shadow acquisition has exactly the same append-only fact contract as production metadata, but
 * it writes to an isolated database/archive and has no route into ContentItem or Report.
 */
import type { Source, Topic, TranscriptAcquisitionFact } from "../types.js";
import { stableEvidenceUrl } from "../sources/podcast-evidence.js";
import { screenPodcastCandidate } from "../sources/podcast-screening.js";
import { PodcastRequestBudgetError, fetchPodcastProgramPage, fetchTranscript, transcriptFetchEnabled, transcriptShadowFetchEnabled } from "../sources/rss.js";
import { assertExplicitTranscriptPolicy } from "../transcript-policy.js";
import type { PodcastProgramPageFetchResult, RawItem, TranscriptFetchResult } from "../sources/types.js";

const PODCAST_TRANSCRIPT_SHADOW_ADAPTER_VERSION = "rss-podcast-transcript-shadow-v1";

export interface PodcastShadowSink {
  /** Persists only to a separately provisioned shadow fact database. */
  append(fact: Omit<TranscriptAcquisitionFact, "event_key">): void | Promise<void>;
  /** Allocates the next terminal/attempt identity for this immutable candidate. */
  nextAttempt(input: Pick<TranscriptAcquisitionFact,
    "source_id" | "canonical_episode_url" | "candidate_hash" | "transcript_policy_version"
  >): number | Promise<number>;
  /** Stores evidence only after RSS, program page and transcript are all successful. */
  archive(input: {
    source_id: string;
    episode: RawItem;
    program_page: Extract<PodcastProgramPageFetchResult, { outcome: "success" }>;
    transcript: Extract<TranscriptFetchResult, { outcome: "success" }>;
  }): string | Promise<string>;
}

export interface ShadowSampleResult { observed: number; requested: number; succeeded: number; budget_limited: number }

type FactInput = Omit<TranscriptAcquisitionFact, "event_key">;

/** Sample observe candidates with source policy limits, with no production ContentItem side effect. */
export async function runPodcastTranscriptShadow(input: {
  source: Source;
  raws: RawItem[];
  topics: Pick<Topic, "id" | "keywords">[];
  sink: PodcastShadowSink;
  now?: () => string;
  fetcher?: typeof fetchTranscript;
  programPageFetcher?: typeof fetchPodcastProgramPage;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ShadowSampleResult> {
  if ((input.source.transcript_mode ?? "off") !== "observe") throw new Error("podcast_shadow_requires_observe_mode");
  assertExplicitTranscriptPolicy(input.source);
  const policyVersion = input.source.transcript_policy_version?.trim();
  if (!policyVersion) throw new Error("transcript_policy_version_required");
  // This function owns transcript requests. Enforce both kill switches here as well as in the
  // collector so a future caller cannot turn an observe sample into an accidental network path.
  if (!transcriptFetchEnabled() || !transcriptShadowFetchEnabled()) throw new Error("podcast_shadow_fetch_disabled");

  const fetcher = input.fetcher ?? fetchTranscript;
  const programPageFetcher = input.programPageFetcher ?? fetchPodcastProgramPage;
  const now = input.now ?? (() => new Date().toISOString());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const itemBudget = input.source.transcript_max_items_per_run ?? 5;
  const byteBudget = input.source.transcript_max_bytes_per_run ?? 5 * 1024 * 1024;
  const timeBudget = input.source.transcript_timeout_budget_ms ?? 30_000;
  const qps = Math.max(input.source.transcript_host_qps ?? 0.5, 0.01);
  const strategy = input.source.transcript_strategy ?? "relevant_only";
  const started = Date.now();
  let requested = 0;
  let succeeded = 0;
  let bytes = 0;
  let observed = 0;
  let budget_limited = 0;
  const lastRequestStartAtByOrigin = new Map<string, number>();

  const waitForHost = async (url: string): Promise<boolean> => {
    let origin = "invalid";
    try { origin = new URL(url).origin; } catch { /* structured fetch result records malformed input */ }
    const earliest = (lastRequestStartAtByOrigin.get(origin) ?? 0) + Math.ceil(1_000 / qps);
    const delay = earliest - Date.now();
    if (delay > 0) await sleep(delay);
    if (Date.now() - started >= timeBudget) return false;
    lastRequestStartAtByOrigin.set(origin, Date.now());
    return true;
  };
  const gateRequest = async (url: string): Promise<void> => {
    if (!await waitForHost(url)) throw new PodcastRequestBudgetError();
  };

  for (const raw of input.raws) {
    if (!raw.is_podcast_episode) continue;
    let decision: ReturnType<typeof screenPodcastCandidate>;
    let canonicalEpisodeUrl: string;
    try {
      decision = screenPodcastCandidate(raw, input.topics);
      canonicalEpisodeUrl = stableEvidenceUrl(raw.url);
    } catch {
      // A malformed feed item is not a terminal acquisition fact because it has no safe,
      // durable episode identity. It must not starve later valid candidates in this sample.
      continue;
    }
    const common = {
      source_id: input.source.id,
      canonical_episode_url: canonicalEpisodeUrl,
      candidate_hash: decision.candidate_hash,
      transcript_policy_version: policyVersion,
      mode: "observe" as const,
      strategy,
      execution_scope: "shadow" as const,
      adapter_version: `${PODCAST_TRANSCRIPT_SHADOW_ADAPTER_VERSION}+${decision.policy_version}`,
      decision: decision.decision,
      fallback_body_kind: raw.body.trim() ? "show_notes" as const : null,
      content_item_id: null,
      run_id: null,
    };
    const append = async (fact: FactInput) => input.sink.append(fact);
    await append({ ...common, stage: "candidate", attempt: 0, outcome: "not_attempted", reason_code: "podcast_metadata",
      bytes: null, duration_ms: null, raw_ref: null, evidence_status: "not_applicable", occurred_at: now() });
    await append({ ...common, stage: "decision", attempt: 0, outcome: "decision", reason_code: decision.reason_code,
      bytes: null, duration_ms: null, raw_ref: null, evidence_status: "not_applicable", occurred_at: now() });
    const attempt = await input.sink.nextAttempt(common);
    const terminal = async (fact: Omit<FactInput, "stage" | "attempt">) => {
      await append({ ...fact, stage: "terminal", attempt });
      observed++;
    };

    if (!raw.transcript_url) {
      await terminal({ ...common, outcome: "no_transcript", reason_code: "transcript_url_missing", bytes: null,
        duration_ms: null, raw_ref: null, evidence_status: "not_applicable", occurred_at: now() });
      continue;
    }
    if (strategy !== "all" && decision.decision === "hard_negative") {
      await terminal({ ...common, outcome: "not_attempted", reason_code: "hard_negative_by_strategy", bytes: null,
        duration_ms: null, raw_ref: null, evidence_status: "not_applicable", occurred_at: now() });
      continue;
    }
    if (requested >= itemBudget || bytes >= byteBudget || Date.now() - started >= timeBudget) {
      await terminal({ ...common, outcome: "budget_limited", reason_code: "source_budget_exhausted", bytes: null,
        duration_ms: null, raw_ref: null, evidence_status: "not_applicable", occurred_at: now() });
      budget_limited++;
      continue;
    }
    requested++;
    await append({ ...common, stage: "attempt", attempt, outcome: "not_attempted", reason_code: "transcript_request_started",
      bytes: null, duration_ms: null, raw_ref: null, evidence_status: "pending", occurred_at: now() });
    const transcriptBudget = Math.max(1, byteBudget - bytes);
    const transcript = await fetcher(raw.transcript_url, {
      maxBytes: transcriptBudget, timeoutMs: Math.max(1, timeBudget - (Date.now() - started)), beforeRequest: gateRequest,
    });
    const transcriptBytes = transcript.bytes ?? (transcript.outcome === "size_limited" ? transcriptBudget : 0);
    bytes += transcriptBytes;
    if (transcript.outcome !== "success") {
      const sourceDeadline = transcript.reason_code === "source_timeout_budget_exhausted";
      await terminal({ ...common, outcome: sourceDeadline ? "budget_limited" : transcript.outcome,
        reason_code: sourceDeadline ? "source_timeout_budget_exhausted" : transcript.reason_code,
        bytes: transcript.bytes ?? (transcript.outcome === "size_limited" ? transcriptBudget : null),
        duration_ms: transcript.duration_ms, raw_ref: null, evidence_status: "failed", occurred_at: now() });
      if (sourceDeadline) budget_limited++;
      continue;
    }
    if (bytes >= byteBudget || Date.now() - started >= timeBudget) {
      await terminal({ ...common, outcome: "budget_limited", reason_code: "source_budget_exhausted_before_program_page", bytes: transcript.bytes,
        duration_ms: transcript.duration_ms, raw_ref: null, evidence_status: "failed", occurred_at: now() });
      budget_limited++;
      continue;
    }
    const programPageBudget = Math.max(1, byteBudget - bytes);
    const programPage = await programPageFetcher(raw.url, {
      maxBytes: programPageBudget, timeoutMs: Math.max(1, timeBudget - (Date.now() - started)), beforeRequest: gateRequest,
    });
    const programPageBytes = programPage.bytes ?? (programPage.outcome === "size_limited" ? programPageBudget : 0);
    bytes += programPageBytes;
    if (programPage.outcome !== "success") {
      const sourceDeadline = programPage.reason_code === "source_timeout_budget_exhausted";
      await terminal({ ...common, outcome: sourceDeadline ? "budget_limited" : programPage.outcome,
        reason_code: sourceDeadline ? "source_timeout_budget_exhausted_before_program_page" : `program_page_${programPage.reason_code ?? programPage.outcome}`,
        bytes: transcript.bytes + programPageBytes, duration_ms: transcript.duration_ms + programPage.duration_ms,
        raw_ref: null, evidence_status: "failed", occurred_at: now() });
      if (sourceDeadline) budget_limited++;
      continue;
    }
    if (Date.now() - started >= timeBudget) {
      await terminal({ ...common, outcome: "budget_limited", reason_code: "source_timeout_budget_exhausted_after_program_page",
        bytes: transcript.bytes + programPage.bytes, duration_ms: transcript.duration_ms + programPage.duration_ms,
        raw_ref: null, evidence_status: "failed", occurred_at: now() });
      budget_limited++;
      continue;
    }
    try {
      const rawRef = await input.sink.archive({ source_id: input.source.id, episode: raw, program_page: programPage, transcript });
      await terminal({ ...common, outcome: "success", reason_code: decision.reason_code, bytes: transcript.bytes + programPage.bytes,
        duration_ms: transcript.duration_ms + programPage.duration_ms, raw_ref: rawRef, evidence_status: "verified", occurred_at: now() });
      succeeded++;
    } catch {
      // Archive failure means the transport bytes were observed but are not durable evidence. It
      // must complete this attempt with a structured failure while the outer collector remains P0-safe.
      await terminal({ ...common, outcome: "transient_error", reason_code: "shadow_archive_write_failed", bytes: transcript.bytes + programPage.bytes,
        duration_ms: transcript.duration_ms + programPage.duration_ms, raw_ref: null, evidence_status: "failed", occurred_at: now() });
    }
  }
  return { observed, requested, succeeded, budget_limited };
}
