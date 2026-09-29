// 生产卷备份 —— 把持久卷 /data 的关键状态做一份**一致的、带保留轮转**的本地备份。
// 与 db-snapshot.mjs 的区别：那个面向 worktree 间共享黄金库（单文件 .db、VACUUM INTO）；
//   本脚本面向**生产持久卷**——除 SQLite 库外还覆盖报告正文 FS（reports.ts 把正文写成
//   /data/reports/<id>.md|.html，DB 只存 body_path，光备份 DB 会丢正文），可完整恢复一份报告。
//   由 cron 容器每日触发（见 ops/crontab）。
//
// 为何不直接 tar 整卷：SQLite 活库直接拷会拿到半截 WAL（不一致）。改用 better-sqlite3 在线备份
//   API（`db.backup()`，带页级锁、对并发写安全）产出一致的 insight.db，再连同 reports/、raw/ 一并落盘。
//
// 备份位置：$DATA_DIR/backups/<UTC 时间戳>/{insight.db, reports/, raw/, backup-manifest.json}
// 保留：新格式默认留最近 BACKUP_KEEP(=14) 份，额外保护 90 天内最近的完整恢复点；旧格式不自动删除。
// raw 原文是引用可恢复的一部分，默认纳入；仅显式 BACKUP_INCLUDE_RAW=0 可生成部分备份。
//
// ⚠️ 备份落在**同一持久卷**：可防 DB 损坏 / 坏迁移 / 误删（点时恢复），但**不防整卷丢失**。
//    真 DR 需把 $DATA_DIR/backups 定期拉到机器外（S3 / rsync，见 operations.md §6）。
//
// 用法：
//   node --no-warnings ops/backup-db.mjs                       # 容器内 cron 调用（读 DATA_DIR/DB_PATH 环境）
//   BACKUP_KEEP=30 node ops/backup-db.mjs               # 多留几份，默认含原文

import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { planBackupPrune, writeBackupManifest } from "./backup-integrity.mjs";

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
// BACKUP_KEEP 加固：非数 / <1 / 负 / 0 一律回退 14（默认安全值），避免负数被 clamp 成 1
// 而几乎删光所有备份；分数向下取整。
const keepRaw = Number(process.env.BACKUP_KEEP ?? 14);
const KEEP = Number.isFinite(keepRaw) && keepRaw >= 1 ? Math.floor(keepRaw) : 14;
const INCLUDE_RAW = process.env.BACKUP_INCLUDE_RAW !== "0";

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
// 同秒重复运行（手动 + cron 撞秒等）会让 mkdirSync(recursive) 静默 no-op、两次合并进同一目录。
// 宁可拒绝覆盖：已存在即报错退出，保住先前那份完整备份。
if (existsSync(dest)) {
  console.error(`✗ 备份目录已存在（同秒重复运行？）：${dest} —— 拒绝覆盖，跳过本次`);
  process.exit(1);
}
mkdirSync(BACKUP_ROOT, { recursive: true });
// Stage outside backups/: the 18:30 off-box sync must never observe a half-copied snapshot.
const staging = mkdtempSync(join(dirname(BACKUP_ROOT), ".backup-staging-"));

// 备份与拷贝包在 try 里：任一步失败就清掉半截目录再退出。否则残留的 <stamp>/ 会匹配
// 下面 retention 的正则、被当成有效一份排进“最近 KEEP”，把真正完整的旧备份挤出去删掉。
let dbKb = "0";
let reportFiles = 0;
let manifest;
try {
  // 1) SQLite 在线备份（对活库安全，产出一致单文件；优于 readonly VACUUM INTO——
  //    后者在 app 并发写时跨连接易遇锁/-shm 问题）。
  const db = new Database(DB_PATH);
  try {
    await db.backup(join(staging, "insight.db"));
  } finally {
    db.close();
  }
  dbKb = (statSync(join(staging, "insight.db")).size / 1024).toFixed(0);

  // 2) 报告正文 FS（reports/<id>.md|.html；DB 只存 body_path，不拷就丢正文）。
  const reportsDir = join(DATA_DIR, "reports");
  if (existsSync(reportsDir)) {
    cpSync(reportsDir, join(staging, "reports"), { recursive: true });
    reportFiles = readdirSync(join(staging, "reports")).length;
  }

  // 3) 原文归档；显式 opt-out 的快照仍保留，但不得称为完整恢复点。
  if (INCLUDE_RAW) {
    const rawDir = join(DATA_DIR, "raw");
    if (existsSync(rawDir)) cpSync(rawDir, join(staging, "raw"), { recursive: true });
  }
  // 4) 对备份快照自身建清单；历史缺口如实标 incomplete，不销毁有用的部分备份。
  manifest = writeBackupManifest(staging, DATA_DIR, { rawIncluded: INCLUDE_RAW });
  if (existsSync(dest)) throw new Error("backup_target_appeared_during_staging");
  renameSync(staging, dest);
} catch (e) {
  rmSync(staging, { recursive: true, force: true });
  console.error(`✗ 备份失败，已清理暂存目录：${e?.message ?? e}`);
  process.exit(1);
}

console.log(`✓ 备份完成：${dest}`);
console.log(`  insight.db ${dbKb} KB · reports ${reportFiles} 文件 · raw ${INCLUDE_RAW ? "已纳入" : "已显式排除"}`);
console.log(`  恢复完整性：${manifest.status} · 缺文件 ${manifest.summary.references_missing} · 无法映射 ${manifest.summary.references_unmapped} · 哈希不符 ${manifest.summary.embedded_hash_mismatch}`);

// 5) 保留轮转：最近 KEEP 份之外，额外保住最近一个标记为 complete 的恢复点。
const stale = planBackupPrune(BACKUP_ROOT, KEEP, DATA_DIR);
for (const name of stale) rmSync(join(BACKUP_ROOT, name), { recursive: true, force: true });
if (stale.length) console.log(`  保留最近 ${KEEP} 份，清理 ${stale.length} 份旧备份`);
