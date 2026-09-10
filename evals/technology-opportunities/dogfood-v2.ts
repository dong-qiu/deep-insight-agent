/**
 * Dogfood protocol v2 for the deterministic TechLead → opportunity projection.
 *
 * This module deliberately consumes an already-qualified TechLead snapshot; it never opens a
 * production database, changes mapping rules, or creates an opportunity.  The blind manifest
 * excludes both source text and system outputs so a reviewer can record expectations first.
 */
import { createHash } from "node:crypto";

export const DOGFOOD_V2_VERSION = "technology-opportunity-dogfood-v2" as const;
export const QUALIFIED_SNAPSHOT_VERSION = "qualified-tech-leads-snapshot-v1" as const;
export type Lane = "core" | "adjacent" | "horizon" | "challenge";
export type Candidate = boolean;

export interface QualifiedLeadForSampling {
  /** Private, stable identifier. It is never emitted into the blind manifest. */
  lead_id: string;
  topic_id: string;
  lead_kind: string;
  evidence_count: number;
  latest_evidence_at: string;
  /** Exported only by the qualified-list reader; dismissed rows are never valid input. */
  status?: "recommended" | "watching";
  /** Attests that the exported row still has a current pass evidence binding. */
  pass_evidence_count?: number;
}

/**
 * The only acceptable source for a real sample.  This is deliberately an attestation rather
 * than a convenient JSON array: a 500-row UI view, an opportunity-pool export, or a stale
 * reader projection must fail before it can influence a dogfood denominator.
 */
export interface QualifiedTechLeadSnapshot {
  snapshot_version: typeof QUALIFIED_SNAPSHOT_VERSION;
  snapshot_at: string;
  source: "listPlanningTechLeads";
  qualification: "current_pass_evidence_and_not_dismissed";
  pagination: "unbounded";
  total_count: number;
  leads: QualifiedLeadForSampling[];
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
  /** SHA-256 over every canonical field in the attested, complete input snapshot. */
  snapshot_digest: string;
  /** SHA-256 over the private deterministic selected rows, used when actuals are materialized. */
  selection_digest: string;
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
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
function exactKeys(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(code);
}
const isLane = (value: unknown): value is Lane => value === "core" || value === "adjacent" || value === "horizon" || value === "challenge";
const isBand = (value: unknown, values: readonly string[]): boolean => typeof value === "string" && values.includes(value);
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
  if (population.some((lead) => !lead.topic_id || !lead.lead_kind || !Number.isInteger(lead.evidence_count) || lead.evidence_count < 1 || !Number.isFinite(Date.parse(lead.latest_evidence_at)))) {
    throw new Error("合格 TechLead 缺少 topic、kind、证据数或有效时间戳");
  }
}

export function validateQualifiedTechLeadSnapshot(snapshot: QualifiedTechLeadSnapshot): void {
  exactKeys(snapshot, ["leads", "pagination", "qualification", "snapshot_at", "snapshot_version", "source", "total_count"], "qualified_snapshot_schema_invalid");
  if (snapshot.snapshot_version !== QUALIFIED_SNAPSHOT_VERSION || snapshot.source !== "listPlanningTechLeads" || snapshot.qualification !== "current_pass_evidence_and_not_dismissed" || snapshot.pagination !== "unbounded") throw new Error("qualified_snapshot_wrong_source_or_attestation");
  if (!Number.isFinite(Date.parse(snapshot.snapshot_at)) || !Number.isInteger(snapshot.total_count) || snapshot.total_count < 1 || !Array.isArray(snapshot.leads) || snapshot.total_count !== snapshot.leads.length) throw new Error("qualified_snapshot_truncated_or_invalid");
  for (const lead of snapshot.leads) {
    exactKeys(lead, ["evidence_count", "lead_id", "lead_kind", "latest_evidence_at", "pass_evidence_count", "status", "topic_id"], "qualified_snapshot_lead_schema_invalid");
    if (lead.status !== "recommended" && lead.status !== "watching") throw new Error("qualified_snapshot_unqualified_lead");
    const passEvidenceCount = lead.pass_evidence_count;
    if (typeof passEvidenceCount !== "number" || !Number.isInteger(passEvidenceCount) || passEvidenceCount < 1) throw new Error("qualified_snapshot_unqualified_lead");
  }
  assertPopulation(snapshot.leads, { generatedAt: snapshot.snapshot_at, seed: "attestation", count: 1 });
}

export const qualifiedSnapshotDigest = (snapshot: QualifiedTechLeadSnapshot): string => {
  validateQualifiedTechLeadSnapshot(snapshot);
  return digest(canonical(snapshot));
};

/**
 * Select from all qualified leads, not from TechnologyOpportunity rows.  Each non-empty
 * topic/kind stratum receives one row before the next round, then ties are resolved by a
 * seeded hash.  The result carries only review-relevant buckets, never IDs, title, quote or URL.
 */
export function createBlindSampleManifest(snapshot: QualifiedTechLeadSnapshot, options: SampleOptions): BlindSampleManifest {
  validateQualifiedTechLeadSnapshot(snapshot);
  const population = snapshot.leads;
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
  const populationDigest = digest(canonical([...population].sort((a, b) => a.lead_id.localeCompare(b.lead_id))));
  return {
    protocol_version: DOGFOOD_V2_VERSION,
    generated_at: options.generatedAt,
    population_source: "qualified_tech_leads",
    population_size: population.length,
    sample_size: selected.length,
    selection_method: "deterministic-stratified-hash-v1",
    seed: options.seed,
    population_digest: populationDigest,
    snapshot_digest: qualifiedSnapshotDigest(snapshot),
    selection_digest: digest(canonical(selected)),
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
  /** Digest from the immutable blind manifest. */
  manifest_digest: string;
  /** Commitment emitted before actual values are materialized. */
  expected_commitment: string;
  sealed_at: string;
  labels: DogfoodLabel[];
}

export type ExpectedLabel = Omit<DogfoodLabel, "actual_candidate" | "actual_direction_id" | "actual_lane">;
export interface SealedExpectedArtifact {
  protocol_version: typeof DOGFOOD_V2_VERSION;
  manifest_digest: string;
  sealed_at: string;
  expected_commitment: string;
  labels: ExpectedLabel[];
}

const manifestDigest = (manifest: BlindSampleManifest): string => digest(canonical(manifest));
const expectedCommitment = (rows: ExpectedLabel[]): string => digest(canonical(rows));

function validateManifest(manifest: BlindSampleManifest): void {
  exactKeys(manifest, ["generated_at", "pilot", "population_digest", "population_size", "population_source", "protocol_version", "rows", "sample_size", "seed", "selection_digest", "selection_method", "snapshot_digest"], "blind_manifest_schema_invalid");
  if (manifest.protocol_version !== DOGFOOD_V2_VERSION || manifest.population_source !== "qualified_tech_leads" || manifest.selection_method !== "deterministic-stratified-hash-v1" || !Number.isInteger(manifest.population_size) || !Number.isInteger(manifest.sample_size) || manifest.sample_size !== manifest.rows.length || !Number.isFinite(Date.parse(manifest.generated_at)) || typeof manifest.snapshot_digest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.snapshot_digest) || !/^[a-f0-9]{64}$/.test(manifest.selection_digest)) throw new Error("blind_manifest_schema_invalid");
  const ids = new Set<string>();
  for (const row of manifest.rows) {
    exactKeys(row, ["evidence_band", "freshness_band", "lead_kind", "sample_id", "topic_id"], "blind_manifest_row_schema_invalid");
    if (!row.sample_id || !row.topic_id || !row.lead_kind || !isBand(row.evidence_band, ["1", "2-3", "4+"]) || !isBand(row.freshness_band, ["0-48h", "49h-14d", "14d+"]) || ids.has(row.sample_id)) throw new Error("blind_manifest_row_schema_invalid");
    ids.add(row.sample_id);
  }
}

/** Create and persist this artifact before querying/mapping any actuals. It contains neither IDs nor actual outcomes. */
export function createSealedExpectedArtifact(manifest: BlindSampleManifest, labels: ExpectedLabel[], sealedAt: string): SealedExpectedArtifact {
  validateManifest(manifest);
  if (!Number.isFinite(Date.parse(sealedAt))) throw new Error("sealed_at_invalid");
  const provisional = labels.map((label) => ({ ...label, actual_candidate: false, actual_direction_id: null, actual_lane: null }));
  validateRowsAgainstManifest(provisional, manifest, true);
  return { protocol_version: DOGFOOD_V2_VERSION, manifest_digest: manifestDigest(manifest), sealed_at: sealedAt, expected_commitment: expectedCommitment(labels), labels };
}

export interface ActualMapping { candidate: boolean; direction_id: string | null; lane: Lane | null; }

/**
 * Materialization is intentionally impossible without both the attested snapshot and the
 * private lead-id mapping.  The public manifest never contains either.  Rebuilding the
 * manifest from that same snapshot catches reordered rows, changed strata and source swaps.
 */
export function materializeActualLabels(snapshot: QualifiedTechLeadSnapshot, manifest: BlindSampleManifest, sealed: SealedExpectedArtifact, actualByLeadId: Readonly<Record<string, ActualMapping>>, generatedAt: string): DogfoodLabelFile {
  validateQualifiedTechLeadSnapshot(snapshot);
  validateManifest(manifest);
  if (qualifiedSnapshotDigest(snapshot) !== manifest.snapshot_digest) throw new Error("actual_snapshot_digest_mismatch");
  const rebuilt = createBlindSampleManifest(snapshot, { generatedAt: manifest.generated_at, seed: manifest.seed, count: manifest.sample_size, pilot: manifest.pilot });
  if (canonical(rebuilt) !== canonical(manifest)) throw new Error("actual_manifest_not_immutable");
  if (sealed.manifest_digest !== manifestDigest(manifest) || expectedCommitment(sealed.labels) !== sealed.expected_commitment) throw new Error("sealed_expected_mutated");
  const selected = (() => {
    const strata = new Map<string, QualifiedLeadForSampling[]>();
    for (const lead of snapshot.leads) { const key = `${lead.topic_id}\u0000${lead.lead_kind}`; const bucket = strata.get(key) ?? []; bucket.push(lead); strata.set(key, bucket); }
    for (const [key, bucket] of strata) bucket.sort((a, b) => stableOrder(manifest.seed, `${key}\u0000${a.lead_id}`).localeCompare(stableOrder(manifest.seed, `${key}\u0000${b.lead_id}`)));
    const ordered = [...strata.keys()].sort((a, b) => stableOrder(manifest.seed, a).localeCompare(stableOrder(manifest.seed, b)));
    const result: QualifiedLeadForSampling[] = [];
    for (let round = 0; result.length < manifest.sample_size; round++) for (const key of ordered) { const lead = strata.get(key)![round]; if (lead) result.push(lead); if (result.length === manifest.sample_size) break; }
    return result;
  })();
  if (digest(canonical(selected)) !== manifest.selection_digest || selected.some((lead) => !(lead.lead_id in actualByLeadId))) throw new Error("actual_mapping_mismatch");
  const file: DogfoodLabelFile = {
    protocol_version: DOGFOOD_V2_VERSION, generated_at: generatedAt, pilot: manifest.pilot, manifest_digest: manifestDigest(manifest), sealed_at: sealed.sealed_at, expected_commitment: sealed.expected_commitment,
    labels: sealed.labels.map((label, index) => {
      const actual = actualByLeadId[selected[index].lead_id];
      return { ...label, actual_candidate: actual.candidate, actual_direction_id: actual.direction_id, actual_lane: actual.lane };
    }),
  };
  validateDogfoodLabels(file, manifest, sealed);
  return file;
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
  exactKeys(row, ["actual_candidate", "actual_direction_id", "actual_lane", "evidence_band", "expected_candidate", "expected_direction_id", "expected_lane", "exclusion_reason", "freshness_band", "lead_kind", "not_enough_evidence", "sample_id", "topic_id"], "label_row_schema_invalid");
  if (!row.sample_id || !row.topic_id || !row.lead_kind || typeof row.expected_candidate !== "boolean" || typeof row.actual_candidate !== "boolean" || typeof row.not_enough_evidence !== "boolean" || (row.expected_direction_id !== null && typeof row.expected_direction_id !== "string") || (row.actual_direction_id !== null && typeof row.actual_direction_id !== "string") || (row.exclusion_reason !== null && typeof row.exclusion_reason !== "string") || (row.expected_lane !== null && !isLane(row.expected_lane)) || (row.actual_lane !== null && !isLane(row.actual_lane)) || !isBand(row.evidence_band, ["1", "2-3", "4+"]) || !isBand(row.freshness_band, ["0-48h", "49h-14d", "14d+"])) throw new Error("label_row_schema_invalid");
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

function validateRowsAgainstManifest(rows: DogfoodLabel[], manifest: BlindSampleManifest, expectedOnly = false): void {
  if (rows.length !== manifest.rows.length) throw new Error("label_manifest_row_count_mismatch");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; const manifestRow = manifest.rows[index];
    validateLabel(row);
    if (row.sample_id !== manifestRow.sample_id || row.topic_id !== manifestRow.topic_id || row.lead_kind !== manifestRow.lead_kind || row.evidence_band !== manifestRow.evidence_band || row.freshness_band !== manifestRow.freshness_band) throw new Error("label_manifest_row_mismatch");
    if (expectedOnly && (row.actual_candidate || row.actual_direction_id !== null || row.actual_lane !== null)) throw new Error("sealed_artifact_actual_leak");
  }
}

export function validateDogfoodLabels(file: DogfoodLabelFile, manifest: BlindSampleManifest, sealed?: SealedExpectedArtifact): void {
  exactKeys(file, ["expected_commitment", "generated_at", "labels", "manifest_digest", "pilot", "protocol_version", "sealed_at"], "label_file_schema_invalid");
  validateManifest(manifest);
  if (file.protocol_version !== DOGFOOD_V2_VERSION || typeof file.pilot !== "boolean" || !Array.isArray(file.labels) || !file.labels.length || !Number.isFinite(Date.parse(file.generated_at)) || !Number.isFinite(Date.parse(file.sealed_at)) || file.manifest_digest !== manifestDigest(manifest) || !/^[a-f0-9]{64}$/.test(file.expected_commitment)) throw new Error("label_file_schema_invalid");
  if (file.pilot !== manifest.pilot) throw new Error("label_manifest_pilot_mismatch");
  const seen = new Set<string>();
  for (const row of file.labels) {
    validateLabel(row);
    if (seen.has(row.sample_id)) throw new Error(`重复 sample_id: ${row.sample_id}`);
    seen.add(row.sample_id);
  }
  validateRowsAgainstManifest(file.labels, manifest);
  const expected = file.labels.map(({ actual_candidate: _actualCandidate, actual_direction_id: _actualDirection, actual_lane: _actualLane, ...row }) => row);
  if (expectedCommitment(expected) !== file.expected_commitment) throw new Error("sealed_expected_mutated");
  if (sealed) {
    exactKeys(sealed, ["expected_commitment", "labels", "manifest_digest", "protocol_version", "sealed_at"], "sealed_artifact_schema_invalid");
    if (sealed.protocol_version !== DOGFOOD_V2_VERSION || sealed.manifest_digest !== file.manifest_digest || sealed.expected_commitment !== file.expected_commitment || sealed.sealed_at !== file.sealed_at || expectedCommitment(sealed.labels) !== sealed.expected_commitment || canonical(sealed.labels) !== canonical(expected)) throw new Error("sealed_expected_mutated");
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

export function scoreDogfoodLabels(file: DogfoodLabelFile, manifest: BlindSampleManifest, sealed?: SealedExpectedArtifact): DogfoodScore {
  validateDogfoodLabels(file, manifest, sealed);
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
