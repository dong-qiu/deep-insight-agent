/** Historical migration inputs extracted without changing SQL, order or checksums. */
import { INTEGRITY_ANCHOR_HARDENING_SCHEMA_SQL, INTEGRITY_ANCHOR_IMMUTABILITY_SQL, INTEGRITY_ANCHOR_LEGACY_SCHEMA_SQL, INTEGRITY_ANCHOR_RECOVERY_SCHEMA_SQL, INTEGRITY_CHECK_KEY_REVOCATION_SCHEMA_SQL, INTEGRITY_CHECK_SCHEMA_SQL, INTEGRITY_LIFECYCLE_COMPLETION_PROOF_SCHEMA_SQL, INTEGRITY_LIFECYCLE_DAILY_ROOT_MATERIAL_BACKFILL_SQL, INTEGRITY_LIFECYCLE_EXTERNAL_HOLD_SCHEMA_SQL, INTEGRITY_LIFECYCLE_HOLD_AND_TOMBSTONE_RETENTION_SCHEMA_SQL, INTEGRITY_LIFECYCLE_HOLD_TOMBSTONE_SNAPSHOT_SCHEMA_SQL, INTEGRITY_LIFECYCLE_PURGE_SCHEMA_SQL, INTEGRITY_LIFECYCLE_REGISTRY_PROOF_SCHEMA_SQL, INTEGRITY_LIFECYCLE_SCHEMA_SQL, INTEGRITY_MAINTENANCE_LEASE_SCHEMA_SQL, P1_DASHBOARD_COST_READ_MODEL_V1_SCHEMA_SQL, P1_DASHBOARD_READ_MODEL_V1_FOLLOWUP_SQL, P1_DASHBOARD_TRACE_READ_MODEL_V1_SCHEMA_SQL, P1_METRICS_CONFLICT_AUDIT_SCHEMA_SQL, P1_METRICS_FOLLOWUP_SCHEMA_SQL, P1_METRICS_SCHEMA_SQL, PODCAST_TRANSCRIPT_POLICY_VERSION_IMMUTABILITY_SQL } from "./schema.js";

// Immutable v47 snapshot of schema.ts's contract. Do not modify after release.
const REPORT_REDACTION_BOUNDARY_V1_FROZEN_SQL = `
CREATE VIEW report_redaction_boundary AS SELECT substr(entity_key,8) AS report_id
  FROM provenance_redaction WHERE scope='report' AND julianday(effective_at)<=julianday('now');
CREATE TRIGGER redaction_no_replace BEFORE INSERT ON provenance_redaction
  WHEN EXISTS (SELECT 1 FROM provenance_redaction WHERE record_id=NEW.record_id OR (entity_key=NEW.entity_key AND scope=NEW.scope))
  BEGIN SELECT RAISE(ABORT,'redaction_record_conflict'); END;
CREATE TRIGGER redaction_report_valid BEFORE INSERT ON provenance_redaction WHEN NEW.scope='report' AND (
  NEW.entity_key NOT GLOB 'report:?*' OR substr(NEW.entity_key,8) GLOB '*[^A-Za-z0-9_-]*'
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.effective_at) IS NOT CASE WHEN length(NEW.effective_at)=20 THEN substr(NEW.effective_at,1,19)||'.000Z' ELSE NEW.effective_at END
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expiry_at) IS NOT CASE WHEN length(NEW.expiry_at)=20 THEN substr(NEW.expiry_at,1,19)||'.000Z' ELSE NEW.expiry_at END
  OR julianday(NEW.expiry_at)<=julianday(NEW.effective_at))
  BEGIN SELECT RAISE(ABORT,'redaction_time_or_key_invalid'); END;
CREATE TRIGGER redacted_report_insert BEFORE INSERT ON report
  WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id=NEW.id) AND (NEW.status<>'deleted' OR NEW.body_path IS NOT NULL)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_report_update BEFORE UPDATE ON report
  WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id IN (OLD.id,NEW.id)) AND (NEW.id<>OLD.id OR NEW.status<>'deleted' OR NEW.body_path IS NOT NULL)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_index_insert BEFORE INSERT ON report_index WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id=NEW.report_id)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_index_update BEFORE UPDATE ON report_index WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id IN (OLD.report_id,NEW.report_id))
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_review_insert BEFORE INSERT ON report_review_snapshot WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id=NEW.report_id)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_review_update BEFORE UPDATE ON report_review_snapshot WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id IN (OLD.report_id,NEW.report_id))
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_selection_insert BEFORE INSERT ON report_selection_decision WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id=NEW.report_id)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_selection_update BEFORE UPDATE ON report_selection_decision WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id IN (OLD.report_id,NEW.report_id))
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_ppt_insert BEFORE INSERT ON ppt_polish_cache WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id=NEW.report_id)
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
CREATE TRIGGER redacted_ppt_update BEFORE UPDATE ON ppt_polish_cache WHEN EXISTS (SELECT 1 FROM report_redaction_boundary WHERE report_id IN (OLD.report_id,NEW.report_id))
  BEGIN SELECT RAISE(ABORT,'report_redacted'); END;
`;

// Immutable migration input. This feature enters after main's v40-v44 ledger
// entries, so its v45 DDL must never be derived from the mutable fresh-schema
// bootstrap contract.
const REPORT_REVIEW_TRACE_V1_FROZEN_SQL = `
CREATE TABLE IF NOT EXISTS report_review_snapshot (
  report_id TEXT PRIMARY KEY REFERENCES report(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL REFERENCES generation_trace(id),
  analysis_batch_id TEXT NOT NULL REFERENCES analysis_batch(id),
  analyze_started_event_id TEXT NOT NULL REFERENCES generation_event(id),
  analyze_completed_event_id TEXT NOT NULL REFERENCES generation_event(id),
  validate_started_event_id TEXT NOT NULL REFERENCES generation_event(id),
  validate_completed_event_id TEXT NOT NULL REFERENCES generation_event(id),
  generate_report_started_event_id TEXT NOT NULL REFERENCES generation_event(id),
  selection_rule_version TEXT NOT NULL,
  review_trace_status TEXT NOT NULL CHECK (review_trace_status IN ('complete','partial','legacy')),
  publication_state TEXT NOT NULL CHECK (publication_state IN ('planned','published')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_review_snapshot_trace ON report_review_snapshot(trace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS report_selection_decision (
  report_id TEXT NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  insight_id TEXT NOT NULL REFERENCES insight(id),
  decision TEXT NOT NULL CHECK (decision IN ('published','excluded')),
  reason_code TEXT NOT NULL,
  related_insight_id TEXT REFERENCES insight(id),
  published_rank INTEGER,
  supporting_citation_indices TEXT NOT NULL DEFAULT '[]',
  selection_rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, insight_id),
  CHECK ((decision='published' AND published_rank IS NOT NULL) OR (decision='excluded' AND published_rank IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_report_selection_decision_report_rank ON report_selection_decision(report_id, decision, published_rank);
`;

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
// Citation display evidence is added conditionally by the runner below so this checksum works
// for both freshly bootstrapped databases and pre-existing production databases.
const DISPLAY_COVERAGE_EVIDENCE_SQL = `
CREATE INDEX IF NOT EXISTS idx_citation_ref ON citation(citation_ref);
CREATE TABLE IF NOT EXISTS display_coverage_audit (
  batch_id TEXT NOT NULL REFERENCES analysis_batch(id), insight_id TEXT NOT NULL REFERENCES insight(id),
  candidate_id TEXT NOT NULL, gate_version TEXT NOT NULL, terminal_reason TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_hash TEXT NOT NULL, validator_model TEXT NOT NULL,
  decision TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (batch_id, insight_id)
);
CREATE INDEX IF NOT EXISTS idx_display_coverage_audit_insight ON display_coverage_audit(insight_id, created_at);
`;

const DISPLAY_COVERAGE_CANDIDATE_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS display_coverage_candidate_audit (
  batch_id TEXT NOT NULL REFERENCES analysis_batch(id), candidate_id TEXT NOT NULL,
  insight_id TEXT REFERENCES insight(id), gate_version TEXT NOT NULL, terminal_reason TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_hash TEXT NOT NULL, validator_model TEXT NOT NULL,
  decision TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (batch_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_display_coverage_candidate_audit_insight ON display_coverage_candidate_audit(insight_id, created_at);
CREATE TRIGGER IF NOT EXISTS display_coverage_audit_batch_matches_insight
BEFORE INSERT ON display_coverage_audit
WHEN NOT EXISTS (SELECT 1 FROM insight WHERE id = NEW.insight_id AND batch_id = NEW.batch_id)
BEGIN SELECT RAISE(ABORT, 'display coverage audit insight belongs to another batch'); END;
CREATE TRIGGER IF NOT EXISTS display_coverage_candidate_audit_batch_matches_insight
BEFORE INSERT ON display_coverage_candidate_audit
WHEN NEW.insight_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM insight WHERE id = NEW.insight_id AND batch_id = NEW.batch_id)
BEGIN SELECT RAISE(ABORT, 'display coverage candidate audit insight belongs to another batch'); END;
`;

/** Legacy rows intentionally remain NULL: reader-visible consumers must not invent a binding. */
const STATEMENT_CITATION_BINDING_SQL = `
CREATE INDEX IF NOT EXISTS idx_insight_batch_statement_citation ON insight(batch_id, statement_citation_index);
`;

/** v6 deliberately does not upgrade old audited rows: quote projection requires a fresh
 * self-contained decision, so the new column defaults every historical batch to legacy. */
const SOURCE_QUOTE_PROJECTION_SQL = `
CREATE INDEX IF NOT EXISTS idx_analysis_batch_display_projection ON analysis_batch(display_projection_version, id);
`;

/** The original audited draft is retained separately from the exact source quote, so reader
 * rendering can present a localized conclusion without weakening the v6 source binding. */
const READER_STATEMENT_SQL = "ALTER TABLE insight ADD COLUMN reader_statement TEXT NOT NULL DEFAULT '';";

// generation_effect originally modelled only report_file and carried a required
// report_id.  Rebuild it forward so raw_archive has the same durable intent
// ledger without weakening report/anchor foreign keys or rewriting old rows.
const RAW_ARCHIVE_EFFECT_SQL = "generation_effect raw_archive durable effect v1";
const CONTENT_READER_ELIGIBILITY_SQL = "content_item reader eligibility v1";
const PENDING_RAW_ARCHIVE_ELIGIBILITY_SQL = "content_item pending raw archive reader eligibility v1";
const PODCAST_TRANSCRIPT_CONTRACTS_SQL = "podcast transcript contracts v1";

// Immutable v48 snapshot of schema.ts. Never derive its checksum from mutable fresh DDL.
const MODEL_USAGE_ATTEMPT_V1_FROZEN_SQL = `
CREATE TABLE model_usage_attempt (
  attempt_id TEXT PRIMARY KEY,
  logical_call_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  run_id TEXT NOT NULL REFERENCES run(id), trace_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('analyzer','validator','coverage','followup')),
  provider TEXT NOT NULL CHECK(provider IN ('anthropic','volcengine-responses')),
  model TEXT NOT NULL, started_at TEXT NOT NULL,
  observation_number INTEGER NOT NULL DEFAULT 0 CHECK(observation_number>=0),
  observed_at TEXT,
  usage_status TEXT NOT NULL DEFAULT 'unknown' CHECK(usage_status IN ('unknown','partial','reported')),
  input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0),
  cache_creation_input_tokens INTEGER CHECK(cache_creation_input_tokens>=0),
  cache_read_input_tokens INTEGER CHECK(cache_read_input_tokens>=0),
  estimate_status TEXT NOT NULL DEFAULT 'unknown' CHECK(estimate_status IN ('unknown','estimated')),
  estimate_usd REAL CHECK(estimate_usd>=0), price_source TEXT, price_snapshot TEXT,
  semantic_hash TEXT,
  UNIQUE(logical_call_id,attempt_number),
  CHECK((estimate_status='unknown' AND estimate_usd IS NULL AND price_source IS NULL AND price_snapshot IS NULL)
     OR (estimate_status='estimated' AND estimate_usd IS NOT NULL AND price_source IS NOT NULL AND price_snapshot IS NOT NULL AND usage_status='reported')),
  CHECK(usage_status<>'reported' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);
CREATE INDEX model_usage_run_started ON model_usage_attempt(run_id,started_at,logical_call_id,attempt_number);
CREATE TRIGGER model_usage_identity_immutable BEFORE UPDATE ON model_usage_attempt WHEN
  NEW.attempt_id IS NOT OLD.attempt_id OR NEW.logical_call_id IS NOT OLD.logical_call_id OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.run_id IS NOT OLD.run_id OR NEW.trace_id IS NOT OLD.trace_id OR NEW.role IS NOT OLD.role
  OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.started_at IS NOT OLD.started_at
  BEGIN SELECT RAISE(ABORT,'usage_identity_immutable'); END;
CREATE TRIGGER model_usage_observation_monotonic BEFORE UPDATE ON model_usage_attempt WHEN
  NEW.observation_number<=OLD.observation_number OR OLD.usage_status='reported'
  BEGIN SELECT RAISE(ABORT,'usage_observation_immutable'); END;
CREATE TRIGGER model_usage_no_replace BEFORE INSERT ON model_usage_attempt WHEN
  EXISTS(SELECT 1 FROM model_usage_attempt WHERE attempt_id=NEW.attempt_id OR (logical_call_id=NEW.logical_call_id AND attempt_number=NEW.attempt_number))
  BEGIN SELECT RAISE(ABORT,'usage_identity_conflict'); END;
CREATE TRIGGER model_usage_no_delete BEFORE DELETE ON model_usage_attempt
  BEGIN SELECT RAISE(ABORT,'usage_delete_forbidden'); END;
`;

export const MIGRATIONS = [
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
  { version: "20260826_33_dashboard_trace_read_model_v1", sql: `${P1_DASHBOARD_TRACE_READ_MODEL_V1_SCHEMA_SQL}
INSERT OR IGNORE INTO dashboard_trace_fact_v1(tenant_id,fact_kind,fact_id,trace_id,attempt,stage,event_type,pipeline_version,reason_code,occurred_at,projection_version)
  SELECT tenant_id,'funnel',event_id,trace_id,attempt,stage,event_type,pipeline_version,COALESCE(reason_code,''),occurred_at,'dashboard-trace-v1' FROM funnel_event;
INSERT OR IGNORE INTO dashboard_trace_fact_v1(tenant_id,fact_kind,fact_id,trace_id,attempt,stage,event_type,pipeline_version,validator,rule_version,reason_code,severity,terminal,occurred_at,projection_version)
  SELECT tenant_id,'validator',result_id,trace_id,attempt,stage,'validator_result',pipeline_version,validator,rule_version,reason_code,severity,terminal,occurred_at,'dashboard-trace-v1' FROM validator_result_fact;` },
  { version: "20260826_34_dashboard_cost_read_model_v1", sql: `${P1_DASHBOARD_COST_READ_MODEL_V1_SCHEMA_SQL}
INSERT OR IGNORE INTO dashboard_cost_fact_v1(tenant_id,entry_id,trace_id,stage,pipeline_version,provider,model,currency,amount_minor,cost_status,occurred_at,projection_version)
  SELECT tenant_id,entry_id,trace_id,stage,pipeline_version,provider,model,currency,amount_minor,cost_status,occurred_at,'dashboard-cost-v1' FROM cost_ledger;` },
  { version: "20260828_35_dashboard_late_visibility_and_dimensions", sql: `${P1_DASHBOARD_READ_MODEL_V1_FOLLOWUP_SQL}
UPDATE dashboard_trace_fact_v1 SET topic_id=COALESCE((SELECT topic_id FROM funnel_event f WHERE dashboard_trace_fact_v1.fact_kind='funnel' AND f.tenant_id=dashboard_trace_fact_v1.tenant_id AND f.event_id=dashboard_trace_fact_v1.fact_id), (SELECT topic_id FROM validator_result_fact v WHERE dashboard_trace_fact_v1.fact_kind='validator' AND v.tenant_id=dashboard_trace_fact_v1.tenant_id AND v.result_id=dashboard_trace_fact_v1.fact_id), ''), source_id=COALESCE((SELECT source_id FROM funnel_event f WHERE dashboard_trace_fact_v1.fact_kind='funnel' AND f.tenant_id=dashboard_trace_fact_v1.tenant_id AND f.event_id=dashboard_trace_fact_v1.fact_id), (SELECT source_id FROM validator_result_fact v WHERE dashboard_trace_fact_v1.fact_kind='validator' AND v.tenant_id=dashboard_trace_fact_v1.tenant_id AND v.result_id=dashboard_trace_fact_v1.fact_id), '');
UPDATE dashboard_cost_fact_v1 SET topic_id=COALESCE((SELECT topic_id FROM cost_ledger c WHERE c.tenant_id=dashboard_cost_fact_v1.tenant_id AND c.entry_id=dashboard_cost_fact_v1.entry_id),''), source_id=COALESCE((SELECT source_id FROM cost_ledger c WHERE c.tenant_id=dashboard_cost_fact_v1.tenant_id AND c.entry_id=dashboard_cost_fact_v1.entry_id),'');
DELETE FROM dashboard_trace_fact_v1 WHERE tenant_id='default' AND EXISTS (
  SELECT 1 FROM metric_late_event late WHERE late.tenant_id=dashboard_trace_fact_v1.tenant_id
    AND late.event_id=dashboard_trace_fact_v1.fact_id AND late.fact_kind=dashboard_trace_fact_v1.fact_kind
    AND COALESCE((SELECT action FROM metric_late_reconciliation r WHERE r.tenant_id=late.tenant_id AND r.fact_kind=late.fact_kind AND r.event_id=late.event_id ORDER BY r.recorded_at DESC,r.id DESC LIMIT 1),'')!='backfilled'
);
DELETE FROM dashboard_cost_fact_v1 WHERE tenant_id='default' AND EXISTS (
  SELECT 1 FROM metric_late_event late WHERE late.tenant_id=dashboard_cost_fact_v1.tenant_id AND late.fact_kind='cost' AND late.event_id=dashboard_cost_fact_v1.entry_id
    AND COALESCE((SELECT action FROM metric_late_reconciliation r WHERE r.tenant_id=late.tenant_id AND r.fact_kind=late.fact_kind AND r.event_id=late.event_id ORDER BY r.recorded_at DESC,r.id DESC LIMIT 1),'')!='backfilled'
);` },
  { version: "20260909_36_display_coverage_evidence", sql: DISPLAY_COVERAGE_EVIDENCE_SQL },
  { version: "20260909_37_display_coverage_candidate_audit", sql: DISPLAY_COVERAGE_CANDIDATE_AUDIT_SQL },
  { version: "20260909_38_statement_citation_binding", sql: STATEMENT_CITATION_BINDING_SQL },
  { version: "20260909_39_source_quote_projection", sql: SOURCE_QUOTE_PROJECTION_SQL },
  { version: "20260910_40_raw_archive_effect", sql: RAW_ARCHIVE_EFFECT_SQL },
  { version: "20260911_41_content_reader_eligibility", sql: CONTENT_READER_ELIGIBILITY_SQL },
  { version: "20260911_42_pending_raw_archive_reader_eligibility", sql: PENDING_RAW_ARCHIVE_ELIGIBILITY_SQL },
  { version: "20260913_43_podcast_transcript_contracts", sql: PODCAST_TRANSCRIPT_CONTRACTS_SQL },
  { version: "20260913_44_podcast_transcript_policy_version_immutability", sql: PODCAST_TRANSCRIPT_POLICY_VERSION_IMMUTABILITY_SQL },
  // v40-v44 were already released on main. This feature was never released
  // under its old branch-local v40/v41 numbers, so it enters as v45.
  { version: "20260916_45_report_quality_review_trace_v1", sql: REPORT_REVIEW_TRACE_V1_FROZEN_SQL },
  { version: "20260924_46_reader_statement", sql: READER_STATEMENT_SQL },
  { version: "20261003_47_report_redaction_boundary", sql: REPORT_REDACTION_BOUNDARY_V1_FROZEN_SQL },
  { version: "20261004_48_model_usage_attempt", sql: MODEL_USAGE_ATTEMPT_V1_FROZEN_SQL },
];
