/**
 * Create the no-body manifest for a candidate A1 v2 source snapshot.  The quality JSONL remains
 * local/ignored and is uploaded separately to controlled storage; this artifact makes the exact
 * item/URL/body-hash population auditable without copying source text into Git.
 *
 * Usage: tsx evals/prepare-controlled-v2-snapshot.ts <quality.local.jsonl> <out-dir> <snapshot-id> [collector-or-builder-manifest...]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { contentHash, normalizeBody } from "../src/lib/sources/normalize.js";

interface SnapshotItem {
  id?: unknown;
  source_id?: unknown;
  url?: unknown;
  body?: unknown;
  content_hash?: unknown;
  raw_ref?: unknown;
  fetch_status?: unknown;
  fetched_at?: unknown;
  published_at?: unknown;
}

interface SnapshotCase {
  topic?: { id?: unknown; name?: unknown };
  items?: SnapshotItem[];
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

interface RawArchive {
  schema_version?: unknown;
  source_body_origin?: unknown;
  source_body?: unknown;
  article_html?: unknown;
  structured_body_sha256?: unknown;
}

/** Fail closed: a v2 candidate must prove the stored body is derivable from a retained source archive. */
function verifySourceArchive(item: SnapshotItem, caseIndex: number, itemIndex: number) {
  const label = `quality case ${caseIndex} item ${itemIndex}`;
  if (item.fetch_status !== "ok") throw new Error(`${label} 的 fetch_status 必须为 ok`);
  if (typeof item.content_hash !== "string" || !item.content_hash) throw new Error(`${label} 缺少 content_hash`);
  if (typeof item.raw_ref !== "string" || !item.raw_ref || !existsSync(item.raw_ref)) {
    throw new Error(`${label} 缺少可读取的 raw_ref`);
  }
  const rawBytes = readFileSync(item.raw_ref);
  let archive: RawArchive;
  try {
    archive = JSON.parse(rawBytes.toString("utf8")) as RawArchive;
  } catch {
    throw new Error(`${label} 的 raw_ref 不是受控 raw archive`);
  }
  if (archive.schema_version !== "content-raw-archive-v1" || typeof archive.source_body !== "string"
    || typeof archive.structured_body_sha256 !== "string") {
    throw new Error(`${label} 的 raw archive 缺少可验证正文绑定`);
  }
  if (archive.source_body_origin !== "feed" && archive.source_body_origin !== "article_page" && archive.source_body_origin !== "transcript") {
    throw new Error(`${label} 的 raw archive 含未知 source_body_origin`);
  }
  if (archive.source_body_origin === "article_page" && typeof archive.article_html !== "string") {
    throw new Error(`${label} 的文章 archive 缺少 article_html`);
  }
  // `contentHash` normalizes its argument so it remains stable for consumers that pass source
  // markup.  The stored body is already normalized, however, and some nested HTML entities make
  // that normalization non-idempotent.  Prove derivation by comparing the one-pass normalized
  // archive input to the stored body, then validate the stored body's declared content hash.
  if (typeof item.body !== "string"
    || normalizeBody(archive.source_body) !== item.body
    || contentHash(item.body) !== item.content_hash
    || archive.structured_body_sha256 !== item.content_hash
  ) {
    throw new Error(`${label} 的 body/content_hash/raw archive 绑定不一致`);
  }
  return {
    raw_archive_sha256: sha256(rawBytes),
    raw_archive_byte_length: rawBytes.length,
    source_body_origin: archive.source_body_origin,
  };
}

const [qualityPath, outDir, snapshotId, ...evidencePaths] = process.argv.slice(2);
if (!qualityPath || !outDir || !snapshotId) {
  console.error("用法：tsx evals/prepare-controlled-v2-snapshot.ts <quality.local.jsonl> <out-dir> <snapshot-id> [collector-or-builder-manifest...]");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{2,80}$/u.test(snapshotId)) {
  console.error("snapshot-id 必须为 3–81 位小写字母、数字或连字符");
  process.exit(2);
}
if (existsSync(outDir)) {
  console.error("输出目录必须不存在，拒绝覆盖候选 snapshot manifest");
  process.exit(2);
}

const qualityBytes = readFileSync(qualityPath);
const quality = qualityBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as SnapshotCase);
const itemIds = new Set<string>();
const urls = new Set<string>();
const sourceCounts = new Map<string, number>();
const topicCounts = new Map<string, number>();
const items: Array<Record<string, unknown>> = [];
const evidenceNames = new Set<string>();
const collection_evidence = evidencePaths.map((path) => {
  const name = basename(path);
  if (!name || evidenceNames.has(name)) throw new Error(`collector/builder evidence 文件名重复：${name}`);
  evidenceNames.add(name);
  const bytes = readFileSync(path);
  return { name, sha256: sha256(bytes), byte_length: bytes.length };
});

for (const [caseIndex, entry] of quality.entries()) {
  const topicId = entry.topic?.id;
  if (typeof topicId !== "string" || !topicId) throw new Error(`quality case ${caseIndex} 缺少 topic.id`);
  if (!Array.isArray(entry.items) || !entry.items.length) throw new Error(`quality case ${caseIndex} 缺少 items`);
  for (const [itemIndex, item] of entry.items.entries()) {
    if (typeof item.id !== "string" || !item.id || typeof item.source_id !== "string" || !item.source_id
      || typeof item.url !== "string" || !item.url || typeof item.body !== "string" || !item.body) {
      throw new Error(`quality case ${caseIndex} item ${itemIndex} 缺少 id/source_id/url/body`);
    }
    const archiveEvidence = verifySourceArchive(item, caseIndex, itemIndex);
    if (itemIds.has(item.id) || urls.has(item.url)) throw new Error(`quality snapshot 含重复 content id 或 URL：${item.id}`);
    itemIds.add(item.id); urls.add(item.url);
    sourceCounts.set(item.source_id, (sourceCounts.get(item.source_id) ?? 0) + 1);
    topicCounts.set(topicId, (topicCounts.get(topicId) ?? 0) + 1);
    items.push({
      content_item_id: item.id,
      source_id: item.source_id,
      url: item.url,
      topic_id: topicId,
      body_sha256: sha256(item.body),
      content_hash: item.content_hash,
      ...archiveEvidence,
      fetched_at: typeof item.fetched_at === "string" ? item.fetched_at : null,
      published_at: typeof item.published_at === "string" ? item.published_at : null,
    });
  }
}

mkdirSync(outDir, { recursive: false });
const manifest = {
  schema_version: "a1-controlled-source-snapshot-v2",
  status: "candidate_pending_labels",
  snapshot_id: snapshotId,
  generated_at: new Date().toISOString(),
  quality_input: {
    sha256: sha256(qualityBytes),
    byte_length: qualityBytes.length,
    item_count: items.length,
    unique_topic_count: topicCounts.size,
    content_item_ids_sha256: sha256([...itemIds].sort().join("\n")),
  },
  source_counts: Object.fromEntries([...sourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  topic_counts: Object.fromEntries([...topicCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  collection_evidence,
  dedupe_key: "content_item_id_or_url",
  license_and_retention: {
    status: "pending_source_terms_review",
    intended_use: "internal A1 quality evaluation only; no redistribution",
    storage_retention: "S3 Object Lock Compliance default retention=90d; lifecycle eligible from day 91",
  },
  items,
};
const manifestPath = resolve(outDir, "source-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已写 ${manifestPath}（${items.length} 条、${topicCounts.size} 主题；不含正文）`);
