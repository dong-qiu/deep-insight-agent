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
  return db;
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
