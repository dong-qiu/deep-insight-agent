/** Durable but isolated storage for observe-mode podcast samples.
 *
 * The store lives under DATA_DIR/podcast-shadow, never in the production SQLite database or
 * its raw archive.  It intentionally contains no ContentItem/Report writer, so a shadow sample
 * cannot become reader-visible by accident.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import type { TranscriptFetchResult } from "../sources/types.js";
import type { PodcastShadowObservation, PodcastShadowSink } from "./podcast-shadow.js";

const SHADOW_DIR = "podcast-shadow";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Explicit global allow gate for a controlled observe sample.  It never enables production
 * transcript collection: that still requires source.transcript_mode=enabled + TRANSCRIPT_FETCH. */
export function transcriptShadowFetchEnabled(): boolean {
  return process.env.TRANSCRIPT_SHADOW_FETCH === "1" || process.env.TRANSCRIPT_SHADOW_FETCH === "true";
}

export interface PodcastShadowStore {
  sink: PodcastShadowSink;
  root: string;
  close(): void;
}

function shadowRoot(): string {
  const dataDir = process.env.DATA_DIR?.trim();
  if (!dataDir) throw new Error("podcast_shadow_requires_DATA_DIR");
  return join(dataDir, SHADOW_DIR);
}

function prepareSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcast_shadow_observation (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      episode_url TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      outcome TEXT NOT NULL,
      bytes INTEGER,
      duration_ms INTEGER,
      raw_ref TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_shadow_observation_source_time
      ON podcast_shadow_observation(source_id, occurred_at DESC);
    CREATE TRIGGER IF NOT EXISTS podcast_shadow_observation_no_update
      BEFORE UPDATE ON podcast_shadow_observation BEGIN SELECT RAISE(ABORT, 'podcast_shadow_observation is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS podcast_shadow_observation_no_delete
      BEFORE DELETE ON podcast_shadow_observation BEGIN SELECT RAISE(ABORT, 'podcast_shadow_observation is append-only'); END;
  `);
}

/** Open an isolated, append-only SQLite and raw archive for a controlled sample. */
export function createPodcastShadowStore(): PodcastShadowStore {
  const root = shadowRoot();
  const archiveDir = join(root, "archive");
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(root, "shadow.db"));
  prepareSchema(db);
  const refs = new Map<string, string>();
  const key = (sourceId: string, episodeUrl: string) => `${sourceId}\n${episodeUrl}`;

  const sink: PodcastShadowSink = {
    archive(input) {
      const transcriptHash = sha256(input.transcript.raw_payload);
      const file = `${sha256(key(input.source_id, input.episode_url)).slice(0, 24)}-${transcriptHash.slice(0, 24)}.json`;
      const rawRef = `archive/${file}`;
      const path = join(archiveDir, file);
      const payload = JSON.stringify({
        schema_version: "podcast-transcript-shadow-evidence-v1",
        fetched_at: new Date().toISOString(),
        source_id: input.source_id,
        episode_url: input.episode_url,
        rss_item: input.raw_rss_item,
        transcript: input.transcript,
      });
      if (!existsSync(path)) {
        try { writeFileSync(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
        catch (error) {
          // Another concurrent controlled sample may have written the same immutable payload.
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      refs.set(key(input.source_id, input.episode_url), rawRef);
    },
    append(observation: PodcastShadowObservation) {
      const rawRef = refs.get(key(observation.source_id, observation.episode_url)) ?? null;
      const id = `pso_${sha256(JSON.stringify({ ...observation, raw_ref: rawRef })).slice(0, 40)}`;
      db.prepare(`INSERT OR IGNORE INTO podcast_shadow_observation
        (id,source_id,episode_url,candidate_hash,policy_version,decision,reason_code,outcome,bytes,duration_ms,raw_ref,occurred_at)
        VALUES (@id,@source_id,@episode_url,@candidate_hash,@policy_version,@decision,@reason_code,@outcome,@bytes,@duration_ms,@raw_ref,@occurred_at)`)
        .run({ id, ...observation, raw_ref: rawRef });
    },
  };
  return { sink, root, close: () => db.close() };
}
