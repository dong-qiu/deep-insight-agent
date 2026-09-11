/** Private, read-only material for an Owner's blind review. */
import {
  createBlindSampleManifest,
  manifestDigest,
  qualifiedSnapshotDigest,
  selectBlindSampleLeads,
  validateManifest,
  validateQualifiedTechLeadSnapshot,
  type BlindSampleManifest,
  type QualifiedTechLeadSnapshot,
} from "./dogfood-v2.js";

export const OWNER_REVIEW_PACK_VERSION = "technology-opportunity-owner-review-pack-v1" as const;

export interface OwnerReviewSample {
  sample_id: string;
  lead_id: string;
  topic: string;
  kind: string;
  title: string;
  summary: string;
  evidence_count: number;
  pass_evidence_count: number;
  latest_evidence_at: string;
}

export interface OwnerReviewPack {
  protocol_version: typeof OWNER_REVIEW_PACK_VERSION;
  input_digests: {
    qualified_tech_leads_snapshot: string;
    blind_sample_manifest: string;
  };
  allowed_direction_ids: string[];
  samples: OwnerReviewSample[];
}

/**
 * Rebuild the manifest exactly, then pair each blind row with its selected lead.
 * This consumes only offline caller-provided data and deliberately excludes rules.
 */
export function createOwnerReviewPack(
  snapshot: QualifiedTechLeadSnapshot,
  manifest: BlindSampleManifest,
  seed: string,
): OwnerReviewPack {
  validateQualifiedTechLeadSnapshot(snapshot);
  validateManifest(manifest);
  if (typeof seed !== "string" || seed.length === 0 || seed !== manifest.seed) {
    throw new Error("owner_review_pack_seed_mismatch");
  }

  const rebuilt = createBlindSampleManifest(snapshot, {
    generatedAt: manifest.generated_at,
    seed,
    count: manifest.sample_size,
    pilot: manifest.pilot,
  });
  if (manifestDigest(rebuilt) !== manifestDigest(manifest)) {
    throw new Error("owner_review_pack_snapshot_or_manifest_mismatch");
  }

  const selected = selectBlindSampleLeads(snapshot, {
    generatedAt: manifest.generated_at,
    seed,
    count: manifest.sample_size,
    pilot: manifest.pilot,
  }).map((resolved, index) => {
    const row = rebuilt.rows[index];
    return {
      sample_id: row.sample_id,
      lead_id: resolved.lead_id,
      topic: resolved.topic_id,
      kind: resolved.lead_kind,
      title: resolved.title,
      summary: resolved.summary,
      evidence_count: resolved.evidence_count,
      pass_evidence_count: resolved.pass_evidence_count,
      latest_evidence_at: resolved.latest_evidence_at,
    };
  });

  if (new Set(selected.map((sample) => sample.lead_id)).size !== selected.length) {
    throw new Error("owner_review_pack_duplicate_selected_lead");
  }

  return {
    protocol_version: OWNER_REVIEW_PACK_VERSION,
    input_digests: {
      qualified_tech_leads_snapshot: qualifiedSnapshotDigest(snapshot),
      blind_sample_manifest: manifestDigest(manifest),
    },
    allowed_direction_ids: snapshot.mapping_directions
      .filter((direction) => direction.status !== "retired")
      .map((direction) => direction.direction_id)
      .sort(),
    samples: selected,
  };
}
