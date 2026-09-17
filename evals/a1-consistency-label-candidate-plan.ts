/** Pure planning helpers for the diagnostic-only v2 consistency-label candidate generator. */
import { createHash } from "node:crypto";

export const LABEL_CANDIDATE_SOURCE_CHARS = 2_400;
export const LABEL_CANDIDATE_COUNT = 100;
export const LABEL_CANDIDATES_PER_TOPIC = 20;
export const LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT = 50;
/**
 * Initial drafting plus four targeted rewrites.  Each rewrite is independently re-calibrated;
 * exhausting this bounded budget fails the batch rather than admitting a mismatched pair.
 */
export const LABEL_CANDIDATE_MAX_GENERATION_ATTEMPTS = 5;
/** Generate several semantically distinct drafts before asking the independent verifier to select one. */
export const LABEL_CANDIDATE_MIN_DRAFTS_PER_ATTEMPT = 3;
export const LABEL_CANDIDATE_MAX_DRAFTS_PER_ATTEMPT = 5;
/** Tolerate a bounded over-return from structured generation, then deterministically trim before calibration. */
export const LABEL_CANDIDATE_MAX_RETURNED_DRAFTS_PER_ATTEMPT = 12;
/**
 * The generator may reduce this relay-facing request batch without changing the
 * 100-pair population or any planned intent.  Keep 20 as the ordinary setting;
 * lower values are a bounded transport recovery setting and are recorded in the
 * diagnostic-only provenance.
 */
export const LABEL_CANDIDATE_DEFAULT_BATCH_SIZE = 20;
export type CandidateIntent = "support" | "uncertain" | "exaggeration" | "out_of_context" | "misattribution";

export interface CandidateSelectionItem {
  id: string;
  topic_id: string;
  source_id: string;
}

/**
 * A feasibility edge is private diagnostic state. It binds the exact generated pair, not just a
 * relation name: an independently calibrated `support` draft can therefore never be relabelled
 * into a needed negative slot later in the run.
 */
export interface CandidateFeasibilityEdge {
  intent: CandidateIntent;
  statement: string;
  statement_sha256: string;
  source_text_sha256: string;
  pair_sha256: string;
  calibration_provenance_sha256: string;
  requested_intent: CandidateIntent;
  observed_intent: CandidateIntent;
}

/** A candidate contributes only edges whose request and independent observation exactly agree. */
export interface FeasibleCandidate extends CandidateSelectionItem {
  feasible_edges: readonly CandidateFeasibilityEdge[];
}

/**
 * Each 20-item topic contributes ten diagnostic negatives. The positions deliberately alternate
 * across the first and second ten-item source blocks: the old tail-packed plan put all negatives
 * on whichever source happened to sort last, and produced zero negatives for two sources.
 */
const INTENTS_PER_TWENTY: readonly CandidateIntent[] = [
  "support", "exaggeration", "uncertain", "out_of_context", "support",
  "misattribution", "uncertain", "exaggeration", "support", "out_of_context",
  "uncertain", "exaggeration", "support", "out_of_context", "uncertain",
  "misattribution", "support", "exaggeration", "uncertain", "out_of_context",
];

export function plannedCandidateIntent(index: number): CandidateIntent {
  return INTENTS_PER_TWENTY[index % INTENTS_PER_TWENTY.length]!;
}

export function plannedIntentCounts(size = LABEL_CANDIDATES_PER_TOPIC): Record<CandidateIntent, number> {
  if (size !== LABEL_CANDIDATES_PER_TOPIC) throw new Error(`v2 feasibility assignment requires ${LABEL_CANDIDATES_PER_TOPIC} candidates per topic`);
  const counts: Record<CandidateIntent, number> = {
    support: 0, uncertain: 0, exaggeration: 0, out_of_context: 0, misattribution: 0,
  };
  for (let index = 0; index < size; index++) counts[plannedCandidateIntent(index)]++;
  return counts;
}

export const MATCHER_VERSION = "a1-v2-feasibility-slot-matcher-v1";
const INTENT_ORDER: readonly CandidateIntent[] = ["support", "uncertain", "exaggeration", "out_of_context", "misattribution"];

/** Opaque to generator/calibration transport: it carries no readable intent or slot position. */
export function candidateFeasibilityProbeId(candidateId: string, intent: CandidateIntent): string {
  return `probe_${createHash("sha256").update(`${candidateId}\u0000${intent}`).digest("hex").slice(0, 24)}`;
}

export function isDiagnosticNegative(intent: CandidateIntent): boolean {
  return intent === "exaggeration" || intent === "out_of_context" || intent === "misattribution";
}

type IntentQuota = Record<CandidateIntent, number>;

function emptyIntentQuota(): IntentQuota {
  return { support: 0, uncertain: 0, exaggeration: 0, out_of_context: 0, misattribution: 0 };
}

function sourceCounts(items: readonly CandidateSelectionItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.source_id, (counts.get(item.source_id) ?? 0) + 1);
  return counts;
}

/**
 * Allocate exactly half of a topic's candidates to negative types without letting a sort-order
 * tail absorb them. Odd source strata get the necessary ceil allocation in stable source-id
 * order, so the result is reproducible and every stratum stays within floor/ceil(50%).
 */
export function plannedSourceNegativeCounts(items: readonly CandidateSelectionItem[]): Map<string, number> {
  if (items.length !== LABEL_CANDIDATES_PER_TOPIC) {
    throw new Error(`source negative quota requires exactly ${LABEL_CANDIDATES_PER_TOPIC} candidates, received ${items.length}`);
  }
  const counts = sourceCounts(items);
  const quota = new Map([...counts.entries()].map(([sourceId, count]) => [sourceId, Math.floor(count / 2)]));
  let remaining = LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT / 5 - [...quota.values()].reduce((sum, value) => sum + value, 0);
  for (const [sourceId, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (remaining === 0) break;
    if (count % 2 !== 0) {
      quota.set(sourceId, quota.get(sourceId)! + 1);
      remaining--;
    }
  }
  if (remaining !== 0) throw new Error("source negative quota could not reach the topic negative total");
  return quota;
}

/**
 * Deterministically turn source capacities and type totals into exact source × intent slots.
 * Negative slots are apportioned first, so two 10-item sources retain the former 2/2/1
 * exaggeration/out-of-context/misattribution distribution. Positive slots fill the remainder.
 */
export function plannedSourceIntentSlots(items: readonly CandidateSelectionItem[]): Map<string, IntentQuota> {
  const sourceTotal = sourceCounts(items);
  const sourceNegative = plannedSourceNegativeCounts(items);
  const slots = new Map([...sourceTotal.keys()].map((sourceId) => [sourceId, emptyIntentQuota()]));
  const totals = plannedIntentCounts();

  const allocateGroup = (intents: readonly CandidateIntent[], sourceCapacity: ReadonlyMap<string, number>, groupTotal: number): void => {
    const base = new Map<string, IntentQuota>();
    const remainingBySource = new Map<string, number>();
    const remainingByIntent = new Map<CandidateIntent, number>();
    for (const sourceId of [...sourceTotal.keys()].sort((left, right) => left.localeCompare(right))) {
      const quota = emptyIntentQuota();
      let used = 0;
      for (const intent of intents) {
        const value = Math.floor((sourceTotal.get(sourceId)! * totals[intent]) / LABEL_CANDIDATES_PER_TOPIC);
        quota[intent] = value;
        used += value;
        slots.get(sourceId)![intent] += value;
      }
      base.set(sourceId, quota);
      const capacity = sourceCapacity.get(sourceId)!;
      if (used > capacity) throw new Error(`source ${sourceId} base ${groupTotal === 10 ? "group" : ""} quota exceeds capacity`);
      remainingBySource.set(sourceId, capacity - used);
    }
    for (const intent of intents) {
      const used = [...base.values()].reduce((sum, quota) => sum + quota[intent], 0);
      remainingByIntent.set(intent, totals[intent] - used);
    }
    const residualSlots = intents.flatMap((intent) => Array.from({ length: remainingByIntent.get(intent)! }, () => intent));
    const sourceIds = [...sourceTotal.keys()].sort((left, right) => left.localeCompare(right));
    const canPlace = (sourceId: string, intent: CandidateIntent): boolean => {
      // A proportional cell can receive at most its floor plus one.
      return remainingBySource.get(sourceId)! > 0 && ((sourceTotal.get(sourceId)! * totals[intent]) % LABEL_CANDIDATES_PER_TOPIC) !== 0;
    };
    const ownerBySlot = new Map<number, string>();
    const usedCells = new Set<string>();
    const place = (slotIndex: number): boolean => {
      if (slotIndex === residualSlots.length) return true;
      const intent = residualSlots[slotIndex]!;
      const candidates = sourceIds
        .filter((sourceId) => canPlace(sourceId, intent) && !usedCells.has(`${sourceId}\u0000${intent}`))
        .sort((left, right) => {
          const leftFraction = (sourceTotal.get(left)! * totals[intent]) % LABEL_CANDIDATES_PER_TOPIC;
          const rightFraction = (sourceTotal.get(right)! * totals[intent]) % LABEL_CANDIDATES_PER_TOPIC;
          return rightFraction - leftFraction || left.localeCompare(right);
        });
      for (const sourceId of candidates) {
        ownerBySlot.set(slotIndex, sourceId);
        usedCells.add(`${sourceId}\u0000${intent}`);
        remainingBySource.set(sourceId, remainingBySource.get(sourceId)! - 1);
        if (place(slotIndex + 1)) return true;
        remainingBySource.set(sourceId, remainingBySource.get(sourceId)! + 1);
        usedCells.delete(`${sourceId}\u0000${intent}`);
        ownerBySlot.delete(slotIndex);
      }
      return false;
    };
    if (!place(0)) throw new Error("source × intent quota rounding has no deterministic complete allocation");
    for (const [slotIndex, sourceId] of ownerBySlot) slots.get(sourceId)![residualSlots[slotIndex]!]++;
    for (const sourceId of sourceIds) {
      const actual = intents.reduce((sum, intent) => sum + slots.get(sourceId)![intent], 0);
      if (actual !== sourceCapacity.get(sourceId)) throw new Error(`source ${sourceId} ${groupTotal === 10 ? "group" : ""} quota does not fill its capacity`);
    }
  };

  const negatives = INTENT_ORDER.filter(isDiagnosticNegative);
  allocateGroup(negatives, sourceNegative, LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT / 5);
  const positives = INTENT_ORDER.filter((intent) => !isDiagnosticNegative(intent));
  const sourcePositive = new Map([...sourceTotal.entries()].map(([sourceId, total]) => [sourceId, total - sourceNegative.get(sourceId)!]));
  allocateGroup(positives, sourcePositive, LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT / 5);
  for (const [sourceId, quota] of slots) {
    const total = INTENT_ORDER.reduce((sum, intent) => sum + quota[intent], 0);
    if (total !== sourceTotal.get(sourceId)) throw new Error(`source ${sourceId} intent slots do not equal source candidate count`);
  }
  return slots;
}

function validFeasibilityEdge(edge: CandidateFeasibilityEdge): boolean {
  return edge.requested_intent === edge.intent
    && edge.observed_intent === edge.intent
    && edge.statement.trim().length >= 10
    && /^[a-f0-9]{64}$/u.test(edge.statement_sha256)
    && /^[a-f0-9]{64}$/u.test(edge.source_text_sha256)
    && /^[a-f0-9]{64}$/u.test(edge.pair_sha256)
    && /^[a-f0-9]{64}$/u.test(edge.calibration_provenance_sha256);
}

/**
 * Deterministically assign each candidate to an exact, calibrated pair edge while preserving
 * topic × source × intent slots. This is a constrained matching problem, not post-hoc relabel:
 * a returned edge is the only statement callers may project into the unlabeled candidate file.
 */
export function assignFeasibleCandidateIntents<T extends FeasibleCandidate>(items: readonly T[]): Map<string, CandidateFeasibilityEdge> {
  const byTopic = new Map<string, T[]>();
  for (const item of items) {
    const topicItems = byTopic.get(item.topic_id) ?? [];
    topicItems.push(item);
    byTopic.set(item.topic_id, topicItems);
  }
  if (byTopic.size !== 5) throw new Error(`v2 feasibility assignment requires 5 topics, received ${byTopic.size}`);
  const assigned = new Map<string, CandidateFeasibilityEdge>();
  for (const [topicId, topicItems] of byTopic) {
    if (topicItems.length !== LABEL_CANDIDATES_PER_TOPIC) throw new Error(`topic ${topicId} requires exactly ${LABEL_CANDIDATES_PER_TOPIC} feasibility entries, received ${topicItems.length}`);
    if (new Set(topicItems.map((item) => item.id)).size !== topicItems.length) throw new Error(`topic ${topicId} contains duplicate candidate ids`);
    for (const candidate of topicItems) {
      if (new Set(candidate.feasible_edges.map((edge) => edge.intent)).size !== candidate.feasible_edges.length
        || candidate.feasible_edges.some((edge) => !validFeasibilityEdge(edge))) {
        throw new Error(`candidate ${candidate.id} contains an invalid or duplicate calibrated feasibility edge`);
      }
    }
    const sourceSlots = plannedSourceIntentSlots(topicItems);
    const slots = [...sourceSlots.entries()].flatMap(([sourceId, quota]) => INTENT_ORDER.flatMap((intent) =>
      Array.from({ length: quota[intent] }, (_, index) => ({ sourceId, intent, index })),
    ));
    const slotOwners = new Map<number, T>();
    const candidateOrder = [...topicItems].sort((left, right) => {
      const feasibleDelta = left.feasible_edges.length - right.feasible_edges.length;
      return feasibleDelta || left.id.localeCompare(right.id);
    });
    const place = (candidate: T, visited: Set<number>): boolean => {
      for (const [slotIndex, slot] of slots.entries()) {
        if (visited.has(slotIndex) || candidate.source_id !== slot.sourceId || !candidate.feasible_edges.some((edge) => edge.intent === slot.intent)) continue;
        visited.add(slotIndex);
        const owner = slotOwners.get(slotIndex);
        if (!owner || place(owner, visited)) {
          slotOwners.set(slotIndex, candidate);
          return true;
        }
      }
      return false;
    };
    for (const candidate of candidateOrder) {
      if (!place(candidate, new Set())) throw new Error(`topic ${topicId} cannot meet exact topic × source × intent quota without mismatched relabeling`);
    }
    for (const [slotIndex, candidate] of slotOwners) {
      const intent = slots[slotIndex]!.intent;
      const edge = candidate.feasible_edges.find((candidateEdge) => candidateEdge.intent === intent);
      if (!edge) throw new Error(`candidate ${candidate.id} lost its selected feasibility edge`);
      assigned.set(candidate.id, edge);
    }
  }
  if (assigned.size !== items.length) throw new Error("feasibility assignment did not cover every candidate");
  return assigned;
}

/** Calibration succeeds only when an independent verifier observes the exact planned relation. */
export function calibrationMatchesIntent(intent: CandidateIntent, observed: CandidateIntent): boolean {
  return intent === observed;
}

/** Target-specific constraints make the requested relation observable to the independent verifier. */
export function candidateIntentConstraint(intent: CandidateIntent): string {
  switch (intent) {
    case "support":
      return "Write a complete fact directly supported by the excerpt; preserve every material subject, scope, degree, certainty, condition, and time qualifier.";
    case "uncertain":
      return "Add one material attribute absent from the excerpt without strengthening any stated scope, amount, certainty, or condition, and without moving a property between entities.";
    case "exaggeration":
      return "Strengthen exactly one explicit scope, amount, certainty, or condition. The resulting statement must no longer be directly supported.";
    case "out_of_context":
      return "Start from a fact with an explicit temporal, conditional, eligibility, exception, or scope qualifier in the excerpt, then omit or invert that qualifier. Never return a complete directly supported fact.";
    case "misattribution":
      return "Transfer exactly one stated property between two explicitly named, distinguishable entities; do not add an entity or property absent from the excerpt.";
  }
}

export function labelCandidateBatchSize(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return LABEL_CANDIDATE_DEFAULT_BATCH_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > LABEL_CANDIDATE_DEFAULT_BATCH_SIZE) {
    throw new Error(`LABEL_CANDIDATE_BATCH_SIZE 必须是 1-${LABEL_CANDIDATE_DEFAULT_BATCH_SIZE} 的整数`);
  }
  return value;
}

/**
 * A v2 quality population can be larger than the 100-pair consistency set. Keep the latter
 * stable and balanced by taking twenty per topic. For expanded topics, source round-robin avoids
 * silently taking only the first source's entries; the caller records this selection in its
 * diagnostic-only manifest, never in the blind reviewer handoff.
 */
export function selectConsistencyCandidateItems<T extends CandidateSelectionItem>(items: readonly T[]): T[] {
  const topics = new Map<string, T[]>();
  for (const item of items) {
    const group = topics.get(item.topic_id) ?? [];
    group.push(item);
    topics.set(item.topic_id, group);
  }
  if (topics.size !== 5) throw new Error(`v2 consistency candidate 要求恰有 5 个 topic，当前 ${topics.size}`);

  const selected: T[] = [];
  for (const [topicId, topicItems] of topics) {
    if (topicItems.length < LABEL_CANDIDATES_PER_TOPIC) {
      throw new Error(`topic ${topicId} 至少需要 ${LABEL_CANDIDATES_PER_TOPIC} 条质量输入，当前 ${topicItems.length}`);
    }
    if (new Set(topicItems.map((item) => item.source_id)).size < 2) {
      throw new Error(`topic ${topicId} 至少需要 2 个来源，不能把跨来源负例分布退化为单一来源`);
    }
    if (topicItems.length === LABEL_CANDIDATES_PER_TOPIC) {
      selected.push(...topicItems);
      continue;
    }
    const bySource = new Map<string, T[]>();
    for (const item of topicItems) {
      const group = bySource.get(item.source_id) ?? [];
      group.push(item);
      bySource.set(item.source_id, group);
    }
    const sourceIds = [...bySource.keys()].sort((a, b) => a.localeCompare(b));
    const offsets = new Map(sourceIds.map((sourceId) => [sourceId, 0]));
    const topicSelected: T[] = [];
    while (topicSelected.length < LABEL_CANDIDATES_PER_TOPIC) {
      let progressed = false;
      for (const sourceId of sourceIds) {
        const sourceItems = bySource.get(sourceId)!;
        const offset = offsets.get(sourceId)!;
        if (offset >= sourceItems.length) continue;
        topicSelected.push(sourceItems[offset]!);
        offsets.set(sourceId, offset + 1);
        progressed = true;
        if (topicSelected.length === LABEL_CANDIDATES_PER_TOPIC) break;
      }
      if (!progressed) throw new Error(`topic ${topicId} 无法选出 ${LABEL_CANDIDATES_PER_TOPIC} 条候选`);
    }
    selected.push(...topicSelected);
  }
  if (selected.length !== LABEL_CANDIDATE_COUNT) {
    throw new Error(`v2 consistency candidate 必须选出 ${LABEL_CANDIDATE_COUNT} 条，当前 ${selected.length}`);
  }
  if (new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new Error("v2 consistency candidate 选择中含重复 item id");
  }
  return selected;
}

/** Preserve verbatim source text while preferring a sentence boundary near the configured limit. */
export function labelSourceWindow(body: string, limit = LABEL_CANDIDATE_SOURCE_CHARS): string {
  if (body.length <= limit) return body;
  const floor = Math.floor(limit * 0.7);
  const slice = body.slice(0, limit);
  const boundaries = [...slice.matchAll(/[.!?。！？](?:\s|$)/gu)].map((match) => match.index! + match[0].length);
  const boundary = boundaries.filter((index) => index >= floor).at(-1);
  return body.slice(0, boundary ?? limit);
}

/** Escape third-party excerpt data only when embedding it in the generator prompt. */
export function escapeCandidatePromptData(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
