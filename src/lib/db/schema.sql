-- M2 骨架 · 数据模型落库（architecture.md「数据模型」为单一事实来源）。
-- WAL / foreign_keys 由 db/index.ts 的 pragma 设置；JSON 字段以 TEXT 存。
-- 本文件随增量扩展：增量1 落 source / topic / content_item / run；
-- analysis_batch / insight / citation / report / report_index 由后续增量补。

CREATE TABLE IF NOT EXISTS source (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('rss','arxiv','api')),
  endpoint       TEXT NOT NULL,
  industry       TEXT NOT NULL CHECK (industry IN ('ai-swe','ai-security')),
  topic_ids      TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  fetch_interval TEXT NOT NULL,                -- duration "1h"
  backfill       TEXT,                          -- JSON {depth,max_cost} | NULL
  enabled        INTEGER NOT NULL DEFAULT 1,    -- bool 0/1
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
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
  topic_ids    TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  tags         TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  body         TEXT NOT NULL,
  raw_ref      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('ok','partial'))
);
CREATE INDEX IF NOT EXISTS idx_content_source ON content_item(source_id);
-- 同 URL 内容更新判定键（content_hash 变化即视为更新）
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_url_hash ON content_item(url, content_hash);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ingest','analyze','validate','report-gen')),
  target      TEXT NOT NULL,                   -- JSON {topic_id?,source_id?,batch_id?,report_id?}
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  cost        TEXT,                            -- JSON {tokens,amount} | NULL
  error       TEXT,                            -- JSON {type,message,stack?} | NULL
  retry_of    TEXT REFERENCES run(id)
);
CREATE INDEX IF NOT EXISTS idx_run_status ON run(status);
CREATE INDEX IF NOT EXISTS idx_run_kind   ON run(kind);

-- ── 增量4：分析批次 / 洞察 / 引用 / 校验 ──

CREATE TABLE IF NOT EXISTS analysis_batch (
  id                   TEXT PRIMARY KEY,
  topic_id             TEXT NOT NULL REFERENCES topic(id),
  time_window          TEXT NOT NULL,                -- JSON {start,end}
  status               TEXT NOT NULL CHECK (status IN ('done','failed')),
  no_significant_event INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batch_topic ON analysis_batch(topic_id);

CREATE TABLE IF NOT EXISTS insight (
  id               TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL REFERENCES analysis_batch(id),
  topic_id         TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('aggregation','trend')),
  event_id         TEXT,
  statement        TEXT NOT NULL,
  importance       INTEGER NOT NULL,
  importance_basis TEXT NOT NULL,
  source_count     INTEGER NOT NULL,
  multi_source     INTEGER NOT NULL,
  time_window      TEXT NOT NULL,                    -- JSON {start,end}
  confidence       TEXT,                             -- high/medium/low | NULL
  language         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_batch ON insight(batch_id);

CREATE TABLE IF NOT EXISTS citation (
  insight_id      TEXT NOT NULL REFERENCES insight(id),
  citation_index  INTEGER NOT NULL,
  content_item_id TEXT NOT NULL,
  quote           TEXT NOT NULL,
  locator         TEXT NOT NULL,                     -- JSON {paragraph_index,char_start,char_end}
  PRIMARY KEY (insight_id, citation_index)
);

CREATE TABLE IF NOT EXISTS citation_check (
  batch_id            TEXT NOT NULL REFERENCES analysis_batch(id),
  insight_id          TEXT NOT NULL,
  citation_index      INTEGER NOT NULL,
  reachability        TEXT NOT NULL,
  reachability_reason TEXT NOT NULL,
  consistency         TEXT NOT NULL,
  consistency_reason  TEXT NOT NULL,
  verdict             TEXT NOT NULL,
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
  releasable               INTEGER NOT NULL
);

-- ── 增量5：报告 + 索引 + 全文检索 ──
-- 正文（Markdown + 自包含 HTML）落 FS（body_path 句柄），元数据落 SQLite。

CREATE TABLE IF NOT EXISTS report (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('brief','deep_dive','initial_digest')),
  topic_id       TEXT NOT NULL REFERENCES topic(id),
  status         TEXT NOT NULL CHECK (status IN ('draft','generating','done','failed','archived','deleted')),
  generated_at   TEXT NOT NULL,
  title          TEXT NOT NULL,
  body_path      TEXT NOT NULL,                 -- FS 前缀；正文 .md/.html 同名，不入库
  insight_ids    TEXT NOT NULL DEFAULT '[]',
  event_ids      TEXT NOT NULL DEFAULT '[]',
  prev_report_id TEXT,
  citation_count INTEGER NOT NULL,
  cost           TEXT NOT NULL                   -- JSON {tokens,amount}
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

-- 全文检索（title / summary / body）
CREATE VIRTUAL TABLE IF NOT EXISTS report_fts USING fts5(report_id UNINDEXED, title, summary, body);
