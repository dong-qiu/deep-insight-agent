import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { insertContentItem, insertSource, insertTopic } from "../src/lib/db/repos.js";
import { contentHash } from "../src/lib/sources/normalize.js";
import type { ContentItem, Source, Topic } from "../src/lib/types.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function runTsx(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), script, ...args], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...env },
  });
}

describe("local quality builder raw archive hand-off", () => {
  it("materializes relative ContentItem raw_ref only in local JSONL so the controlled snapshot can verify it", () => {
    const root = mkdtempSync(join(tmpdir(), "ia-build-local-eval-")); roots.push(root);
    const dbPath = join(root, "insight.db");
    const dataDir = join(root, "data");
    const topic: Topic = {
      id: "t_eval", name: "Eval", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
      archetype: "deep_vertical", facets: [],
    };
    const sources: Source[] = ["src_a", "src_b"].map((id) => ({
      id, name: id, type: "rss", endpoint: `https://example.test/${id}`, topic_ids: [topic.id], fetch_interval: "daily",
      backfill: null, enabled: true, fetch_mode: "feed", content_container: null,
    }));
    const db = openDb(dbPath); applyProvenanceMigrations(db); insertTopic(db, topic);
    for (const source of sources) insertSource(db, source);
    for (const source of sources) {
      const body = `${source.id} ${"verified source text ".repeat(30)}`.trim();
      const rawRef = join("raw", `${source.id}.json`);
      mkdirSync(join(dataDir, "raw"), { recursive: true });
      writeFileSync(join(dataDir, rawRef), `${JSON.stringify({
        schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: body,
        structured_body_sha256: contentHash(body),
      })}\n`);
      const item: ContentItem = {
        id: `item_${source.id}`, source_id: source.id, url: `https://example.test/${source.id}/post`, title: source.id,
        author: null, published_at: null, fetched_at: new Date().toISOString(), language: "en", topic_ids: [topic.id],
        tags: [], body, body_kind: "article", raw_ref: rawRef, content_hash: contentHash(body), fetch_status: "ok",
      };
      insertContentItem(db, item);
    }
    db.close();

    const qualityPath = join(root, "quality.local.jsonl");
    const build = runTsx("evals/build-local-eval.ts", [], {
      DB_PATH: dbPath, DATA_DIR: dataDir, EVAL_TOPIC_IDS: topic.id,
      EVAL_TOPIC_SOURCE_IDS: JSON.stringify({ [topic.id]: sources.map((source) => source.id) }),
      EVAL_MIN_BODY: "400", EVAL_PER_SOURCE: "1", EVAL_MAX_ITEMS: "2", EVAL_LOCAL_OUT: qualityPath,
      PROVENANCE_SCHEMA_REQUIRED: "0", PROVENANCE_DEPLOYMENT_REQUIRED: "0", NODE_ENV: "test",
    });
    expect(build.status).toBe(0);
    const quality = JSON.parse(readFileSync(qualityPath, "utf8").trim()) as { items: ContentItem[] };
    expect(quality.items.map((item) => item.raw_ref)).toEqual(sources.map((source) => join(dataDir, "raw", `${source.id}.json`)));

    const candidate = join(root, "candidate");
    const prepared = runTsx("evals/prepare-controlled-v2-snapshot.ts", [qualityPath, candidate, "a1-v2-local-chain"], {});
    expect(prepared.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(candidate, "source-manifest.json"), "utf8")) as { status: string; items: unknown[] };
    expect(manifest.status).toBe("candidate_pending_labels");
    expect(manifest.items).toEqual(expect.arrayContaining([expect.objectContaining({ content_item_id: "item_src_a" })]));
  });
});
