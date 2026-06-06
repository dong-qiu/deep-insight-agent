// DB 快照 —— 把当前 SQLite 库导出成一份干净的单文件"黄金数据集"，供各 worktree 恢复为共同起点。
// 最佳实践：worktree 间共享的是这份不可变快照（配方），不是 live 库文件 —— 各 worktree 起独立库、
// 各自从快照恢复后再读写，互不漂移、无并发写锁、无迁移冲突。配套见 ops/db-restore.mjs。
//
// 用 VACUUM INTO 导出：自动 checkpoint WAL、整理碎片，产出单一 .db（无需随附 -wal/-shm）。
//
// 用法：
//   npm run db:snapshot                         # 读 .env.local 的 DB_PATH → 写 SNAPSHOT_PATH
//   SNAPSHOT_PATH=/abs/golden.db npm run db:snapshot   # 显式指定共享快照路径
// 跨 worktree 共享：把 SNAPSHOT_PATH 钉成一个绝对路径（写进各 worktree .env.local），指向同一份。

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

// 与 evals/seed.ts 一致：手动加载 .env.local，让 DB_PATH / SNAPSHOT_PATH 跟随 worktree 钉值。
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const DB_PATH =
  process.env.DB_PATH ??
  (process.env.DATA_DIR ? process.env.DATA_DIR + "/insight.db" : ".data/insight.db");
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? ".data/snapshots/golden.db";

if (!existsSync(DB_PATH)) {
  console.error(`源库不存在：${DB_PATH}（先 npm run seed 或跑一次管线再快照）`);
  process.exit(1);
}

console.log(`源库   : ${DB_PATH}`);
console.log(`快照   : ${SNAPSHOT_PATH}`);

mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
// VACUUM INTO 要求目标不存在 —— 先清掉旧快照。
if (existsSync(SNAPSHOT_PATH)) rmSync(SNAPSHOT_PATH);

const db = new Database(DB_PATH, { readonly: true });
db.exec(`VACUUM INTO '${SNAPSHOT_PATH.replace(/'/g, "''")}'`);
db.close();

const kb = (statSync(SNAPSHOT_PATH).size / 1024).toFixed(0);
console.log(`✓ 快照已生成（${kb} KB）。各 worktree 用 npm run db:restore 恢复为共同起点。`);
