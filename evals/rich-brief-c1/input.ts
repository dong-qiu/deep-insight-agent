import { z } from "zod";
import { ANALYZE_BODY_CHARS, ANALYZE_BATCH_CHARS, SELECT_WINDOW_CHARS, chunkByChars, selectForAnalyze, truncateForAnalyze, analyzeChunkInputSha256 } from "../../src/lib/agents/analyzer.js";
import { canonicalHash } from "../../src/lib/db/provenance-facts.js";
import type { ContentItem, Topic } from "../../src/lib/types.js";
import type { HistoricalEvent } from "../../src/lib/agents/analyzer.js";
import type { PreparedData } from "../rich-brief-stage0/data.js";
import { digest, nonempty, resourceSchema, sha, utc, type Resource } from "./common.js";

const content = z.object({ id: nonempty, source_id: nonempty, url: nonempty, title: z.string(), author: z.string().nullable(), published_at: z.string().nullable(), fetched_at: utc,
  language: z.enum(["zh", "en", "mixed"]), topic_ids: z.array(nonempty), tags: z.array(z.string()), body: z.string(), body_kind: z.enum(["article", "show_notes", "transcript"]),
  raw_ref: nonempty, content_hash: digest, fetch_status: z.enum(["ok", "partial"]), speaker_map_status: z.enum(["not_applicable", "unknown", "verified"]).optional(), speaker_map_ref: z.string().nullable().optional() }).strict();
const topic = z.object({ id: nonempty, name: nonempty, keywords: z.array(nonempty), language: z.enum(["zh", "en", "mixed"]), brief_schedule: z.enum(["daily", "weekly"]), enabled: z.boolean(),
  archetype: z.enum(["deep_vertical", "horizontal_pulse"]).optional(), facets: z.array(z.string()).optional() }).strict();
const historyEvent = z.object({ event_id: nonempty, statement: nonempty, statement_fingerprint: z.string().optional(), type: z.enum(["aggregation", "trend"]).optional(), content_item_ids: z.array(nonempty).optional(), date: z.string().optional() }).strict();
export interface ReplayAttempt {
  attempt_id: string; topic: Topic; items: ContentItem[]; time_window: { start: string; end: string };
  history: { status: "cutoff_safe_lower_bound" | "exact_runtime_proven"; events: HistoricalEvent[]; excluded_after_cutoff: number; unproven_publication_occurrences: number; reason: string };
  snapshot_resources: Resource[];
}
export const machineSchema = z.object({ schema_version: z.literal("rich-brief-c1-machine-input-v1"), execution_scope: z.literal("shadow"),
  upstream_input_sha256: digest, gold_visibility: z.literal("absent"), production_enabled: z.literal(false),
  registered_runs: z.array(z.object({ run_id: nonempty, scheduled_at: utc, status: z.enum(["observed", "unknown"]), attempt_ids: z.array(nonempty) }).strict()),
  attempts: z.array(z.object({ attempt_id: nonempty, run_id: nonempty, original_kind: z.enum(["batch", "trace_without_batch"]), original_total_candidates: z.union([z.number().int().nonnegative(), z.literal("unknown")]),
    topic, time_window: z.object({ start: utc, end: utc }).strict(), history_cutoff: utc,
    history: z.object({ status: z.enum(["cutoff_safe_lower_bound", "exact_runtime_proven"]), events: z.array(historyEvent), excluded_after_cutoff: z.number().int().nonnegative(), unproven_publication_occurrences: z.number().int().nonnegative(), reason: nonempty }).strict(),
    items: z.array(content), occurrences: z.array(z.object({ occurrence_id: nonempty, content_item_id: nonempty, revision: nonempty, body_sha256: digest }).strict()),
    diagnostic_visibility: z.object({ status: z.literal("current_code_profile_not_historical_certification"), body_budget_chars: z.number().int().positive(), batch_budget_chars: z.number().int().positive(), transcript_window_chars: z.number().int().positive(),
      items: z.array(z.object({ content_item_id: nonempty, strategy: z.enum(["prefix", "topic_windows"]), visible_body: z.string(), visible_sha256: digest, original_utf16_chars: z.number().int().nonnegative(), visible_utf16_chars: z.number().int().nonnegative(), omitted: z.boolean() }).strict()),
      chunk_input_hashes: z.array(digest) }).strict(), snapshot_resources: z.array(resourceSchema),
  }).strict()),
  resources: z.array(resourceSchema),
}).strict();
export type MachineInput = z.infer<typeof machineSchema>;
export function assertMachineMatchesStage0(machine: MachineInput, data: PreparedData): void {
  if (canonicalHash(machine.registered_runs) !== canonicalHash(data.runs) || machine.attempts.length !== data.attempts.length) throw new Error("machine_registered_denominator_mismatch");
  for (const original of data.attempts) {
    const attempt = machine.attempts.find((a) => a.attempt_id === original.attempt_id);
    if (!attempt || attempt.run_id !== original.run_id || attempt.original_kind !== original.kind || attempt.original_total_candidates !== original.total_candidates) throw new Error("machine_original_attempt_mismatch");
    const originalSources = data.occurrences.filter((o) => o.attempt_id === original.attempt_id);
    if (attempt.occurrences.length !== originalSources.length) throw new Error("machine_original_occurrence_denominator_mismatch");
    for (const source of originalSources) {
      const occurrence = attempt.occurrences.find((o) => o.occurrence_id === source.occurrence_id);
      const item = occurrence && attempt.items.find((i) => i.id === occurrence.content_item_id);
      if (!occurrence || !item || source.ref.locator.kind !== "id" || occurrence.content_item_id !== source.ref.locator.id || occurrence.revision !== source.ref.revision
        || occurrence.body_sha256 !== source.body_sha256 || item.body !== source.body || item.body_kind !== source.body_kind || item.title !== source.title || item.url !== source.url) throw new Error("machine_original_source_revision_mismatch");
    }
    if (original.cutoff !== "unknown" && original.cutoff !== attempt.history_cutoff) throw new Error("machine_original_history_cutoff_mismatch");
  }
}

/** Whitelist construction: no label bodies, family assignments, dimensions, questions or scorer paths. */
export function buildMachineInput(data: PreparedData, inputSha256: string, replays: ReplayAttempt[], codeResources: Resource[]): MachineInput {
  if (data.schema_version !== "rich-brief-stage0-input-v1" || data.topic !== "t_code_agents") throw new Error("stage0_input_required");
  if (replays.length !== data.attempts.length || new Set(replays.map((r) => r.attempt_id)).size !== replays.length) throw new Error("full_attempt_denominator_required");
  const attempts = data.attempts.map((original) => {
    const replay = replays.find((r) => r.attempt_id === original.attempt_id); if (!replay) throw new Error("attempt_replay_missing");
    const occurrences = data.occurrences.filter((o) => o.attempt_id === original.attempt_id);
    if (replay.items.length !== occurrences.length || new Set(replay.items.map((i) => i.id)).size !== replay.items.length) throw new Error("full_source_occurrence_denominator_required");
    for (const source of occurrences) {
      const item = replay.items.find((i) => source.ref.locator.kind === "id" && i.id === source.ref.locator.id);
      if (!item || item.body !== source.body || sha(item.body) !== source.body_sha256 || item.body_kind !== source.body_kind || source.evidence_gaps.length) throw new Error("source_revision_body_or_evidence_mismatch");
    }
    if (replay.topic.id !== data.topic || replay.time_window.start >= replay.time_window.end || original.cutoff !== "unknown" && original.cutoff !== replay.time_window.end) throw new Error("topic_or_history_cutoff_mismatch");
    const parsedItems = replay.items.map((item) => content.parse(item)), parsedTopic = topic.parse(replay.topic), parsedHistory = replay.history.events.map((event) => historyEvent.parse(event));
    const visible = parsedItems.map((item) => {
      const body = item.body_kind === "transcript" ? selectForAnalyze(item.body, parsedTopic.keywords) : truncateForAnalyze(item.body);
      return { content_item_id: item.id, strategy: item.body_kind === "transcript" ? "topic_windows" as const : "prefix" as const, visible_body: body, visible_sha256: sha(body),
        original_utf16_chars: item.body.length, visible_utf16_chars: body.length, omitted: body !== item.body };
    });
    return { attempt_id: original.attempt_id, run_id: original.run_id, original_kind: original.kind as "batch" | "trace_without_batch", original_total_candidates: original.total_candidates,
      topic: parsedTopic, items: parsedItems, time_window: replay.time_window, history_cutoff: replay.time_window.end, history: { ...replay.history, events: parsedHistory },
      occurrences: occurrences.map((source) => ({ occurrence_id: source.occurrence_id, content_item_id: source.ref.locator.kind === "id" ? source.ref.locator.id : "", revision: source.ref.revision!, body_sha256: source.body_sha256! })),
      diagnostic_visibility: { status: "current_code_profile_not_historical_certification" as const, body_budget_chars: ANALYZE_BODY_CHARS, batch_budget_chars: ANALYZE_BATCH_CHARS, transcript_window_chars: SELECT_WINDOW_CHARS, items: visible,
        chunk_input_hashes: chunkByChars(parsedItems).map((chunk) => analyzeChunkInputSha256(parsedTopic, chunk, replay.time_window, parsedHistory)) }, snapshot_resources: replay.snapshot_resources };
  });
  const machine = machineSchema.parse({ schema_version: "rich-brief-c1-machine-input-v1", execution_scope: "shadow", upstream_input_sha256: inputSha256, gold_visibility: "absent", production_enabled: false,
    registered_runs: data.runs, attempts, resources: codeResources });
  validateMachineInput(machine); assertMachineMatchesStage0(machine, data); return machine;
}

export function validateMachineInput(raw: unknown): MachineInput {
  const machine = machineSchema.parse(raw);
  if (new Set(machine.registered_runs.map((r) => r.run_id)).size !== machine.registered_runs.length || new Set(machine.attempts.map((a) => a.attempt_id)).size !== machine.attempts.length) throw new Error("duplicate_run_or_attempt");
  for (const run of machine.registered_runs) for (const attemptId of run.attempt_ids) if (!machine.attempts.some((a) => a.attempt_id === attemptId && a.run_id === run.run_id)) throw new Error("registered_attempt_missing");
  const occurrenceIds = new Set<string>();
  for (const attempt of machine.attempts) {
    if (!machine.registered_runs.some((r) => r.run_id === attempt.run_id && r.attempt_ids.includes(attempt.attempt_id))) throw new Error("unregistered_attempt");
    if (attempt.time_window.start >= attempt.time_window.end || attempt.time_window.end !== attempt.history_cutoff) throw new Error("history_cutoff_mismatch");
    if (attempt.items.length !== attempt.occurrences.length || new Set(attempt.items.map((i) => i.id)).size !== attempt.items.length) throw new Error("full_source_occurrence_denominator_required");
    for (const source of attempt.occurrences) {
      if (occurrenceIds.has(source.occurrence_id)) throw new Error("duplicate_occurrence"); occurrenceIds.add(source.occurrence_id);
      const item = attempt.items.find((i) => i.id === source.content_item_id);
      if (!item || sha(item.body) !== source.body_sha256) throw new Error("machine_body_hash_mismatch");
    }
    if (attempt.diagnostic_visibility.items.length !== attempt.items.length || new Set(attempt.diagnostic_visibility.items.map((i) => i.content_item_id)).size !== attempt.items.length) throw new Error("visibility_coverage_mismatch");
    for (const visibility of attempt.diagnostic_visibility.items) {
      const item = attempt.items.find((i) => i.id === visibility.content_item_id); if (!item) throw new Error("visibility_source_missing");
      const expected = item.body_kind === "transcript" ? selectForAnalyze(item.body, attempt.topic.keywords) : truncateForAnalyze(item.body);
      if (expected !== visibility.visible_body || sha(expected) !== visibility.visible_sha256 || item.body.length !== visibility.original_utf16_chars || expected.length !== visibility.visible_utf16_chars || (expected !== item.body) !== visibility.omitted) throw new Error("actual_visibility_path_mismatch");
    }
    if (attempt.diagnostic_visibility.body_budget_chars !== ANALYZE_BODY_CHARS || attempt.diagnostic_visibility.batch_budget_chars !== ANALYZE_BATCH_CHARS || attempt.diagnostic_visibility.transcript_window_chars !== SELECT_WINDOW_CHARS) throw new Error("actual_visibility_profile_mismatch");
    const expectedHashes = chunkByChars(attempt.items).map((chunk) => analyzeChunkInputSha256(attempt.topic, chunk, attempt.time_window, attempt.history.events));
    if (canonicalHash(expectedHashes) !== canonicalHash(attempt.diagnostic_visibility.chunk_input_hashes)) throw new Error("actual_chunk_input_hash_mismatch");
  }
  return machine;
}
