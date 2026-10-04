/** Explicit migration runner only; application startup imports the read-only ledger gate. */
import { createHash } from "node:crypto";
import type { DB } from "./connection.js";
import { MIGRATIONS } from "./migration-definitions.js";
import { merkleRoot } from "./integrity-anchors.js";
import { migratePodcastTranscriptContracts } from "./podcast-transcript-migrations.js";
import { applyRedactionTombstone, redactionUtc, type RedactionTombstone } from "./redaction.js";

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

function reportBodyPathIsNullable(db: DB): boolean {
  const row = (db.prepare("PRAGMA table_info(report)").all() as { name: string; notnull: number }[])
    .find((column) => column.name === "body_path");
  return row?.notnull === 0;
}

/** Pre-v30 roots carry only the frozen hash; reconstruct their leaf projection
 * only when the surviving immutable manifests reproduce it exactly. */
function backfillDailyRootMaterial(db: DB): void {
  const roots = db.prepare("SELECT tenant_id,utc_date,leaf_count,merkle_root FROM integrity_daily_root").all() as Array<{ tenant_id: string; utc_date: string; leaf_count: number; merkle_root: string }>;
  const leaves = db.prepare(`SELECT report_id,artifact_id,artifact_version,manifest_hash
    FROM artifact_manifest WHERE tenant_id=? AND committed_at >= ? AND committed_at < ?
    ORDER BY tenant_id,report_id,artifact_id,artifact_version,manifest_hash`);
  const insert = db.prepare(`INSERT OR IGNORE INTO integrity_daily_root_material(tenant_id,utc_date,report_id,artifact_id,artifact_version,manifest_hash)
    VALUES (?,?,?,?,?,?)`);
  for (const root of roots) {
    const start = `${root.utc_date}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
    const rows = leaves.all(root.tenant_id, start, end) as Array<{ report_id: string; artifact_id: string; artifact_version: string; manifest_hash: string }>;
    if (rows.length !== root.leaf_count || merkleRoot(rows.map((row) => row.manifest_hash)) !== root.merkle_root) continue;
    for (const row of rows) insert.run(root.tenant_id, root.utc_date, row.report_id, row.artifact_id, row.artifact_version, row.manifest_hash);
  }
}

/** SQLite 不能移除 NOT NULL；旧 report 表需重建，保留所有既有发布记录和 child FK。 */
function migrateReportLifecycle(db: DB): void {
  if (!reportBodyPathIsNullable(db)) {
    db.exec(`
      CREATE TABLE report_provenance_next (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL CHECK (type IN ('brief','deep_dive','initial_digest')),
        topic_id       TEXT NOT NULL REFERENCES topic(id),
        status         TEXT NOT NULL CHECK (status IN ('draft','generating','done','failed','archived','deleted')),
        generated_at   TEXT NOT NULL,
        title          TEXT NOT NULL,
        body_path      TEXT,
        insight_ids    TEXT NOT NULL DEFAULT '[]',
        event_ids      TEXT NOT NULL DEFAULT '[]',
        prev_report_id TEXT,
        citation_count INTEGER NOT NULL,
        cost           TEXT NOT NULL,
        failure        TEXT
      );
      INSERT INTO report_provenance_next
        (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
      SELECT id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,NULL FROM report;
      DROP TABLE report;
      ALTER TABLE report_provenance_next RENAME TO report;
      CREATE INDEX IF NOT EXISTS idx_report_topic ON report(topic_id);
      CREATE INDEX IF NOT EXISTS idx_report_status ON report(status);
    `);
  }
  if (!hasColumn(db, "report", "failure")) db.exec("ALTER TABLE report ADD COLUMN failure TEXT");
}

function migrateRawArchiveEffect(db: DB): void {
  db.exec(`
    -- The anchor table has an FK to generation_effect.  Recreate the child in
    -- the same exclusive migration so SQLite does not retain a reference to
    -- the renamed legacy parent.
    ALTER TABLE generation_anchor_effect RENAME TO generation_anchor_effect_legacy;
    ALTER TABLE generation_effect RENAME TO generation_effect_legacy;
    CREATE TABLE generation_effect (
      id TEXT PRIMARY KEY,
      trace_id TEXT REFERENCES generation_trace(id),
      event_id TEXT REFERENCES generation_event(id),
      report_id TEXT UNIQUE REFERENCES report(id),
      raw_content_id TEXT REFERENCES content_item(id),
      kind TEXT NOT NULL CHECK (kind IN ('report_file','raw_archive')),
      idempotency_key TEXT NOT NULL UNIQUE,
      artifact_manifest TEXT NOT NULL,
      publication_payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned','attempted','committed','unknown','abandoned')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((kind='report_file' AND report_id IS NOT NULL AND raw_content_id IS NULL)
        OR (kind='raw_archive' AND report_id IS NULL AND raw_content_id IS NOT NULL))
    );
    CREATE TABLE generation_anchor_effect (
      id TEXT PRIMARY KEY,
      generation_effect_id TEXT NOT NULL REFERENCES generation_effect(id),
      tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
      report_id TEXT NOT NULL REFERENCES report(id),
      artifact_id TEXT NOT NULL,
      artifact_version TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_canonical TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      anchor_idempotency_key TEXT NOT NULL UNIQUE,
      object_key TEXT NOT NULL,
      anchor_payload TEXT NOT NULL,
      anchor_provider_version_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('planned','anchor_written','committed','unknown','failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      manifest_signature TEXT,
      manifest_key_id TEXT,
      manifest_algorithm TEXT,
      manifest_issued_at TEXT,
      retain_until TEXT,
      UNIQUE(generation_effect_id, artifact_id, artifact_version)
    );
    INSERT INTO generation_effect(id,trace_id,event_id,report_id,raw_content_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at)
      SELECT id,trace_id,event_id,report_id,NULL,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at
      FROM generation_effect_legacy;
    INSERT INTO generation_anchor_effect(id,generation_effect_id,tenant_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,anchor_idempotency_key,object_key,anchor_payload,anchor_provider_version_id,status,retry_count,error,created_at,updated_at,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until)
      SELECT id,generation_effect_id,tenant_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,anchor_idempotency_key,object_key,anchor_payload,anchor_provider_version_id,status,retry_count,error,created_at,updated_at,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until
      FROM generation_anchor_effect_legacy;
    DROP TABLE generation_anchor_effect_legacy;
    DROP TABLE generation_effect_legacy;
    CREATE INDEX idx_generation_effect_pending ON generation_effect(status, created_at);
    CREATE INDEX idx_generation_effect_trace_event ON generation_effect(trace_id, event_id);
    CREATE INDEX idx_generation_effect_raw_pending ON generation_effect(raw_content_id, status, created_at) WHERE kind='raw_archive';
    CREATE INDEX idx_generation_anchor_effect_tenant_reconcile ON generation_anchor_effect(tenant_id,status,created_at);
    CREATE UNIQUE INDEX idx_generation_anchor_effect_tenant_effect_artifact ON generation_anchor_effect(tenant_id,generation_effect_id,artifact_id,artifact_version);
  `);
}

/** 只允许 migration runner 调用；重复运行验证 checksum，不会重复执行 DDL。 */
export function applyProvenanceMigrations(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const applied = db.prepare("SELECT checksum FROM schema_migration WHERE version=?").get(migration.version) as { checksum: string } | undefined;
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
      continue;
    }
    // DDL 与 ledger 必须在同一把 SQLite 排他锁中提交：其它 writer 只能看到迁移前或迁移后，
    // 不会观察到半个 provenance schema。
    const rebuildReport = migration.version === "20260803_02_report_lifecycle" && !reportBodyPathIsNullable(db);
    const rebuildSourceCreditPrimaryKeys = migration.version === "20260823_13_source_credit_tenant_primary_keys";
    const rebuildRawArchiveEffect = migration.version === "20260910_40_raw_archive_effect";
    let transactionStarted = false;
    let migrationFailed = false;
    try {
      if (rebuildReport || rebuildSourceCreditPrimaryKeys || rebuildRawArchiveEffect) db.pragma("foreign_keys = OFF");
      db.exec("BEGIN EXCLUSIVE");
      transactionStarted = true;
      if (migration.version === "20260803_01_provenance_core") {
        // SQLite ALTER ADD COLUMN 不支持 IF NOT EXISTS；fresh schema 已含 trace_id，旧库才需要补列。
        if (!hasColumn(db, "run", "trace_id")) db.exec("ALTER TABLE run ADD COLUMN trace_id TEXT");
        const rest = migration.sql.replace("ALTER TABLE run ADD COLUMN trace_id TEXT;", "");
        db.exec(rest);
      } else if (migration.version === "20260803_02_report_lifecycle") {
        migrateReportLifecycle(db);
      } else if (migration.version === "20260803_03_report_effect") {
        db.exec(migration.sql);
      } else if (migration.version === "20260803_04_redaction_tombstone" || migration.version === "20260803_05_redaction_request" || migration.version === "20260803_06_provenance_facts" || migration.version === "20260803_07_deployment_record") {
        db.exec(migration.sql);
      } else if (migration.version === "20260811_08_source_collect") {
        if (!hasColumn(db, "generation_trace", "source_id")) db.exec("ALTER TABLE generation_trace ADD COLUMN source_id TEXT REFERENCES source(id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_generation_trace_source_started ON generation_trace(source_id, started_at DESC)");
      } else if (migration.version === "20260909_36_display_coverage_evidence") {
        if (!hasColumn(db, "citation", "citation_ref")) db.exec("ALTER TABLE citation ADD COLUMN citation_ref TEXT NOT NULL DEFAULT ''");
        if (!hasColumn(db, "citation", "claim")) db.exec("ALTER TABLE citation ADD COLUMN claim TEXT NOT NULL DEFAULT ''");
        db.exec(migration.sql);
      } else if (migration.version === "20260909_37_display_coverage_candidate_audit") {
        if (!hasColumn(db, "analysis_batch", "display_coverage_state")) {
          db.exec("ALTER TABLE analysis_batch ADD COLUMN display_coverage_state TEXT NOT NULL DEFAULT 'legacy' CHECK (display_coverage_state IN ('legacy','audited'))");
        }
        db.exec(migration.sql);
      } else if (migration.version === "20260909_38_statement_citation_binding") {
        if (!hasColumn(db, "insight", "statement_citation_index")) {
          db.exec("ALTER TABLE insight ADD COLUMN statement_citation_index INTEGER");
        }
        db.exec(migration.sql);
      } else if (migration.version === "20260909_39_source_quote_projection") {
        if (!hasColumn(db, "analysis_batch", "display_projection_version")) {
          db.exec("ALTER TABLE analysis_batch ADD COLUMN display_projection_version TEXT NOT NULL DEFAULT 'legacy' CHECK (display_projection_version IN ('legacy','source_quote_v1'))");
        }
        db.exec(migration.sql);
      } else if (migration.version === "20260924_46_reader_statement") {
        if (!hasColumn(db, "insight", "reader_statement")) {
          db.exec(migration.sql);
        }
      } else if (migration.version === "20261004_48_model_usage_attempt") {
        db.exec(migration.sql);
      } else if (migration.version === "20261003_47_report_redaction_boundary") {
        const records = db.prepare("SELECT record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref FROM provenance_redaction WHERE scope='report'").all() as RedactionTombstone[];
        // Validate the entire set before repairing anything; the surrounding
        // exclusive transaction also rolls back DDL, repairs and ledger on error.
        for (const record of records) {
          if (!/^report:[A-Za-z0-9_-]+$/.test(record.entity_key)) throw new Error("redaction_report_key_invalid");
          if (redactionUtc(record.expiry_at) <= redactionUtc(record.effective_at)) throw new Error("redaction_time_invalid");
        }
        for (const record of records) applyRedactionTombstone(db, record);
        db.exec(migration.sql);
      } else if (migration.version === "20260910_40_raw_archive_effect") {
        migrateRawArchiveEffect(db);
      } else if (migration.version === "20260911_41_content_reader_eligibility") {
        if (!hasColumn(db, "content_item", "reader_eligible")) {
          db.exec("ALTER TABLE content_item ADD COLUMN reader_eligible INTEGER NOT NULL DEFAULT 1 CHECK (reader_eligible IN (0,1))");
        }
        db.exec("CREATE INDEX IF NOT EXISTS idx_content_reader_eligible ON content_item(reader_eligible, fetched_at DESC)");
      } else if (migration.version === "20260911_42_pending_raw_archive_reader_eligibility") {
        // Existing planned/attempted/unknown archive effects were created by
        // the prior release.  They must not be visible during this upgrade;
        // startup reconciliation alone may restore visibility after hashing.
        db.exec(`UPDATE content_item SET reader_eligible=0
          WHERE EXISTS (
            SELECT 1 FROM generation_effect effect
            WHERE effect.kind='raw_archive' AND effect.raw_content_id=content_item.id
              AND effect.status IN ('planned','attempted','unknown')
          )`);
      } else if (migration.version === "20260913_43_podcast_transcript_contracts") {
        migratePodcastTranscriptContracts(db, { includePolicyVersionImmutability: false });
      } else if (migration.version === "20260913_44_podcast_transcript_policy_version_immutability") {
        db.exec(migration.sql);
      } else if (migration.version === "20260916_45_report_quality_review_trace_v1") {
        db.exec(migration.sql);
      } else if (migration.version === "20260825_31_integrity_daily_root_material_backfill") {
        backfillDailyRootMaterial(db);
      } else if (migration.version === "20260817_09_bounded_provenance_views" || migration.version === "20260817_10_bounded_provenance_view_index_fix" || migration.version === "20260820_11_effect_event_link" || migration.version === "20260823_12_source_credit_facts" || migration.version === "20260823_14_p1_metric_facts" || migration.version === "20260823_15_p1_metric_fact_contracts" || migration.version === "20260823_16_p1_metric_conflict_audit" || migration.version === "20260823_17_integrity_anchors" || migration.version === "20260823_18_integrity_anchor_immutability" || migration.version === "20260824_19_integrity_anchor_recovery_material" || migration.version === "20260824_20_integrity_anchor_hardening" || migration.version === "20260824_21_integrity_anchor_tenant_reconcile_index" || migration.version === "20260824_22_integrity_check_ledger" || migration.version === "20260824_23_integrity_check_key_revocation" || migration.version === "20260824_24_integrity_lifecycle" || migration.version === "20260824_25_integrity_lifecycle_purge" || migration.version === "20260825_26_integrity_lifecycle_completion_proof" || migration.version === "20260825_27_integrity_lifecycle_registry_proof" || migration.version === "20260825_28_integrity_lifecycle_hold_and_tombstone_retention" || migration.version === "20260825_29_integrity_lifecycle_hold_tombstone_snapshot" || migration.version === "20260825_30_integrity_lifecycle_external_hold" || migration.version === "20260825_32_integrity_maintenance_lease" || migration.version === "20260826_33_dashboard_trace_read_model_v1" || migration.version === "20260826_34_dashboard_cost_read_model_v1" || migration.version === "20260828_35_dashboard_late_visibility_and_dimensions") {
        db.exec(migration.sql);
      } else if (migration.version === "20260823_13_source_credit_tenant_primary_keys") {
        db.exec(migration.sql);
      }
      db.prepare("INSERT INTO schema_migration(version,checksum,applied_at) VALUES (?,?,?)")
        .run(migration.version, checksum, new Date().toISOString());
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      migrationFailed = true;
      // A failed BEGIN must never roll back a transaction owned by the caller.
      if (transactionStarted) {
        try { db.exec("ROLLBACK"); } catch { /* transaction may already have been rolled back */ }
      }
      throw error;
    } finally {
      if (rebuildReport || rebuildSourceCreditPrimaryKeys || rebuildRawArchiveEffect) {
        try { db.pragma("foreign_keys = ON"); } catch (error) {
          if (!migrationFailed) throw error; // Preserve the original migration error.
        }
      }
    }
  }
}
