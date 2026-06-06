// DB 恢复 —— 把黄金快照（ops/db-snapshot.mjs 产出）覆盖到本 worktree 的库，作为已知共同起点。
// 覆盖前会删掉旧库的 -wal/-shm 旁文件，避免半截 WAL 被错误重放。配套见 ops/db-snapshot.mjs。
//
// 用法：
//   npm run db:restore                          # 读 .env.local 的 DB_PATH / SNAPSHOT_PATH
//   npm run db:restore -- --force               # DB_PATH 已存在时仍覆盖（默认会拦下）
// 注意：这会丢弃本 worktree 库的现有数据（被快照内容替换）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

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
const force = process.argv.slice(2).includes("--force");

if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`快照不存在：${SNAPSHOT_PATH}（先在有数据的环境跑 npm run db:snapshot）`);
  process.exit(1);
}
if (existsSync(DB_PATH) && !force) {
  console.error(`目标库已存在：${DB_PATH}`);
  console.error(`会丢弃其现有数据。确认要覆盖请加 --force：npm run db:restore -- --force`);
  process.exit(1);
}

console.log(`快照   : ${SNAPSHOT_PATH}`);
console.log(`目标库 : ${DB_PATH}${existsSync(DB_PATH) ? "（覆盖）" : "（新建）"}`);

mkdirSync(dirname(DB_PATH), { recursive: true });
// 清掉旧库及其 WAL 旁文件，确保恢复后库是快照的纯净状态。
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(p)) rmSync(p);
}
copyFileSync(SNAPSHOT_PATH, DB_PATH);

const kb = (statSync(DB_PATH).size / 1024).toFixed(0);
console.log(`✓ 已恢复（${kb} KB）。本 worktree 现与快照同起点，可独立读写。`);
