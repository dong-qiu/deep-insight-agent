/**
 * Create a snapshot-specific prototype owner-decision record.  This is deliberately not a
 * formal source-terms decision and cannot make a v2 dataset lock eligible.
 *
 * Usage:
 *   tsx evals/prepare-a1-v2-prototype-owner-decision.ts <source-manifest.json> <immutable-s3-manifest-reference> <object-lock-retain-until> <record-id> <out.json>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface SourceManifest {
  snapshot_id?: unknown;
  source_counts?: unknown;
}

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

const [manifestPath, manifestReference, retainUntil, recordId, outPath] = process.argv.slice(2);
if (!manifestPath || !manifestReference || !retainUntil || !recordId || !outPath) {
  console.error("用法：tsx evals/prepare-a1-v2-prototype-owner-decision.ts <source-manifest.json> <immutable-s3-manifest-reference> <object-lock-retain-until> <record-id> <out.json>");
  process.exit(2);
}
if (existsSync(outPath)) {
  console.error("输出 owner decision 已存在；拒绝覆盖");
  process.exit(2);
}
if (!/^s3:\/\/[^/?]+\/.*\/source-manifest\.json\?versionId=[^&]+$/u.test(manifestReference)) {
  console.error("source manifest reference 必须是带 versionId 的不可变 S3 source-manifest.json 引用");
  process.exit(2);
}
if (!/^[A-Z0-9-]{8,120}$/u.test(recordId)) {
  console.error("record id 必须为 8–120 位大写字母、数字或连字符");
  process.exit(2);
}
const retainAt = new Date(retainUntil);
if (Number.isNaN(retainAt.valueOf()) || retainAt.valueOf() <= Date.now()) {
  console.error("object lock retain-until 必须是未来的 UTC 时间");
  process.exit(2);
}

const manifestBytes = readFileSync(manifestPath);
let manifest: SourceManifest;
try {
  manifest = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
} catch {
  throw new Error("source manifest 不是合法 JSON");
}
if (typeof manifest.snapshot_id !== "string" || !manifest.snapshot_id) {
  throw new Error("source manifest 缺少 snapshot_id");
}
if (!manifest.source_counts || typeof manifest.source_counts !== "object" || Array.isArray(manifest.source_counts)) {
  throw new Error("source manifest 缺少 source_counts");
}
const sources = Object.keys(manifest.source_counts).sort();
if (!sources.length || sources.some((source) => !source)) {
  throw new Error("source manifest 缺少有效 source id");
}

const decision = {
  schema_version: "a1-v2-source-terms-owner-decision-v1",
  record_id: recordId,
  status: "approved_all",
  decision_at: new Date().toISOString(),
  scope: {
    snapshot_id: manifest.snapshot_id,
    source_manifest_reference: manifestReference,
    source_manifest_sha256: sha256(manifestBytes),
    object_lock_retain_until: retainAt.toISOString(),
  },
  owner_decision: {
    owner_ref: "project-owner:dongqiu",
    basis: "prototype-stage owner authorization for internal A1 quality evaluation",
    not_legal_advice: true,
    permitted_uses: [
      "internal A1 quality evaluation",
      "human consistency-label review in the controlled environment",
      "model evaluation of the retained full text",
    ],
    prohibited_uses: [
      "redistribution",
      "public display of source bodies",
      "model training",
      "production publication approval",
    ],
  },
  recording: {
    recorder_kind: "system",
    recorder_ref: "codex-session",
    independent_human_recorder: false,
    note: "This prototype record deliberately does not claim independent legal review. A formal-release decision must replace it with source-specific terms/permission evidence and an independent recorder.",
  },
  sources,
  retention: {
    permitted_retention_until: retainAt.toISOString(),
    rule: "must not be shortened below the immutable Object Lock retention of this named candidate",
  },
  prototype_only: true,
  lock_eligible: false,
};
writeFileSync(outPath, `${JSON.stringify(decision, null, 2)}\n`);
console.log(`已写 ${outPath}（snapshot=${manifest.snapshot_id}；${sources.length} 个 source；prototype-only、lock_eligible=false）`);
