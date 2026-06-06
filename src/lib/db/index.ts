/** SQLite 持久层入口（architecture：SQLite WAL + FTS5，挂 Docker 持久卷）。
 * - openDb(path)：打开/建库、设 WAL + 外键、应用 schema（幂等，CREATE IF NOT EXISTS）。
 * - getDb()：进程内单例，库路径取 env DB_PATH，默认 .data/insight.db（不入仓）。
 * schema 内联（见 schema.ts），不依赖运行时读 .sql，跨 tsx/vitest/Next/Docker 一致。 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recoverOrphanedRuns } from "./repos.js";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 多写者（并行 worktree/容器共享同一卷、或 cron+web 同进程外）抢锁时，
  // 默认会立刻抛 SQLITE_BUSY；改为最多等 5s 让写串行化，而非直接失败。
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrate(db);
  // review follow-up #1：进程重启后清扫上一次跑到一半被 SIGTERM 杀掉的孤儿 Run。
  // 单例 DB 第一次创建时触发；测试用 :memory: 时此操作 no-op（无 running Run 可清）。
  const orphaned = recoverOrphanedRuns(db);
  if (orphaned > 0) {
    // eslint-disable-next-line no-console
    console.warn(`⚠️ 启动清扫：${orphaned} 条孤儿 Run 已标 failed（OrphanedOnRestart）`);
  }
  return db;
}

/** 轻量幂等迁移：CREATE IF NOT EXISTS 不会给已存在的表补列，故对增列做显式 ALTER。
 *  表/列名为内部常量（非用户输入），无注入面。 */
function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function migrate(db: DB): void {
  // 洞察级护栏字段（round2）：旧库补列，已存在行取 DEFAULT 0（重跑管线即写入正确值）
  ensureColumn(db, "validation_result", "insights_total", "insights_total INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "validation_result", "insights_includable", "insights_includable INTEGER NOT NULL DEFAULT 0");
  // P1 不复报（2026-06-06 dogfood）：analyzer 喂历史 event_id 后标"同事件 follow-up"，
  // 旧数据全 0（视为新事件）；新管线写正确值。0/1 表 bool，与 schema 其他 bool 一致。
  ensureColumn(db, "insight", "is_followup", "is_followup INTEGER NOT NULL DEFAULT 0");
}

let _db: DB | null = null;

export function getDb(): DB {
  return (_db ??= openDb(process.env.DB_PATH ?? ".data/insight.db"));
}

/** 测试/重置用：关闭并清空单例 */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
