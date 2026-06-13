// 生产卷备份 —— 把持久卷 /data 的关键状态做一份**一致的、带保留轮转**的本地备份。
// 与 db-snapshot.mjs 的区别：那个面向 worktree 间共享黄金库（单文件 .db、VACUUM INTO）；
//   本脚本面向**生产持久卷**——除 SQLite 库外还覆盖报告正文 FS（reports.ts 把正文写成
//   /data/reports/<id>.md|.html，DB 只存 body_path，光备份 DB 会丢正文），可完整恢复一份报告。
//   由 cron 容器每日触发（见 ops/crontab）。
//
// 为何不直接 tar 整卷：SQLite 活库直接拷会拿到半截 WAL（不一致）。改用 better-sqlite3 在线备份
//   API（`db.backup()`，带页级锁、对并发写安全）产出一致的 insight.db，再连同 reports/ 一并落盘。
//
// 备份位置：$DATA_DIR/backups/<UTC 时间戳>/{insight.db, reports/}
// 保留：默认留最近 BACKUP_KEEP(=14) 份，更早的自动删除。
// raw 原文（/data/raw，可重抓、体量大）默认**不**备份；BACKUP_INCLUDE_RAW=1 才纳入。
//
// ⚠️ 备份落在**同一持久卷**：可防 DB 损坏 / 坏迁移 / 误删（点时恢复），但**不防整卷丢失**。
//    真 DR 需把 $DATA_DIR/backups 定期拉到机器外（S3 / rsync，见 operations.md §6）。
//
// 用法：
//   node --no-warnings ops/backup-db.mjs                       # 容器内 cron 调用（读 DATA_DIR/DB_PATH 环境）
//   BACKUP_KEEP=30 BACKUP_INCLUDE_RAW=1 node ops/backup-db.mjs # 多留几份 + 含原文

import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// 同 db-snapshot.mjs：手动加载 .env.local，让本地手动跑时跟随 worktree 钉值；
// 容器内 DATA_DIR/DB_PATH 来自镜像 ENV（见 Dockerfile），无 .env.local 文件，此处为 no-op。
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const DATA_DIR = process.env.DATA_DIR ?? ".data";
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "insight.db");
const BACKUP_ROOT = process.env.BACKUP_DIR ?? join(DATA_DIR, "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);
const INCLUDE_RAW = process.env.BACKUP_INCLUDE_RAW === "1";

if (!existsSync(DB_PATH)) {
  console.error(`✗ 源库不存在：${DB_PATH}（检查 DB_PATH/DATA_DIR；库还没建过？先跑一次管线）`);
  process.exit(1);
}

// UTC 时间戳目录名 YYYYMMDD-HHMMSS（普通运维脚本，非 workflow，可用 Date）。
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const stamp =
  `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}` +
  `-${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`;
const dest = join(BACKUP_ROOT, stamp);
mkdirSync(dest, { recursive: true });

// 1) SQLite 在线备份（对活库安全，产出一致单文件；优于 readonly VACUUM INTO——
//    后者在 app 并发写时跨连接易遇锁/-shm 问题）。
const db = new Database(DB_PATH);
try {
  await db.backup(join(dest, "insight.db"));
} finally {
  db.close();
}
const dbKb = (statSync(join(dest, "insight.db")).size / 1024).toFixed(0);

// 2) 报告正文 FS（reports/<id>.md|.html；DB 只存 body_path，不拷就丢正文）。
const reportsDir = join(DATA_DIR, "reports");
let reportFiles = 0;
if (existsSync(reportsDir)) {
  cpSync(reportsDir, join(dest, "reports"), { recursive: true });
  reportFiles = readdirSync(join(dest, "reports")).length;
}

// 3) 可选：raw 原文归档（体量大、可重抓，默认跳过）。
if (INCLUDE_RAW) {
  const rawDir = join(DATA_DIR, "raw");
  if (existsSync(rawDir)) cpSync(rawDir, join(dest, "raw"), { recursive: true });
}

console.log(`✓ 备份完成：${dest}`);
console.log(`  insight.db ${dbKb} KB · reports ${reportFiles} 文件${INCLUDE_RAW ? " · 含 raw" : ""}`);

// 4) 保留轮转：按时间戳目录名降序，只留最近 KEEP 份。
const all = readdirSync(BACKUP_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name))
  .map((d) => d.name)
  .sort()
  .reverse();
const stale = all.slice(KEEP);
for (const name of stale) rmSync(join(BACKUP_ROOT, name), { recursive: true, force: true });
if (stale.length) console.log(`  保留最近 ${KEEP} 份，清理 ${stale.length} 份旧备份`);
