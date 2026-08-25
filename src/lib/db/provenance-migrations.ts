/** P0a 的显式 migration runner。应用启动不调用它；部署必须先运行本模块。 */
import { createHash } from "node:crypto";
import type { DB } from "./index.js";
import { merkleRoot } from "./integrity-anchors.js";
import { INTEGRITY_ANCHOR_HARDENING_SCHEMA_SQL, INTEGRITY_ANCHOR_IMMUTABILITY_SQL, INTEGRITY_ANCHOR_LEGACY_SCHEMA_SQL, INTEGRITY_ANCHOR_RECOVERY_SCHEMA_SQL, INTEGRITY_CHECK_KEY_REVOCATION_SCHEMA_SQL, INTEGRITY_CHECK_SCHEMA_SQL, INTEGRITY_LIFECYCLE_COMPLETION_PROOF_SCHEMA_SQL, INTEGRITY_LIFECYCLE_DAILY_ROOT_MATERIAL_BACKFILL_SQL, INTEGRITY_LIFECYCLE_EXTERNAL_HOLD_SCHEMA_SQL, INTEGRITY_LIFECYCLE_HOLD_AND_TOMBSTONE_RETENTION_SCHEMA_SQL, INTEGRITY_LIFECYCLE_HOLD_TOMBSTONE_SNAPSHOT_SCHEMA_SQL, INTEGRITY_LIFECYCLE_PURGE_SCHEMA_SQL, INTEGRITY_LIFECYCLE_REGISTRY_PROOF_SCHEMA_SQL, INTEGRITY_LIFECYCLE_SCHEMA_SQL, INTEGRITY_MAINTENANCE_LEASE_SCHEMA_SQL, P1_METRICS_CONFLICT_AUDIT_SCHEMA_SQL, P1_METRICS_FOLLOWUP_SCHEMA_SQL, P1_METRICS_SCHEMA_SQL } from "./schema.js";

const CORE_SQL = `
ALTER TABLE run ADD COLUMN trace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_run_trace ON run(trace_id);
CREATE TABLE generation_trace (id TEXT PRIMARY KEY,request_id TEXT UNIQUE,scope_kind TEXT NOT NULL,trigger_kind TEXT NOT NULL,topic_id TEXT REFERENCES topic(id),root_run_id TEXT REFERENCES run(id) DEFERRABLE INITIALLY DEFERRED,status TEXT NOT NULL,completion_policy TEXT NOT NULL,coverage TEXT NOT NULL DEFAULT 'complete',runtime_version TEXT NOT NULL DEFAULT '{}',summary TEXT NOT NULL DEFAULT '{}',next_sequence INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT,retry_of_trace_id TEXT REFERENCES generation_trace(id));
CREATE INDEX idx_generation_trace_topic_started ON generation_trace(topic_id, started_at DESC);
CREATE TABLE generation_trace_request (id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,active_key TEXT NOT NULL,idempotency_key_hash TEXT,request_sequence INTEGER NOT NULL DEFAULT 1,trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),state TEXT NOT NULL,retained_until TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX idx_trace_request_idempotency ON generation_trace_request(idempotency_key_hash, retained_until);
CREATE TABLE generation_dispatch (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES generation_trace_request(id),trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,claim_epoch INTEGER NOT NULL DEFAULT 0,owner_token TEXT,claimed_at TEXT,heartbeat_at TEXT,lease_expires_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX idx_dispatch_claim ON generation_dispatch(state, lease_expires_at, created_at);
CREATE TABLE generation_lease (id TEXT PRIMARY KEY,active_key TEXT NOT NULL,scope_key TEXT NOT NULL,trace_id TEXT NOT NULL REFERENCES generation_trace(id),state TEXT NOT NULL,owner_token TEXT,fencing_epoch INTEGER NOT NULL DEFAULT 0,heartbeat_at TEXT,expires_at TEXT,created_at TEXT NOT NULL,released_at TEXT);
CREATE UNIQUE INDEX idx_generation_lease_active ON generation_lease(active_key) WHERE state IN ('reserved','owned');
`;

// 第二个版本只负责 Report 表契约；完整 generation_effect/reconciliation 会跟随 event/revision
// 阶段加入，不能在还没有投影真值时伪造一个无法恢复的 effect 表。
const REPORT_LIFECYCLE_SQL = "report.body_path nullable; report.failure structured JSON";
const REPORT_EFFECT_SQL = `
CREATE TABLE generation_effect (
  id TEXT PRIMARY KEY,
  trace_id TEXT REFERENCES generation_trace(id),
  report_id TEXT NOT NULL UNIQUE REFERENCES report(id),
  kind TEXT NOT NULL CHECK (kind IN ('report_file')),
  idempotency_key TEXT NOT NULL UNIQUE,
  artifact_manifest TEXT NOT NULL,
  publication_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','attempted','committed','unknown','abandoned')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_generation_effect_pending ON generation_effect(status, created_at);
`;
const REDACTION_SQL = `
CREATE TABLE provenance_redaction (
  record_id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  expiry_at TEXT NOT NULL,
  registry_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(entity_key, scope)
);
CREATE INDEX idx_provenance_redaction_active ON provenance_redaction(entity_key, effective_at, expiry_at);
CREATE TRIGGER provenance_redaction_no_update BEFORE UPDATE ON provenance_redaction BEGIN SELECT RAISE(ABORT, 'provenance_redaction is append-only'); END;
CREATE TRIGGER provenance_redaction_no_delete BEFORE DELETE ON provenance_redaction BEGIN SELECT RAISE(ABORT, 'provenance_redaction is append-only'); END;
`;

// 条件写 S3 前持久化完全相同的密文 payload：进程在 PutObject 成功、SQLite tombstone 未提交时中断，
// 下次可复用相同 key/body 重试；不得重新加密而产生同 record_id 的不同 immutable object。
const REDACTION_REQUEST_SQL = `
CREATE TABLE provenance_redaction_request (
  deletion_request_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  entity_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  expiry_at TEXT NOT NULL,
  registry_key TEXT NOT NULL UNIQUE,
  registry_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','registered')),
  created_at TEXT NOT NULL,
  registered_at TEXT,
  UNIQUE(entity_key, scope)
);
CREATE INDEX idx_provenance_redaction_request_status ON provenance_redaction_request(status, created_at);
`;

const PROVENANCE_FACTS_SQL = `
CREATE TABLE generation_event (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES generation_trace(id),
  sequence INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  parent_event_id TEXT REFERENCES generation_event(id),
  run_id TEXT REFERENCES run(id),
  stage TEXT NOT NULL CHECK(stage IN ('collect','normalize','select','analyze','validate','derive_lead','map_direction','derive_opportunity','generate_report','deliver','human_review','direction_change')),
  event_type TEXT NOT NULL CHECK(event_type IN ('started','planned','attempted','completed','failed','skipped','retried','manual_decided','config_changed','published')),
  occurred_at TEXT NOT NULL,
  duration_ms INTEGER,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('system','user','scheduler')),
  actor_id TEXT,
  audit_log_id INTEGER REFERENCES audit_log(id),
  reason_code TEXT,
  input_refs TEXT NOT NULL,
  output_refs TEXT NOT NULL,
  metrics TEXT NOT NULL,
  version_context TEXT NOT NULL,
  context_completeness TEXT NOT NULL CHECK(context_completeness IN ('complete','partial')),
  error TEXT,
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  semantic_payload_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE(trace_id, sequence),
  UNIQUE(trace_id, stage, attempt, event_type)
);
CREATE INDEX idx_generation_event_trace_sequence ON generation_event(trace_id, sequence);
CREATE INDEX idx_generation_event_id ON generation_event(id);
CREATE TRIGGER generation_event_no_update BEFORE UPDATE ON generation_event BEGIN SELECT RAISE(ABORT, 'generation_event is append-only'); END;
CREATE TRIGGER generation_event_no_delete BEFORE DELETE ON generation_event BEGIN SELECT RAISE(ABORT, 'generation_event is append-only'); END;

CREATE TABLE provenance_revision (
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_key, revision)
);
CREATE INDEX idx_provenance_revision_entity ON provenance_revision(entity_type, entity_key, captured_at DESC);
CREATE TRIGGER provenance_revision_no_update BEFORE UPDATE ON provenance_revision BEGIN SELECT RAISE(ABORT, 'provenance_revision is append-only'); END;
CREATE TRIGGER provenance_revision_no_delete BEFORE DELETE ON provenance_revision BEGIN SELECT RAISE(ABORT, 'provenance_revision is append-only'); END;

CREATE TABLE generation_entity_ref (
  trace_id TEXT NOT NULL REFERENCES generation_trace(id),
  event_id TEXT NOT NULL REFERENCES generation_event(id),
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('input','output','evidence','filtered','superseded')),
  visibility_class TEXT NOT NULL CHECK(visibility_class IN ('public_evidence','admin_only','redacted_at_write')),
  PRIMARY KEY(event_id, entity_type, entity_key, revision, role)
);
CREATE INDEX idx_generation_entity_ref_entity ON generation_entity_ref(entity_type, entity_key, trace_id);

CREATE TABLE generation_edge (
  trace_id TEXT NOT NULL REFERENCES generation_trace(id),
  event_id TEXT NOT NULL REFERENCES generation_event(id),
  from_type TEXT NOT NULL, from_key TEXT NOT NULL, from_revision TEXT NOT NULL,
  to_type TEXT NOT NULL, to_key TEXT NOT NULL, to_revision TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('consumed','produced','validated','supports','filtered_by','derived_from','decided_on','delivered_as','supersedes','retry_of')),
  visibility_class TEXT NOT NULL CHECK(visibility_class IN ('public_evidence','admin_only','redacted_at_write')),
  PRIMARY KEY(event_id, from_type, from_key, from_revision, to_type, to_key, to_revision, relation)
);
CREATE INDEX idx_generation_edge_from ON generation_edge(from_type, from_key, trace_id);
CREATE INDEX idx_generation_edge_to ON generation_edge(to_type, to_key, trace_id);

CREATE TABLE provenance_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER provenance_meta_no_update BEFORE UPDATE ON provenance_meta BEGIN SELECT RAISE(ABORT, 'provenance_meta is immutable'); END;
CREATE TRIGGER provenance_meta_no_delete BEFORE DELETE ON provenance_meta BEGIN SELECT RAISE(ABORT, 'provenance_meta is immutable'); END;
`;
const DEPLOYMENT_SQL = `
CREATE TABLE deployment_record (id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,git_sha TEXT NOT NULL,deployed_at TEXT NOT NULL,actor TEXT NOT NULL);
CREATE INDEX idx_deployment_record_at ON deployment_record(deployed_at DESC);
CREATE TRIGGER deployment_record_no_update BEFORE UPDATE ON deployment_record BEGIN SELECT RAISE(ABORT, 'deployment_record is immutable'); END;
CREATE TRIGGER deployment_record_no_delete BEFORE DELETE ON deployment_record BEGIN SELECT RAISE(ABORT, 'deployment_record is immutable'); END;
`;
// P0b-1：source_collect trace 需要可查询的根来源。不能把来源藏进 JSON summary，
// 否则后续来源时间线和按来源检索会退化为全表扫描。
const SOURCE_COLLECT_SQL = `
ALTER TABLE generation_trace ADD COLUMN source_id TEXT REFERENCES source(id);
CREATE INDEX IF NOT EXISTS idx_generation_trace_source_started ON generation_trace(source_id, started_at DESC);
`;
// P0c：单 trace 的分页 refs 与受限图遍历。索引只服务于 append-only provenance 读路径，
// 不改变 trace/event/revision 的事实语义；部署仍须先由 migration runner 应用。
const BOUNDED_VIEW_SQL = `
CREATE INDEX IF NOT EXISTS idx_generation_entity_ref_trace_event ON generation_entity_ref(trace_id, event_id, role, entity_type, entity_key, revision);
CREATE INDEX IF NOT EXISTS idx_generation_entity_ref_trace_entity_event ON generation_entity_ref(trace_id, entity_type, entity_key, revision, event_id);
CREATE INDEX IF NOT EXISTS idx_generation_edge_trace_from ON generation_edge(trace_id, from_type, from_key, from_revision, event_id);
CREATE INDEX IF NOT EXISTS idx_generation_edge_trace_to ON generation_edge(trace_id, to_type, to_key, to_revision, event_id);
`;
// 09 已在部分环境应用过，必须保留其 SQL 的 checksum；用独立迁移把旧的
// role 先导索引替换为能支持 rowid keyset 的 (trace_id,event_id) 路径。
const BOUNDED_VIEW_INDEX_FIX_SQL = `
DROP INDEX IF EXISTS idx_generation_entity_ref_trace_event;
CREATE INDEX idx_generation_entity_ref_trace_event ON generation_entity_ref(trace_id, event_id);
`;
// P0e：effect 必须能回指生成它的 append-only 事件。既有 effect 保持可读，
// 因而新增列可空；新 provenance writer 则要求 trace/event 成对写入。
const EFFECT_EVENT_LINK_SQL = `
ALTER TABLE generation_effect ADD COLUMN event_id TEXT REFERENCES generation_event(id);
CREATE INDEX idx_generation_effect_trace_event ON generation_effect(trace_id, event_id);
`;
// P1b-1：来源 credit 是独立的追加事实，不参与 P1a 的 funnel/cost/validator 明细或任何 rollup。
// event header 与每来源分配拆开，以便一个 event 的整数 micro-credit 可以精确守恒；迟到和冲突
// 也保留为可审计记录，绝不通过覆盖原事实来“修正”。当前服务端只有 default tenant，但索引仍以
// tenant 前缀开始，避免把单租户假设编码进未来查询路径。
// 此 SQL 已作为 20260823_12 的 checksum 契约被记录。即使 schema.ts 中的现行实体定义
// 随后修正，也绝不能改写这里；后续物理变更必须以新 migration 前进。
const SOURCE_CREDIT_FACTS_SQL = `
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
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  existing_semantic_payload_hash TEXT NOT NULL,
  received_semantic_payload_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL
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
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reconciled','declined')),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_late_event(tenant_id, event_id)
);
CREATE INDEX idx_source_credit_late_reconciliation_tenant_event ON source_credit_late_reconciliation(tenant_id, event_id, recorded_at DESC);
CREATE TRIGGER source_credit_late_reconciliation_no_update BEFORE UPDATE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
CREATE TRIGGER source_credit_late_reconciliation_no_delete BEFORE DELETE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
`;
const SOURCE_CREDIT_TENANT_PRIMARY_KEY_FIX_SQL = `
CREATE TABLE source_credit_conflict_next (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  existing_semantic_payload_hash TEXT NOT NULL,
  received_semantic_payload_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);
INSERT INTO source_credit_conflict_next(id,tenant_id,event_id,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at)
  SELECT id,tenant_id,event_id,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at FROM source_credit_conflict;
DROP TABLE source_credit_conflict;
ALTER TABLE source_credit_conflict_next RENAME TO source_credit_conflict;
CREATE INDEX idx_source_credit_conflict_tenant_event ON source_credit_conflict(tenant_id, event_id, observed_at DESC);
CREATE TRIGGER source_credit_conflict_no_update BEFORE UPDATE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;
CREATE TRIGGER source_credit_conflict_no_delete BEFORE DELETE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;

CREATE TABLE source_credit_late_reconciliation_next (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reconciled','declined')),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id),
  FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_late_event(tenant_id, event_id)
);
INSERT INTO source_credit_late_reconciliation_next(id,tenant_id,event_id,action,actor_id,recorded_at)
  SELECT id,tenant_id,event_id,action,actor_id,recorded_at FROM source_credit_late_reconciliation;
DROP TABLE source_credit_late_reconciliation;
ALTER TABLE source_credit_late_reconciliation_next RENAME TO source_credit_late_reconciliation;
CREATE INDEX idx_source_credit_late_reconciliation_tenant_event ON source_credit_late_reconciliation(tenant_id, event_id, recorded_at DESC);
CREATE TRIGGER source_credit_late_reconciliation_no_update BEFORE UPDATE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
CREATE TRIGGER source_credit_late_reconciliation_no_delete BEFORE DELETE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
`;
const MIGRATIONS = [
  { version: "20260803_01_provenance_core", sql: CORE_SQL },
  { version: "20260803_02_report_lifecycle", sql: REPORT_LIFECYCLE_SQL },
  { version: "20260803_03_report_effect", sql: REPORT_EFFECT_SQL },
  { version: "20260803_04_redaction_tombstone", sql: REDACTION_SQL },
  { version: "20260803_05_redaction_request", sql: REDACTION_REQUEST_SQL },
  { version: "20260803_06_provenance_facts", sql: PROVENANCE_FACTS_SQL },
  { version: "20260803_07_deployment_record", sql: DEPLOYMENT_SQL },
  { version: "20260811_08_source_collect", sql: SOURCE_COLLECT_SQL },
  { version: "20260817_09_bounded_provenance_views", sql: BOUNDED_VIEW_SQL },
  { version: "20260817_10_bounded_provenance_view_index_fix", sql: BOUNDED_VIEW_INDEX_FIX_SQL },
  { version: "20260820_11_effect_event_link", sql: EFFECT_EVENT_LINK_SQL },
  { version: "20260823_12_source_credit_facts", sql: SOURCE_CREDIT_FACTS_SQL },
  { version: "20260823_13_source_credit_tenant_primary_keys", sql: SOURCE_CREDIT_TENANT_PRIMARY_KEY_FIX_SQL },
  { version: "20260823_14_p1_metric_facts", sql: P1_METRICS_SCHEMA_SQL },
  { version: "20260823_15_p1_metric_fact_contracts", sql: P1_METRICS_FOLLOWUP_SCHEMA_SQL },
  { version: "20260823_16_p1_metric_conflict_audit", sql: P1_METRICS_CONFLICT_AUDIT_SCHEMA_SQL },
  { version: "20260823_17_integrity_anchors", sql: INTEGRITY_ANCHOR_LEGACY_SCHEMA_SQL },
  { version: "20260823_18_integrity_anchor_immutability", sql: INTEGRITY_ANCHOR_IMMUTABILITY_SQL },
  { version: "20260824_19_integrity_anchor_recovery_material", sql: INTEGRITY_ANCHOR_RECOVERY_SCHEMA_SQL },
  { version: "20260824_20_integrity_anchor_hardening", sql: INTEGRITY_ANCHOR_HARDENING_SCHEMA_SQL },
  { version: "20260824_21_integrity_anchor_tenant_reconcile_index", sql: "DROP INDEX IF EXISTS idx_generation_anchor_effect_reconcile;" },
  { version: "20260824_22_integrity_check_ledger", sql: INTEGRITY_CHECK_SCHEMA_SQL },
  { version: "20260824_23_integrity_check_key_revocation", sql: INTEGRITY_CHECK_KEY_REVOCATION_SCHEMA_SQL },
  { version: "20260824_24_integrity_lifecycle", sql: INTEGRITY_LIFECYCLE_SCHEMA_SQL },
  { version: "20260824_25_integrity_lifecycle_purge", sql: INTEGRITY_LIFECYCLE_PURGE_SCHEMA_SQL },
  { version: "20260825_26_integrity_lifecycle_completion_proof", sql: INTEGRITY_LIFECYCLE_COMPLETION_PROOF_SCHEMA_SQL },
  { version: "20260825_27_integrity_lifecycle_registry_proof", sql: INTEGRITY_LIFECYCLE_REGISTRY_PROOF_SCHEMA_SQL },
  { version: "20260825_28_integrity_lifecycle_hold_and_tombstone_retention", sql: INTEGRITY_LIFECYCLE_HOLD_AND_TOMBSTONE_RETENTION_SCHEMA_SQL },
  { version: "20260825_29_integrity_lifecycle_hold_tombstone_snapshot", sql: INTEGRITY_LIFECYCLE_HOLD_TOMBSTONE_SNAPSHOT_SCHEMA_SQL },
  { version: "20260825_30_integrity_lifecycle_external_hold", sql: INTEGRITY_LIFECYCLE_EXTERNAL_HOLD_SCHEMA_SQL },
  { version: "20260825_31_integrity_daily_root_material_backfill", sql: INTEGRITY_LIFECYCLE_DAILY_ROOT_MATERIAL_BACKFILL_SQL },
  { version: "20260825_32_integrity_maintenance_lease", sql: INTEGRITY_MAINTENANCE_LEASE_SCHEMA_SQL },
];

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
    if (rebuildReport || rebuildSourceCreditPrimaryKeys) db.pragma("foreign_keys = OFF");
    db.exec("BEGIN EXCLUSIVE");
    try {
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
      } else if (migration.version === "20260825_31_integrity_daily_root_material_backfill") {
        backfillDailyRootMaterial(db);
      } else if (migration.version === "20260817_09_bounded_provenance_views" || migration.version === "20260817_10_bounded_provenance_view_index_fix" || migration.version === "20260820_11_effect_event_link" || migration.version === "20260823_12_source_credit_facts" || migration.version === "20260823_14_p1_metric_facts" || migration.version === "20260823_15_p1_metric_fact_contracts" || migration.version === "20260823_16_p1_metric_conflict_audit" || migration.version === "20260823_17_integrity_anchors" || migration.version === "20260823_18_integrity_anchor_immutability" || migration.version === "20260824_19_integrity_anchor_recovery_material" || migration.version === "20260824_20_integrity_anchor_hardening" || migration.version === "20260824_21_integrity_anchor_tenant_reconcile_index" || migration.version === "20260824_22_integrity_check_ledger" || migration.version === "20260824_23_integrity_check_key_revocation" || migration.version === "20260824_24_integrity_lifecycle" || migration.version === "20260824_25_integrity_lifecycle_purge" || migration.version === "20260825_26_integrity_lifecycle_completion_proof" || migration.version === "20260825_27_integrity_lifecycle_registry_proof" || migration.version === "20260825_28_integrity_lifecycle_hold_and_tombstone_retention" || migration.version === "20260825_29_integrity_lifecycle_hold_tombstone_snapshot" || migration.version === "20260825_30_integrity_lifecycle_external_hold" || migration.version === "20260825_32_integrity_maintenance_lease") {
        db.exec(migration.sql);
      } else if (migration.version === "20260823_13_source_credit_tenant_primary_keys") {
        db.exec(migration.sql);
      }
      db.prepare("INSERT INTO schema_migration(version,checksum,applied_at) VALUES (?,?,?)")
        .run(migration.version, checksum, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction may already have been rolled back */ }
      throw error;
    } finally {
      if (rebuildReport || rebuildSourceCreditPrimaryKeys) db.pragma("foreign_keys = ON");
    }
  }
}

export function assertProvenanceSchema(db: DB): void {
  const latest = MIGRATIONS.at(-1)!;
  const expected = latest.version;
  const ledgerExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'",
  ).get();
  if (!ledgerExists) throw new Error(`provenance migration ${expected} has not been applied`);
  const row = db.prepare("SELECT checksum FROM schema_migration WHERE version=?").get(expected) as { checksum: string } | undefined;
  if (!row) throw new Error(`provenance migration ${expected} has not been applied`);
  const checksum = createHash("sha256").update(latest.sql).digest("hex");
  if (row.checksum !== checksum) throw new Error(`provenance migration checksum mismatch: ${expected}`);
}
