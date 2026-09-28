import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/** Historical previews consume a standalone, static SQLite backup, never a live WAL database. */
export function openReadonlyReportSnapshot(dbPath) {
  if (!dbPath) throw new Error("必须显式指定隔离快照 DB_PATH；不能默认读取生产库");
  const path = realpathSync(dbPath);
  if (!statSync(path).isFile()) throw new Error("DB_PATH 必须指向现有的 SQLite 快照文件");
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new Error("拒绝读取带 WAL/SHM 的库；请先用 SQLite backup 生成独立静止快照");
  }
  // SQLite's immutable URI avoids creating WAL/SHM sidecars during a preview.
  // Caller guarantees this standalone snapshot will not change while it is read.
  // better-sqlite3 enables SQLite URI parsing at addon initialization via this env flag.
  if (process.env.SQLITE_USE_URI === "0") throw new Error("SQLITE_USE_URI=0 禁用安全快照读取");
  process.env.SQLITE_USE_URI = "1";
  const db = new Database(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}
