/** Application initialization and publication; never invokes the explicit migration runner. */
import { openConnection, closeFailedInitialization, type DB } from "./connection.js";
import { bootstrapLegacySchema, tableExists } from "./legacy-bootstrap.js";
import { recoverOrphanedRuns } from "./repos.js";
import { seedDefaultDirections } from "./planning.js";
import { assertProvenanceSchema } from "./migration-ledger.js";
import { assertDeploymentIdentity } from "./deployment.js";
import { reconcileReportEffects } from "./reports.js";
import { reconcileRawArchiveEffects } from "./raw-archive.js";

/** Compatibility bootstrap for local callers; bootstrap:false only configures a connection. */
export function openDb(path: string, opts: { bootstrap?: boolean } = {}): DB {
  const db = openConnection(path);
  try {
    const freshDatabase = !tableExists(db, "source");
    if (opts.bootstrap !== false) {
      bootstrapLegacySchema(db, freshDatabase);
      const orphaned = recoverOrphanedRuns(db);
      if (orphaned > 0) {
        console.warn(`⚠️ 启动清扫：${orphaned} 条孤儿 Run 已标 failed（OrphanedOnRestart）`);
      }
    }
    return db;
  } catch (error) {
    closeFailedInitialization(db);
    throw error;
  }
}

let _db: DB | null = null;

export function getDb(): DB {
  if (!_db) {
    const strictProvenance = process.env.PROVENANCE_SCHEMA_REQUIRED === "1";
    // 严格 writer 在触碰旧 schema、启动期补列或 orphan recovery 前，必须先验证 migration ledger。
    const db = openDb(process.env.DB_PATH ?? ".data/insight.db", { bootstrap: !strictProvenance });
    try {
      // P0a 发布编排在 migration runner 成功后设为 1；未迁移库不得悄悄成为生产 writer。
      if (strictProvenance) assertProvenanceSchema(db);
      // deployment-record writer is a one-shot bootstrap process: it must be able to
      // atomically append the new identity before the new Web writer validates it.
      if (process.env.PROVENANCE_DEPLOYMENT_REQUIRED === "1" && process.env.PROVENANCE_DEPLOYMENT_WRITER !== "1") assertDeploymentIdentity(db);
      // Report publication depends on its current source archive. Recover verified raw
      // effects first so a resumable report is not failed merely due to startup order.
      reconcileRawArchiveEffects(db);
      // 文件 rename 与 SQLite 不能组成一个事务；启动时只发布 hash 完整的双 artifact，其余 fail-closed。
      reconcileReportEffects(db);
      // 已有生产库会立即补齐方向档案；空库会安全跳过，待配置层播种 topic 后再补。
      seedDefaultDirections(db);
      // Publish only a fully initialized connection; failed attempts must never become writers.
      _db = db;
    } catch (error) {
      closeFailedInitialization(db);
      throw error;
    }
  }
  return _db;
}

/** 测试/重置用：关闭并清空单例 */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
