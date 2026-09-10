/**
 * Dogfood protocol v2 for the deterministic TechLead → opportunity projection.
 *
 * This module deliberately consumes an already-qualified TechLead snapshot; it never opens a
 * production database, changes mapping rules, or creates an opportunity.  The blind manifest
 * excludes both source text and system outputs so a reviewer can record expectations first.
 */
import { createHash } from "node:crypto";

export const DOGFOOD_V2_VERSION = "technology-opportunity-dogfood-v2" as const;
export type Lane = "core" | "adjacent" | "horizon" | "challenge";
export type Candidate = boolean;

export interface QualifiedLeadForSampling {
  /** Private, stable identifier. It is never emitted into the blind manifest. */
  lead_id: string;
  topic_id: string;
  lead_kind: string;
  evidence_count: number;
  latest_evidence_at: string;
}

export interface BlindSampleRow {
  sample_id: string;
  topic_id: string;
  lead_kind: string;
  evidence_band: "1" | "2-3" | "4+";
  freshness_band: "0-48h" | "49h-14d" | "14d+";
}

export interface BlindSampleManifest {
  protocol_version: typeof DOGFOOD_V2_VERSION;
  generated_at: string;
  population_source: "qualified_tech_leads";
  population_size: number;
  sample_size: number;
  selection_method: "deterministic-stratified-hash-v1";
  seed: string;
  population_digest: string;
  pilot: boolean;
  rows: BlindSampleRow[];
}

export interface SampleOptions {
  generatedAt: string;
  seed: string;
  count: number;
  pilot?: boolean;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const stableOrder = (seed: string, value: string): string => digest(`${seed}\u0000${value}`);
const evidenceBand = (count: number): BlindSampleRow["evidence_band"] => count >= 4 ? "4+" : count >= 2 ? "2-3" : "1";
const freshnessBand = (at: string, generatedAt: string): BlindSampleRow["freshness_band"] => {
  const hours = Math.max(0, (Date.parse(generatedAt) - Date.parse(at)) / 3_600_000);
  return hours <= 48 ? "0-48h" : hours <= 14 * 24 ? "49h-14d" : "14d+";
};

function assertPopulation(population: QualifiedLeadForSampling[], options: SampleOptions): void {
  if (!population.length) throw new Error("合格 TechLead 总体不能为空");
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("样本数量必须为正整数");
  if (options.count > population.length) throw new Error("样本数量不能超过合格 TechLead 总体");
  if (!options.seed) throw new Error("必须固定提供抽样 seed");
  if (!Number.isFinite(Date.parse(options.generatedAt))) throw new Error("generatedAt 必须是 ISO 时间戳");
  const ids = new Set(population.map((lead) => lead.lead_id));
  if (ids.size !== population.length || [...ids].some((id) => !id)) throw new Error("合格 TechLead 必须有唯一非空 lead_id");
  if (population.some((lead) => !lead.topic_id || !lead.lead_kind || lead.evidence_count < 1 || !Number.isFinite(Date.parse(lead.latest_evidence_at)))) {
    throw new Error("合格 TechLead 缺少 topic、kind、证据数或有效时间戳");
  }
}

/**
 * Select from all qualified leads, not from TechnologyOpportunity rows.  Each non-empty
 * topic/kind stratum receives one row before the next round, then ties are resolved by a
 * seeded hash.  The result carries only review-relevant buckets, never IDs, title, quote or URL.
 */
export function createBlindSampleManifest(population: QualifiedLeadForSampling[], options: SampleOptions): BlindSampleManifest {
  assertPopulation(population, options);
  const strata = new Map<string, QualifiedLeadForSampling[]>();
  for (const lead of population) {
    const key = `${lead.topic_id}\u0000${lead.lead_kind}`;
    const bucket = strata.get(key) ?? [];
    bucket.push(lead);
    strata.set(key, bucket);
  }
  for (const [key, bucket] of strata) bucket.sort((a, b) => stableOrder(options.seed, `${key}\u0000${a.lead_id}`).localeCompare(stableOrder(options.seed, `${key}\u0000${b.lead_id}`)));
  const orderedStrata = [...strata.keys()].sort((a, b) => stableOrder(options.seed, a).localeCompare(stableOrder(options.seed, b)));
  const selected: QualifiedLeadForSampling[] = [];
  for (let round = 0; selected.length < options.count; round++) {
    let picked = false;
    for (const key of orderedStrata) {
      const lead = strata.get(key)![round];
      if (!lead) continue;
      selected.push(lead);
      picked = true;
      if (selected.length === options.count) break;
    }
    if (!picked) break;
  }
  const populationDigest = digest([...population].map((lead) => lead.lead_id).sort().join("\n"));
  return {
    protocol_version: DOGFOOD_V2_VERSION,
    generated_at: options.generatedAt,
    population_source: "qualified_tech_leads",
    population_size: population.length,
    sample_size: selected.length,
    selection_method: "deterministic-stratified-hash-v1",
    seed: options.seed,
    population_digest: populationDigest,
    pilot: options.pilot ?? false,
    rows: selected.map((lead, index) => ({
      sample_id: `dogfood-v2-${String(index + 1).padStart(3, "0")}`,
      topic_id: lead.topic_id,
      lead_kind: lead.lead_kind,
      evidence_band: evidenceBand(lead.evidence_count),
      freshness_band: freshnessBand(lead.latest_evidence_at, options.generatedAt),
    })),
  };
}

export interface DogfoodLabel extends BlindSampleRow {
  expected_candidate: Candidate;
  actual_candidate: Candidate;
  expected_direction_id: string | null;
  actual_direction_id: string | null;
  expected_lane: Lane | null;
  actual_lane: Lane | null;
  /** Human cannot decide from the permitted evidence. Excluded from scored denominators. */
  not_enough_evidence: boolean;
  /** Required for an expected exclusion; controlled free text keeps the reason inspectable. */
  exclusion_reason: string | null;
}

export interface DogfoodLabelFile {
  protocol_version: typeof DOGFOOD_V2_VERSION;
  generated_at: string;
  pilot: boolean;
  labels: DogfoodLabel[];
}

type Matrix = Record<string, Record<string, number>>;
const none = (value: string | null): string => value ?? "∅";
const matrix = (rows: DogfoodLabel[], expected: (row: DogfoodLabel) => string, actual: (row: DogfoodLabel) => string): Matrix => {
  const out: Matrix = {};
  for (const row of rows) {
    const e = expected(row); const a = actual(row);
    out[e] ??= {};
    out[e][a] = (out[e][a] ?? 0) + 1;
  }
  return out;
};

function validateLabel(row: DogfoodLabel): void {
  if (!row.sample_id || !row.topic_id || !row.lead_kind) throw new Error("标签缺少 sample_id、topic_id 或 lead_kind");
  if (row.not_enough_evidence && row.expected_candidate) throw new Error(`${row.sample_id}: not_enough_evidence 不可与 expected_candidate=true 并存`);
  if (!row.expected_candidate && !row.exclusion_reason) throw new Error(`${row.sample_id}: expected_candidate=false 必须说明 exclusion_reason`);
  for (const [side, candidate, direction, lane] of [
    ["expected", row.expected_candidate, row.expected_direction_id, row.expected_lane],
    ["actual", row.actual_candidate, row.actual_direction_id, row.actual_lane],
  ] as const) {
    if (!candidate && (direction !== null || lane !== null)) throw new Error(`${row.sample_id}: ${side} 非候选不得带 direction/lane`);
    if (candidate && !lane) throw new Error(`${row.sample_id}: ${side} 候选必须带 lane`);
    if (lane === "horizon" && direction !== null) throw new Error(`${row.sample_id}: horizon 候选不得带 direction`);
    if (candidate && lane !== "horizon" && direction === null) throw new Error(`${row.sample_id}: 非 horizon 候选必须带 direction`);
  }
}

export function validateDogfoodLabels(file: DogfoodLabelFile): void {
  if (file.protocol_version !== DOGFOOD_V2_VERSION) throw new Error("不支持的 dogfood 标签版本");
  if (!Array.isArray(file.labels) || !file.labels.length) throw new Error("标签文件必须包含非空 labels 数组");
  if (!Number.isFinite(Date.parse(file.generated_at))) throw new Error("标签文件必须有 generated_at 时间戳");
  const seen = new Set<string>();
  for (const row of file.labels) {
    validateLabel(row);
    if (seen.has(row.sample_id)) throw new Error(`重复 sample_id: ${row.sample_id}`);
    seen.add(row.sample_id);
  }
}

const ratio = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
const stratifiedCoverage = (rows: DogfoodLabel[], field: "topic_id" | "lead_kind" | "expected_lane"): Record<string, { total: number; scored: number; expected_candidates: number; actual_candidates: number }> => {
  const out: Record<string, { total: number; scored: number; expected_candidates: number; actual_candidates: number }> = {};
  for (const row of rows) {
    const key = field === "expected_lane" ? none(row.expected_lane) : row[field];
    out[key] ??= { total: 0, scored: 0, expected_candidates: 0, actual_candidates: 0 };
    const bucket = out[key];
    bucket.total++;
    if (!row.not_enough_evidence) {
      bucket.scored++;
      if (row.expected_candidate) bucket.expected_candidates++;
      if (row.actual_candidate) bucket.actual_candidates++;
    }
  }
  return out;
};

export interface DogfoodScore {
  protocol_version: typeof DOGFOOD_V2_VERSION;
  pilot: boolean;
  total: number;
  scored_total: number;
  excluded_not_enough_evidence: number;
  candidate: { true_positive: number; false_positive: number; false_negative: number; true_negative: number; precision: number | null; recall: number | null };
  stratified_coverage: { by_topic: Record<string, { total: number; scored: number; expected_candidates: number; actual_candidates: number }>; by_lead_kind: Record<string, { total: number; scored: number; expected_candidates: number; actual_candidates: number }>; by_expected_lane: Record<string, { total: number; scored: number; expected_candidates: number; actual_candidates: number }> };
  confusion_matrices: { candidate: Matrix; direction: Matrix; lane: Matrix };
  misclassification_attribution: Array<{ reason: string; count: number; sample_ids: string[] }>;
}

export function scoreDogfoodLabels(file: DogfoodLabelFile): DogfoodScore {
  validateDogfoodLabels(file);
  const scored = file.labels.filter((row) => !row.not_enough_evidence);
  const tp = scored.filter((row) => row.expected_candidate && row.actual_candidate).length;
  const fp = scored.filter((row) => !row.expected_candidate && row.actual_candidate).length;
  const fn = scored.filter((row) => row.expected_candidate && !row.actual_candidate).length;
  const tn = scored.filter((row) => !row.expected_candidate && !row.actual_candidate).length;
  const attribution = new Map<string, string[]>();
  const note = (reason: string, id: string): void => { const ids = attribution.get(reason) ?? []; ids.push(id); attribution.set(reason, ids); };
  for (const row of scored) {
    if (!row.expected_candidate && row.actual_candidate) note(`unexpected_candidate${row.exclusion_reason ? `:${row.exclusion_reason}` : ""}`, row.sample_id);
    else if (row.expected_candidate && !row.actual_candidate) note("missed_expected_candidate", row.sample_id);
    else if (row.expected_candidate && row.actual_candidate && row.expected_direction_id !== row.actual_direction_id && row.expected_lane !== row.actual_lane) note("direction_and_lane_mismatch", row.sample_id);
    else if (row.expected_candidate && row.actual_candidate && row.expected_direction_id !== row.actual_direction_id) note("wrong_direction", row.sample_id);
    else if (row.expected_candidate && row.actual_candidate && row.expected_lane !== row.actual_lane) note("wrong_lane", row.sample_id);
  }
  return {
    protocol_version: DOGFOOD_V2_VERSION,
    pilot: file.pilot,
    total: file.labels.length,
    scored_total: scored.length,
    excluded_not_enough_evidence: file.labels.length - scored.length,
    candidate: { true_positive: tp, false_positive: fp, false_negative: fn, true_negative: tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) },
    stratified_coverage: {
      by_topic: stratifiedCoverage(file.labels, "topic_id"),
      by_lead_kind: stratifiedCoverage(file.labels, "lead_kind"),
      by_expected_lane: stratifiedCoverage(file.labels, "expected_lane"),
    },
    confusion_matrices: {
      candidate: matrix(scored, (row) => String(row.expected_candidate), (row) => String(row.actual_candidate)),
      direction: matrix(scored, (row) => none(row.expected_direction_id), (row) => none(row.actual_direction_id)),
      lane: matrix(scored, (row) => none(row.expected_lane), (row) => none(row.actual_lane)),
    },
    misclassification_attribution: [...attribution.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, sample_ids]) => ({ reason, count: sample_ids.length, sample_ids })),
  };
}
