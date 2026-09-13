/** Shared forward migration for podcast transcript contracts. Application startup uses it for
 * local compatibility; production invokes the same function through the immutable migration
 * ledger before a strict writer is allowed to start. */
import type { DB } from "./index.js";
import {
  citationCheckTableSql,
  PODCAST_TRANSCRIPT_CONTRACTS_SCHEMA_SQL,
  PODCAST_TRANSCRIPT_POLICY_VERSION_IMMUTABILITY_SQL,
} from "./schema.js";

function tableExists(db: DB, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** SQLite cannot alter a CHECK constraint in place. Rebuild this compact validation projection
 * before a validator can emit the new fail-closed speaker-attribution reason. */
function migrateCitationCheckReason(db: DB): void {
  if (!tableExists(db, "citation_check")) return;
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='citation_check'")
    .get() as { sql: string } | undefined;
  if (!current || current.sql.includes("speaker_attribution_unknown")) return;
  // The production migration runner already holds an exclusive transaction. Startup compatibility
  // executes these DDL statements only for a local/non-strict database.
  db.exec("ALTER TABLE citation_check RENAME TO citation_check_legacy");
  db.exec(citationCheckTableSql());
  db.exec(`INSERT INTO citation_check
    (batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict)
    SELECT batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict
    FROM citation_check_legacy`);
  db.exec("DROP TABLE citation_check_legacy");
}

/** Apply all v43 fields before the shared table/trigger fragment. Existing unversioned modes are
 * deliberately reset to `off`: a policy-aware collector must never infer missing policy intent.
 * v44 is intentionally excluded unless the caller explicitly owns fresh-schema initialization. */
export function migratePodcastTranscriptContracts(
  db: DB,
  { includePolicyVersionImmutability = false }: { includePolicyVersionImmutability?: boolean } = {},
): void {
  ensureColumn(db, "content_item", "body_kind", "body_kind TEXT NOT NULL DEFAULT 'article' CHECK (body_kind IN ('article','show_notes','transcript'))");
  ensureColumn(db, "source", "transcript_mode", "transcript_mode TEXT NOT NULL DEFAULT 'off' CHECK (transcript_mode IN ('off','observe','enabled'))");
  ensureColumn(db, "source", "transcript_strategy", "transcript_strategy TEXT NOT NULL DEFAULT 'relevant_only' CHECK (transcript_strategy IN ('all','relevant_only'))");
  ensureColumn(db, "source", "transcript_max_items_per_run", "transcript_max_items_per_run INTEGER NOT NULL DEFAULT 5 CHECK (transcript_max_items_per_run > 0)");
  ensureColumn(db, "source", "transcript_max_bytes_per_run", "transcript_max_bytes_per_run INTEGER NOT NULL DEFAULT 5242880 CHECK (transcript_max_bytes_per_run > 0)");
  ensureColumn(db, "source", "transcript_timeout_budget_ms", "transcript_timeout_budget_ms INTEGER NOT NULL DEFAULT 30000 CHECK (transcript_timeout_budget_ms > 0)");
  ensureColumn(db, "source", "transcript_host_qps", "transcript_host_qps REAL NOT NULL DEFAULT 0.5 CHECK (transcript_host_qps > 0)");
  ensureColumn(db, "source", "transcript_policy_version", "transcript_policy_version TEXT");
  db.exec("UPDATE source SET transcript_mode='off' WHERE transcript_mode <> 'off' AND (transcript_policy_version IS NULL OR trim(transcript_policy_version) = '')");

  ensureColumn(db, "content_item", "speaker_map_status", "speaker_map_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (speaker_map_status IN ('not_applicable','unknown','verified'))");
  ensureColumn(db, "content_item", "speaker_map_ref", "speaker_map_ref TEXT");
  db.exec("UPDATE content_item SET speaker_map_status='unknown', speaker_map_ref=NULL WHERE body_kind='transcript' AND speaker_map_status='not_applicable'");

  if (tableExists(db, "citation")) {
    ensureColumn(db, "citation", "speaker_attribution", "speaker_attribution TEXT");
  }
  migrateCitationCheckReason(db);
  db.exec(PODCAST_TRANSCRIPT_CONTRACTS_SCHEMA_SQL);
  if (includePolicyVersionImmutability) db.exec(PODCAST_TRANSCRIPT_POLICY_VERSION_IMMUTABILITY_SQL);
  db.exec(`INSERT OR IGNORE INTO source_transcript_policy_version(source_id,transcript_policy_version,recorded_at)
    SELECT id,trim(transcript_policy_version),datetime('now')
    FROM source WHERE transcript_mode <> 'off' AND transcript_policy_version IS NOT NULL AND length(trim(transcript_policy_version)) > 0`);
}
