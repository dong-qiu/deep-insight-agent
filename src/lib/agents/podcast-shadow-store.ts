/** Durable, isolated storage for observe-mode podcast samples.
 *
 * The shadow DB uses the repository-owned schema and TranscriptAcquisitionFact writer. It has no
 * ContentItem rows or production raw archive, so observe data cannot reach a published report.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/index.js";
import { appendTranscriptAcquisitionFact, getSource, insertSource, transcriptAcquisitionEventKey } from "../db/repos.js";
import { podcastTranscriptEvidenceEnvelope } from "../sources/podcast-evidence.js";
import type { Source, TranscriptAcquisitionFact } from "../types.js";
import type { PodcastShadowSink } from "./podcast-shadow.js";

const SHADOW_DIR = "podcast-shadow";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Explicit global allow gate for a controlled observe sample. It never enables production
 * transcript collection: that still needs an enabled source and separate future implementation. */
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

/** Open an isolated fact DB plus immutable evidence archive. */
export function createPodcastShadowStore(source: Source): PodcastShadowStore {
  const root = shadowRoot();
  const archiveDir = join(root, "archive");
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(root, "shadow.db"));
  if (!getSource(db, source.id)) insertSource(db, source);

  const sink: PodcastShadowSink = {
    archive(input) {
      const envelope = podcastTranscriptEvidenceEnvelope({
        adapter_version: "rss-podcast-transcript-shadow-v1",
        fetched_at: new Date().toISOString(),
        episode: input.episode,
        program_page: {
          stable_url: input.program_page.stable_url,
          content_type: input.program_page.content_type,
          raw_payload: input.program_page.raw_payload,
        },
        transcript: input.transcript,
      });
      // fetched_at is a transport observation timestamp, not evidence identity. Every remaining
      // byte (RSS entry + program page + transcript) participates in the archive identity.
      const identity = JSON.parse(envelope) as Record<string, unknown>;
      delete identity.fetched_at;
      const file = `${sha256(`${input.source_id}\n${JSON.stringify(identity)}`)}.json`;
      const rawRef = `archive/${file}`;
      const path = join(archiveDir, file);
      if (!existsSync(path)) {
        try { writeFileSync(path, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
        catch (error) {
          // Concurrent samples may write the same immutable envelope. Any different envelope has
          // a different digest and therefore cannot silently reuse this file.
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      return rawRef;
    },
    append(fact) {
      const eventKey = transcriptAcquisitionEventKey(fact);
      // Candidate/decision delivery timestamps are excluded by the repository semantic hash, so
      // an ordinary replay is a no-op while a changed immutable outcome still enters its conflict ledger.
      appendTranscriptAcquisitionFact(db, { ...fact, event_key: eventKey });
    },
    nextAttempt(input) {
      const row = db.prepare(
        `SELECT MAX(attempt) AS max_attempt FROM transcript_acquisition_fact
         WHERE source_id=@source_id AND canonical_episode_url=@canonical_episode_url
           AND candidate_hash=@candidate_hash AND transcript_policy_version=@transcript_policy_version
           AND stage IN ('attempt','terminal')`,
      ).get(input) as { max_attempt: number | null };
      return (row.max_attempt ?? 0) + 1;
    },
  };
  return { sink, root, close: () => db.close() };
}
