/** Isolated shadow sampler for podcast transcripts.
 *
 * It shares the source adapter, deterministic screen and structured fetch result with collection,
 * but has no DB import and no route into ContentItem/Report.  The caller must provide a sink backed
 * by a separately provisioned shadow database/archive; this makes production publication an
 * unrepresentable side effect of a shadow sample.
 */
import type { Source, Topic } from "../types.js";
import { PODCAST_SCREENING_POLICY_VERSION, screenPodcastCandidate } from "../sources/podcast-screening.js";
import { fetchTranscript } from "../sources/rss.js";
import type { RawItem, TranscriptFetchResult } from "../sources/types.js";

export interface PodcastShadowObservation {
  source_id: string;
  episode_url: string;
  candidate_hash: string;
  policy_version: string;
  decision: "fetch" | "unknown" | "hard_negative";
  reason_code: string;
  outcome: "no_transcript" | "budget_limited" | "policy_skipped" | TranscriptFetchResult["outcome"];
  bytes: number | null;
  duration_ms: number | null;
  occurred_at: string;
}

export interface PodcastShadowSink {
  /** Persists only to the caller's isolated shadow store. */
  append(observation: PodcastShadowObservation): void | Promise<void>;
  /** Stores a successful raw payload only in the shadow archive. */
  archive(input: { source_id: string; episode_url: string; raw_rss_item: string; transcript: Extract<TranscriptFetchResult, { outcome: "success" }> }): void | Promise<void>;
}

export interface ShadowSampleResult { observed: number; requested: number; succeeded: number; budget_limited: number }

/** Sample `observe` candidates with the same decisions and resource limits as a canary, without
 * creating production ContentItems.  `fetcher` exists solely for deterministic tests. */
export async function runPodcastTranscriptShadow(input: {
  source: Source;
  raws: RawItem[];
  topics: Pick<Topic, "id" | "keywords">[];
  sink: PodcastShadowSink;
  now?: () => string;
  fetcher?: typeof fetchTranscript;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ShadowSampleResult> {
  if ((input.source.transcript_mode ?? "off") !== "observe") throw new Error("podcast_shadow_requires_observe_mode");
  const fetcher = input.fetcher ?? fetchTranscript;
  const now = input.now ?? (() => new Date().toISOString());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const itemBudget = input.source.transcript_max_items_per_run ?? 5;
  const byteBudget = input.source.transcript_max_bytes_per_run ?? 5 * 1024 * 1024;
  const timeBudget = input.source.transcript_timeout_budget_ms ?? 30_000;
  const started = Date.now();
  let requested = 0;
  let succeeded = 0;
  let bytes = 0;
  let observed = 0;
  let budget_limited = 0;
  const lastTranscriptStartAtByOrigin = new Map<string, number>();
  for (const raw of input.raws) {
    if (!raw.is_podcast_episode) continue;
    const decision = screenPodcastCandidate(raw, input.topics);
    const base = {
      source_id: input.source.id, episode_url: raw.url, candidate_hash: decision.candidate_hash,
      policy_version: PODCAST_SCREENING_POLICY_VERSION, decision: decision.decision,
      reason_code: decision.reason_code, occurred_at: now(),
    };
    if (!raw.transcript_url) {
      await input.sink.append({ ...base, outcome: "no_transcript", bytes: null, duration_ms: null });
      observed++;
      continue;
    }
    const shouldRequest = input.source.transcript_strategy === "all" || decision.decision !== "hard_negative";
    if (!shouldRequest) {
      await input.sink.append({ ...base, outcome: "policy_skipped", reason_code: "hard_negative_by_strategy", bytes: null, duration_ms: null });
      observed++;
      continue;
    }
    if (requested >= itemBudget || bytes >= byteBudget || Date.now() - started >= timeBudget) {
      await input.sink.append({ ...base, outcome: "budget_limited", bytes: null, duration_ms: null });
      observed++;
      budget_limited++;
      continue;
    }
    let origin = "invalid";
    try { origin = new URL(raw.transcript_url).origin; } catch { /* fetcher records malformed URLs */ }
    const qps = Math.max(input.source.transcript_host_qps ?? 0.5, 0.01);
    const earliestStart = (lastTranscriptStartAtByOrigin.get(origin) ?? 0) + Math.ceil(1_000 / qps);
    if (earliestStart > Date.now()) await sleep(earliestStart - Date.now());
    if (Date.now() - started >= timeBudget) {
      await input.sink.append({ ...base, outcome: "budget_limited", bytes: null, duration_ms: null });
      observed++;
      budget_limited++;
      continue;
    }
    requested++;
    lastTranscriptStartAtByOrigin.set(origin, Date.now());
    const result = await fetcher(raw.transcript_url, {
      maxBytes: Math.max(1, byteBudget - bytes), timeoutMs: Math.max(1, timeBudget - (Date.now() - started)),
      adapter: raw.transcript_adapter ?? "direct",
    });
    bytes += result.bytes ?? 0;
    if (result.outcome === "success") {
      await input.sink.archive({ source_id: input.source.id, episode_url: raw.url, raw_rss_item: raw.raw, transcript: result });
      succeeded++;
    }
    await input.sink.append({
      ...base, outcome: result.outcome, bytes: result.bytes, duration_ms: result.duration_ms,
      reason_code: result.outcome === "success" ? decision.reason_code : result.reason_code ?? decision.reason_code,
    });
    observed++;
  }
  return { observed, requested, succeeded, budget_limited };
}
