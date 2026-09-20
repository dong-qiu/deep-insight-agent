/**
 * Deterministically replace one topic in a controlled A1 quality input with a separately
 * prepared expansion.  This keeps a candidate population reproducible without copying source
 * content into the repository.
 *
 * Usage:
 *   tsx evals/compose-a1-v2-expanded-quality.ts <base-quality.local.jsonl> <topic-expansion.local.jsonl> <out.local.jsonl>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface QualityItem {
  id?: unknown;
  url?: unknown;
}

interface QualityCase {
  topic?: { id?: unknown };
  items?: QualityItem[];
}

const TARGET_TOPIC = "t_coding_agent_platforms";

function readQuality(path: string): QualityCase[] {
  const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`${path} 为空`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as QualityCase;
    } catch {
      throw new Error(`${path} 第 ${index + 1} 行不是合法 JSON`);
    }
  });
}

function topicId(entry: QualityCase, inputName: string, index: number): string {
  if (typeof entry.topic?.id !== "string" || !entry.topic.id) {
    throw new Error(`${inputName} 第 ${index + 1} 个 case 缺少 topic.id`);
  }
  if (!Array.isArray(entry.items) || !entry.items.length) {
    throw new Error(`${inputName} 的 ${entry.topic.id} 缺少 items`);
  }
  return entry.topic.id;
}

function requireOneTarget(entries: QualityCase[], inputName: string): QualityCase {
  const matches = entries.filter((entry, index) => topicId(entry, inputName, index) === TARGET_TOPIC);
  if (matches.length !== 1) {
    throw new Error(`${inputName} 必须恰好包含一个 ${TARGET_TOPIC} case，实际为 ${matches.length}`);
  }
  return matches[0]!;
}

function assertGlobalDedupe(entries: QualityCase[]) {
  const contentIds = new Set<string>();
  const urls = new Set<string>();
  let itemCount = 0;
  for (const [caseIndex, entry] of entries.entries()) {
    const id = topicId(entry, "输出候选", caseIndex);
    for (const [itemIndex, item] of entry.items!.entries()) {
      if (typeof item.id !== "string" || !item.id || typeof item.url !== "string" || !item.url) {
        throw new Error(`输出候选的 ${id} item ${itemIndex + 1} 缺少 id 或 url`);
      }
      if (contentIds.has(item.id) || urls.has(item.url)) {
        throw new Error(`输出候选包含重复 content id 或 URL：${item.id}`);
      }
      contentIds.add(item.id);
      urls.add(item.url);
      itemCount += 1;
    }
  }
  return itemCount;
}

const [basePath, expansionPath, outPath] = process.argv.slice(2);
if (!basePath || !expansionPath || !outPath) {
  console.error("用法：tsx evals/compose-a1-v2-expanded-quality.ts <base-quality.local.jsonl> <topic-expansion.local.jsonl> <out.local.jsonl>");
  process.exit(2);
}
if (existsSync(outPath)) {
  console.error("输出文件已存在；拒绝覆盖候选 quality input");
  process.exit(2);
}

const base = readQuality(basePath);
const expansion = readQuality(expansionPath);
const replacement = requireOneTarget(expansion, "topic expansion input");
if (expansion.length !== 1) {
  throw new Error(`topic expansion input 只能包含 ${TARGET_TOPIC} 一个 case`);
}
requireOneTarget(base, "base quality input");

const output = base.map((entry, index) => topicId(entry, "base quality input", index) === TARGET_TOPIC ? replacement : entry);
const itemCount = assertGlobalDedupe(output);
writeFileSync(outPath, `${output.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
console.log(`已写 ${outPath}（${output.length} 个 topic、${itemCount} 条；${TARGET_TOPIC} 使用 ${replacement.items!.length} 条 expansion input）`);
