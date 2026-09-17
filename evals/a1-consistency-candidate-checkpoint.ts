import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { consistencyPairHash } from "./a1-consistency-label-receipt.js";
import { candidateFeasibilityProbeId, plannedSourceIntentSlots, type CandidateFeasibilityEdge, type CandidateIntent } from "./a1-consistency-label-candidate-plan.js";

/** v2 checkpoints contain position-bound statements and are deliberately never resumable. */
export const CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION = "a1-v2-consistency-candidate-checkpoint-v6";

export interface CandidateCheckpointContext {
  quality_input_sha256: string;
  candidate_input_sha256: string;
  probe_matrix_sha256: string;
  slot_plan_sha256: string;
  matcher_version: string;
  model: string;
  prompt_version: string;
  prompt_sha256: string;
  generator_response_schema_sha256: string;
  generator_thinking: false;
  generator_batch_size: number;
  generator_max_tokens: number;
  calibration_model: string;
  calibration_thinking: boolean;
  calibration_prompt_version: string;
  calibration_prompt_sha256: string;
  calibration_response_schema_sha256: string;
  calibration_max_tokens: number;
  calibration_max_generation_attempts: number;
  calibration_minimum_drafts_per_attempt: number;
  calibration_maximum_drafts_per_attempt: number;
  generator_max_returned_drafts_per_attempt: number;
  generator_max_structural_response_attempts: number;
  structured_transport_version: string;
}

export interface CandidateCheckpointBatchPlan {
  start: number;
  candidates: CandidateCheckpointCoordinate[];
}

/** Hash-only source coordinates prove that matching has not reassigned a candidate across slots. */
export interface CandidateCheckpointCoordinate {
  id: string;
  topic_id: string;
  source_id: string;
  source_text_sha256: string;
  source_body_sha256: string;
}

export interface CandidateProbeAttempt {
  drafts: Array<{ statement: string; observed_intent: CandidateIntent }>;
}

export interface CandidateProbeDiagnostic {
  probe_id: string;
  intent: CandidateIntent;
  attempts: CandidateProbeAttempt[];
  feasible_edge?: CandidateFeasibilityEdge;
}

export interface CandidateCheckpointCandidate extends CandidateCheckpointCoordinate {
  probes: CandidateProbeDiagnostic[];
}

export interface CandidateCheckpointBatch {
  start: number;
  candidates: CandidateCheckpointCandidate[];
}

/** Exact output of deterministic source × intent matching, not merely an arbitrary feasible edge. */
export interface CandidateCheckpointSelectedMatch {
  id: string;
  topic_id: string;
  source_id: string;
  intent: CandidateIntent;
  pair_sha256: string;
}

/** Aggregate-only call accounting is checkpointed so a second-write recovery never rewrites history. */
export interface CandidateCheckpointProbeMetrics {
  generation_calls: number;
  structural_response_retries: number;
  calibration_calls: number;
  retry_probe_attempts: number;
}

export interface CandidateCheckpoint extends CandidateCheckpointContext {
  schema_version: typeof CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION;
  completed_batches: CandidateCheckpointBatch[];
  probe_metrics: CandidateCheckpointProbeMetrics;
  selected_matching?: {
    matcher_version: string;
    slot_plan_sha256: string;
    selection_sha256: string;
    entries: CandidateCheckpointSelectedMatch[];
  };
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const intentValues = new Set<CandidateIntent>(["support", "uncertain", "exaggeration", "out_of_context", "misattribution"]);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};
const selectedMatchingSha256 = (entries: readonly CandidateCheckpointSelectedMatch[]): string => hash(stable(
  [...entries].sort((left, right) => left.id.localeCompare(right.id)),
));

export function candidateFeasibilityEdgeProvenanceSha256(
  edge: Pick<CandidateFeasibilityEdge, "intent" | "statement_sha256" | "source_text_sha256" | "pair_sha256">,
  candidateId: string,
  probeId: string,
  context: Pick<CandidateCheckpointContext,
    "calibration_model" | "calibration_thinking" | "calibration_prompt_sha256" | "calibration_response_schema_sha256"
    | "calibration_max_tokens" | "structured_transport_version"
  >,
): string {
  return hash(stable({
    candidate_id: candidateId, probe_id: probeId, requested_intent: edge.intent, observed_intent: edge.intent,
    statement_sha256: edge.statement_sha256, source_text_sha256: edge.source_text_sha256, pair_sha256: edge.pair_sha256,
    calibration_model: context.calibration_model, calibration_thinking: context.calibration_thinking,
    calibration_prompt_sha256: context.calibration_prompt_sha256, calibration_response_schema_sha256: context.calibration_response_schema_sha256,
    calibration_max_tokens: context.calibration_max_tokens, structured_transport_version: context.structured_transport_version,
  }));
}

export interface CandidateCheckpointProbeInput {
  id: string;
  source_text: string;
}

export interface CandidateCheckpointOutputRow extends CandidateCheckpointProbeInput {
  statement: string;
  source_body_sha256: string;
}

function isCoordinate(value: unknown): value is CandidateCheckpointCoordinate {
  if (value == null || typeof value !== "object") return false;
  const coordinate = value as Partial<CandidateCheckpointCoordinate>;
  return typeof coordinate.id === "string" && coordinate.id.trim().length > 0
    && typeof coordinate.topic_id === "string" && coordinate.topic_id.trim().length > 0
    && typeof coordinate.source_id === "string" && coordinate.source_id.trim().length > 0
    && isHash(coordinate.source_text_sha256) && isHash(coordinate.source_body_sha256);
}

function sameCoordinate(left: CandidateCheckpointCoordinate, right: CandidateCheckpointCoordinate): boolean {
  return left.id === right.id && left.topic_id === right.topic_id && left.source_id === right.source_id
    && left.source_text_sha256 === right.source_text_sha256 && left.source_body_sha256 === right.source_body_sha256;
}

function assertCheckpointContext(context: CandidateCheckpointContext): void {
  const hashes: Array<keyof CandidateCheckpointContext> = [
    "quality_input_sha256", "candidate_input_sha256", "probe_matrix_sha256", "slot_plan_sha256", "prompt_sha256",
    "generator_response_schema_sha256", "calibration_prompt_sha256", "calibration_response_schema_sha256",
  ];
  if (hashes.some((key) => !isHash(context[key])) || context.generator_thinking !== false
    || !context.matcher_version.trim() || !context.model.trim() || !context.prompt_version.trim()
    || !context.calibration_model.trim() || !context.calibration_prompt_version.trim() || !context.structured_transport_version.trim()
    || !Number.isSafeInteger(context.generator_batch_size) || context.generator_batch_size < 1
    || !Number.isSafeInteger(context.generator_max_tokens) || context.generator_max_tokens < 1
    || !Number.isSafeInteger(context.calibration_max_tokens) || context.calibration_max_tokens < 1
    || !Number.isSafeInteger(context.calibration_max_generation_attempts) || context.calibration_max_generation_attempts < 1
    || !Number.isSafeInteger(context.calibration_minimum_drafts_per_attempt) || context.calibration_minimum_drafts_per_attempt < 1
    || !Number.isSafeInteger(context.calibration_maximum_drafts_per_attempt)
    || context.calibration_maximum_drafts_per_attempt < context.calibration_minimum_drafts_per_attempt
    || !Number.isSafeInteger(context.generator_max_returned_drafts_per_attempt)
    || context.generator_max_returned_drafts_per_attempt < context.calibration_maximum_drafts_per_attempt
    || !Number.isSafeInteger(context.generator_max_structural_response_attempts) || context.generator_max_structural_response_attempts < 1) {
    throw new Error("candidate checkpoint 上下文或预算无效");
  }
}

function validProbeMetrics(value: unknown): value is CandidateCheckpointProbeMetrics {
  if (value == null || typeof value !== "object") return false;
  const metrics = value as Partial<CandidateCheckpointProbeMetrics>;
  return [metrics.generation_calls, metrics.structural_response_retries, metrics.calibration_calls, metrics.retry_probe_attempts]
    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0);
}

/**
 * Bind every restored edge back to the actual calibrated draft, opaque probe identity, source
 * pair and the current calibration provenance. Structural JSON validation alone is insufficient.
 */
export function assertCandidateCheckpointProbeIntegrity(
  candidates: readonly CandidateCheckpointBatch["candidates"][number][],
  inputs: readonly CandidateCheckpointProbeInput[],
  context: CandidateCheckpointContext,
): void {
  assertCheckpointContext(context);
  const inputsById = new Map(inputs.map((input) => [input.id, input]));
  for (const candidate of candidates) {
    const input = inputsById.get(candidate.id);
    if (!input) throw new Error(`candidate checkpoint references unknown input ${candidate.id}`);
    for (const probe of candidate.probes) {
      if (probe.probe_id !== candidateFeasibilityProbeId(candidate.id, probe.intent)) {
        throw new Error(`candidate checkpoint probe id does not bind ${candidate.id} × ${probe.intent}`);
      }
      const edge = probe.feasible_edge;
      if (!edge) continue;
      if (edge.statement_sha256 !== hash(edge.statement)
        || edge.source_text_sha256 !== hash(input.source_text)
        || edge.pair_sha256 !== consistencyPairHash({ id: candidate.id, statement: edge.statement, source_text: input.source_text })
        || edge.calibration_provenance_sha256 !== candidateFeasibilityEdgeProvenanceSha256(edge, candidate.id, probe.probe_id, context)) {
        throw new Error(`candidate checkpoint feasibility edge hash/provenance does not bind ${candidate.id} × ${probe.intent}`);
      }
      if (!probe.attempts.some((attempt) => attempt.drafts.some((draft) => draft.statement === edge.statement && draft.observed_intent === probe.intent))) {
        throw new Error(`candidate checkpoint feasibility edge was not independently calibrated for ${candidate.id} × ${probe.intent}`);
      }
    }
  }
}

function assertSelectedMatching(checkpoint: CandidateCheckpoint): void {
  const matching = checkpoint.selected_matching;
  if (!matching || matching.matcher_version !== checkpoint.matcher_version || matching.slot_plan_sha256 !== checkpoint.slot_plan_sha256
    || !Array.isArray(matching.entries) || matching.selection_sha256 !== selectedMatchingSha256(matching.entries)) {
    throw new Error("candidate checkpoint 缺少或损坏最终 source × intent matching");
  }
  const candidates = checkpoint.completed_batches.flatMap((batch) => batch.candidates);
  if (matching.entries.length !== candidates.length || new Set(matching.entries.map((entry) => entry.id)).size !== matching.entries.length) {
    throw new Error("candidate checkpoint 最终 matching 未一一覆盖 candidate");
  }
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const entry of matching.entries) {
    const candidate = candidatesById.get(entry.id);
    if (!candidate || !intentValues.has(entry.intent) || !isHash(entry.pair_sha256)
      || entry.topic_id !== candidate.topic_id || entry.source_id !== candidate.source_id
      || !candidate.probes.some((probe) => probe.intent === entry.intent && probe.feasible_edge?.pair_sha256 === entry.pair_sha256)) {
      throw new Error(`candidate checkpoint 最终 matching 未绑定 ${entry.id} 的受限可行边`);
    }
  }
  const byTopic = new Map<string, CandidateCheckpointSelectedMatch[]>();
  for (const entry of matching.entries) {
    const entries = byTopic.get(entry.topic_id) ?? [];
    entries.push(entry);
    byTopic.set(entry.topic_id, entries);
  }
  if (byTopic.size !== 5) throw new Error("candidate checkpoint 最终 matching 未覆盖五个 topic");
  for (const [topicId, entries] of byTopic) {
    const slots = plannedSourceIntentSlots(entries.map((entry) => ({ id: entry.id, topic_id: topicId, source_id: entry.source_id })));
    for (const [sourceId, quota] of slots) {
      for (const intent of intentValues) {
        const count = entries.filter((entry) => entry.source_id === sourceId && entry.intent === intent).length;
        if (count !== quota[intent]) throw new Error(`candidate checkpoint 最终 matching 未满足 ${topicId}/${sourceId}/${intent} slot`);
      }
    }
  }
}

/** Persist the deterministic matching that selected each final pair, then prove its slot coverage. */
export function setCandidateCheckpointSelectedMatching(
  checkpoint: CandidateCheckpoint,
  entries: readonly CandidateCheckpointSelectedMatch[],
): void {
  const expectedCount = checkpoint.completed_batches.flatMap((batch) => batch.candidates).length;
  if (!expectedCount || entries.length !== expectedCount) throw new Error("candidate checkpoint 不能为未完成探测设置最终 matching");
  checkpoint.selected_matching = {
    matcher_version: checkpoint.matcher_version,
    slot_plan_sha256: checkpoint.slot_plan_sha256,
    selection_sha256: selectedMatchingSha256(entries),
    entries: [...entries].sort((left, right) => left.id.localeCompare(right.id)),
  };
  assertSelectedMatching(checkpoint);
}

/**
 * Verify that a candidate file is a projection of the same completed probe checkpoint, rather
 * than merely a JSONL with a self-declared manifest. This intentionally requires the local
 * diagnostic checkpoint; it does not treat an unbound candidate/manifest pair as review input.
 */
export function assertCandidateCheckpointCandidateProjection(
  value: unknown,
  rows: readonly CandidateCheckpointOutputRow[],
): void {
  if (value == null || typeof value !== "object") throw new Error("candidate checkpoint 无法解析");
  const checkpoint = value as CandidateCheckpoint;
  if (checkpoint.schema_version !== CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION || !Array.isArray(checkpoint.completed_batches)) {
    throw new Error("candidate checkpoint 版本或批次无效");
  }
  assertCheckpointContext(checkpoint);
  if (!rows.length || rows.some((row) => !isHash(row.source_body_sha256) || !row.id.trim() || !row.statement.trim() || !row.source_text.trim())) {
    throw new Error("candidate 输出缺少受控 source hash 或原文-结论对");
  }
  const checkpointCandidates = checkpoint.completed_batches.flatMap((batch) => batch.candidates);
  if (checkpointCandidates.length !== rows.length || new Set(checkpointCandidates.map((candidate) => candidate.id)).size !== checkpointCandidates.length
    || checkpointCandidates.some((candidate) => !isCandidate(candidate, checkpoint))) {
    throw new Error("candidate checkpoint 未形成与候选输出一一对应的完整探测矩阵");
  }
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  if (rowsById.size !== rows.length || checkpointCandidates.some((candidate) => !rowsById.has(candidate.id))) {
    throw new Error("candidate checkpoint 与候选输出 ID 集合不一致");
  }
  assertCandidateCheckpointProbeIntegrity(checkpointCandidates, rows, checkpoint);
  assertSelectedMatching(checkpoint);
  const selectedById = new Map(checkpoint.selected_matching!.entries.map((entry) => [entry.id, entry]));
  for (const candidate of checkpointCandidates) {
    const row = rowsById.get(candidate.id)!;
    const selected = selectedById.get(candidate.id)!;
    if (candidate.source_body_sha256 !== row.source_body_sha256 || candidate.source_text_sha256 !== hash(row.source_text)) {
      throw new Error(`candidate ${candidate.id} 未绑定到受控 source body/window hash`);
    }
    const match = candidate.probes.find((probe) => probe.intent === selected.intent && probe.feasible_edge?.pair_sha256 === selected.pair_sha256)?.feasible_edge;
    if (!match || match.statement !== row.statement || match.pair_sha256 !== consistencyPairHash({ id: row.id, statement: row.statement, source_text: row.source_text })) {
      throw new Error(`candidate ${candidate.id} 未绑定到最终受限 matching 所选 pair`);
    }
  }
}

export function candidateCheckpointPath(outputPath: string): string {
  return outputPath.replace(/\.local\.jsonl$/u, ".candidate-checkpoint.local.json");
}

export function createCandidateCheckpoint(context: CandidateCheckpointContext): CandidateCheckpoint {
  assertCheckpointContext(context);
  return {
    schema_version: CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION, ...context, completed_batches: [],
    probe_metrics: { generation_calls: 0, structural_response_retries: 0, calibration_calls: 0, retry_probe_attempts: 0 },
  };
}

function sameContext(checkpoint: CandidateCheckpoint, context: CandidateCheckpointContext): boolean {
  return Object.keys(context).every((key) => checkpoint[key as keyof CandidateCheckpointContext] === context[key as keyof CandidateCheckpointContext]);
}

function isFeasibleEdge(value: unknown, probeIntent: CandidateIntent): value is CandidateFeasibilityEdge {
  if (value == null || typeof value !== "object") return false;
  const edge = value as Partial<CandidateFeasibilityEdge>;
  return edge.intent === probeIntent
    && edge.requested_intent === probeIntent
    && edge.observed_intent === probeIntent
    && typeof edge.statement === "string" && edge.statement.trim().length >= 10
    && isHash(edge.statement_sha256) && isHash(edge.source_text_sha256)
    && isHash(edge.pair_sha256) && isHash(edge.calibration_provenance_sha256);
}

function isProbe(value: unknown, context: CandidateCheckpointContext): value is CandidateProbeDiagnostic {
  if (value == null || typeof value !== "object") return false;
  const probe = value as Partial<CandidateProbeDiagnostic>;
  if (typeof probe.probe_id !== "string" || !probe.probe_id.trim() || !intentValues.has(probe.intent as CandidateIntent)
    || !Array.isArray(probe.attempts) || probe.attempts.length < 1 || probe.attempts.length > context.calibration_max_generation_attempts) return false;
  if (probe.attempts.some((attempt) => attempt == null || !Array.isArray(attempt.drafts)
    || attempt.drafts.length < context.calibration_minimum_drafts_per_attempt || attempt.drafts.length > context.calibration_maximum_drafts_per_attempt
    || attempt.drafts.some((draft) => typeof draft?.statement !== "string" || draft.statement.trim().length < 10 || !intentValues.has(draft.observed_intent)))) return false;
  return probe.feasible_edge == null || isFeasibleEdge(probe.feasible_edge, probe.intent as CandidateIntent);
}

function isCandidate(value: unknown, context: CandidateCheckpointContext): value is CandidateCheckpointBatch["candidates"][number] {
  if (value == null || typeof value !== "object" || !isCoordinate(value)) return false;
  const candidate = value as Partial<CandidateCheckpointCandidate>;
  return Array.isArray(candidate.probes)
    && candidate.probes.length === intentValues.size
    && candidate.probes.every((probe) => isProbe(probe, context))
    && new Set(candidate.probes.map((probe) => probe.intent)).size === intentValues.size;
}

function validateCheckpoint(
  checkpoint: CandidateCheckpoint,
  context: CandidateCheckpointContext,
  plan: readonly CandidateCheckpointBatchPlan[],
): void {
  assertCheckpointContext(context);
  if (checkpoint.schema_version !== CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION || !sameContext(checkpoint, context)) {
    throw new Error("candidate checkpoint 与当前输入、探测矩阵、匹配器、模型、prompt 或 batch 配置不匹配");
  }
  if (!Array.isArray(checkpoint.completed_batches) || checkpoint.completed_batches.length > plan.length) {
    throw new Error("candidate checkpoint 批次结构无效");
  }
  if (!validProbeMetrics(checkpoint.probe_metrics)) throw new Error("candidate checkpoint 探测调用指标无效");
  for (const [index, batch] of checkpoint.completed_batches.entries()) {
    const expected = plan[index];
    if (!expected || batch == null || typeof batch !== "object" || batch.start !== expected.start
      || !Array.isArray(batch.candidates) || batch.candidates.length !== expected.candidates.length
      || batch.candidates.some((candidate, candidateIndex) => !isCandidate(candidate, context) || !sameCoordinate(candidate, expected.candidates[candidateIndex]!))) {
      throw new Error("candidate checkpoint 不是当前探测计划的连续完整前缀");
    }
  }
  if (checkpoint.selected_matching != null) {
    if (checkpoint.completed_batches.length !== plan.length) throw new Error("candidate checkpoint 不可在探测未完成时保存最终 matching");
    assertSelectedMatching(checkpoint);
  }
}

export function loadCandidateCheckpoint(
  path: string,
  context: CandidateCheckpointContext,
  plan: readonly CandidateCheckpointBatchPlan[],
): CandidateCheckpoint | null {
  if (!existsSync(path)) return null;
  let checkpoint: CandidateCheckpoint;
  try {
    checkpoint = JSON.parse(readFileSync(path, "utf8")) as CandidateCheckpoint;
  } catch {
    throw new Error("candidate checkpoint 无法解析；拒绝混入未知进度");
  }
  validateCheckpoint(checkpoint, context, plan);
  return checkpoint;
}

export function appendCandidateCheckpointBatch(
  checkpoint: CandidateCheckpoint,
  plan: readonly CandidateCheckpointBatchPlan[],
  batch: CandidateCheckpointBatch,
): void {
  assertCheckpointContext(checkpoint);
  const expected = plan[checkpoint.completed_batches.length];
  if (checkpoint.selected_matching != null || !expected || batch.start !== expected.start || batch.candidates.length !== expected.candidates.length
    || batch.candidates.some((candidate, index) => !isCandidate(candidate, checkpoint) || !sameCoordinate(candidate, expected.candidates[index]!))) {
    throw new Error("candidate checkpoint 只能追加当前探测计划的下一个完整批次");
  }
  checkpoint.completed_batches.push({
    start: batch.start,
    candidates: batch.candidates.map((candidate) => ({
      id: candidate.id, topic_id: candidate.topic_id, source_id: candidate.source_id,
      source_text_sha256: candidate.source_text_sha256, source_body_sha256: candidate.source_body_sha256,
      probes: candidate.probes.map((probe) => ({
        probe_id: probe.probe_id,
        intent: probe.intent,
        attempts: probe.attempts.map((attempt) => ({
          drafts: attempt.drafts.map((draft) => ({ statement: draft.statement.trim(), observed_intent: draft.observed_intent })),
        })),
        ...(probe.feasible_edge == null ? {} : { feasible_edge: { ...probe.feasible_edge, statement: probe.feasible_edge.statement.trim() } }),
      })),
    })),
  });
}

/** Add metrics before each atomic checkpoint write; recovered diagnostics must retain prior calls. */
export function addCandidateCheckpointProbeMetrics(
  checkpoint: CandidateCheckpoint,
  metrics: CandidateCheckpointProbeMetrics,
): void {
  if (!validProbeMetrics(metrics) || !validProbeMetrics(checkpoint.probe_metrics)) {
    throw new Error("candidate checkpoint 探测调用指标无效");
  }
  checkpoint.probe_metrics = {
    generation_calls: checkpoint.probe_metrics.generation_calls + metrics.generation_calls,
    structural_response_retries: checkpoint.probe_metrics.structural_response_retries + metrics.structural_response_retries,
    calibration_calls: checkpoint.probe_metrics.calibration_calls + metrics.calibration_calls,
    retry_probe_attempts: checkpoint.probe_metrics.retry_probe_attempts + metrics.retry_probe_attempts,
  };
  if (!validProbeMetrics(checkpoint.probe_metrics)) throw new Error("candidate checkpoint 探测调用指标溢出");
}

/** Atomically persist local-only probe statements and calibrations; source excerpts never enter this file. */
export function writeCandidateCheckpoint(path: string, checkpoint: CandidateCheckpoint): void {
  assertCheckpointContext(checkpoint);
  if (!validProbeMetrics(checkpoint.probe_metrics)) throw new Error("candidate checkpoint 探测调用指标无效");
  if (checkpoint.selected_matching != null) assertSelectedMatching(checkpoint);
  const temporary = `${path}.${process.pid}.${hash(JSON.stringify(checkpoint)).slice(0, 12)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}
