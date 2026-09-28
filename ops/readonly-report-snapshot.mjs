import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/** Historical previews consume a standalone, static SQLite backup, never a live WAL database. */
export function openReadonlyReportSnapshot(snapshotPath) {
  if (!snapshotPath) throw new Error("必须显式指定隔离快照 REPORT_SNAPSHOT_DB_PATH；不能默认读取生产库");
  const path = realpathSync(snapshotPath);
  const snapshotStat = statSync(path);
  if (!snapshotStat.isFile()) throw new Error("REPORT_SNAPSHOT_DB_PATH 必须指向现有的 SQLite 快照文件");
  for (const activeDbPath of [process.env.DB_PATH, "/data/insight.db"].filter(Boolean)) {
    const activePath = existsSync(activeDbPath) ? realpathSync(activeDbPath) : resolve(activeDbPath);
    const activeStat = existsSync(activeDbPath) ? statSync(activeDbPath) : null;
    if (path === activePath || (activeStat && snapshotStat.dev === activeStat.dev && snapshotStat.ino === activeStat.ino)) {
      throw new Error("拒绝将活动库作为报告快照；请先创建独立的 SQLite backup");
    }
  }
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
