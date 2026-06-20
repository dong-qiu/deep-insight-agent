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

-- 应用用户（多账号 · 受邀只读账号）：admin 在设置页增删；密码 scrypt 哈希存储。
-- bootstrap admin 走 env ADMIN_EMAIL/ADMIN_PASSWORD、不入此表（不可删、不会被锁死）。
CREATE TABLE IF NOT EXISTS app_user (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邮件分发收件人（报告推送的邮件渠道收件名单）：admin 在设置页增删/启停。
-- 取代「改服务器 env REPORT_EMAIL_TO」——库里有启用收件人即以库为准，库空才回落 env（兜底、零回归）。
-- email 为 PK（规范化小写存，天然去重）；enabled=0 暂停而不删；label 备注（谁/用途，可空）。
CREATE TABLE IF NOT EXISTS email_recipient (
  email      TEXT PRIMARY KEY,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  body_kind    TEXT NOT NULL DEFAULT 'article' CHECK (body_kind IN ('article','show_notes','transcript')),
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
-- 看板全部 listRuns 走 ORDER BY started_at DESC（分页/时序/源健康），run 表随每轮 cron 无界增长
-- → started_at 加索引避免全表排序；复合 (kind,started_at) 同时覆盖按段筛选+排序。
CREATE INDEX IF NOT EXISTS idx_run_started      ON run(started_at);
CREATE INDEX IF NOT EXISTS idx_run_kind_started ON run(kind, started_at);

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
  headline         TEXT NOT NULL DEFAULT '',
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
  errored                  INTEGER NOT NULL DEFAULT 0,
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
  highlights   TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  entity_names TEXT NOT NULL DEFAULT '[]',
  importance   INTEGER NOT NULL,
  event_ids    TEXT NOT NULL DEFAULT '[]',
  milestone_count INTEGER NOT NULL DEFAULT 0
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

-- ── 增量·D：PPT polish 缓存（B 路径 LLM 重写）──
-- B 路径每次 ~$0.21 / ~30s；同一 report 重复点击导出按钮（或 LLM 路径），靠 inputs_hash
-- 复用上次成功结果，cache 命中秒级返、零成本。
-- inputs_hash = SHA-256(topic.name + sorted [insight.id, statement, importance_basis])，
-- 任一输入变化（topic 改名、洞察改写、纳入条变动）都自动失效。
-- 只缓存"完整成功"结果（perInsight 全填 + executive 非 null），partial 不写入
-- → 中转站偶发流式截断时下次还会重试、直到攒齐一份完整 polish 才锁。
CREATE TABLE IF NOT EXISTS ppt_polish_cache (
  report_id   TEXT PRIMARY KEY,
  inputs_hash TEXT NOT NULL,
  polish_json TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  amount      REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一致性判定缓存：跨批/跨run 复用 (statement, item.body) 的 Opus 判定，省重复校验成本
-- （尤其 relay 抖动导致的部分失败重跑、报告重生成）。key = sha256(version + NUL + statement + NUL + body)，
-- version=校验模型+prompt 哈希（改模型/prompt 自动失效）；读侧带 TTL（见 db/consistency-cache.ts）。
-- 只缓存成功判定（support/not_support/uncertain）；调用失败（not_evaluated）绝不入缓存（瞬时抖动须重试）。
CREATE TABLE IF NOT EXISTS consistency_cache (
  key                 TEXT PRIMARY KEY,
  consistency         TEXT NOT NULL CHECK (consistency IN ('support','not_support','uncertain')),
  consistency_reason  TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 报告页内追问（Follow-up Q&A，A4）：用户就某报告内容提问 → 受限于该报告引用池的可溯源回答。
-- thread_id / turn_index 为多轮升级预留：v1 单轮恒 thread_id=自身id、turn_index=0；
-- 升级多轮时按 thread_id 归并、turn_index 排序，无需迁移。
-- citations_used / validation / cost 以 JSON TEXT 存（与本库其他 JSON 字段一致）。
CREATE TABLE IF NOT EXISTS followup_qa (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES report(id),
  thread_id      TEXT NOT NULL,
  turn_index     INTEGER NOT NULL DEFAULT 0,
  question       TEXT NOT NULL,
  answer_md      TEXT NOT NULL,
  citations_used TEXT NOT NULL DEFAULT '[]',
  validation     TEXT NOT NULL DEFAULT '{}',
  cost           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('done','failed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followup_report ON followup_qa(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_followup_thread ON followup_qa(thread_id, turn_index);
`;
