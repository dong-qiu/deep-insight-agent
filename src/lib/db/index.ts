/** SQLite 持久层入口（architecture：SQLite WAL + FTS5，挂 Docker 持久卷）。
 * - openDb(path)：打开/建库、设 WAL + 外键、应用 schema（幂等，CREATE IF NOT EXISTS）。
 * - getDb()：进程内单例，库路径取 env DB_PATH，默认 .data/insight.db（不入仓）。
 * schema 内联（见 schema.ts），不依赖运行时读 .sql，跨 tsx/vitest/Next/Docker 一致。 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
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
