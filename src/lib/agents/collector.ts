/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；统一经 Job Runner 记一条 ingest Run
 *  （与 analyze/validate/report-gen 一致：单调时钟耗时 + 失败捕获 + 可重试）。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContentByUrl, insertContentItem, setRunInserted, updateContentItem } from "../db/repos.js";
import type { DB } from "../db/index.js";
import {
  assertSourceCollectClaim,
  bindSourceCollectRootRun,
  finishSourceCollectTrace,
  heartbeatSourceCollectTrace,
  type SourceCollectClaim,
} from "../db/provenance.js";
import { appendGenerationEvent, captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import { contentItemRef, contentItemRevisionSnapshot, sourceConfigRef, sourceConfigSnapshot } from "../db/provenance-revisions.js";
import { runJob } from "../runtime/jobs.js";
import type { Source } from "../types.js";
import { MIN_ARTICLE_CHARS, articleFetchEnabled, articleFetchKilled, fetchArticleBody } from "../sources/article.js";
import { fetchFromSource } from "../sources/index.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import { fetchTranscript, transcriptFetchEnabled } from "../sources/rss.js";

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

/** 原文存档到 FS（architecture：raw_ref 句柄，MVP 不清理），返回相对路径句柄。 */
function archiveRaw(id: string, raw: string): string {
  const dir = join(process.env.DATA_DIR ?? ".data", "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.txt`);
  writeFileSync(path, raw);
  return path;
}

export async function collectSource(
  db: DB,
  source: Source,
  opts: { retryOf?: string | null; probe?: boolean; traceClaim?: SourceCollectClaim } = {},
): Promise<CollectResult> {
  const trace = opts.traceClaim;
  const sourceRef = trace ? sourceConfigRef(source) : null;
  const outputs: EntityRef[] = [];
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
    const fetchedAt = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let articleFetches = 0; // 本轮已抓全文条数（绑首轮全量回填的串行规模，剩余留下轮）
    const articleBudget = articleFetchMaxPerRun();
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
      if (!raw.body.trim()) {
        skipped++; // 仍空（feed 模式空正文 / 全文抓取失败且原本就空）→ 不产出条目
        continue;
      }
      let item = rawToContentItem(raw, source, fetchedAt);
      const existing = getContentByUrl(db, item.url);
      // B族·不降级（6a）：已是 transcript 的 item 不被 show_notes/article 覆盖——防转写被降级 + 旧引用失效（Major6）。
      if (existing?.body_kind === "transcript" && item.body_kind !== "transcript") {
        skipped++;
        continue;
      }
      // B族·只抓新（6a）：库里没有的 url + 有 transcript_url + 开关开 → 抓转写、重建为 transcript item。
      // 「只对新 url 抓」既避免每轮全抓 50 集，又确保已入库 item 永不被原地从 show_notes 改成 transcript（根除 Major6）。
      if (!existing && raw.transcript_url && transcriptFetchEnabled()) {
        const transcript = await fetchTranscript(raw.transcript_url);
        if (transcript) item = rawToContentItem({ ...raw, body: transcript, body_kind: "transcript" }, source, fetchedAt);
      }
      if (existing && existing.content_hash === item.content_hash) {
        skipped++; // 同 URL + 同指纹 = 完全重复（AC2 ①）
        continue;
      }
      item.raw_ref = archiveRaw(item.id, raw.raw);
      const outputRef = trace ? contentItemRef(item, "output") : null;
      // Content 的新不可变 snapshot 与业务 upsert 同一 SQLite 事务：任一失败都不会留下
      // “内容已更新、但 trace 指向不存在 revision”的半事实。raw_ref 依规不进入 P0 snapshot / ref。
      db.transaction(() => {
        assertWrite();
        if (outputRef) {
          captureRevision(db, {
            entity_type: outputRef.type,
            entity_key: entityKey(outputRef),
            revision: outputRef.revision,
            snapshot: contentItemRevisionSnapshot(item),
          });
        }
        if (existing) updateContentItem(db, item); // 同 URL 内容更新 → 原地更新、id 不变（AC2 ②）
        else insertContentItem(db, item); // 新 URL（AC2 ③）
      })();
      if (outputRef) outputs.push(outputRef);
      if (existing) updated++;
      else inserted++;
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
    status: "done",
    summary: { fetched_count: result.fetched, inserted_count: result.inserted, updated_count: result.updated, skipped_count: result.skipped },
  })) throw new Error("source_collect_finish_fence_lost");
  return { runId: run.id, ...result };
  } catch (error) {
    if (trace && !lostLease) {
      try {
        assertWrite();
        // 逐条 upsert 已各自原子提交：此前成功的 Content revision 可明确列为 committed；
        // 当前事务的失败会回滚，未知数量显式为 0，避免把不确定性藏进错误文本。
        const outcome = outputs.length > 0 ? "committed" : "rolled_back";
        appendGenerationEvent(db, {
          trace_id: trace.traceId, run_id: traceRunId, stage, event_type: "failed",
          input_refs: sourceRef ? [sourceRef] : [], output_refs: outputs,
          reason_code: error instanceof Error && error.message === "provenance_revision_conflict"
            ? "provenance_revision_conflict" : `${stage}_failed`,
          metrics: {
            fetched_count: fetched,
            committed_output_ref_count: outputs.length,
            rolled_back_output_ref_count: outcome === "rolled_back" ? 1 : 0,
            unknown_output_ref_count: 0,
          },
          version_context: sourceRef ? { source_config_revision: sourceRef.revision } : {},
          context_completeness: "partial",
          error: { reason_code: `${stage}_failed`, retryable: true },
        });
        finishSourceCollectTrace(db, trace, {
          status: "failed",
          summary: {
            failed_stage: stage,
            committed_output_ref_count: outputs.length,
            rolled_back_output_ref_count: outcome === "rolled_back" ? 1 : 0,
            unknown_output_ref_count: 0,
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
