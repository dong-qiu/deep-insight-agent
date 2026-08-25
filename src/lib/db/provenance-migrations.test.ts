import { describe, expect, it } from "vitest";
import { closeDb, getDb, openDb } from "./index.js";
import { applyProvenanceMigrations, assertProvenanceSchema } from "./provenance-migrations.js";

describe("provenance migration runner", () => {
  it("applies once, records its checksum, and is safe to rerun", () => {
    const db = openDb(":memory:");
    expect(() => assertProvenanceSchema(db)).toThrow("has not been applied");
    applyProvenanceMigrations(db);
    applyProvenanceMigrations(db);
    expect(() => assertProvenanceSchema(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migration").get()).toEqual({ count: 30 });
    expect((db.prepare("PRAGMA table_info(run)").all() as { name: string }[]).some((row) => row.name === "trace_id")).toBe(true);
    const reportColumns = db.prepare("PRAGMA table_info(report)").all() as { name: string; notnull: number }[];
    expect(reportColumns.find((column) => column.name === "body_path")?.notnull).toBe(0);
    expect(reportColumns.some((column) => column.name === "failure")).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_effect'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA table_info(generation_effect)").all() as { name: string }[]).some((row) => row.name === "event_id")).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_redaction'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_redaction_request'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_event'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_credit_event'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='funnel_event'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metric_fact_conflict'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_source_credit_fact_tenant_source_event'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA table_info(generation_trace)").all() as { name: string }[]).some((row) => row.name === "source_id")).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_generation_edge_trace_from'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='artifact_manifest_no_update'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='integrity_signing_key_no_delete'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA table_info(integrity_daily_root)").all() as { name: string }[]).map((row) => row.name)).toEqual(expect.arrayContaining(["algorithm", "issued_at", "provider_version_id", "retain_until"]));
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_check'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='integrity_check_no_delete'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_check_alert_dedup'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA table_info(integrity_check)").all() as { name: string }[]).some((column) => column.name === "key_revoked")).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_generation_anchor_effect_reconcile'").get()).toBeFalsy();
    expect((db.prepare("PRAGMA index_info(idx_generation_anchor_effect_tenant_reconcile)").all() as { name: string }[])
      .map((column) => column.name)).toEqual(["tenant_id", "status", "created_at"]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_report_lifecycle'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_retention_tombstone'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_retention_completion'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_legal_hold_material'").get()).toBeTruthy();
  });

  it("rejects a production writer when the runner has not applied the ledger", () => {
    const original = process.env.PROVENANCE_SCHEMA_REQUIRED;
    process.env.PROVENANCE_SCHEMA_REQUIRED = "1";
    process.env.DB_PATH = ":memory:";
    closeDb();
    expect(() => getDb()).toThrow("has not been applied");
    closeDb();
    if (original == null) delete process.env.PROVENANCE_SCHEMA_REQUIRED;
    else process.env.PROVENANCE_SCHEMA_REQUIRED = original;
    delete process.env.DB_PATH;
  });

  it("upgrades a database that had already applied the original bounded-view index", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    // 模拟 _09 已应用、但尚未获得 _10 修复的实际部署状态。
    db.exec("DROP INDEX idx_generation_entity_ref_trace_event; CREATE INDEX idx_generation_entity_ref_trace_event ON generation_entity_ref(trace_id,event_id,role,entity_type,entity_key,revision)");
    db.prepare("DELETE FROM schema_migration WHERE version=?").run("20260817_10_bounded_provenance_view_index_fix");
    applyProvenanceMigrations(db);
    const columns = db.prepare("PRAGMA index_info(idx_generation_entity_ref_trace_event)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(["trace_id", "event_id"]);
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE version='20260817_10_bounded_provenance_view_index_fix'").get()).toBeTruthy();
  });

  it("upgrades an existing v11 provenance ledger with no source-credit tables", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    // Recreate the exact physical pre-v12 state: the base schema plus migrations 01–11,
    // with no v12 ledger entry or source-credit objects left behind.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE source_credit_late_reconciliation;
      DROP TABLE source_credit_late_event;
      DROP TABLE source_credit_fact;
      DROP TABLE source_credit_conflict;
      DROP TABLE source_credit_event;
    `);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM schema_migration WHERE version IN ('20260823_12_source_credit_facts','20260823_13_source_credit_tenant_primary_keys')").run();

    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migration").get()).toEqual({ count: 30 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_credit_event'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_source_credit_fact_tenant_source_event'").get()).toBeTruthy();
    for (const table of ["source_credit_conflict", "source_credit_late_reconciliation"]) {
      const primaryKey = (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; origin: string }[])
        .find((index) => index.origin === "pk");
      expect(primaryKey).toBeTruthy();
      expect((db.prepare(`PRAGMA index_info(${primaryKey!.name})`).all() as { name: string }[]).map((column) => column.name))
        .toEqual(["tenant_id", "id"]);
    }
  });

  it("upgrades an already-ledgered v12 source-credit schema without checksum drift", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    db.exec(`
      INSERT INTO source_credit_event(tenant_id,event_id,trace_id,occurred_at,ingested_at,schema_version,allocation_version,producer_version,trace_coverage,lateness,semantic_payload_hash,created_at)
        VALUES ('default','credit_event',NULL,'2026-08-23T00:00:00Z','2026-08-23T00:00:00Z','source-credit-v1','equal-split-micros-v1','source-credit-producer-v1','legacy','reconcilable','hash','2026-08-23T00:00:00Z');
      INSERT INTO source_credit_late_event(tenant_id,event_id,lateness,recorded_at)
        VALUES ('default','credit_event','reconcilable','2026-08-23T00:00:00Z');
      INSERT INTO source_credit_conflict(id,tenant_id,event_id,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at)
        VALUES ('conflict_1','default','credit_event','old','new','2026-08-23T00:00:00Z');
      INSERT INTO source_credit_late_reconciliation(id,tenant_id,event_id,action,actor_id,recorded_at)
        VALUES ('reconciliation_1','default','credit_event','reconciled','admin_1','2026-08-23T00:00:00Z');
    `);
    // Restore the v12 physical primary keys while retaining its original checksum ledger.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE source_credit_conflict_v12 (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), event_id TEXT NOT NULL,
        existing_semantic_payload_hash TEXT NOT NULL, received_semantic_payload_hash TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      INSERT INTO source_credit_conflict_v12 SELECT id,tenant_id,event_id,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at FROM source_credit_conflict;
      DROP TABLE source_credit_conflict;
      ALTER TABLE source_credit_conflict_v12 RENAME TO source_credit_conflict;
      CREATE INDEX idx_source_credit_conflict_tenant_event ON source_credit_conflict(tenant_id, event_id, observed_at DESC);
      CREATE TRIGGER source_credit_conflict_no_update BEFORE UPDATE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;
      CREATE TRIGGER source_credit_conflict_no_delete BEFORE DELETE ON source_credit_conflict BEGIN SELECT RAISE(ABORT, 'source_credit_conflict is append-only'); END;
      CREATE TABLE source_credit_late_reconciliation_v12 (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL CHECK(tenant_id = 'default'), event_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('reconciled','declined')), actor_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id, event_id) REFERENCES source_credit_late_event(tenant_id, event_id)
      );
      INSERT INTO source_credit_late_reconciliation_v12 SELECT id,tenant_id,event_id,action,actor_id,recorded_at FROM source_credit_late_reconciliation;
      DROP TABLE source_credit_late_reconciliation;
      ALTER TABLE source_credit_late_reconciliation_v12 RENAME TO source_credit_late_reconciliation;
      CREATE INDEX idx_source_credit_late_reconciliation_tenant_event ON source_credit_late_reconciliation(tenant_id, event_id, recorded_at DESC);
      CREATE TRIGGER source_credit_late_reconciliation_no_update BEFORE UPDATE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
      CREATE TRIGGER source_credit_late_reconciliation_no_delete BEFORE DELETE ON source_credit_late_reconciliation BEGIN SELECT RAISE(ABORT, 'source_credit_late_reconciliation is append-only'); END;
    `);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM schema_migration WHERE version='20260823_13_source_credit_tenant_primary_keys'").run();

    expect(() => applyProvenanceMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT tenant_id,event_id FROM source_credit_conflict WHERE id='conflict_1'").get())
      .toEqual({ tenant_id: "default", event_id: "credit_event" });
    expect(db.prepare("SELECT tenant_id,event_id,action FROM source_credit_late_reconciliation WHERE id='reconciliation_1'").get())
      .toEqual({ tenant_id: "default", event_id: "credit_event", action: "reconciled" });
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE version='20260823_13_source_credit_tenant_primary_keys'").get()).toBeTruthy();
    for (const object of [
      "idx_source_credit_conflict_tenant_event", "idx_source_credit_late_reconciliation_tenant_event",
      "source_credit_conflict_no_update", "source_credit_conflict_no_delete",
      "source_credit_late_reconciliation_no_update", "source_credit_late_reconciliation_no_delete",
    ]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(object)).toBeTruthy();
    }
  });

  it("upgrades a deployed v15 metric schema by adding immutable conflict audit facts", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    db.exec("DROP TABLE metric_fact_conflict");
    db.prepare("DELETE FROM schema_migration WHERE version='20260823_16_p1_metric_conflict_audit'").run();

    expect(() => applyProvenanceMigrations(db)).not.toThrow();
    for (const object of ["metric_fact_conflict", "idx_metric_fact_conflict_tenant_kind_business", "metric_fact_conflict_no_update", "metric_fact_conflict_no_delete"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(object)).toBeTruthy();
    }
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE version='20260823_16_p1_metric_conflict_audit'").get()).toBeTruthy();
  });

  it("drops the legacy reconciliation index from an already migrated P1c database", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    db.exec("CREATE INDEX idx_generation_anchor_effect_reconcile ON generation_anchor_effect(status, created_at)");
    db.prepare("DELETE FROM schema_migration WHERE version='20260824_21_integrity_anchor_tenant_reconcile_index'").run();

    applyProvenanceMigrations(db);

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_generation_anchor_effect_reconcile'").get()).toBeFalsy();
    expect((db.prepare("PRAGMA index_info(idx_generation_anchor_effect_tenant_reconcile)").all() as { name: string }[])
      .map((column) => column.name)).toEqual(["tenant_id", "status", "created_at"]);
  });

  it("rebuilds a legacy NOT NULL body_path table without losing a published report", () => {
    const checksumDb = openDb(":memory:");
    applyProvenanceMigrations(checksumDb);
    const core = checksumDb.prepare("SELECT checksum FROM schema_migration WHERE version=?")
      .get("20260803_01_provenance_core") as { checksum: string };

    const db = openDb(":memory:");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE report;
      CREATE TABLE report (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topic(id), status TEXT NOT NULL,
        generated_at TEXT NOT NULL, title TEXT NOT NULL, body_path TEXT NOT NULL, insight_ids TEXT NOT NULL DEFAULT '[]',
        event_ids TEXT NOT NULL DEFAULT '[]', prev_report_id TEXT, citation_count INTEGER NOT NULL, cost TEXT NOT NULL
      );
    `);
    db.pragma("foreign_keys = ON");
    // 该 fixture 的 core migration ledger 已人为标记为完成；补最小父表以模拟其存在，
    // 让后续 P0b 的 source_id ALTER 与本测试关注的 report rebuild 在同一遗留形态下运行。
    db.exec("CREATE TABLE generation_trace (id TEXT PRIMARY KEY, started_at TEXT NOT NULL)");
    db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1)").run();
    db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
      VALUES ('r','brief','t','done','2026-08-03T00:00:00Z','R','/data/reports/r','[]','[]',NULL,0,'{}')`).run();
    db.exec("CREATE TABLE schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_migration(version,checksum,applied_at) VALUES (?,?,?)")
      .run("20260803_01_provenance_core", core.checksum, "2026-08-03T00:00:00Z");

    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT body_path, failure FROM report WHERE id='r'").get()).toEqual({ body_path: "/data/reports/r", failure: null });
    expect((db.prepare("PRAGMA table_info(report)").all() as { name: string; notnull: number }[])
      .find((column) => column.name === "body_path")?.notnull).toBe(0);
  });
});
