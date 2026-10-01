/** Current reader evidence: a historical pass/support result is not enough after content changes.
 * A context is scoped to one synchronous read operation; never retain positive file checks across requests. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_BODY_CHARS, MAX_TRANSCRIPT_CHARS, contentHash, normalizeBody } from "../sources/normalize.js";
import { compareKey } from "../runtime/text-normalize.js";
import type { DB } from "./index.js";

export interface CurrentSourceEvidence {
  content_item_id: string;
  raw_ref: string;
  body: string;
  body_kind: string;
  content_hash: string;
}
export interface CurrentCitationEvidence extends CurrentSourceEvidence { quote: string }
export interface ReaderEvidenceContext {
  preload(rows: readonly CurrentCitationEvidence[]): void;
  hasVerifiedSource(row: CurrentSourceEvidence): boolean;
  accepts(row: CurrentCitationEvidence): boolean;
}

interface RawArchiveEffect {
  status: string;
  idempotency_key: string;
  artifact_manifest: string;
}
interface Artifact { target: string; sha256: string; size: number }

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const CONTENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET = /^[A-Za-z0-9_-]{1,128}\.[a-f0-9]{64}\.txt$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Only the exact currently bound effect may authorize the row. An older unknown effect does not
 * veto a later committed revision, and an older committed effect cannot authorize a pending one. */
export function createReaderEvidenceContext(db: DB): ReaderEvidenceContext {
  // A pre-migration/isolated database must hide evidence, not turn a reader route into a 500.
  const hasEffectTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_effect'").get();
  const hasContentBinding = hasEffectTable && (db.prepare("PRAGMA table_info(generation_effect)").all() as { name: string }[])
    .some((column) => column.name === "raw_content_id");
  if (!hasContentBinding) return { preload: () => {}, hasVerifiedSource: () => false, accepts: () => false };
  const effects = db.prepare(`SELECT status,idempotency_key,artifact_manifest FROM generation_effect
    WHERE kind='raw_archive' AND raw_content_id=?`);
  const effectCache = new Map<string, RawArchiveEffect[]>();
  const sourceCache = new Map<string, boolean>();

  function preload(rows: readonly CurrentCitationEvidence[]): void {
    const ids = [...new Set(rows.map((row) => row.content_item_id))]
      .filter((id) => CONTENT_ID.test(id) && !effectCache.has(id));
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      for (const id of chunk) effectCache.set(id, []);
      const sql = `SELECT raw_content_id,status,idempotency_key,artifact_manifest FROM generation_effect
        WHERE kind='raw_archive' AND raw_content_id IN (${chunk.map(() => "?").join(",")})`;
      for (const effect of db.prepare(sql).all(...chunk) as Array<RawArchiveEffect & { raw_content_id: string }>) {
        effectCache.get(effect.raw_content_id)?.push(effect);
      }
    }
  }

  function sourceAvailable(row: CurrentSourceEvidence): boolean {
    if (!CONTENT_ID.test(row.content_item_id) || !SHA256.test(row.content_hash)
      || typeof row.body !== "string" || !row.body.trim()
      || !["article", "show_notes", "transcript"].includes(row.body_kind)
      || contentHash(row.body) !== row.content_hash) return false;
    const matching: Array<{ effect: RawArchiveEffect; artifact: Artifact }> = [];
    const contentEffects = effectCache.get(row.content_item_id) ?? effects.all(row.content_item_id) as RawArchiveEffect[];
    for (const effect of contentEffects) {
      let parsed: unknown;
      try { parsed = JSON.parse(effect.artifact_manifest); } catch { continue; }
      if (!Array.isArray(parsed) || parsed.length !== 1) continue;
      const artifact = parsed[0] as Artifact;
      if (!artifact || typeof artifact.target !== "string" || !TARGET.test(artifact.target)
        || artifact.target !== `${row.content_item_id}.${artifact.sha256}.txt`
        || typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.size) || artifact.size < 0
        || row.raw_ref !== join("raw", artifact.target)
        || effect.idempotency_key !== `raw_archive:${row.content_item_id}:${artifact.sha256}`) continue;
      matching.push({ effect, artifact });
    }
    if (matching.length !== 1 || matching[0]!.effect.status !== "committed") return false;
    const { artifact } = matching[0]!;
    let bytes: Buffer;
    try {
      const rawRoot = realpathSync(resolve(process.env.DATA_DIR ?? ".data", "raw"));
      const file = join(rawRoot, artifact.target);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== artifact.size) return false;
        bytes = readFileSync(fd);
      } finally { closeSync(fd); }
    } catch { return false; }
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) return false;
    let envelope: unknown;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { return false; }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
    const archived = envelope as Record<string, unknown>;
    const origin = archived.source_body_origin;
    const allowedKeys = new Set(["schema_version", "source_body_origin", "source_body", "source_body_kind",
      "source_item_raw", "article_html", "structured_body_sha256"]);
    if (archived.schema_version !== "content-raw-archive-v1"
      || typeof archived.source_body !== "string"
      || typeof archived.source_item_raw !== "string"
      || !["feed", "article_page", "transcript"].includes(origin as string)
      || (origin === "article_page" ? typeof archived.article_html !== "string"
        : Object.hasOwn(archived, "article_html"))
      || (origin === "transcript") !== (row.body_kind === "transcript")
      || Object.keys(archived).some((key) => !allowedKeys.has(key))
      || archived.source_body_kind !== row.body_kind
      || archived.structured_body_sha256 !== row.content_hash) return false;
    const cap = row.body_kind === "transcript" ? MAX_TRANSCRIPT_CHARS : MAX_BODY_CHARS;
    return normalizeBody(archived.source_body).slice(0, cap) === row.body;
  }

  function hasVerifiedSource(row: CurrentSourceEvidence): boolean {
    let available = sourceCache.get(row.content_item_id);
    if (available === undefined) {
      available = sourceAvailable(row);
      sourceCache.set(row.content_item_id, available);
    }
    return available;
  }

  return {
    preload,
    hasVerifiedSource,
    accepts(row) {
      if (typeof row.quote !== "string" || !row.quote.trim()) return false;
      return hasVerifiedSource(row) && compareKey(row.body).includes(compareKey(row.quote));
    },
  };
}
