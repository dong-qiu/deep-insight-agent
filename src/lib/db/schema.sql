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
