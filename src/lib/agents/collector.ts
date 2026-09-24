/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；统一经 Job Runner 记一条 ingest Run
 *  （与 analyze/validate/report-gen 一致：单调时钟耗时 + 失败捕获 + 可重试）。 */
import { appendTranscriptAcquisitionFact, getContentByUrl, getPendingOrEligibleContentItem, insertContentItem, listTopics, setRunInserted, transcriptAcquisitionEventKey, updateContentItem } from "../db/repos.js";
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
import type { Source, TranscriptAcquisitionFact } from "../types.js";
import { articleFetchEnabled, articleFetchKilled, fetchArticle } from "../sources/article.js";
import { fetchFromSource } from "../sources/index.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import { screenPodcastCandidate } from "../sources/podcast-screening.js";
import { stableEvidenceUrl } from "../sources/podcast-evidence.js";
import { transcriptFetchEnabled, transcriptShadowFetchEnabled } from "../sources/rss.js";
import type { RawItem } from "../sources/types.js";
import { runPodcastTranscriptShadow } from "./podcast-shadow.js";
import { createPodcastShadowStore } from "./podcast-shadow-store.js";

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

type RawBodyOrigin = "feed" | "article_page" | "transcript";

/** The raw-archive effect owns filesystem writes.  Its payload is an envelope so the body that
 * was normalized into ContentItem is bound to the feed item and, where applicable, page HTML. */
function rawArchiveEnvelope(
  raw: RawItem,
  item: { content_hash: string },
  bodyOrigin: RawBodyOrigin,
  articleHtml: string | null,
): string {
  return `${JSON.stringify({
    schema_version: "content-raw-archive-v1",
    source_body_origin: bodyOrigin,
    source_body: raw.body,
    source_body_kind: raw.body_kind ?? "article",
    source_item_raw: raw.raw,
    ...(articleHtml == null ? {} : { article_html: articleHtml }),
    structured_body_sha256: item.content_hash,
  })}\n`;
}

const PODCAST_TRANSCRIPT_ADAPTER_VERSION = "rss-podcast-transcript-v1";

/** Acquisition facts are diagnostic metadata. A failed fact write must not change the normal RSS
 * collection, reader eligibility, or report path. */
function recordTranscriptFact(db: DB, fact: Omit<TranscriptAcquisitionFact, "event_key">): void {
  try {
    appendTranscriptAcquisitionFact(db, { ...fact, event_key: transcriptAcquisitionEventKey(fact) });
  } catch (error) {
    console.warn(`[transcript-acquisition] diagnostic fact not recorded: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

function recordPodcastMetadataFacts(input: {
  db: DB;
  source: Source;
  raw: RawItem;
  runId: string;
  topics: ReturnType<typeof listTopics>;
  occurredAt: string;
}): void {
  const mode = input.source.transcript_mode ?? "off";
  const policyVersion = input.source.transcript_policy_version?.trim();
  if (mode === "off" || !policyVersion || !input.raw.is_podcast_episode) return;

  const decision = screenPodcastCandidate(input.raw, input.topics);
  const fallbackBodyKind: TranscriptAcquisitionFact["fallback_body_kind"] = input.raw.body.trim()
    ? (input.raw.body_kind === "show_notes" ? "show_notes" : "article")
    : null;
  const common = {
    source_id: input.source.id,
    // Facts are append-only diagnostics, so their episode identity must never retain signed
    // transport query parameters or URL userinfo.
    canonical_episode_url: stableEvidenceUrl(input.raw.url),
    candidate_hash: decision.candidate_hash,
    transcript_policy_version: policyVersion,
    mode,
    strategy: input.source.transcript_strategy ?? "relevant_only",
    execution_scope: "production_metadata" as const,
    adapter_version: `${PODCAST_TRANSCRIPT_ADAPTER_VERSION}+${decision.policy_version}`,
    decision: decision.decision,
    bytes: null,
    duration_ms: null,
    fallback_body_kind: fallbackBodyKind,
    content_item_id: null,
    raw_ref: null,
    evidence_status: "not_applicable" as const,
    run_id: input.runId,
    occurred_at: input.occurredAt,
  };
  recordTranscriptFact(input.db, {
    ...common, stage: "candidate", attempt: 0, outcome: "not_attempted", reason_code: "podcast_metadata",
  });
  recordTranscriptFact(input.db, {
    ...common, stage: "decision", attempt: 0, outcome: "decision", reason_code: decision.reason_code,
  });
}

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
    const transcriptMode = source.transcript_mode ?? "off";
    const sourceTopics = transcriptMode === "off"
      ? []
      : listTopics(db, { enabledOnly: true }).filter((topic) => source.topic_ids.includes(topic.id));
    for (const raw of raws) {
      // full_text only accepts a page-derived body for a new URL. In particular, an emergency fetch
      // kill must not overwrite an already-complete article with the feed summary.
      if (!raw.is_podcast_episode && source.fetch_mode === "full_text" && getContentByUrl(db, normalizeUrl(raw.url))) {
        skipped++;
        continue;
      }
      // full_text 是完整性承诺，而不是 RSS 摘要长度的启发式：每个新 URL 都必须抓文章页。
      // feed 源（默认）仍只在正文为空且 legacy 开关开启时补抓，保持历史行为。
      const bodyLen = raw.body.trim().length;
      const wantFullText = !raw.is_podcast_episode && (
        source.fetch_mode === "full_text"
          ? !articleFetchKilled()
          : bodyLen === 0 && articleFetchEnabled());
      let fullTextComplete = source.fetch_mode !== "full_text" || raw.is_podcast_episode;
      let bodyOrigin: RawBodyOrigin = raw.body_kind === "transcript" ? "transcript" : "feed";
      let articleHtml: string | null = null;
      if (wantFullText) {
        // 单轮全文抓取硬上限：串行抓 robots+page 各有超时，首轮一个 feed 全是新文时防阻塞 collectSource
        // 太久。超限的留到下一轮（抓前去重保证不重抓已采，新文逐轮被消化）。
        if (articleFetches >= articleBudget) {
          skipped++;
          continue;
        }
        articleFetches++;
        const article = await fetchArticle(raw.url, source.content_container);
        if (article) {
          raw.body = article.body_html;
          raw.body_kind = "article";
          articleHtml = article.raw_html;
          bodyOrigin = "article_page";
          fullTextComplete = true;
        }
        // full_text 抓失败：保留 feed 摘要时必须标 partial；空摘要继续在下方丢弃。
      }
      // Facts remain visible even when a podcast entry has no show notes and therefore does not
      // become a ContentItem. They are diagnostics only and cannot influence the RSS run.
      recordPodcastMetadataFacts({ db, source, raw, runId: ctx.runId, topics: sourceTopics, occurredAt: fetchedAt });
      if (!raw.body.trim()) {
        skipped++; // 仍空（feed 模式空正文 / 全文抓取失败且原本就空）→ 不产出条目
        continue;
      }
      const forcePartial = source.fetch_mode === "full_text" && !fullTextComplete;
      let item = rawToContentItem(raw, source, fetchedAt, { forcePartial });
      const existing = getContentByUrl(db, item.url);
      // A URL's original evidence form is immutable. A later feed observation must not mutate
      // article ↔ show-notes ↔ transcript and invalidate historical citations. Transcript
      // acquisition is deliberately not performed by this production collector until the
      // policy, screening, quota, and evidence gates are wired in a later slice.
      if (existing && existing.body_kind !== item.body_kind) {
        skipped++;
        continue;
      }
      if (existing && existing.content_hash === item.content_hash) {
        skipped++; // 同 URL + 同指纹 = 完全重复（AC2 ①）
        continue;
      }
      let rawArchive: ReturnType<typeof planRawArchive> | null = null;
      const rawArchivePayload = rawArchiveEnvelope(raw, item, bodyOrigin, articleHtml);
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
      // Optional P1 telemetry observes committed output only; it never feeds
      // report selection or citation validation.
      telemetry.recordCollector(db, { run_id: ctx.runId, item: persistedItem });
      if (existing) updated++;
      else inserted++;
    }
    // Observe samples use a separate SQLite/archive. Any shadow error is diagnostic; it can
    // never fail or mutate the production RSS collection.
    if (!opts.probe && transcriptMode === "observe" && transcriptFetchEnabled() && transcriptShadowFetchEnabled()) {
      try {
        const shadow = createPodcastShadowStore(source);
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
