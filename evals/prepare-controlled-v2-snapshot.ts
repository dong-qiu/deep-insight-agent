/**
 * Create the no-body manifest for a candidate A1 v2 source snapshot.  The quality JSONL remains
 * local/ignored and is uploaded separately to controlled storage; this artifact makes the exact
 * item/URL/body-hash population auditable without copying source text into Git.
 *
 * Usage: tsx evals/prepare-controlled-v2-snapshot.ts <quality.local.jsonl> <out-dir> <snapshot-id>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface SnapshotItem {
  id?: unknown;
  source_id?: unknown;
  url?: unknown;
  body?: unknown;
  content_hash?: unknown;
  fetched_at?: unknown;
  published_at?: unknown;
}

interface SnapshotCase {
  topic?: { id?: unknown; name?: unknown };
  items?: SnapshotItem[];
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const [qualityPath, outDir, snapshotId] = process.argv.slice(2);
if (!qualityPath || !outDir || !snapshotId) {
  console.error("用法：tsx evals/prepare-controlled-v2-snapshot.ts <quality.local.jsonl> <out-dir> <snapshot-id>");
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

for (const [caseIndex, entry] of quality.entries()) {
  const topicId = entry.topic?.id;
  if (typeof topicId !== "string" || !topicId) throw new Error(`quality case ${caseIndex} 缺少 topic.id`);
  if (!Array.isArray(entry.items) || !entry.items.length) throw new Error(`quality case ${caseIndex} 缺少 items`);
  for (const [itemIndex, item] of entry.items.entries()) {
    if (typeof item.id !== "string" || !item.id || typeof item.source_id !== "string" || !item.source_id
      || typeof item.url !== "string" || !item.url || typeof item.body !== "string" || !item.body) {
      throw new Error(`quality case ${caseIndex} item ${itemIndex} 缺少 id/source_id/url/body`);
    }
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
      content_hash: typeof item.content_hash === "string" ? item.content_hash : null,
      fetched_at: typeof item.fetched_at === "string" ? item.fetched_at : null,
      published_at: typeof item.published_at === "string" ? item.published_at : null,
    });
  }
}

mkdirSync(outDir, { recursive: false });
const manifest = {
  schema_version: "a1-controlled-source-snapshot-v1",
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
