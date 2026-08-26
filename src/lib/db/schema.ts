/** 数据库 schema（落 architecture.md「数据模型」单一事实来源）。
 *  内联为字符串常量（而非运行时读 .sql 文件），保证 tsx / vitest / Next / Docker 各环境一致，
 *  不依赖资源路径解析。WAL / foreign_keys 由 db/index.ts 的 pragma 设置；JSON 字段以 TEXT 存。 */

/**
 * P1b-1 来源 credit 的 SQLite 实体权威定义。
 *
 * 这些 append-only 表由 provenance migration runner 在基线 schema 之后创建；因此不要并入
 * SCHEMA_SQL（应用启动不得自行执行 provenance migration）。迁移模块只引用本常量，避免
 * 迁移 DDL 与 schema 事实源发生漂移。
 */
export const SOURCE_CREDIT_FACTS_SCHEMA_SQL = `
CREATE TABLE source_credit_event (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  trace_id TEXT,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version = 'source-credit-v1'),
  allocation_version TEXT NOT NULL CHECK(allocation_version = 'equal-split-micros-v1'),
  producer_version TEXT NOT NULL CHECK(producer_version = 'source-credit-producer-v1'),
  trace_coverage TEXT NOT NULL CHECK(trace_coverage IN ('complete','partial','legacy')),
  lateness TEXT NOT NULL CHECK(lateness IN ('timely','reconcilable','quarantined')),
  semantic_payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, event_id)
);
CREATE INDEX idx_source_credit_event_tenant_occurred ON source_credit_event(tenant_id, occurred_at DESC);
CREATE INDEX idx_source_credit_event_tenant_trace ON source_credit_event(tenant_id, trace_id, occurred_at DESC);
CREATE TRIGGER source_credit_event_no_update BEFORE UPDATE ON source_credit_event BEGIN SELECT RAISE(ABORT, 'source_credit_event is append-only'); END;
CREATE TRIGGER source_credit_event_no_delete BEFORE DELETE ON source_credit_event BEGIN SELECT RAISE(ABORT, 'source_credit_event is append-only'); END;

CREATE TABLE source_credit_fact (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  credit_micros INTEGER NOT NULL CHECK(credit_micros > 0 AND credit_micros <= 1000000),
  PRIMARY KEY(tenant_id, event_id, source_id),
  FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_event(tenant_id, event_id)
);
CREATE INDEX idx_source_credit_fact_tenant_source_event ON source_credit_fact(tenant_id, source_id, event_id);
CREATE TRIGGER source_credit_fact_no_update BEFORE UPDATE ON source_credit_fact BEGIN SELECT RAISE(ABORT, 'source_credit_fact is append-only'); END;
CREATE TRIGGER source_credit_fact_no_delete BEFORE DELETE ON source_credit_fact BEGIN SELECT RAISE(ABORT, 'source_credit_fact is append-only'); END;

CREATE TABLE source_credit_conflict (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  existing_semantic_payload_hash TEXT NOT NULL,
  received_semantic_payload_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);
CREATE INDEX idx_source_credit_conflict_tenant_event ON source_credit_conflict(tenant_id, event_id, observed_at DESC);
CREATE TRIGGER source_credit_conflict_no_update BEFORE UPDATE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;
CREATE TRIGGER source_credit_conflict_no_delete BEFORE DELETE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;

CREATE TABLE source_credit_late_event (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  lateness TEXT NOT NULL CHECK(lateness IN ('reconcilable','quarantined')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, event_id),
  FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_event(tenant_id, event_id)
);
CREATE INDEX idx_source_credit_late_event_tenant_lateness ON source_credit_late_event(tenant_id, lateness, recorded_at DESC);
CREATE TRIGGER source_credit_late_event_no_update BEFORE UPDATE ON source_credit_late_event BEGIN SELECT RAISE(ABORT, 'source_credit_late_event is append-only'); END;
CREATE TRIGGER source_credit_late_event_no_delete BEFORE DELETE ON source_credit_late_event BEGIN SELECT RAISE(ABORT, 'source_credit_late_event is append-only'); END;

CREATE TABLE source_credit_late_reconciliation (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reconciled','declined')),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id),
  FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_late_event(tenant_id, event_id)
);
CREATE INDEX idx_source_credit_late_reconciliation_tenant_event ON source_credit_late_reconciliation(tenant_id, event_id, recorded_at DESC);
CREATE TRIGGER source_credit_late_reconciliation_no_update BEFORE UPDATE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
CREATE TRIGGER source_credit_late_reconciliation_no_delete BEFORE DELETE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
`;

/** P1c evidence schema.  Migration code consumes these strings verbatim. */
export const INTEGRITY_ANCHOR_SCHEMA_SQL = `
CREATE TABLE artifact_manifest (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES report(id),
  manifest_canonical TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  anchor_object_key TEXT NOT NULL,
  anchor_provider_version_id TEXT,
  anchor_payload_hash TEXT,
  anchor_signature TEXT,
  anchor_key_id TEXT,
  anchor_issued_at TEXT,
  committed_at TEXT,
  PRIMARY KEY(tenant_id, artifact_id, artifact_version),
  UNIQUE(tenant_id, report_id, artifact_id, artifact_version),
  UNIQUE(tenant_id, manifest_hash)
);
CREATE INDEX idx_artifact_manifest_report ON artifact_manifest(tenant_id, report_id, committed_at);
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
  UNIQUE(generation_effect_id, artifact_id, artifact_version)
);
CREATE INDEX idx_generation_anchor_effect_reconcile ON generation_anchor_effect(tenant_id, status, created_at);
CREATE TABLE integrity_audit_event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  effect_id TEXT,
  artifact_id TEXT,
  artifact_version TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('anchor_written_sqlite_uncommitted','anchor_reconciled','orphan_anchor','daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered')),
  severity TEXT NOT NULL CHECK(severity IN ('high','critical')),
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_integrity_audit_pending ON integrity_audit_event(tenant_id, event_type, created_at DESC);
CREATE TABLE integrity_daily_root (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  utc_date TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  leaf_count INTEGER NOT NULL,
  merkle_root TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('committed','recovered','missing','conflict')),
  committed_at TEXT,
  PRIMARY KEY(tenant_id, utc_date)
);
`;

/** Immutable v17 migration payload. New databases use the tenant-first DDL
 * above; this preserved text keeps the recorded v17 checksum valid while a
 * later forward migration removes its legacy index. */
export const INTEGRITY_ANCHOR_LEGACY_SCHEMA_SQL = INTEGRITY_ANCHOR_SCHEMA_SQL
  .replace("ON generation_anchor_effect(tenant_id, status, created_at)", "ON generation_anchor_effect(status, created_at)");

/** Existing rows remain readable; newly applied P1c databases deny destructive mutations. */
export const INTEGRITY_ANCHOR_IMMUTABILITY_SQL = `
CREATE TRIGGER artifact_manifest_no_update BEFORE UPDATE ON artifact_manifest BEGIN SELECT RAISE(ABORT, 'artifact_manifest is append-only'); END;
CREATE TRIGGER artifact_manifest_no_delete BEFORE DELETE ON artifact_manifest BEGIN SELECT RAISE(ABORT, 'artifact_manifest is append-only'); END;
CREATE TRIGGER integrity_audit_event_no_update BEFORE UPDATE ON integrity_audit_event BEGIN SELECT RAISE(ABORT, 'integrity_audit_event is append-only'); END;
CREATE TRIGGER integrity_audit_event_no_delete BEFORE DELETE ON integrity_audit_event BEGIN SELECT RAISE(ABORT, 'integrity_audit_event is append-only'); END;
CREATE TRIGGER integrity_daily_root_no_update BEFORE UPDATE ON integrity_daily_root BEGIN SELECT RAISE(ABORT, 'integrity_daily_root is append-only'); END;
CREATE TRIGGER integrity_daily_root_no_delete BEFORE DELETE ON integrity_daily_root BEGIN SELECT RAISE(ABORT, 'integrity_daily_root is append-only'); END;
`;

/** P1c follow-up.  Keep v17/v18 immutable: deployed databases advance through
 * this additive migration, while schema.ts remains the single DDL source. */
export const INTEGRITY_ANCHOR_RECOVERY_SCHEMA_SQL = `
ALTER TABLE artifact_manifest ADD COLUMN anchor_algorithm TEXT;
ALTER TABLE artifact_manifest ADD COLUMN manifest_signature TEXT;
ALTER TABLE artifact_manifest ADD COLUMN manifest_key_id TEXT;
ALTER TABLE artifact_manifest ADD COLUMN manifest_algorithm TEXT;
ALTER TABLE artifact_manifest ADD COLUMN manifest_issued_at TEXT;
ALTER TABLE artifact_manifest ADD COLUMN retain_until TEXT;
ALTER TABLE generation_anchor_effect ADD COLUMN manifest_signature TEXT;
ALTER TABLE generation_anchor_effect ADD COLUMN manifest_key_id TEXT;
ALTER TABLE generation_anchor_effect ADD COLUMN manifest_algorithm TEXT;
ALTER TABLE generation_anchor_effect ADD COLUMN manifest_issued_at TEXT;
ALTER TABLE generation_anchor_effect ADD COLUMN retain_until TEXT;

CREATE TABLE integrity_signing_key (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  certificate_pem TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,key_id)
);
CREATE TABLE integrity_key_revocation (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  key_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(tenant_id,key_id),
  FOREIGN KEY(tenant_id,key_id) REFERENCES integrity_signing_key(tenant_id,key_id)
);
CREATE INDEX idx_generation_anchor_effect_tenant_reconcile ON generation_anchor_effect(tenant_id,status,created_at);
CREATE UNIQUE INDEX idx_generation_anchor_effect_tenant_effect_artifact ON generation_anchor_effect(tenant_id,generation_effect_id,artifact_id,artifact_version);
`;

/** P1c review hardening. Existing P1c rows stay readable, but new migrations
 * retain enough root material for rotation-safe verification and make key
 * history append-only. */
export const INTEGRITY_ANCHOR_HARDENING_SCHEMA_SQL = `
ALTER TABLE integrity_daily_root ADD COLUMN algorithm TEXT;
ALTER TABLE integrity_daily_root ADD COLUMN issued_at TEXT;
ALTER TABLE integrity_daily_root ADD COLUMN provider_version_id TEXT;
ALTER TABLE integrity_daily_root ADD COLUMN retain_until TEXT;

CREATE TRIGGER integrity_signing_key_no_update BEFORE UPDATE ON integrity_signing_key BEGIN SELECT RAISE(ABORT, 'integrity_signing_key is append-only'); END;
CREATE TRIGGER integrity_signing_key_no_delete BEFORE DELETE ON integrity_signing_key BEGIN SELECT RAISE(ABORT, 'integrity_signing_key is append-only'); END;
CREATE TRIGGER integrity_key_revocation_no_update BEFORE UPDATE ON integrity_key_revocation BEGIN SELECT RAISE(ABORT, 'integrity_key_revocation is append-only'); END;
CREATE TRIGGER integrity_key_revocation_no_delete BEFORE DELETE ON integrity_key_revocation BEGIN SELECT RAISE(ABORT, 'integrity_key_revocation is append-only'); END;
`;

/** P1c verification ledger. Check rows contain only versions, result codes and
 * hash prefixes; they must never contain artifact content or object-store URIs. */
export const INTEGRITY_CHECK_SCHEMA_SQL = `
CREATE TABLE integrity_check (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pass','content_mismatch','manifest_mismatch','anchor_mismatch','verification_material_unavailable','missing_artifact','unreadable','unsupported_algorithm','authorization_denied')),
  failure_step TEXT,
  expected_hash_prefix TEXT,
  actual_hash_prefix TEXT,
  checker_version TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,artifact_id,artifact_version) REFERENCES artifact_manifest(tenant_id,artifact_id,artifact_version)
);
CREATE INDEX idx_integrity_check_tenant_artifact_checked ON integrity_check(tenant_id,artifact_id,artifact_version,checked_at DESC);
CREATE TRIGGER integrity_check_no_update BEFORE UPDATE ON integrity_check BEGIN SELECT RAISE(ABORT, 'integrity_check is append-only'); END;
CREATE TRIGGER integrity_check_no_delete BEFORE DELETE ON integrity_check BEGIN SELECT RAISE(ABORT, 'integrity_check is append-only'); END;
CREATE TABLE integrity_check_alert_dedup (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  window_start TEXT NOT NULL,
  PRIMARY KEY(tenant_id,artifact_id,artifact_version,window_start)
);
CREATE TRIGGER integrity_check_alert_dedup_no_update BEFORE UPDATE ON integrity_check_alert_dedup BEGIN SELECT RAISE(ABORT, 'integrity_check_alert_dedup is append-only'); END;
CREATE TRIGGER integrity_check_alert_dedup_no_delete BEFORE DELETE ON integrity_check_alert_dedup BEGIN SELECT RAISE(ABORT, 'integrity_check_alert_dedup is append-only'); END;
`;

/** Historical signature verification remains valid after revocation, but the
 * immutable check record must disclose that the recorded verification key is
 * revoked.  This stays separate from v22 so installed ledgers never have
 * their migration checksum rewritten. */
export const INTEGRITY_CHECK_KEY_REVOCATION_SCHEMA_SQL = `
ALTER TABLE integrity_check ADD COLUMN key_revoked INTEGER NOT NULL DEFAULT 0 CHECK(key_revoked IN (0,1));
`;

/** One mutable operational row per tenant.  Unlike the evidence ledger this
 * is not an audit fact: it is a fenced, expiring coordination lease for the
 * independently scheduled integrity maintenance job. */
export const INTEGRITY_MAINTENANCE_LEASE_SCHEMA_SQL = `
CREATE TABLE integrity_maintenance_lease (
  tenant_id TEXT PRIMARY KEY CHECK(tenant_id = 'default'),
  owner_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);
`;

/** P1d lifecycle facts are deliberately separate from immutable manifest and
 * check ledgers. A report can be withdrawn from every reader before its
 * evidence reaches the end of its retention period; that withdrawal must not
 * rewrite an anchored publication or make a reader call an integrity worker. */
export const INTEGRITY_LIFECYCLE_SCHEMA_SQL = `
CREATE TABLE integrity_report_lifecycle (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  reader_state TEXT NOT NULL CHECK(reader_state IN ('active','delete_pending','destroyed')),
  readable_until TEXT NOT NULL,
  archive_until TEXT NOT NULL,
  delete_requested_at TEXT,
  destroyed_at TEXT,
  PRIMARY KEY(tenant_id,report_id)
);
CREATE INDEX idx_integrity_report_lifecycle_reader ON integrity_report_lifecycle(tenant_id,reader_state,report_id);

CREATE TABLE integrity_legal_hold_event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  hold_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('placed','released')),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE(tenant_id,report_id,hold_id,action)
);
CREATE INDEX idx_integrity_legal_hold_report ON integrity_legal_hold_event(tenant_id,report_id,hold_id,occurred_at DESC);
CREATE TRIGGER integrity_legal_hold_event_no_update BEFORE UPDATE ON integrity_legal_hold_event BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_event is append-only'); END;
CREATE TRIGGER integrity_legal_hold_event_no_delete BEFORE DELETE ON integrity_legal_hold_event BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_event is append-only'); END;

CREATE TABLE integrity_retention_tombstone (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK(algorithm = 'ed25519'),
  destroyed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id)
);
CREATE TRIGGER integrity_retention_tombstone_no_update BEFORE UPDATE ON integrity_retention_tombstone BEGIN SELECT RAISE(ABORT, 'integrity_retention_tombstone is append-only'); END;
CREATE TRIGGER integrity_retention_tombstone_no_delete BEFORE DELETE ON integrity_retention_tombstone BEGIN SELECT RAISE(ABORT, 'integrity_retention_tombstone is append-only'); END;

CREATE TABLE integrity_lifecycle_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('deletion_requested','deletion_blocked_legal_hold','retention_tombstone_written','retention_not_eligible')),
  actor_id TEXT,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_integrity_lifecycle_audit_report ON integrity_lifecycle_audit(tenant_id,report_id,created_at DESC);
CREATE TRIGGER integrity_lifecycle_audit_no_update BEFORE UPDATE ON integrity_lifecycle_audit BEGIN SELECT RAISE(ABORT, 'integrity_lifecycle_audit is append-only'); END;
CREATE TRIGGER integrity_lifecycle_audit_no_delete BEFORE DELETE ON integrity_lifecycle_audit BEGIN SELECT RAISE(ABORT, 'integrity_lifecycle_audit is append-only'); END;
`;

/** P1d review repair.  Retention expiry is the sole governed exception to the
 * append-only verification ledgers.  A durable backup/registry completion and
 * an already-registered P0 redaction tombstone are required before the guard
 * can be opened by the lifecycle operation. */
export const INTEGRITY_LIFECYCLE_PURGE_SCHEMA_SQL = `
ALTER TABLE integrity_report_lifecycle ADD COLUMN artifact_body_path TEXT;

CREATE TABLE integrity_retention_completion (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  backup_reference TEXT NOT NULL,
  registry_record_id TEXT NOT NULL,
  registry_ref TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id)
);

CREATE TABLE integrity_retention_purge_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT INTO integrity_retention_purge_guard(id,enabled) VALUES (1,0);

DROP TRIGGER artifact_manifest_no_delete;
DROP TRIGGER integrity_audit_event_no_delete;
DROP TRIGGER integrity_daily_root_no_delete;
DROP TRIGGER integrity_signing_key_no_delete;
DROP TRIGGER integrity_key_revocation_no_delete;
DROP TRIGGER integrity_check_no_delete;
DROP TRIGGER integrity_check_alert_dedup_no_delete;
DROP TRIGGER integrity_legal_hold_event_no_delete;
DROP TRIGGER integrity_retention_tombstone_no_delete;
DROP TRIGGER integrity_lifecycle_audit_no_delete;

CREATE TRIGGER artifact_manifest_no_delete BEFORE DELETE ON artifact_manifest WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'artifact_manifest is append-only'); END;
CREATE TRIGGER integrity_audit_event_no_delete BEFORE DELETE ON integrity_audit_event WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_audit_event is append-only'); END;
CREATE TRIGGER integrity_daily_root_no_delete BEFORE DELETE ON integrity_daily_root WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_daily_root is append-only'); END;
CREATE TRIGGER integrity_signing_key_no_delete BEFORE DELETE ON integrity_signing_key WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_signing_key is append-only'); END;
CREATE TRIGGER integrity_key_revocation_no_delete BEFORE DELETE ON integrity_key_revocation WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_key_revocation is append-only'); END;
CREATE TRIGGER integrity_check_no_delete BEFORE DELETE ON integrity_check WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_check is append-only'); END;
CREATE TRIGGER integrity_check_alert_dedup_no_delete BEFORE DELETE ON integrity_check_alert_dedup WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_check_alert_dedup is append-only'); END;
CREATE TRIGGER integrity_legal_hold_event_no_delete BEFORE DELETE ON integrity_legal_hold_event WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_event is append-only'); END;
CREATE TRIGGER integrity_retention_tombstone_no_delete BEFORE DELETE ON integrity_retention_tombstone WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_retention_tombstone is append-only'); END;
CREATE TRIGGER integrity_lifecycle_audit_no_delete BEFORE DELETE ON integrity_lifecycle_audit WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_lifecycle_audit is append-only'); END;
`;

/** P1d review repair. Completion proof is an immutable fact: the registry
 * writer records it only after its conditional external write succeeds, and a
 * trusted backup verifier must accept the receipt both then and at purge. */
export const INTEGRITY_LIFECYCLE_COMPLETION_PROOF_SCHEMA_SQL = `
CREATE TABLE integrity_report_lifecycle_next (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  reader_state TEXT NOT NULL CHECK(reader_state IN ('active','delete_pending','purge_pending','destroyed')),
  readable_until TEXT NOT NULL,
  archive_until TEXT NOT NULL,
  delete_requested_at TEXT,
  destroyed_at TEXT,
  artifact_body_path TEXT,
  PRIMARY KEY(tenant_id,report_id)
);
INSERT INTO integrity_report_lifecycle_next(tenant_id,report_id,reader_state,readable_until,archive_until,delete_requested_at,destroyed_at,artifact_body_path)
  SELECT tenant_id,report_id,reader_state,readable_until,archive_until,delete_requested_at,destroyed_at,artifact_body_path FROM integrity_report_lifecycle;
DROP TABLE integrity_report_lifecycle;
ALTER TABLE integrity_report_lifecycle_next RENAME TO integrity_report_lifecycle;
CREATE INDEX idx_integrity_report_lifecycle_reader ON integrity_report_lifecycle(tenant_id,reader_state,report_id);

ALTER TABLE integrity_retention_completion ADD COLUMN backup_receipt TEXT NOT NULL DEFAULT '';
ALTER TABLE integrity_retention_completion ADD COLUMN backup_receipt_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE integrity_retention_completion ADD COLUMN backup_receipt_signature TEXT NOT NULL DEFAULT '';
ALTER TABLE integrity_retention_completion ADD COLUMN backup_receipt_key_id TEXT NOT NULL DEFAULT '';

CREATE TRIGGER integrity_retention_completion_no_update BEFORE UPDATE ON integrity_retention_completion BEGIN SELECT RAISE(ABORT, 'integrity_retention_completion is immutable'); END;
CREATE TRIGGER integrity_retention_completion_no_delete BEFORE DELETE ON integrity_retention_completion WHEN (SELECT enabled FROM integrity_retention_purge_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'integrity_retention_completion is append-only'); END;
`;

/** P1d review repair follow-up. Bind the completion to the exact immutable
 * registry envelope rather than merely its local locator. */
export const INTEGRITY_LIFECYCLE_REGISTRY_PROOF_SCHEMA_SQL = `
ALTER TABLE integrity_retention_completion ADD COLUMN registry_payload_hash TEXT NOT NULL DEFAULT '';
`;

/** P1d review repair. A destruction tombstone is verification material in its
 * own right: its signature key and canonical payload remain available through
 * the redaction registry's governed retention period. Legal-hold snapshots are
 * immutable evidence of every material set protected by the hold. */
export const INTEGRITY_LIFECYCLE_HOLD_AND_TOMBSTONE_RETENTION_SCHEMA_SQL = `
ALTER TABLE integrity_retention_tombstone ADD COLUMN retain_until TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z';

CREATE TABLE integrity_legal_hold_material (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  hold_id TEXT NOT NULL,
  material_kind TEXT NOT NULL CHECK(material_kind IN ('artifact_manifest','anchor','signing_key','integrity_check')),
  material_id TEXT NOT NULL,
  retain_until TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id,hold_id,material_kind,material_id)
);
CREATE TRIGGER integrity_legal_hold_material_no_update BEFORE UPDATE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;
CREATE TRIGGER integrity_legal_hold_material_no_delete BEFORE DELETE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;
`;

/** P1d review repair. Holds placed after a report has been destroyed must
 * snapshot the destruction proof itself. SQLite requires rebuilding this
 * append-only table to widen its material-kind contract. */
export const INTEGRITY_LIFECYCLE_HOLD_TOMBSTONE_SNAPSHOT_SCHEMA_SQL = `
DROP TRIGGER integrity_legal_hold_material_no_update;
DROP TRIGGER integrity_legal_hold_material_no_delete;
CREATE TABLE integrity_legal_hold_material_next (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  hold_id TEXT NOT NULL,
  material_kind TEXT NOT NULL CHECK(material_kind IN ('artifact_manifest','anchor','signing_key','integrity_check','retention_tombstone')),
  material_id TEXT NOT NULL,
  retain_until TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id,hold_id,material_kind,material_id)
);
INSERT INTO integrity_legal_hold_material_next(tenant_id,report_id,hold_id,material_kind,material_id,retain_until,recorded_at)
  SELECT tenant_id,report_id,hold_id,material_kind,material_id,retain_until,recorded_at FROM integrity_legal_hold_material;
DROP TABLE integrity_legal_hold_material;
ALTER TABLE integrity_legal_hold_material_next RENAME TO integrity_legal_hold_material;
CREATE TRIGGER integrity_legal_hold_material_no_update BEFORE UPDATE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;
CREATE TRIGGER integrity_legal_hold_material_no_delete BEFORE DELETE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;
`;

/** P1d review repair. A daily root is verification material for every leaf it
 * summarizes. Hold placement also stores the successful external Object-Lock
 * extension receipt; a failed extension creates an immutable local fence so
 * retention cannot proceed while the operator retries it. */
export const INTEGRITY_LIFECYCLE_EXTERNAL_HOLD_SCHEMA_SQL = `
DROP TRIGGER integrity_legal_hold_material_no_update;
DROP TRIGGER integrity_legal_hold_material_no_delete;
CREATE TABLE integrity_legal_hold_material_next (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), report_id TEXT NOT NULL REFERENCES report(id), hold_id TEXT NOT NULL,
  material_kind TEXT NOT NULL CHECK(material_kind IN ('artifact_manifest','anchor','daily_root','signing_key','integrity_check','retention_tombstone')),
  material_id TEXT NOT NULL, retain_until TEXT, recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id,hold_id,material_kind,material_id)
);
INSERT INTO integrity_legal_hold_material_next(tenant_id,report_id,hold_id,material_kind,material_id,retain_until,recorded_at)
  SELECT tenant_id,report_id,hold_id,material_kind,material_id,retain_until,recorded_at FROM integrity_legal_hold_material;
DROP TABLE integrity_legal_hold_material;
ALTER TABLE integrity_legal_hold_material_next RENAME TO integrity_legal_hold_material;
CREATE TRIGGER integrity_legal_hold_material_no_update BEFORE UPDATE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;
CREATE TRIGGER integrity_legal_hold_material_no_delete BEFORE DELETE ON integrity_legal_hold_material BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_material is append-only'); END;

CREATE TABLE integrity_daily_root_material (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  utc_date TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES report(id),
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  PRIMARY KEY(tenant_id,utc_date,artifact_id,artifact_version),
  FOREIGN KEY(tenant_id,utc_date) REFERENCES integrity_daily_root(tenant_id,utc_date)
);
CREATE INDEX idx_integrity_daily_root_material_report ON integrity_daily_root_material(tenant_id,report_id,utc_date);

CREATE TABLE integrity_legal_hold_extension_failure (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  hold_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id,hold_id,occurred_at)
);
CREATE TRIGGER integrity_legal_hold_extension_failure_no_update BEFORE UPDATE ON integrity_legal_hold_extension_failure BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_extension_failure is append-only'); END;
CREATE TRIGGER integrity_legal_hold_extension_failure_no_delete BEFORE DELETE ON integrity_legal_hold_extension_failure BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_extension_failure is append-only'); END;

CREATE TABLE integrity_legal_hold_external_proof (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  report_id TEXT NOT NULL REFERENCES report(id),
  hold_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  provider_version_id TEXT,
  retain_until TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,report_id,hold_id,object_key,provider_version_id)
);
CREATE TRIGGER integrity_legal_hold_external_proof_no_update BEFORE UPDATE ON integrity_legal_hold_external_proof BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_external_proof is append-only'); END;
CREATE TRIGGER integrity_legal_hold_external_proof_no_delete BEFORE DELETE ON integrity_legal_hold_external_proof BEGIN SELECT RAISE(ABORT, 'integrity_legal_hold_external_proof is append-only'); END;
`;

/** P1d review repair. This code-backed migration reconstructs legacy daily
 * root material only after the runner verifies the frozen leaf count and
 * canonical Merkle root; ambiguous historic roots stay fail-closed. */
export const INTEGRITY_LIFECYCLE_DAILY_ROOT_MATERIAL_BACKFILL_SQL = `
 -- The runner verifies ordered manifest hashes before it inserts this projection.
`;

/** P1b-2 dashboard facts. These are isolated from source-credit facts and report reads. */
export const P1_METRICS_SCHEMA_SQL = `
CREATE TABLE funnel_event (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), event_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, run_id TEXT, report_id TEXT, topic_id TEXT, source_id TEXT, stage TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('entered','terminal')), attempt INTEGER NOT NULL CHECK(attempt > 0),
  pipeline_version TEXT NOT NULL, skip_reason_code TEXT, reason_code TEXT,
  occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, schema_version TEXT NOT NULL CHECK(schema_version = 'funnel-v1'),
  producer_version TEXT NOT NULL, semantic_payload_hash TEXT NOT NULL,
  PRIMARY KEY(tenant_id,event_id)
);
CREATE UNIQUE INDEX idx_funnel_event_trace_stage_attempt_type ON funnel_event(tenant_id,trace_id,stage,attempt,event_type);
CREATE INDEX idx_funnel_event_tenant_occurred ON funnel_event(tenant_id,occurred_at DESC);
CREATE INDEX idx_funnel_event_tenant_report ON funnel_event(tenant_id,report_id);
CREATE INDEX idx_funnel_event_tenant_pipeline_occurred ON funnel_event(tenant_id,pipeline_version,occurred_at DESC);
CREATE INDEX idx_funnel_event_tenant_source_occurred ON funnel_event(tenant_id,source_id,occurred_at DESC);
CREATE TABLE funnel_event_conflict (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), id TEXT NOT NULL, event_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL, event_type TEXT NOT NULL,
  existing_semantic_payload_hash TEXT, received_semantic_payload_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX idx_funnel_event_conflict_tenant_event ON funnel_event_conflict(tenant_id,event_id,observed_at DESC);
CREATE TABLE cost_ledger (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), entry_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
  pipeline_version TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, currency TEXT NOT NULL,
  amount_minor INTEGER, cost_status TEXT NOT NULL CHECK(cost_status IN ('known','unknown')),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, schema_version TEXT NOT NULL CHECK(schema_version = 'cost-ledger-v1'),
  producer_version TEXT NOT NULL, semantic_payload_hash TEXT NOT NULL,
  PRIMARY KEY(tenant_id,entry_id)
);
CREATE INDEX idx_cost_ledger_tenant_occurred_provider_model ON cost_ledger(tenant_id,occurred_at,provider,model);
CREATE TABLE validator_result_fact (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), result_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0), pipeline_version TEXT NOT NULL,
  validator TEXT NOT NULL, rule_version TEXT NOT NULL, reason_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','error','critical')), terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
  occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, schema_version TEXT NOT NULL CHECK(schema_version = 'validator-result-v1'),
  producer_version TEXT NOT NULL, semantic_payload_hash TEXT NOT NULL,
  PRIMARY KEY(tenant_id,result_id)
);
CREATE INDEX idx_validator_result_tenant_validator_reason_occurred ON validator_result_fact(tenant_id,validator,reason_code,occurred_at);
CREATE TABLE metric_late_event (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), fact_kind TEXT NOT NULL, event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, reason_code TEXT NOT NULL CHECK(reason_code = 'late_event_outside_backfill_window'),
  PRIMARY KEY(tenant_id,fact_kind,event_id)
);
CREATE INDEX idx_metric_late_event_tenant_occurred ON metric_late_event(tenant_id,occurred_at DESC);
CREATE TABLE metric_rollup (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), grain TEXT NOT NULL CHECK(grain IN ('hour','day')),
  bucket_start TEXT NOT NULL, metric_kind TEXT NOT NULL CHECK(metric_kind IN ('funnel','cost','validator')),
  pipeline_version TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '', validator TEXT NOT NULL DEFAULT '', reason_code TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT '', rule_version TEXT NOT NULL DEFAULT '',
  received_traces INTEGER NOT NULL DEFAULT 0, reached_traces INTEGER NOT NULL DEFAULT 0, terminal_events INTEGER NOT NULL DEFAULT 0,
  known_cost_minor INTEGER NOT NULL DEFAULT 0, known_cost_entries INTEGER NOT NULL DEFAULT 0, unknown_cost_entries INTEGER NOT NULL DEFAULT 0,
  validator_results INTEGER NOT NULL DEFAULT 0, validator_traces INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT, revised_at TEXT,
  PRIMARY KEY(tenant_id,grain,bucket_start,metric_kind,pipeline_version,stage,provider,model,currency,validator,reason_code,severity,rule_version)
);
CREATE INDEX idx_metric_rollup_tenant_grain_bucket ON metric_rollup(tenant_id,grain,bucket_start DESC);
`;

/** P1b-2 follow-up. Keep this separate from the immutable v14 migration: existing
 * databases must advance without a checksum rewrite. */
export const P1_METRICS_FOLLOWUP_SCHEMA_SQL = `
ALTER TABLE cost_ledger ADD COLUMN topic_id TEXT;
ALTER TABLE cost_ledger ADD COLUMN source_id TEXT;
ALTER TABLE validator_result_fact ADD COLUMN topic_id TEXT;
ALTER TABLE validator_result_fact ADD COLUMN source_id TEXT;

CREATE TABLE metric_rollup_next (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), grain TEXT NOT NULL CHECK(grain IN ('hour','day')),
  bucket_start TEXT NOT NULL, metric_kind TEXT NOT NULL CHECK(metric_kind IN ('funnel','cost','validator')),
  topic_id TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', pipeline_version TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '', validator TEXT NOT NULL DEFAULT '', reason_code TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT '', rule_version TEXT NOT NULL DEFAULT '',
  received_traces INTEGER NOT NULL DEFAULT 0, reached_traces INTEGER NOT NULL DEFAULT 0, terminal_events INTEGER NOT NULL DEFAULT 0,
  known_cost_minor INTEGER NOT NULL DEFAULT 0, known_cost_entries INTEGER NOT NULL DEFAULT 0, unknown_cost_entries INTEGER NOT NULL DEFAULT 0,
  validator_results INTEGER NOT NULL DEFAULT 0, validator_traces INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT, revised_at TEXT,
  PRIMARY KEY(tenant_id,grain,bucket_start,metric_kind,topic_id,source_id,pipeline_version,stage,provider,model,currency,validator,reason_code,severity,rule_version)
);
INSERT INTO metric_rollup_next(tenant_id,grain,bucket_start,metric_kind,pipeline_version,stage,provider,model,currency,validator,reason_code,severity,rule_version,received_traces,reached_traces,terminal_events,known_cost_minor,known_cost_entries,unknown_cost_entries,validator_results,validator_traces,frozen_at,revised_at)
  SELECT tenant_id,grain,bucket_start,metric_kind,pipeline_version,stage,provider,model,currency,validator,reason_code,severity,rule_version,received_traces,reached_traces,terminal_events,known_cost_minor,known_cost_entries,unknown_cost_entries,validator_results,validator_traces,frozen_at,revised_at FROM metric_rollup;
DROP TABLE metric_rollup;
ALTER TABLE metric_rollup_next RENAME TO metric_rollup;
CREATE INDEX idx_metric_rollup_tenant_grain_bucket ON metric_rollup(tenant_id,grain,bucket_start DESC);
CREATE INDEX idx_metric_rollup_tenant_grain_topic_bucket ON metric_rollup(tenant_id,grain,topic_id,bucket_start DESC);
CREATE INDEX idx_metric_rollup_tenant_grain_source_bucket ON metric_rollup(tenant_id,grain,source_id,bucket_start DESC);
CREATE INDEX idx_cost_ledger_tenant_topic_occurred ON cost_ledger(tenant_id,topic_id,occurred_at DESC);
CREATE INDEX idx_cost_ledger_tenant_source_occurred ON cost_ledger(tenant_id,source_id,occurred_at DESC);
CREATE INDEX idx_validator_result_tenant_topic_occurred ON validator_result_fact(tenant_id,topic_id,occurred_at DESC);
CREATE INDEX idx_validator_result_tenant_source_occurred ON validator_result_fact(tenant_id,source_id,occurred_at DESC);
CREATE INDEX idx_validator_result_tenant_occurred ON validator_result_fact(tenant_id,occurred_at DESC);

CREATE TABLE metric_late_reconciliation (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), id TEXT NOT NULL, fact_kind TEXT NOT NULL, event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('backfilled','declined')), actor_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,fact_kind,event_id) REFERENCES metric_late_event(tenant_id,fact_kind,event_id)
);
CREATE INDEX idx_metric_late_reconciliation_tenant_event ON metric_late_reconciliation(tenant_id,fact_kind,event_id,recorded_at DESC);
CREATE TABLE metric_maintenance_guard (id INTEGER PRIMARY KEY CHECK(id = 1), retention_delete INTEGER NOT NULL CHECK(retention_delete IN (0,1)));
INSERT INTO metric_maintenance_guard(id,retention_delete) VALUES (1,0);

CREATE TRIGGER funnel_event_no_update BEFORE UPDATE ON funnel_event BEGIN SELECT RAISE(ABORT, 'funnel_event is append-only'); END;
CREATE TRIGGER funnel_event_no_delete BEFORE DELETE ON funnel_event WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'funnel_event is append-only'); END;
CREATE TRIGGER funnel_event_conflict_no_update BEFORE UPDATE ON funnel_event_conflict BEGIN SELECT RAISE(ABORT, 'funnel_event_conflict is append-only'); END;
CREATE TRIGGER funnel_event_conflict_no_delete BEFORE DELETE ON funnel_event_conflict WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'funnel_event_conflict is append-only'); END;
CREATE TRIGGER cost_ledger_no_update BEFORE UPDATE ON cost_ledger BEGIN SELECT RAISE(ABORT, 'cost_ledger is append-only'); END;
CREATE TRIGGER cost_ledger_no_delete BEFORE DELETE ON cost_ledger WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'cost_ledger is append-only'); END;
CREATE TRIGGER validator_result_fact_no_update BEFORE UPDATE ON validator_result_fact BEGIN SELECT RAISE(ABORT, 'validator_result_fact is append-only'); END;
CREATE TRIGGER validator_result_fact_no_delete BEFORE DELETE ON validator_result_fact WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'validator_result_fact is append-only'); END;
CREATE TRIGGER metric_late_event_no_update BEFORE UPDATE ON metric_late_event BEGIN SELECT RAISE(ABORT, 'metric_late_event is append-only'); END;
CREATE TRIGGER metric_late_event_no_delete BEFORE DELETE ON metric_late_event WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'metric_late_event is append-only'); END;
CREATE TRIGGER metric_late_reconciliation_no_update BEFORE UPDATE ON metric_late_reconciliation BEGIN SELECT RAISE(ABORT, 'metric_late_reconciliation is append-only'); END;
CREATE TRIGGER metric_late_reconciliation_no_delete BEFORE DELETE ON metric_late_reconciliation WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'metric_late_reconciliation is append-only'); END;
`;

/** P1b-2 conflict audit follow-up.  Keep the original metric migrations immutable. */
export const P1_METRICS_CONFLICT_AUDIT_SCHEMA_SQL = `
CREATE TABLE metric_fact_conflict (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK(fact_kind IN ('cost','validator')), business_id TEXT NOT NULL,
  existing_semantic_payload_hash TEXT NOT NULL, received_semantic_payload_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(reason_code = 'semantic_payload_mismatch'), observed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX idx_metric_fact_conflict_tenant_kind_business ON metric_fact_conflict(tenant_id,fact_kind,business_id,observed_at DESC);
CREATE TRIGGER metric_fact_conflict_no_update BEFORE UPDATE ON metric_fact_conflict BEGIN SELECT RAISE(ABORT, 'metric_fact_conflict is append-only'); END;
CREATE TRIGGER metric_fact_conflict_no_delete BEFORE DELETE ON metric_fact_conflict WHEN (SELECT retention_delete FROM metric_maintenance_guard WHERE id=1) = 0 BEGIN SELECT RAISE(ABORT, 'metric_fact_conflict is append-only'); END;
`;

/**
 * Versioned, trace-granular dashboard projection.  Daily rollups cannot be
 * added together for a distinct-trace metric, so this projection retains the
 * minimum controlled fields required to calculate exact 31–400 day windows.
 */
export const P1_DASHBOARD_TRACE_READ_MODEL_V1_SCHEMA_SQL = `
CREATE TABLE dashboard_trace_fact_v1 (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  fact_kind TEXT NOT NULL CHECK(fact_kind IN ('funnel','validator')),
  fact_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('entered','terminal','validator_result')),
  pipeline_version TEXT NOT NULL,
  validator TEXT NOT NULL DEFAULT '',
  rule_version TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT '',
  terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),
  occurred_at TEXT NOT NULL,
  projection_version TEXT NOT NULL CHECK(projection_version = 'dashboard-trace-v1'),
  PRIMARY KEY(tenant_id,fact_kind,fact_id)
);
CREATE INDEX idx_dashboard_trace_fact_v1_window ON dashboard_trace_fact_v1(tenant_id,projection_version,occurred_at,trace_id);
CREATE INDEX idx_dashboard_trace_fact_v1_kind_window ON dashboard_trace_fact_v1(tenant_id,projection_version,fact_kind,occurred_at,trace_id);
CREATE INDEX idx_dashboard_trace_fact_v1_terminal_window ON dashboard_trace_fact_v1(tenant_id,projection_version,fact_kind,event_type,occurred_at,trace_id,fact_id);
`;

/**
 * Versioned, cost-granular dashboard projection. Daily rollups are exact only
 * for complete UTC days, so this retains the controlled fields necessary to
 * aggregate either partial boundary day for a 31–400 day dashboard window.
 */
export const P1_DASHBOARD_COST_READ_MODEL_V1_SCHEMA_SQL = `
CREATE TABLE dashboard_cost_fact_v1 (
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  entry_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER,
  cost_status TEXT NOT NULL CHECK(cost_status IN ('known','unknown')),
  occurred_at TEXT NOT NULL,
  projection_version TEXT NOT NULL CHECK(projection_version = 'dashboard-cost-v1'),
  PRIMARY KEY(tenant_id,entry_id)
);
CREATE INDEX idx_dashboard_cost_fact_v1_window ON dashboard_cost_fact_v1(tenant_id,projection_version,occurred_at,provider,model);
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('rss','arxiv','api')),
  endpoint       TEXT NOT NULL,
  topic_ids      TEXT NOT NULL DEFAULT '[]',
  fetch_interval TEXT NOT NULL,
  backfill       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  fetch_mode     TEXT NOT NULL DEFAULT 'feed' CHECK (fetch_mode IN ('feed','full_text')),
  content_container TEXT,
  disabled_reason TEXT,
  disabled_at     TEXT,
  circuit_reset_at TEXT,
  last_probe_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 应用用户（多账号 · 受邀只读账号）：admin 在设置页增删；密码 scrypt 哈希存储。
-- bootstrap admin 走 env ADMIN_EMAIL/ADMIN_PASSWORD、不入此表（不可删、不会被锁死）。
CREATE TABLE IF NOT EXISTS app_user (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邮件分发收件人（报告推送的邮件渠道收件名单）：admin 在设置页增删/启停。
-- 取代「改服务器 env REPORT_EMAIL_TO」——库里有启用收件人即以库为准，库空才回落 env（兜底、零回归）。
-- email 为 PK（规范化小写存，天然去重）；enabled=0 暂停而不删；label 备注（谁/用途，可空）。
CREATE TABLE IF NOT EXISTS email_recipient (
  email      TEXT PRIMARY KEY,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',
  language       TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),
  brief_schedule TEXT NOT NULL CHECK (brief_schedule IN ('daily','weekly')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  -- ADR-0010 行为原型：无 DB CHECK（app 层 ARCHETYPE_VALUES 校验，加原型零迁移，reference-data 模式）
  archetype      TEXT NOT NULL DEFAULT 'deep_vertical',
  -- ADR-0010 分面标签（JSON 数组，如 ["domain:software-engineering","lens:business"]）：分类维度 domain(必填)+lens(选填)。
  facets         TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_item (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(id),
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  author       TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  language     TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),
  topic_ids    TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  body         TEXT NOT NULL,
  body_kind    TEXT NOT NULL DEFAULT 'article' CHECK (body_kind IN ('article','show_notes','transcript')),
  raw_ref      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('ok','partial'))
);
CREATE INDEX IF NOT EXISTS idx_content_source ON content_item(source_id);
-- 规范化 url 唯一（data-collection AC2：同 URL 内容更新走原地 upsert、不新增；id 由 url 派生不变）
DROP INDEX IF EXISTS idx_content_url_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_url ON content_item(url);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ingest','analyze','validate','report-gen')),
  target      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  cost        TEXT,
  error       TEXT,
  retry_of    TEXT REFERENCES run(id),
  inserted    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_status ON run(status);
CREATE INDEX IF NOT EXISTS idx_run_kind   ON run(kind);
-- 看板全部 listRuns 走 ORDER BY started_at DESC（分页/时序/源健康），run 表随每轮 cron 无界增长
-- → started_at 加索引避免全表排序；复合 (kind,started_at) 同时覆盖按段筛选+排序。
CREATE INDEX IF NOT EXISTS idx_run_started      ON run(started_at);
CREATE INDEX IF NOT EXISTS idx_run_kind_started ON run(kind, started_at);

CREATE TABLE IF NOT EXISTS analysis_batch (
  id                   TEXT PRIMARY KEY,
  topic_id             TEXT NOT NULL REFERENCES topic(id),
  time_window          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('done','failed')),
  no_significant_event INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (no_significant_event = 1 AND status <> 'done'))
);
CREATE INDEX IF NOT EXISTS idx_batch_topic ON analysis_batch(topic_id);

CREATE TABLE IF NOT EXISTS insight (
  id               TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL REFERENCES analysis_batch(id),
  topic_id         TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('aggregation','trend')),
  event_id         TEXT,
  statement        TEXT NOT NULL,
  headline         TEXT NOT NULL DEFAULT '',
  importance       INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  importance_basis TEXT NOT NULL,
  source_count     INTEGER NOT NULL,
  multi_source     INTEGER NOT NULL,
  time_window      TEXT NOT NULL,
  confidence       TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  language         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_batch ON insight(batch_id);

CREATE TABLE IF NOT EXISTS citation (
  insight_id      TEXT NOT NULL REFERENCES insight(id),
  citation_index  INTEGER NOT NULL,
  content_item_id TEXT NOT NULL,
  quote           TEXT NOT NULL,
  locator         TEXT NOT NULL,
  PRIMARY KEY (insight_id, citation_index)
);

CREATE TABLE IF NOT EXISTS citation_check (
  batch_id            TEXT NOT NULL REFERENCES analysis_batch(id),
  insight_id          TEXT NOT NULL,
  citation_index      INTEGER NOT NULL,
  reachability        TEXT NOT NULL CHECK (reachability IN ('pass','fail')),
  reachability_reason TEXT NOT NULL CHECK (reachability_reason IN ('ok','source_not_found','source_unreachable','quote_not_in_source')),
  consistency         TEXT NOT NULL CHECK (consistency IN ('support','not_support','uncertain','not_evaluated')),
  consistency_reason  TEXT NOT NULL CHECK (consistency_reason IN ('ok','out_of_context','exaggeration','misattribution','uncertain','not_evaluated')),
  verdict             TEXT NOT NULL CHECK (verdict IN ('pass','blocked','flagged')),
  PRIMARY KEY (batch_id, insight_id, citation_index)
);

CREATE TABLE IF NOT EXISTS validation_result (
  batch_id                 TEXT PRIMARY KEY REFERENCES analysis_batch(id),
  total                    INTEGER NOT NULL,
  pass                     INTEGER NOT NULL,
  blocked                  INTEGER NOT NULL,
  flagged                  INTEGER NOT NULL,
  errored                  INTEGER NOT NULL DEFAULT 0,
  consistency_failure_rate REAL NOT NULL,
  flagged_rate             REAL NOT NULL,
  insights_total           INTEGER NOT NULL DEFAULT 0,
  insights_includable      INTEGER NOT NULL DEFAULT 0,
  releasable               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS report (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('brief','deep_dive','initial_digest')),
  topic_id       TEXT NOT NULL REFERENCES topic(id),
  status         TEXT NOT NULL CHECK (status IN ('draft','generating','done','failed','archived','deleted')),
  generated_at   TEXT NOT NULL,
  title          TEXT NOT NULL,
  -- failed/generating 尝试没有公开 artifact；只有 published(done) 行拥有正文路径。
  body_path      TEXT,
  insight_ids    TEXT NOT NULL DEFAULT '[]',
  event_ids      TEXT NOT NULL DEFAULT '[]',
  prev_report_id TEXT,
  citation_count INTEGER NOT NULL,
  cost           TEXT NOT NULL,
  failure        TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_topic  ON report(topic_id);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status);

CREATE TABLE IF NOT EXISTS report_index (
  report_id    TEXT PRIMARY KEY REFERENCES report(id),
  type         TEXT NOT NULL,
  topic_id     TEXT NOT NULL,
  facets       TEXT NOT NULL DEFAULT '[]',
  date         TEXT NOT NULL,
  source_ids   TEXT NOT NULL DEFAULT '[]',
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  highlights   TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  entity_names TEXT NOT NULL DEFAULT '[]',
  importance   INTEGER NOT NULL,
  event_ids    TEXT NOT NULL DEFAULT '[]',
  milestone_count INTEGER NOT NULL DEFAULT 0,
  freshest_candidate_at TEXT,
  freshest_citation_at TEXT,
  freshness_lag_hours REAL
);
CREATE INDEX IF NOT EXISTS idx_report_index_topic ON report_index(topic_id);
CREATE INDEX IF NOT EXISTS idx_report_index_date  ON report_index(date);

-- 技术线索：由成功校验洞察确定性派生。canonical_key 在一个主题内唯一，保证“新证据更新而非重复推荐”。
CREATE TABLE IF NOT EXISTS tech_lead (
  id                 TEXT PRIMARY KEY,
  topic_id           TEXT NOT NULL REFERENCES topic(id),
  canonical_key      TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('model','framework','paper','benchmark','tool','method','security','other')),
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('recommended','watching','dismissed')) DEFAULT 'recommended',
  score              REAL NOT NULL,
  score_detail       TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  latest_evidence_at TEXT NOT NULL,
  UNIQUE(topic_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_tech_lead_topic_score ON tech_lead(topic_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_tech_lead_latest ON tech_lead(latest_evidence_at DESC);

CREATE TABLE IF NOT EXISTS tech_lead_evidence (
  lead_id        TEXT NOT NULL REFERENCES tech_lead(id) ON DELETE CASCADE,
  insight_id     TEXT NOT NULL,
  citation_index INTEGER NOT NULL,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (lead_id, insight_id, citation_index),
  FOREIGN KEY (insight_id, citation_index) REFERENCES citation(insight_id, citation_index)
);

-- 技术规划层：只链接技术线索事实层，不创建绕过 CitationCheck(pass) 的发布旁路。
CREATE TABLE IF NOT EXISTS topic_direction (
  id                TEXT PRIMARY KEY,
  topic_id          TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  objective         TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  in_scope          TEXT NOT NULL DEFAULT '[]',
  out_of_scope      TEXT NOT NULL DEFAULT '[]',
  key_questions     TEXT NOT NULL DEFAULT '[]',
  constraints_json  TEXT NOT NULL DEFAULT '[]',
  success_signals   TEXT NOT NULL DEFAULT '[]',
  match_terms       TEXT NOT NULL DEFAULT '[]',
  adjacent_terms    TEXT NOT NULL DEFAULT '[]',
  challenge_terms   TEXT NOT NULL DEFAULT '[]',
  horizon           TEXT NOT NULL CHECK (horizon IN ('now','next','explore')),
  status            TEXT NOT NULL CHECK (status IN ('active','watching','retired')),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_direction_topic ON topic_direction(topic_id, status, horizon);

CREATE TABLE IF NOT EXISTS tech_lead_direction_map (
  lead_id         TEXT NOT NULL REFERENCES tech_lead(id) ON DELETE CASCADE,
  direction_id    TEXT NOT NULL REFERENCES topic_direction(id) ON DELETE CASCADE,
  lane            TEXT NOT NULL CHECK (lane IN ('core','adjacent','horizon','challenge')),
  planning_effect TEXT NOT NULL CHECK (planning_effect IN ('reinforce','expand','challenge','new_direction')),
  fit_score       REAL NOT NULL,
  rationale       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (lead_id, direction_id)
);

CREATE TABLE IF NOT EXISTS technology_opportunity (
  id                  TEXT PRIMARY KEY,
  topic_id            TEXT NOT NULL REFERENCES topic(id),
  direction_id        TEXT REFERENCES topic_direction(id) ON DELETE SET NULL,
  canonical_key       TEXT NOT NULL,
  lane                TEXT NOT NULL CHECK (lane IN ('core','adjacent','horizon','challenge')),
  planning_effect     TEXT NOT NULL CHECK (planning_effect IN ('reinforce','expand','challenge','new_direction')),
  title               TEXT NOT NULL,
  hypothesis          TEXT NOT NULL,
  proposed_validation TEXT NOT NULL,
  uncertainties       TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('observed','watching','research_candidate','poc_ready','project_candidate','adopted','rejected','archived')) DEFAULT 'observed',
  mapping_state       TEXT NOT NULL DEFAULT 'current' CHECK (mapping_state IN ('current','stale')),
  mapping_direction_version INTEGER,
  priority_score      REAL NOT NULL,
  score_detail        TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  latest_evidence_at  TEXT NOT NULL,
  UNIQUE(topic_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_topic_priority ON technology_opportunity(topic_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_opportunity_direction ON technology_opportunity(direction_id, status);

CREATE TABLE IF NOT EXISTS opportunity_lead (
  opportunity_id TEXT NOT NULL REFERENCES technology_opportunity(id) ON DELETE CASCADE,
  lead_id        TEXT NOT NULL REFERENCES tech_lead(id) ON DELETE CASCADE,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, lead_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS report_fts USING fts5(report_id UNINDEXED, title, summary, body);

-- ── 增量6c：审计日志（append-only，architecture 安全设计「审计与日志」，保留 90 天）──
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT,                 -- 用户 / 系统标识
  action TEXT NOT NULL,        -- login / config_change / source_add / report_gen / push / delete ...
  target TEXT,                 -- 关联对象
  detail TEXT                  -- JSON 附加（调用方负责脱敏后再传入）
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- ── 增量·D：PPT polish 缓存（B 路径 LLM 重写）──
-- B 路径每次 ~$0.21 / ~30s；同一 report 重复点击导出按钮（或 LLM 路径），靠 inputs_hash
-- 复用上次成功结果，cache 命中秒级返、零成本。
-- inputs_hash = SHA-256(topic.name + sorted [insight.id, statement, importance_basis])，
-- 任一输入变化（topic 改名、洞察改写、纳入条变动）都自动失效。
-- 只缓存"完整成功"结果（perInsight 全填 + executive 非 null），partial 不写入
-- → 中转站偶发流式截断时下次还会重试、直到攒齐一份完整 polish 才锁。
CREATE TABLE IF NOT EXISTS ppt_polish_cache (
  report_id   TEXT PRIMARY KEY,
  inputs_hash TEXT NOT NULL,
  polish_json TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  amount      REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一致性判定缓存：跨批/跨run 复用 (statement, item.body) 的 Opus 判定，省重复校验成本
-- （尤其 relay 抖动导致的部分失败重跑、报告重生成）。key = sha256(version + NUL + statement + NUL + body)，
-- version=校验模型+prompt 哈希（改模型/prompt 自动失效）；读侧带 TTL（见 db/consistency-cache.ts）。
-- 只缓存成功判定（support/not_support/uncertain）；调用失败（not_evaluated）绝不入缓存（瞬时抖动须重试）。
CREATE TABLE IF NOT EXISTS consistency_cache (
  key                 TEXT PRIMARY KEY,
  consistency         TEXT NOT NULL CHECK (consistency IN ('support','not_support','uncertain')),
  consistency_reason  TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 增量分析缓存（ADR-0009 切片1，行为中性·只写不读）：记录每 (item content_hash, topic, analyzer 版本)
-- 产出的单源洞察 + 同键重复出现次数（hit_count = would-be cache hit），用于量化「同内容跨日重析」冗余/命中率。
-- 切片1 不读不复用（LLM 照常跑、输出不变）；切片2 才据此跳过重析。版本隔离 + TTL 同 consistency_cache。
CREATE TABLE IF NOT EXISTS analysis_cache (
  key            TEXT PRIMARY KEY,            -- sha256(analyzer_version ⊥ topic_id ⊥ content_hash)
  topic_id       TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  insights_json  TEXT NOT NULL,               -- 该 item 的单源洞察数组（首写定；空数组=分析了但没产出）
  hit_count      INTEGER NOT NULL DEFAULT 0,  -- 同键重复写入次数 = would-be 命中（切片1 命中率度量）
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 报告页内追问（Follow-up Q&A，A4）：用户就某报告内容提问 → 受限于该报告引用池的可溯源回答。
-- thread_id / turn_index 为多轮升级预留：v1 单轮恒 thread_id=自身id、turn_index=0；
-- 升级多轮时按 thread_id 归并、turn_index 排序，无需迁移。
-- citations_used / validation / cost 以 JSON TEXT 存（与本库其他 JSON 字段一致）。
CREATE TABLE IF NOT EXISTS followup_qa (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES report(id),
  thread_id      TEXT NOT NULL,
  turn_index     INTEGER NOT NULL DEFAULT 0,
  question       TEXT NOT NULL,
  answer_md      TEXT NOT NULL,
  citations_used TEXT NOT NULL DEFAULT '[]',
  validation     TEXT NOT NULL DEFAULT '{}',
  cost           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('done','failed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followup_report ON followup_qa(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_followup_thread ON followup_qa(thread_id, turn_index);
`;
