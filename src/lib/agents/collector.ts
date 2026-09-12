/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；统一经 Job Runner 记一条 ingest Run
 *  （与 analyze/validate/report-gen 一致：单调时钟耗时 + 失败捕获 + 可重试）。 */
import { appendTranscriptAcquisitionFact, getContentByUrl, getPendingOrEligibleContentItem, insertContentItem, listTopics, nextTranscriptAcquisitionAttempt, setRunInserted, updateContentItem } from "../db/repos.js";
import { createHash } from "node:crypto";
import type { DB } from "../db/index.js";
import { markRawArchiveUnknown, planRawArchive, writePlannedRawArchive } from "../db/raw-archive.js";
import {
  assertSourceCollectClaim,
  bindSourceCollectRootRun,
  finishSourceCollectTrace,
  heartbeatSourceCollectTrace,
  type SourceCollectClaim,
} from "../db/provenance.js";
import { appendGenerationEvent, captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import { contentItemRef, contentItemRevisionSnapshot, sourceConfigRef, sourceConfigSnapshot } from "../db/provenance-revisions.js";
import { NOOP_P1_TELEMETRY_SINK, type P1TelemetrySink } from "../capabilities/p1-telemetry.js";
import { runJob } from "../runtime/jobs.js";
import type { Source, TranscriptAcquisitionFact, TranscriptAcquisitionOutcome } from "../types.js";
import { MIN_ARTICLE_CHARS, articleFetchEnabled, articleFetchKilled, fetchArticleBody } from "../sources/article.js";
import { fetchFromSource } from "../sources/index.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import { PODCAST_SCREENING_POLICY_VERSION, screenPodcastCandidate, type PodcastScreeningDecision } from "../sources/podcast-screening.js";
import { fetchTranscript, transcriptFetchEnabled } from "../sources/rss.js";
import type { RawItem, TranscriptFetchResult } from "../sources/types.js";
import { runPodcastTranscriptShadow } from "./podcast-shadow.js";
import { createPodcastShadowStore, transcriptShadowFetchEnabled } from "./podcast-shadow-store.js";

export interface CollectResult {
  runId: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/** 单次 collectSource 内全文抓取条数上限（绑首轮全量回填的串行规模）。env ARTICLE_FETCH_MAX_PER_RUN 可覆盖。
 *  超限条目本轮跳过、下轮再抓——抓前去重保证不重抓已采，逐轮把积压新文消化完。
 *  运行期读 env（非模块常量）：便于运行期调 + 单测可控。 */
function articleFetchMaxPerRun(): number {
  return Number(process.env.ARTICLE_FETCH_MAX_PER_RUN) || 25;
}

const PODCAST_TRANSCRIPT_ADAPTER_VERSION = "rss-podcast-transcript-v1";
const SUBSTACK_EPISODE_ADAPTER_VERSION = "substack-episode-hydration-v1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transcriptAdapterVersion(raw: RawItem): string {
  return raw.transcript_adapter === "substack_episode_hydration"
    ? SUBSTACK_EPISODE_ADAPTER_VERSION
    : PODCAST_TRANSCRIPT_ADAPTER_VERSION;
}

/** Archive the raw RSS fragment and the exact downloaded transcript together.  The fetch URL is
 * intentionally represented only by the query-free stable URL: expiring provider signatures are
 * transport details, not evidence consumers should replay. */
function transcriptEvidenceEnvelope(raw: RawItem, result: Extract<TranscriptFetchResult, { outcome: "success" }>, fetchedAt: string): string {
  return JSON.stringify({
    schema_version: "podcast-transcript-evidence-v1",
    adapter_version: transcriptAdapterVersion(raw),
    fetched_at: fetchedAt,
    episode: {
      url: raw.url,
      title: raw.title,
      published_at: raw.published_at,
      rss_item: raw.raw,
    },
    transcript: {
      stable_url: result.stable_url,
      content_type: result.content_type,
      bytes: result.bytes,
      duration_ms: result.duration_ms,
      speaker_attribution: result.speaker_attribution,
      raw_payload_sha256: sha256(result.raw_payload),
      cleaned_body_sha256: sha256(result.cleaned_body),
      raw_payload: result.raw_payload,
    },
    ...(result.program_page ? {
      program_page: {
        stable_url: result.program_page.stable_url,
        content_type: result.program_page.content_type,
        raw_payload_sha256: sha256(result.program_page.raw_payload),
        raw_payload: result.program_page.raw_payload,
      },
    } : {}),
  });
}

function transcriptFactId(sourceId: string, episodeUrl: string, candidateHash: string, attempt: number): string {
  return `taf_${sha256(`${sourceId}\n${episodeUrl}\n${candidateHash}\n${PODCAST_SCREENING_POLICY_VERSION}\n${attempt}`).slice(0, 40)}`;
}

function fallbackBodyKind(raw: RawItem): "article" | "show_notes" | null {
  return raw.body.trim() ? (raw.body_kind === "show_notes" ? "show_notes" : "article") : null;
}

/** Acquisition facts are observer-only. A broken diagnostic table or an idempotency conflict must
 * not turn a healthy RSS run into a failed one or alter report eligibility. */
function recordTranscriptFact(db: DB, fact: TranscriptAcquisitionFact): void {
  try {
    appendTranscriptAcquisitionFact(db, fact);
  } catch (error) {
    console.warn(`[transcript-acquisition] diagnostic fact not recorded: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

function makeTranscriptFact(input: {
  source: Source;
  adapterVersion: string;
  episodeUrl: string;
  screen: PodcastScreeningDecision;
  attempt: number;
  outcome: TranscriptAcquisitionOutcome;
  decision: PodcastScreeningDecision["decision"] | null;
  reasonCode: string | null;
  bytes?: number | null;
  durationMs?: number | null;
  fallback?: "article" | "show_notes" | null;
  contentItemId?: string | null;
  occurredAt: string;
}): TranscriptAcquisitionFact {
  return {
    id: transcriptFactId(input.source.id, input.episodeUrl, input.screen.candidate_hash, input.attempt),
    source_id: input.source.id, episode_url: input.episodeUrl, candidate_hash: input.screen.candidate_hash,
    policy_version: PODCAST_SCREENING_POLICY_VERSION, adapter_version: input.adapterVersion,
    attempt: input.attempt, decision: input.decision, outcome: input.outcome, reason_code: input.reasonCode,
    bytes: input.bytes ?? null, duration_ms: input.durationMs ?? null,
    fallback_body_kind: input.fallback ?? null, content_item_id: input.contentItemId ?? null,
    occurred_at: input.occurredAt,
  };
}

function sourceTranscriptItemBudget(source: Source): number {
  return source.transcript_max_items_per_run ?? 5;
}

function sourceTranscriptByteBudget(source: Source): number {
  return source.transcript_max_bytes_per_run ?? 5 * 1024 * 1024;
}

function sourceTranscriptTimeBudget(source: Source): number {
  return source.transcript_timeout_budget_ms ?? 30_000;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function collectSource(
  db: DB,
  source: Source,
  opts: { retryOf?: string | null; probe?: boolean; traceClaim?: SourceCollectClaim; telemetry?: P1TelemetrySink } = {},
): Promise<CollectResult> {
  const telemetry = opts.telemetry ?? NOOP_P1_TELEMETRY_SINK;
  const trace = opts.traceClaim;
  const sourceRef = trace ? sourceConfigRef(source) : null;
  const outputs: EntityRef[] = [];
  const unknownOutputs: EntityRef[] = [];
  let stage: "collect" | "normalize" = "collect";
  let fetched = 0;
  let traceRunId: string | null = null;
  let lostLease = false;
  const heartbeat = trace ? setInterval(() => {
    if (!heartbeatSourceCollectTrace(db, trace)) lostLease = true;
  }, 30_000) : null;
  const assertWrite = () => {
    if (!trace) return;
    if (lostLease) throw new Error("source_collect_fence_lost");
    assertSourceCollectClaim(db, trace);
  };

  try {
  const { run, result } = await runJob(
    db,
    {
      kind: "ingest",
      // 半开探测（3b-2）：target 打 probe 标记（evaluateCircuit 排除、不污染 consecutiveFails）+ silent（失败不刷告警）
      target: { source_id: source.id, ...(opts.probe ? { probe: true } : {}) },
      retryOf: opts.retryOf ?? null,
      silent: opts.probe,
      traceId: trace?.traceId,
      assertWrite: trace ? assertWrite : undefined,
    },
    async (ctx) => {
    traceRunId = ctx.runId;
    if (trace && sourceRef) {
      db.transaction(() => {
        assertWrite();
        bindSourceCollectRootRun(db, trace, ctx.runId);
        captureRevision(db, {
          entity_type: sourceRef.type,
          entity_key: entityKey(sourceRef),
          revision: sourceRef.revision,
          snapshot: sourceConfigSnapshot(source),
        });
        appendGenerationEvent(db, {
          trace_id: trace.traceId, run_id: ctx.runId, stage: "collect", event_type: "started",
          input_refs: [sourceRef],
          version_context: { source_config_revision: sourceRef.revision, collection_mode: source.fetch_mode ?? "feed" },
          context_completeness: "partial",
        });
      })();
    }
    const raws = await fetchFromSource(source);
    fetched = raws.length;
    if (trace && sourceRef) {
      assertWrite();
      appendGenerationEvent(db, {
        trace_id: trace.traceId, run_id: ctx.runId, stage: "collect", event_type: "completed",
        input_refs: [sourceRef], metrics: { fetched_count: raws.length },
        version_context: { source_config_revision: sourceRef.revision }, context_completeness: "partial",
      });
      appendGenerationEvent(db, {
        trace_id: trace.traceId, run_id: ctx.runId, stage: "normalize", event_type: "started",
        input_refs: [sourceRef], metrics: { fetched_count: raws.length },
        version_context: { source_config_revision: sourceRef.revision }, context_completeness: "partial",
      });
    }
    stage = "normalize";
    const rawArchiveProvenance = trace
      ? (() => {
        const event = db.prepare("SELECT id FROM generation_event WHERE trace_id=? AND stage='normalize' AND event_type='started'")
          .get(trace.traceId) as { id: string } | undefined;
        if (!event) throw new Error("raw_archive_normalize_event_missing");
        return { traceId: trace.traceId, eventId: event.id };
      })()
      : undefined;
    const fetchedAt = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let articleFetches = 0; // 本轮已抓全文条数（绑首轮全量回填的串行规模，剩余留下轮）
    const articleBudget = articleFetchMaxPerRun();
    const sourceTopics = listTopics(db, { enabledOnly: true }).filter((topic) => source.topic_ids.includes(topic.id));
    const transcriptMode = source.transcript_mode ?? "off";
    const transcriptRunStartedAt = Date.now();
    let transcriptFetches = 0;
    let transcriptBytes = 0;
    const lastTranscriptStartAtByOrigin = new Map<string, number>();
    for (const raw of raws) {
      // ADR-0008 决定③ 按源全文策略：决定是否按 URL 抓文章页补全正文。
      //  - full_text 源：正文空或过短(<MIN) → 抓；只受应急熔断 ARTICLE_FETCH=0 约束（不受 legacy 默认关约束）。
      //  - feed 源（默认）：仅全局 ARTICLE_FETCH 开 + 正文为空 → 抓（向后兼容安全客等切片2 前旧配置）。
      const bodyLen = raw.body.trim().length;
      const wantFullText =
        source.fetch_mode === "full_text"
          ? bodyLen < MIN_ARTICLE_CHARS && !articleFetchKilled()
          : bodyLen === 0 && articleFetchEnabled();
      if (wantFullText) {
        // **抓前去重 = 每 URL 一次性抓取**：已采过该 URL → 跳过、不重抓（只抓新文章，避免每轮 cron hammer 源）。
        // 取舍（ADR-0008 决定③ / 评审）：full_text 源若首轮文章页**临时**失败 → 回退落库短摘要后**永不重试**全文，
        // 该条永久停在短摘要。**有意为之**——替代方案「库里现有 <MIN 就重抓」会让**真正短的文章**
        // （fetchArticleBody 因抽取 <MIN 返 null）每轮无限重抓、hammer 源，更糟。临时失败罕见且短摘要非空（仍有内容），可接受。
        if (getContentByUrl(db, normalizeUrl(raw.url))) {
          skipped++;
          continue;
        }
        // 单轮全文抓取硬上限：串行抓 robots+page 各有超时，首轮一个 feed 全是新文时防阻塞 collectSource
        // 太久。超限的留到下一轮（抓前去重保证不重抓已采，新文逐轮被消化）。
        if (articleFetches >= articleBudget) {
          skipped++;
          continue;
        }
        articleFetches++;
        const body = await fetchArticleBody(raw.url, source.content_container);
        if (body) {
          raw.body = body;
          raw.body_kind = "article";
        }
        // 抓失败：full_text 短正文 → 保留原短摘要落库（回退）；空正文 → 落到下面判空跳过。
      }
      let item = rawToContentItem(raw, source, fetchedAt);
      let rawArchivePayload = raw.raw;
      const existing = getContentByUrl(db, item.url);
      const transcriptUrl = raw.transcript_url;
      const adapterVersion = transcriptAdapterVersion(raw);
      const screening = transcriptMode !== "off" && raw.is_podcast_episode
        ? screenPodcastCandidate(raw, sourceTopics)
        : null;
      if (screening) {
        recordTranscriptFact(db, makeTranscriptFact({
          source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: 0, outcome: "decision",
          decision: screening.decision, reasonCode: screening.reason_code, occurredAt: fetchedAt,
        }));
      }
      const terminalAttempt = screening
        ? nextTranscriptAcquisitionAttempt(db, {
          source_id: source.id, episode_url: item.url, candidate_hash: screening.candidate_hash,
          policy_version: PODCAST_SCREENING_POLICY_VERSION,
        })
        : 0;
      // Podcast evidence is immutable per episode URL.  A fresh feed pass may observe the URL,
      // but must not silently replace a prior show-notes/transcript evidence version.
      if (screening && existing) {
        recordTranscriptFact(db, makeTranscriptFact({
          source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "existing_url",
          decision: screening.decision, reasonCode: "existing_url", fallback: fallbackBodyKind(raw),
          contentItemId: existing.id, occurredAt: fetchedAt,
        }));
        skipped++;
        continue;
      }
      // B族·不降级（6a）：已是 transcript 的 item 不被 show_notes/article 覆盖——防转写被降级 + 旧引用失效（Major6）。
      if (existing?.body_kind === "transcript" && item.body_kind !== "transcript") {
        skipped++;
        continue;
      }
      let successfulTranscript: Extract<TranscriptFetchResult, { outcome: "success" }> | null = null;
      // The global switch can only further restrict an explicit per-source `enabled` policy.
      // `observe` records the same deterministic decision but never requests a production body.
      const shouldRequest = screening && transcriptMode === "enabled" && transcriptUrl && transcriptFetchEnabled()
        && (source.transcript_strategy === "all" || screening.decision !== "hard_negative");
      if (screening && !transcriptUrl) {
        recordTranscriptFact(db, makeTranscriptFact({
          source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "no_transcript",
          decision: screening.decision, reasonCode: "rss_transcript_url_absent", fallback: fallbackBodyKind(raw), occurredAt: fetchedAt,
        }));
      } else if (screening && transcriptMode === "enabled" && transcriptUrl && transcriptFetchEnabled()
        && source.transcript_strategy === "relevant_only" && screening.decision === "hard_negative") {
        // This is an intentional policy decision, not a resource exhaustion. Keep it separate
        // from budget_limited so the heldout recall review sees the real rejection rate.
        recordTranscriptFact(db, makeTranscriptFact({
          source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "policy_skipped",
          decision: screening.decision, reasonCode: "hard_negative_by_strategy", fallback: fallbackBodyKind(raw), occurredAt: fetchedAt,
        }));
      } else if (shouldRequest) {
        const elapsedBefore = Date.now() - transcriptRunStartedAt;
        const itemBudget = sourceTranscriptItemBudget(source);
        const byteBudget = sourceTranscriptByteBudget(source);
        const timeBudget = sourceTranscriptTimeBudget(source);
        if (transcriptFetches >= itemBudget || transcriptBytes >= byteBudget || elapsedBefore >= timeBudget) {
          recordTranscriptFact(db, makeTranscriptFact({
            source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "budget_limited",
            decision: screening.decision, reasonCode: transcriptFetches >= itemBudget ? "item_budget" : transcriptBytes >= byteBudget ? "byte_budget" : "time_budget",
            fallback: fallbackBodyKind(raw), occurredAt: fetchedAt,
          }));
        } else {
          let origin = "invalid";
          try { origin = new URL(transcriptUrl).origin; } catch { /* fetchTranscript records the structured failure */ }
          const qps = Math.max(source.transcript_host_qps ?? 0.5, 0.01);
          const earliestStart = (lastTranscriptStartAtByOrigin.get(origin) ?? 0) + Math.ceil(1_000 / qps);
          if (earliestStart > Date.now()) await wait(earliestStart - Date.now());
          const elapsedAfterThrottle = Date.now() - transcriptRunStartedAt;
          if (elapsedAfterThrottle >= timeBudget) {
            recordTranscriptFact(db, makeTranscriptFact({
              source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "budget_limited",
              decision: screening.decision, reasonCode: "time_budget", fallback: fallbackBodyKind(raw), occurredAt: fetchedAt,
            }));
          } else {
            transcriptFetches++;
            lastTranscriptStartAtByOrigin.set(origin, Date.now());
            const transcript = await fetchTranscript(transcriptUrl, {
              maxBytes: Math.max(1, byteBudget - transcriptBytes),
              timeoutMs: Math.max(1, timeBudget - elapsedAfterThrottle),
              adapter: raw.transcript_adapter ?? "direct",
            });
            transcriptBytes += transcript.bytes ?? 0;
            if (transcript.outcome === "success") {
              item = rawToContentItem({ ...raw, body: transcript.cleaned_body, body_kind: "transcript" }, source, fetchedAt);
              rawArchivePayload = transcriptEvidenceEnvelope(raw, transcript, fetchedAt);
              successfulTranscript = transcript;
            } else {
              recordTranscriptFact(db, makeTranscriptFact({
                source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: transcript.outcome,
                decision: screening.decision, reasonCode: transcript.reason_code, bytes: transcript.bytes,
                durationMs: transcript.duration_ms, fallback: fallbackBodyKind(raw), occurredAt: fetchedAt,
              }));
            }
          }
        }
      }
      if (!item.body.trim()) {
        skipped++; // RSS 没有 notes 且没有可用 transcript：只留下 acquisition facts，不产出空 ContentItem。
        continue;
      }
      if (existing && existing.content_hash === item.content_hash) {
        skipped++; // 同 URL + 同指纹 = 完全重复（AC2 ①）
        continue;
      }
      let rawArchive: ReturnType<typeof planRawArchive> | null = null;
      let persistedItem: typeof item | null = null;
      let persistedOutputRef: EntityRef | null = null;
      // Content 的业务 upsert、实际持久化行的 snapshot 与 provenance revision 在同一 SQLite
      // 事务中提交：source_id / published_at / topic_ids 等保留字段绝不从本轮候选对象臆造。
      db.transaction(() => {
        assertWrite();
        if (existing) updateContentItem(db, item); // 同 URL 内容更新 → 原地更新、id 不变（AC2 ②）
        else insertContentItem(db, item); // 新 URL（AC2 ③）
        // The ContentItem change and the raw archive intent are one SQLite
        // transaction.  The external file is written only after this commits.
        rawArchive = planRawArchive(db, { contentId: existing?.id ?? item.id, raw: rawArchivePayload, ...rawArchiveProvenance });
        item.raw_ref = rawArchive.rawRef;
        persistedItem = getPendingOrEligibleContentItem(db, existing?.id ?? item.id);
        if (!persistedItem) throw new Error("content_item_write_not_found");
        persistedOutputRef = trace ? contentItemRef(persistedItem, "output") : null;
        if (persistedOutputRef) {
          captureRevision(db, {
            entity_type: persistedOutputRef.type,
            entity_key: entityKey(persistedOutputRef),
            revision: persistedOutputRef.revision,
            snapshot: contentItemRevisionSnapshot(persistedItem),
          });
        }
      })();
      if (!persistedItem) throw new Error("content_item_write_not_found");
      if (!rawArchive) throw new Error("raw_archive_plan_not_created");
      const rawArchiveEffectId = (rawArchive as ReturnType<typeof planRawArchive>).effectId;
      try {
        writePlannedRawArchive(db, rawArchive, rawArchivePayload);
      } catch (error) {
        // Its DB intent/revision committed but the archive did not verify.
        // Keep that exact unknown revision visible in the failure event only.
        markRawArchiveUnknown(db, rawArchiveEffectId, error instanceof Error ? error.message : "raw_archive_write_failed");
        if (persistedOutputRef) unknownOutputs.push(persistedOutputRef);
        throw error;
      }
      if (persistedOutputRef) outputs.push(persistedOutputRef);
      if (screening && successfulTranscript) {
        recordTranscriptFact(db, makeTranscriptFact({
          source, adapterVersion, episodeUrl: item.url, screen: screening, attempt: terminalAttempt, outcome: "success",
          decision: screening.decision, reasonCode: null, bytes: successfulTranscript.bytes,
          durationMs: successfulTranscript.duration_ms, contentItemId: item.id, occurredAt: fetchedAt,
        }));
      }
      // Optional P1 telemetry observes committed output only; it never feeds
      // report selection or citation validation.
      telemetry.recordCollector(db, { run_id: ctx.runId, item: persistedItem });
      if (existing) updated++;
      else inserted++;
    }
    // Observe samples have a separate explicit global gate and an entirely separate SQLite/archive.
    // They are intentionally best-effort: failure must never make the RSS source unhealthy or
    // alter the already-committed ContentItem path.
    if (!opts.probe && transcriptMode === "observe" && transcriptShadowFetchEnabled()) {
      try {
        const shadow = createPodcastShadowStore();
        try {
          await runPodcastTranscriptShadow({ source, raws, topics: sourceTopics, sink: shadow.sink });
        } finally {
          shadow.close();
        }
      } catch (error) {
        console.warn(`[transcript-shadow] source=${source.id} sample failed: ${error instanceof Error ? error.message : "unknown_error"}`);
      }
    }
    if (!opts.probe) {
      assertWrite();
      setRunInserted(db, ctx.runId, inserted); // 探测 run 不参与零产出统计
    }
    if (trace && sourceRef) {
      assertWrite();
      appendGenerationEvent(db, {
        trace_id: trace.traceId, run_id: ctx.runId, stage: "normalize", event_type: "completed",
        input_refs: [sourceRef], output_refs: outputs,
        metrics: { fetched_count: raws.length, inserted_count: inserted, updated_count: updated, skipped_count: skipped },
        version_context: { source_config_revision: sourceRef.revision }, context_completeness: "partial",
      });
    }
      return { fetched: raws.length, inserted, updated, skipped };
    },
  );
  if (trace && !finishSourceCollectTrace(db, trace, {
    summary: { fetched_count: result.fetched, inserted_count: result.inserted, updated_count: result.updated, skipped_count: result.skipped },
  })) throw new Error("source_collect_finish_fence_lost");
  return { runId: run.id, ...result };
  } catch (error) {
    if (trace && !lostLease) {
      try {
        assertWrite();
        // Finalized rows are committed.  A failed archive is durable but
        // not-reader-eligible, so its exact revision/count is unknown.
        const rolledBack = outputs.length === 0 && unknownOutputs.length === 0 ? 1 : 0;
        appendGenerationEvent(db, {
          trace_id: trace.traceId, run_id: traceRunId, stage, event_type: "failed",
          input_refs: sourceRef ? [sourceRef] : [], output_refs: [...outputs, ...unknownOutputs],
          reason_code: error instanceof Error && error.message === "provenance_revision_conflict"
            ? "provenance_revision_conflict" : `${stage}_failed`,
          metrics: {
            fetched_count: fetched,
            committed_output_ref_count: outputs.length,
            rolled_back_output_ref_count: rolledBack,
            unknown_output_ref_count: unknownOutputs.length,
          },
          version_context: sourceRef ? { source_config_revision: sourceRef.revision } : {},
          context_completeness: "partial",
          error: { reason_code: `${stage}_failed`, retryable: true },
        });
        finishSourceCollectTrace(db, trace, {
          summary: {
            failed_stage: stage,
            committed_output_ref_count: outputs.length,
            rolled_back_output_ref_count: rolledBack,
            unknown_output_ref_count: unknownOutputs.length,
          },
        });
      } catch {
        // 已失去 lease 时禁止旧 owner 再写失败事件；原始采集错误仍交给调用方和 Run 处理。
      }
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
