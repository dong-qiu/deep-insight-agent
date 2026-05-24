/**
 * SQLite 持久层入口（architecture：SQLite WAL + FTS5，挂 Docker 持久卷）。
 * - openDb(path)：打开/建库、设 WAL + 外键、应用 schema（幂等，CREATE IF NOT EXISTS）。
 * - getDb()：进程内单例，库路径取 env DB_PATH，默认 .data/insight.db（不入仓）。
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
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
