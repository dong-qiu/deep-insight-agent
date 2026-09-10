/**
 * 在调用方提供的隔离 DB_PATH / DATA_DIR 中，按生产 collector 路径采集一个 source cohort。
 *
 * 此脚本刻意不看 Source.enabled：staged source 应先经这里验证可采集、可入评测集，之后才有资格
 * 进入生产启用脚本。调用方必须传临时路径，避免评测写入开发/生产 SQLite 或原文存档。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectSource, type CollectResult } from "../src/lib/agents/collector.js";
import { getEffectiveSources, loadStaticConfig, seedDefaults } from "../src/lib/config/index.js";
import { getDb } from "../src/lib/db/index.js";
import type { DB } from "../src/lib/db/index.js";
import type { Source } from "../src/lib/types.js";
import { parseSourceIds } from "./build-local-eval-lib.js";

export function resolveCohortSources(sources: Source[], sourceIds: string[]): Source[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const missing = sourceIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`未在当前静态配置中找到 source cohort：${missing.join(", ")}`);
  return sourceIds.map((id) => byId.get(id)!);
}

type CohortEnvironment = {
  DB_PATH?: string;
  DATA_DIR?: string;
  EVAL_ISOLATED_ROOT?: string;
};

function isDescendant(path: string, directory: string): boolean {
  const remainder = relative(directory, path);
  return remainder !== "" && !remainder.startsWith("../") && remainder !== "..";
}

/**
 * 评测数据的边界不能只靠调用者自觉。必须指定一个隔离根，且 DB 与原文目录都在其中；
 * 尤其拒绝仓库默认 .data，避免一次本地 eval 误写开发或生产挂载数据。
 */
export function resolveIsolatedCohortPaths(
  environment: CohortEnvironment,
  cwd = process.cwd(),
): { dbPath: string; dataDir: string; isolatedRoot: string } {
  const { DB_PATH: dbPathValue, DATA_DIR: dataDirValue, EVAL_ISOLATED_ROOT: rootValue } = environment;
  if (!dbPathValue || !dataDirValue || !rootValue) {
    throw new Error("必须显式设置 EVAL_ISOLATED_ROOT、DB_PATH 与 DATA_DIR，拒绝写入默认 .data");
  }

  const dbPath = resolve(cwd, dbPathValue);
  const dataDir = resolve(cwd, dataDirValue);
  const isolatedRoot = resolve(cwd, rootValue);
  const defaultDataDir = resolve(cwd, ".data");

  if (
    isolatedRoot === defaultDataDir ||
    isDescendant(dbPath, defaultDataDir) ||
    dataDir === defaultDataDir ||
    isDescendant(dataDir, defaultDataDir)
  ) {
    throw new Error("隔离 cohort 不得使用仓库默认 .data；请用 mktemp -d 创建 EVAL_ISOLATED_ROOT");
  }
  if (!isDescendant(dbPath, isolatedRoot) || !isDescendant(dataDir, isolatedRoot)) {
    throw new Error("DB_PATH 与 DATA_DIR 必须位于 EVAL_ISOLATED_ROOT 内");
  }

  return { dbPath, dataDir, isolatedRoot };
}

export async function collectCohort(
  db: DB,
  sources: Source[],
  collect: (db: DB, source: Source) => Promise<CollectResult> = collectSource,
): Promise<CohortCollectionEntry[]> {
  const results: CohortCollectionEntry[] = [];
  // 与 Scheduler 的 ingestConcurrency=1 一致：不让评测绕开生产串行采集/robots 行为。
  for (const source of sources) {
    console.log(`采集 cohort source：${source.id}`);
    try {
      results.push({ source_id: source.id, status: "collected", result: await collect(db, source) });
    } catch (error) {
      // collector 的原始错误可能含 endpoint 或凭据片段。manifest 只保留可审计且可安全展示的分类。
      results.push({ source_id: source.id, status: "failed", error: toPublicCollectionError(error) });
    }
  }
  return results;
}

export type CohortCollectionEntry =
  | { source_id: string; status: "collected"; result: CollectResult }
  | { source_id: string; status: "failed"; error: CohortCollectionError };

export type CohortCollectionError = { kind: string; code?: string };

function toPublicCollectionError(error: unknown): CohortCollectionError {
  const kind = error instanceof Error && error.name ? error.name : "UnknownError";
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;

  // Node/undici 等稳定错误码可用于聚类；拒绝自由文本，避免把 URL 或 token 写进 manifest。
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? { kind, code }
    : { kind };
}

async function main(): Promise<void> {
  const sourceIds = parseSourceIds(process.env.EVAL_SOURCE_IDS, "EVAL_SOURCE_IDS");
  if (!sourceIds.length) throw new Error("必须设置 EVAL_SOURCE_IDS（逗号分隔的 source id）");
  const isolated = resolveIsolatedCohortPaths({
    DB_PATH: process.env.DB_PATH,
    DATA_DIR: process.env.DATA_DIR,
    EVAL_ISOLATED_ROOT: process.env.EVAL_ISOLATED_ROOT,
  });
  const config = loadStaticConfig();
  const db = getDb();
  seedDefaults(db, config);
  const sources = resolveCohortSources(getEffectiveSources(db, config), sourceIds);
  const output = process.env.EVAL_COHORT_COLLECTION_MANIFEST;
  if (!output) throw new Error("必须设置 EVAL_COHORT_COLLECTION_MANIFEST，保留采集审计记录");

  const results = await collectCohort(db, sources);
  const failed = results.filter((entry) => entry.status === "failed");
  const manifest = {
    generated_at: new Date().toISOString(),
    db_path: isolated.dbPath,
    data_dir: isolated.dataDir,
    source_ids: sourceIds,
    collection_status: failed.length ? "partial_failed" : "completed",
    results,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已完成 ${results.length} 个 source 的隔离采集；失败 ${failed.length} 个。`);

  if (failed.length) {
    throw new Error(`source cohort 采集失败：${failed.map((entry) => entry.source_id).join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`source cohort 采集终止：${error instanceof Error ? error.name : "UnknownError"}`);
    process.exit(1);
  });
}
