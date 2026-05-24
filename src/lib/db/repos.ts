/**
 * 实体仓储（CRUD）。JSON 字段在此序列化/反序列化，bool ↔ 0/1。
 * 增量1 覆盖 Source / Topic / ContentItem / Run；其余实体随后续增量加。
 */
import type { ContentItem, Cost, Run, Source, Topic } from "../types.js";
import type { DB } from "./index.js";

const j = (v: unknown): string => JSON.stringify(v);
const b = (v: boolean): number => (v ? 1 : 0);

// ── Source ──
export function insertSource(db: DB, s: Source): void {
  db.prepare(
    `INSERT INTO source (id,name,type,endpoint,industry,topic_ids,fetch_interval,backfill,enabled)
     VALUES (@id,@name,@type,@endpoint,@industry,@topic_ids,@fetch_interval,@backfill,@enabled)`,
  ).run({
    id: s.id, name: s.name, type: s.type, endpoint: s.endpoint, industry: s.industry,
    topic_ids: j(s.topic_ids), fetch_interval: s.fetch_interval,
    backfill: s.backfill ? j(s.backfill) : null, enabled: b(s.enabled),
  });
}
export function getSource(db: DB, id: string): Source | null {
  const r = db.prepare("SELECT * FROM source WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToSource(r) : null;
}
export function listSources(db: DB, opts: { enabledOnly?: boolean } = {}): Source[] {
  const sql = opts.enabledOnly ? "SELECT * FROM source WHERE enabled = 1" : "SELECT * FROM source";
  return (db.prepare(sql).all() as Record<string, unknown>[]).map(rowToSource);
}
function rowToSource(r: Record<string, unknown>): Source {
  return {
    id: r.id as string, name: r.name as string, type: r.type as Source["type"],
    endpoint: r.endpoint as string, industry: r.industry as Source["industry"],
    topic_ids: JSON.parse(r.topic_ids as string), fetch_interval: r.fetch_interval as string,
    backfill: r.backfill ? JSON.parse(r.backfill as string) : null, enabled: r.enabled === 1,
  };
}

// ── Topic ──
export function insertTopic(db: DB, t: Topic): void {
  db.prepare(
    `INSERT INTO topic (id,name,keywords,industry,language,brief_schedule,enabled)
     VALUES (@id,@name,@keywords,@industry,@language,@brief_schedule,@enabled)`,
  ).run({
    id: t.id, name: t.name, keywords: j(t.keywords), industry: t.industry,
    language: t.language, brief_schedule: t.brief_schedule, enabled: b(t.enabled),
  });
}
export function getTopic(db: DB, id: string): Topic | null {
  const r = db.prepare("SELECT * FROM topic WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToTopic(r) : null;
}
export function listTopics(db: DB, opts: { enabledOnly?: boolean } = {}): Topic[] {
  const sql = opts.enabledOnly ? "SELECT * FROM topic WHERE enabled = 1" : "SELECT * FROM topic";
  return (db.prepare(sql).all() as Record<string, unknown>[]).map(rowToTopic);
}
function rowToTopic(r: Record<string, unknown>): Topic {
  return {
    id: r.id as string, name: r.name as string, keywords: JSON.parse(r.keywords as string),
    industry: r.industry as Topic["industry"], language: r.language as Topic["language"],
    brief_schedule: r.brief_schedule as Topic["brief_schedule"], enabled: r.enabled === 1,
  };
}

// ── ContentItem ──
export function insertContentItem(db: DB, c: ContentItem): void {
  db.prepare(
    `INSERT INTO content_item
       (id,source_id,url,title,author,published_at,fetched_at,language,topic_ids,tags,body,raw_ref,content_hash,fetch_status)
     VALUES (@id,@source_id,@url,@title,@author,@published_at,@fetched_at,@language,@topic_ids,@tags,@body,@raw_ref,@content_hash,@fetch_status)`,
  ).run({
    id: c.id, source_id: c.source_id, url: c.url, title: c.title, author: c.author,
    published_at: c.published_at, fetched_at: c.fetched_at, language: c.language,
    topic_ids: j(c.topic_ids), tags: j(c.tags), body: c.body, raw_ref: c.raw_ref,
    content_hash: c.content_hash, fetch_status: c.fetch_status,
  });
}
export function getContentItem(db: DB, id: string): ContentItem | null {
  const r = db.prepare("SELECT * FROM content_item WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToContentItem(r) : null;
}
/** 同 URL + content_hash 已存在则视为重复（去重 / 更新判定） */
export function contentExists(db: DB, url: string, contentHash: string): boolean {
  return (
    db.prepare("SELECT 1 FROM content_item WHERE url = ? AND content_hash = ?").get(url, contentHash) !==
    undefined
  );
}
function rowToContentItem(r: Record<string, unknown>): ContentItem {
  return {
    id: r.id as string, source_id: r.source_id as string, url: r.url as string,
    title: r.title as string, author: (r.author as string) ?? null,
    published_at: (r.published_at as string) ?? null, fetched_at: r.fetched_at as string,
    language: r.language as ContentItem["language"], topic_ids: JSON.parse(r.topic_ids as string),
    tags: JSON.parse(r.tags as string), body: r.body as string, raw_ref: r.raw_ref as string,
    content_hash: r.content_hash as string, fetch_status: r.fetch_status as ContentItem["fetch_status"],
  };
}

// ── Run（Job Runner 状态机的持久化原语） ──
export function insertRun(db: DB, run: Run): void {
  db.prepare(
    `INSERT INTO run (id,kind,target,status,started_at,ended_at,duration_ms,cost,error,retry_of)
     VALUES (@id,@kind,@target,@status,@started_at,@ended_at,@duration_ms,@cost,@error,@retry_of)`,
  ).run({
    id: run.id, kind: run.kind, target: j(run.target), status: run.status,
    started_at: run.started_at, ended_at: run.ended_at, duration_ms: run.duration_ms,
    cost: run.cost ? j(run.cost) : null, error: run.error ? j(run.error) : null,
    retry_of: run.retry_of,
  });
}
export function finishRun(
  db: DB,
  id: string,
  outcome: { status: "done" | "failed"; cost?: Cost | null; error?: Run["error"] },
): void {
  const ended = new Date().toISOString();
  const row = db.prepare("SELECT started_at FROM run WHERE id = ?").get(id) as { started_at: string } | undefined;
  const duration = row ? Date.now() - new Date(row.started_at).getTime() : null;
  db.prepare(
    "UPDATE run SET status=@status, ended_at=@ended_at, duration_ms=@duration_ms, cost=@cost, error=@error WHERE id=@id",
  ).run({
    id, status: outcome.status, ended_at: ended, duration_ms: duration,
    cost: outcome.cost ? j(outcome.cost) : null, error: outcome.error ? j(outcome.error) : null,
  });
}
export function getRun(db: DB, id: string): Run | null {
  const r = db.prepare("SELECT * FROM run WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}
export function listRuns(db: DB, opts: { status?: Run["status"]; limit?: number } = {}): Run[] {
  const where = opts.status ? "WHERE status = @status" : "";
  const rows = db
    .prepare(`SELECT * FROM run ${where} ORDER BY started_at DESC LIMIT @limit`)
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 }) as Record<string, unknown>[];
  return rows.map(rowToRun);
}
function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string, kind: r.kind as Run["kind"], target: JSON.parse(r.target as string),
    status: r.status as Run["status"], started_at: r.started_at as string,
    ended_at: (r.ended_at as string) ?? null, duration_ms: (r.duration_ms as number) ?? null,
    cost: r.cost ? JSON.parse(r.cost as string) : null,
    error: r.error ? JSON.parse(r.error as string) : null, retry_of: (r.retry_of as string) ?? null,
  };
}
