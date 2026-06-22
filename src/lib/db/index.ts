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
  // 校验失败计数（validator 抗抖 round）：旧库补列，已存在行取 DEFAULT 0（重跑管线即写入正确值）
  ensureColumn(db, "validation_result", "errored", "errored INTEGER NOT NULL DEFAULT 0");
  // P1 不复报（2026-06-06 dogfood）：analyzer 喂历史 event_id 后标"同事件 follow-up"，
  // 旧数据全 0（视为新事件）；新管线写正确值。0/1 表 bool，与 schema 其他 bool 一致。
  ensureColumn(db, "insight", "is_followup", "is_followup INTEGER NOT NULL DEFAULT 0");
  // 实体追踪：analyzer 抽取的关键实体 JSON 数组；旧库补列默认 '[]'（重跑管线写正确值）。
  ensureColumn(db, "insight", "entities", "entities TEXT NOT NULL DEFAULT '[]'");
  // 主题标签：analyzer 抽取的标签 JSON 数组，供报告库「标签」维度筛选；旧库补列默认 '[]'（重跑管线写正确值）。
  ensureColumn(db, "insight", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
  // 一句话要点（headline 方案）：analyzer 为每条洞察产出的 ≤40 字浓缩，供列表卡片扫读；
  // 旧库补列默认 ''（重跑管线写正确值，渲染端回退到 statement）。
  ensureColumn(db, "insight", "headline", "headline TEXT NOT NULL DEFAULT ''");
  // 卡片要点列表（headline 方案）：report_index 派生的 headline 数组，取代 summary 拼接长串供卡片分点扫读；
  // 旧报告补列默认 '[]'（重生报告写正确值，渲染端回退到 summary）。
  ensureColumn(db, "report_index", "highlights", "highlights TEXT NOT NULL DEFAULT '[]'");
  // 里程碑自动标注（ADR-0006）：report_index 派生的里程碑洞察计数（importance≥5 + 非追加 + aggregation），
  // 供主题页徽标/里程碑时间线；旧报告补列默认 0（重生报告写正确值）。
  ensureColumn(db, "report_index", "milestone_count", "milestone_count INTEGER NOT NULL DEFAULT 0");
  // 料源形态（ADR-0007 播客接入）：旧库补列默认 'article'（存量全是网页/论文/show_notes 文摘，
  // 重采才写真值）；CHECK 已实测可随 ADD COLUMN 加（默认值满足约束）。
  ensureColumn(
    db,
    "content_item",
    "body_kind",
    "body_kind TEXT NOT NULL DEFAULT 'article' CHECK (body_kind IN ('article','show_notes','transcript'))",
  );
  // 按源全文策略（ADR-0008 决定③）：旧库补列——存量源默认 'feed'（行为不变）、content_container NULL。
  // CHECK 随 ADD COLUMN 加（默认值 'feed' 满足约束，同 body_kind 实测）。
  ensureColumn(
    db,
    "source",
    "fetch_mode",
    "fetch_mode TEXT NOT NULL DEFAULT 'feed' CHECK (fetch_mode IN ('feed','full_text'))",
  );
  ensureColumn(db, "source", "content_container", "content_container TEXT");
  // 源健康自愈（ADR-0008 决定② / 切片3b）：系统熔断态。旧库补列默认 NULL（未熔断）。
  // disabled_reason='circuit_open' 标系统熔断（区分人工停用=NULL）；circuit_reset_at 锚定 consecutiveFails 计数起点。
  ensureColumn(db, "source", "disabled_reason", "disabled_reason TEXT");
  ensureColumn(db, "source", "disabled_at", "disabled_at TEXT");
  ensureColumn(db, "source", "circuit_reset_at", "circuit_reset_at TEXT");
  // 半开探测时间（切片3b-2）：节流，每源每天最多探一次。
  ensureColumn(db, "source", "last_probe_at", "last_probe_at TEXT");
  // ingest 本轮入库条数（切片3b-3 零产出看门狗）：旧 run NULL=未知不计入；新 ingest run 由 collectSource 回填。
  ensureColumn(db, "run", "inserted", "inserted INTEGER");
  // 主题行为原型（ADR-0010）：存量主题派生默认 deep_vertical=现状行为，零回填。无 CHECK（app 校验）。
  ensureColumn(db, "topic", "archetype", "archetype TEXT NOT NULL DEFAULT 'deep_vertical'");
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
