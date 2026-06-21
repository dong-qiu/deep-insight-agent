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
    `INSERT INTO source (id,name,type,endpoint,industry,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container)
     VALUES (@id,@name,@type,@endpoint,@industry,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container)`,
  ).run({
    id: s.id, name: s.name, type: s.type, endpoint: s.endpoint, industry: s.industry,
    topic_ids: j(s.topic_ids), fetch_interval: s.fetch_interval,
    backfill: s.backfill ? j(s.backfill) : null, enabled: b(s.enabled),
    fetch_mode: s.fetch_mode ?? "feed", content_container: s.content_container ?? null,
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
    // 旧库行（ensureColumn 前查到的）可能无该字段 → 取默认；空串视为未设
    fetch_mode: r.fetch_mode === "full_text" ? "full_text" : "feed",
    content_container: r.content_container ? (r.content_container as string) : null,
    disabled_reason: (r.disabled_reason as string) || null,
    disabled_at: (r.disabled_at as string) || null,
    circuit_reset_at: (r.circuit_reset_at as string) || null,
  };
}
/** 更新 source（id 不变，覆盖表单字段）。**不碰熔断态列**（disabled_reason/disabled_at/circuit_reset_at）——
 *  那由 setCircuit/clearCircuit 专管。但**人工把系统熔断源拉回 enabled=1 → 自动 clearCircuit**（ADR-0008 决定②，
 *  评审🔴：否则留 enabled=1∧reason=circuit_open 脏态 + consecutiveFails 反扑）。返 changes 数。 */
export function updateSource(db: DB, s: Source): number {
  const prev = db.prepare("SELECT disabled_reason FROM source WHERE id=?").get(s.id) as
    | { disabled_reason: string | null }
    | undefined;
  const r = db.prepare(
    `UPDATE source SET name=@name,type=@type,endpoint=@endpoint,industry=@industry,
       topic_ids=@topic_ids,fetch_interval=@fetch_interval,backfill=@backfill,enabled=@enabled,
       fetch_mode=@fetch_mode,content_container=@content_container
     WHERE id=@id`,
  ).run({
    id: s.id, name: s.name, type: s.type, endpoint: s.endpoint, industry: s.industry,
    topic_ids: j(s.topic_ids), fetch_interval: s.fetch_interval,
    backfill: s.backfill ? j(s.backfill) : null, enabled: b(s.enabled),
    fetch_mode: s.fetch_mode ?? "feed", content_container: s.content_container ?? null,
  });
  // 人工拉回启用一个系统熔断源 → 清熔断态（写 circuit_reset_at 干净重数 consecutiveFails）
  if (s.enabled && prev?.disabled_reason === "circuit_open") clearCircuit(db, s.id);
  return r.changes;
}

/** 系统熔断软停用（ADR-0008 决定②）：enabled=0 + 标 circuit_open + 锚定 circuit_reset_at。 */
export function setCircuit(db: DB, id: string): void {
  db.prepare(
    "UPDATE source SET enabled=0, disabled_reason='circuit_open', disabled_at=datetime('now'), circuit_reset_at=datetime('now') WHERE id=?",
  ).run(id);
}

/** 清熔断态（半开复活 / 人工拉回启用）：清 reason/disabled_at + 写 circuit_reset_at（重数 consecutiveFails）。
 *  不强改 enabled（调用方决定）——半开复活时调用方另置 enabled=1；人工 re-enable 时 updateSource 已置。 */
export function clearCircuit(db: DB, id: string): void {
  db.prepare(
    "UPDATE source SET disabled_reason=NULL, disabled_at=NULL, circuit_reset_at=datetime('now') WHERE id=?",
  ).run(id);
}
/** 物理删 source；FK 违例（被 content_item 引用）由调用方 catch 返友好错。 */
export function deleteSource(db: DB, id: string): number {
  return db.prepare("DELETE FROM source WHERE id = ?").run(id).changes;
}
/** 每个源历史产出过的正文形态（body_kind 去重集）。
 *  设置页据此标「播客是否已产出转写」——body_kind 只在 content_item 层，
 *  source 层无法直接得知形态，故按 source_id 聚合回填。返 Map<source_id, Set<body_kind>>。 */
export function getSourceBodyKinds(db: DB): Map<string, Set<string>> {
  const rows = db
    .prepare("SELECT source_id, body_kind FROM content_item GROUP BY source_id, body_kind")
    .all() as { source_id: string; body_kind: string }[];
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.source_id)) map.set(r.source_id, new Set());
    map.get(r.source_id)!.add(r.body_kind);
  }
  return map;
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
/** 更新 topic。返 changes 数。 */
export function updateTopic(db: DB, t: Topic): number {
  const r = db.prepare(
    `UPDATE topic SET name=@name,keywords=@keywords,industry=@industry,
       language=@language,brief_schedule=@brief_schedule,enabled=@enabled
     WHERE id=@id`,
  ).run({
    id: t.id, name: t.name, keywords: j(t.keywords), industry: t.industry,
    language: t.language, brief_schedule: t.brief_schedule, enabled: b(t.enabled),
  });
  return r.changes;
}
/** 物理删 topic；FK 违例（被 report / insight 引用）由调用方 catch 返友好错。 */
export function deleteTopic(db: DB, id: string): number {
  return db.prepare("DELETE FROM topic WHERE id = ?").run(id).changes;
}

// ── ContentItem ──
export function insertContentItem(db: DB, c: ContentItem): void {
  db.prepare(
    `INSERT INTO content_item
       (id,source_id,url,title,author,published_at,fetched_at,language,topic_ids,tags,body,body_kind,raw_ref,content_hash,fetch_status)
     VALUES (@id,@source_id,@url,@title,@author,@published_at,@fetched_at,@language,@topic_ids,@tags,@body,@body_kind,@raw_ref,@content_hash,@fetch_status)`,
  ).run({
    id: c.id, source_id: c.source_id, url: c.url, title: c.title, author: c.author,
    published_at: c.published_at, fetched_at: c.fetched_at, language: c.language,
    topic_ids: j(c.topic_ids), tags: j(c.tags), body: c.body, body_kind: c.body_kind, raw_ref: c.raw_ref,
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
/** 按规范化 url 查已存条目的 id + content_hash + body_kind（去重/更新判定 + B族不降级用）。 */
export function getContentByUrl(
  db: DB,
  url: string,
): { id: string; content_hash: string; body_kind: ContentItem["body_kind"] } | null {
  const r = db.prepare("SELECT id, content_hash, body_kind FROM content_item WHERE url = ?").get(url) as
    | { id: string; content_hash: string; body_kind: ContentItem["body_kind"] }
    | undefined;
  return r ?? null;
}
/** 原地更新（data-collection AC2）：同 url 内容变化时刷新内容字段，保留 id / source_id / published_at。 */
export function updateContentItem(db: DB, c: ContentItem): void {
  db.prepare(
    `UPDATE content_item
       SET title=@title, author=@author, fetched_at=@fetched_at, language=@language,
           tags=@tags, body=@body, body_kind=@body_kind, raw_ref=@raw_ref, content_hash=@content_hash, fetch_status=@fetch_status
     WHERE url=@url`,
  ).run({
    url: c.url, title: c.title, author: c.author, fetched_at: c.fetched_at, language: c.language,
    tags: j(c.tags), body: c.body, body_kind: c.body_kind, raw_ref: c.raw_ref, content_hash: c.content_hash,
    fetch_status: c.fetch_status,
  });
}
/** 取归属某主题、且在 since 之后采集的 ContentItem（调度管线按主题切片用）。
 *  topic_ids 以 JSON 数组文本存储，用带引号的子串匹配做包含判断（id 不含特殊字符，安全）。 */
export function listContentForTopic(
  db: DB,
  topicId: string,
  opts: { since?: string; limit?: number } = {},
): ContentItem[] {
  const clauses = ["topic_ids LIKE @like"];
  const params: Record<string, unknown> = { like: `%"${topicId}"%`, limit: opts.limit ?? 200 };
  if (opts.since) {
    // dogfood feedback：用 published_at（真发布时间，已归一化 ISO 8601）做窗口过滤——
    // 之前用 fetched_at 导致几个月前的 GitHub Eng 文章今天还在 brief 里（"重抓 ≠ 新鲜"）。
    // COALESCE 在 published_at 为 null 时回退到 fetched_at，保证不解析的源仍能被收录。
    clauses.push("COALESCE(published_at, fetched_at) >= @since");
    params.since = opts.since;
  }
  const rows = db
    .prepare(
      `SELECT * FROM content_item WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT @limit`,
    )
    .all(params) as Record<string, unknown>[];
  return rows.map(rowToContentItem);
}

function rowToContentItem(r: Record<string, unknown>): ContentItem {
  return {
    id: r.id as string, source_id: r.source_id as string, url: r.url as string,
    title: r.title as string, author: (r.author as string) ?? null,
    published_at: (r.published_at as string) ?? null, fetched_at: r.fetched_at as string,
    language: r.language as ContentItem["language"], topic_ids: JSON.parse(r.topic_ids as string),
    tags: JSON.parse(r.tags as string), body: r.body as string,
    body_kind: (r.body_kind as ContentItem["body_kind"]) ?? "article", raw_ref: r.raw_ref as string,
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
  outcome: { status: "done" | "failed"; cost?: Cost | null; error?: Run["error"]; duration_ms?: number },
): void {
  const ended = new Date().toISOString();
  const row = db.prepare("SELECT started_at FROM run WHERE id = ?").get(id) as { started_at: string } | undefined;
  if (!row) throw new Error(`finishRun: Run ${id} 不存在`);
  // 优先用调用方传入的单调时钟耗时（runJob 提供）；缺省回退墙钟差（受 NTP 跳变影响，仅兜底）
  const wall = Date.now() - new Date(row.started_at).getTime();
  const duration = outcome.duration_ms ?? (Number.isFinite(wall) ? wall : null);
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
export function listRuns(
  db: DB,
  opts: { kind?: Run["kind"]; status?: Run["status"]; limit?: number; offset?: number } = {},
): Run[] {
  const conds: string[] = [];
  if (opts.kind) conds.push("kind = @kind");
  if (opts.status) conds.push("status = @status");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM run ${where} ORDER BY started_at DESC LIMIT @limit OFFSET @offset`)
    .all({ kind: opts.kind ?? null, status: opts.status ?? null, limit: opts.limit ?? 100, offset: opts.offset ?? 0 }) as Record<string, unknown>[];
  return rows.map(rowToRun);
}
/** batch_id → topic_id 映射（admin 看板：validate Run 的 target 只有 batch_id，借此解析回主题名）。
 *  按页内实际 batch_id 精确查（WHERE id IN），不设时间窗——避免翻旧页时窗外 batch 静默解析不到。 */
export function batchTopicMap(db: DB, batchIds: string[]): Map<string, string> {
  if (!batchIds.length) return new Map();
  const ph = batchIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, topic_id FROM analysis_batch WHERE id IN (${ph})`)
    .all(...batchIds) as { id: string; topic_id: string }[];
  return new Map(rows.map((r) => [r.id, r.topic_id]));
}

/** 某主题某次深挖触发后的管线 Run（进度透明 3.3）：analyze / report-gen 直接带 topic_id；
 *  validate 的 target 只有 batch_id，经 analysis_batch.topic_id 关联回主题。`sinceIso` 锚定
 *  本次触发时刻（用 started_at ≥ since 把历史轮次隔离掉），started_at 升序还原 采集→分析→报告 时序。 */
export function listRunsForTopicSince(db: DB, topicId: string, sinceIso: string): Run[] {
  const rows = db
    .prepare(
      `SELECT * FROM run
       WHERE started_at >= @since AND (
         (kind IN ('analyze','report-gen') AND json_extract(target, '$.topic_id') = @topic)
         OR (kind = 'validate' AND json_extract(target, '$.batch_id') IN (
               SELECT id FROM analysis_batch WHERE topic_id = @topic))
       )
       ORDER BY started_at ASC`,
    )
    .all({ since: sinceIso, topic: topicId }) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

/** 启动期清扫"孤儿 Run"（review follow-up #1）：进程被 SIGTERM / 容器重启时，
 *  正在跑的 Run 留在 `status=running` 永不变 done/failed，/admin 看板显示永久"运行中"。
 *  openDb 触发时把所有 `running` Run 一刀切标 failed，error.type="OrphanedOnRestart"，
 *  duration_ms 用 ended-started 补；返扫到几条以便日志。
 *  幂等：清扫只对仍 running 的生效，新一轮 runJob 起的新 Run 不受影响。 */
export function recoverOrphanedRuns(db: DB): number {
  const now = new Date().toISOString();
  const errorJson = JSON.stringify({
    type: "OrphanedOnRestart",
    message: "进程重启时该 Run 仍在 running 状态，无法继续；已标 failed。可手动重试。",
  });
  const r = db.prepare(
    `UPDATE run
     SET status = 'failed',
         ended_at = ?,
         duration_ms = COALESCE(duration_ms, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
         error = ?
     WHERE status = 'running'`,
  ).run(now, now, errorJson);
  return r.changes;
}

/** 同 kind + target 下是否有任一 Run 处于 running（review follow-up #2 防并发）。
 *  - kind=ingest：targetMatch={ source_id }；
 *  - kind=analyze/validate/report-gen：targetMatch={ topic_id }（用户场景仅深挖触发 analyze）。
 *  target 在 DB 是 JSON 字符串，用 SQLite 内建 json_extract 比对。 */
export function hasRunningRun(
  db: DB,
  kind: Run["kind"],
  targetField: "source_id" | "topic_id" | "batch_id",
  value: string,
): boolean {
  const r = db.prepare(
    `SELECT 1 FROM run
     WHERE status='running' AND kind=? AND json_extract(target, '$.${targetField}') = ?
     LIMIT 1`,
  ).get(kind, value);
  return r != null;
}

/** 累计 started_at ≥ sinceIso 的 Run 真实成本（USD）——成本预算守卫（cost-guard）用。
 *  cost 是 JSON TEXT，用 SQLite 内建 json_extract 取 amount；无 cost 的 Run（确定性段如
 *  ingest / report-gen）json_extract 返 NULL、被 SUM 忽略。started_at 为 ISO8601（同格式），
 *  字典序比较即时间序，可直接走 idx 无需解析。 */
export function sumRunCostSince(db: DB, sinceIso: string): number {
  const r = db
    .prepare(`SELECT COALESCE(SUM(json_extract(cost, '$.amount')), 0) AS total FROM run WHERE started_at >= ?`)
    .get(sinceIso) as { total: number };
  return r.total ?? 0;
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
