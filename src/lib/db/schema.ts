/** 数据库 schema（落 architecture.md「数据模型」单一事实来源）。
 *  内联为字符串常量（而非运行时读 .sql 文件），保证 tsx / vitest / Next / Docker 各环境一致，
 *  不依赖资源路径解析。WAL / foreign_keys 由 db/index.ts 的 pragma 设置；JSON 字段以 TEXT 存。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('rss','arxiv','api')),
  endpoint       TEXT NOT NULL,
  industry       TEXT NOT NULL CHECK (industry IN ('ai-swe','ai-security')),
  topic_ids      TEXT NOT NULL DEFAULT '[]',
  fetch_interval TEXT NOT NULL,
  backfill       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',
  industry       TEXT NOT NULL CHECK (industry IN ('ai-swe','ai-security')),
  language       TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),
  brief_schedule TEXT NOT NULL CHECK (brief_schedule IN ('daily','weekly')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_item (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(id),
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  author       TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  language     TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),
  topic_ids    TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  body         TEXT NOT NULL,
  raw_ref      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('ok','partial'))
);
CREATE INDEX IF NOT EXISTS idx_content_source ON content_item(source_id);
-- 规范化 url 唯一（data-collection AC2：同 URL 内容更新走原地 upsert、不新增；id 由 url 派生不变）
DROP INDEX IF EXISTS idx_content_url_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_url ON content_item(url);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ingest','analyze','validate','report-gen')),
  target      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  cost        TEXT,
  error       TEXT,
  retry_of    TEXT REFERENCES run(id)
);
CREATE INDEX IF NOT EXISTS idx_run_status ON run(status);
CREATE INDEX IF NOT EXISTS idx_run_kind   ON run(kind);

CREATE TABLE IF NOT EXISTS analysis_batch (
  id                   TEXT PRIMARY KEY,
  topic_id             TEXT NOT NULL REFERENCES topic(id),
  time_window          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('done','failed')),
  no_significant_event INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (no_significant_event = 1 AND status <> 'done'))
);
CREATE INDEX IF NOT EXISTS idx_batch_topic ON analysis_batch(topic_id);

CREATE TABLE IF NOT EXISTS insight (
  id               TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL REFERENCES analysis_batch(id),
  topic_id         TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('aggregation','trend')),
  event_id         TEXT,
  statement        TEXT NOT NULL,
  importance       INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  importance_basis TEXT NOT NULL,
  source_count     INTEGER NOT NULL,
  multi_source     INTEGER NOT NULL,
  time_window      TEXT NOT NULL,
  confidence       TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  language         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_batch ON insight(batch_id);

CREATE TABLE IF NOT EXISTS citation (
  insight_id      TEXT NOT NULL REFERENCES insight(id),
  citation_index  INTEGER NOT NULL,
  content_item_id TEXT NOT NULL,
  quote           TEXT NOT NULL,
  locator         TEXT NOT NULL,
  PRIMARY KEY (insight_id, citation_index)
);

CREATE TABLE IF NOT EXISTS citation_check (
  batch_id            TEXT NOT NULL REFERENCES analysis_batch(id),
  insight_id          TEXT NOT NULL,
  citation_index      INTEGER NOT NULL,
  reachability        TEXT NOT NULL CHECK (reachability IN ('pass','fail')),
  reachability_reason TEXT NOT NULL CHECK (reachability_reason IN ('ok','source_not_found','source_unreachable','quote_not_in_source')),
  consistency         TEXT NOT NULL CHECK (consistency IN ('support','not_support','uncertain','not_evaluated')),
  consistency_reason  TEXT NOT NULL CHECK (consistency_reason IN ('ok','out_of_context','exaggeration','misattribution','uncertain','not_evaluated')),
  verdict             TEXT NOT NULL CHECK (verdict IN ('pass','blocked','flagged')),
  PRIMARY KEY (batch_id, insight_id, citation_index)
);

CREATE TABLE IF NOT EXISTS validation_result (
  batch_id                 TEXT PRIMARY KEY REFERENCES analysis_batch(id),
  total                    INTEGER NOT NULL,
  pass                     INTEGER NOT NULL,
  blocked                  INTEGER NOT NULL,
  flagged                  INTEGER NOT NULL,
  consistency_failure_rate REAL NOT NULL,
  flagged_rate             REAL NOT NULL,
  insights_total           INTEGER NOT NULL DEFAULT 0,
  insights_includable      INTEGER NOT NULL DEFAULT 0,
  releasable               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS report (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('brief','deep_dive','initial_digest')),
  topic_id       TEXT NOT NULL REFERENCES topic(id),
  status         TEXT NOT NULL CHECK (status IN ('draft','generating','done','failed','archived','deleted')),
  generated_at   TEXT NOT NULL,
  title          TEXT NOT NULL,
  body_path      TEXT NOT NULL,
  insight_ids    TEXT NOT NULL DEFAULT '[]',
  event_ids      TEXT NOT NULL DEFAULT '[]',
  prev_report_id TEXT,
  citation_count INTEGER NOT NULL,
  cost           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_topic  ON report(topic_id);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status);

CREATE TABLE IF NOT EXISTS report_index (
  report_id    TEXT PRIMARY KEY REFERENCES report(id),
  type         TEXT NOT NULL,
  topic_id     TEXT NOT NULL,
  industry     TEXT NOT NULL,
  date         TEXT NOT NULL,
  source_ids   TEXT NOT NULL DEFAULT '[]',
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  entity_names TEXT NOT NULL DEFAULT '[]',
  importance   INTEGER NOT NULL,
  event_ids    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_report_index_topic ON report_index(topic_id);
CREATE INDEX IF NOT EXISTS idx_report_index_date  ON report_index(date);

CREATE VIRTUAL TABLE IF NOT EXISTS report_fts USING fts5(report_id UNINDEXED, title, summary, body);

-- ── 增量6c：审计日志（append-only，architecture 安全设计「审计与日志」，保留 90 天）──
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT,                 -- 用户 / 系统标识
  action TEXT NOT NULL,        -- login / config_change / source_add / report_gen / push / delete ...
  target TEXT,                 -- 关联对象
  detail TEXT                  -- JSON 附加（调用方负责脱敏后再传入）
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;
