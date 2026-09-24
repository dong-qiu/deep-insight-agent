/**
 * 实体仓储（CRUD）。JSON 字段在此序列化/反序列化，bool ↔ 0/1。
 * 增量1 覆盖 Source / Topic / ContentItem / Run；其余实体随后续增量加。
 */
import { parseFacets } from "../topics/facets.js";
import type { ContentItem, Cost, Run, Source, Topic, TranscriptAcquisitionFact } from "../types.js";
import type { DB } from "./index.js";
import { canonicalHash, projectTrace } from "./provenance-facts.js";
import { assertExplicitTranscriptPolicy } from "../transcript-policy.js";

const j = (v: unknown): string => JSON.stringify(v);
const b = (v: boolean): number => (v ? 1 : 0);

type TranscriptPolicy = Pick<Source,
  "transcript_mode" | "transcript_strategy" | "transcript_max_items_per_run" |
  "transcript_max_bytes_per_run" | "transcript_timeout_budget_ms" | "transcript_host_qps" |
  "transcript_policy_version"
>;

/** Resolve optional legacy Source fields at the persistence boundary. `off` keeps its version
 * empty; a policy-aware mode must be explicitly versioned before any collector may read it. */
function transcriptPolicyForWrite(source: Source): Required<TranscriptPolicy> {
  const transcript_mode = source.transcript_mode ?? "off";
  assertExplicitTranscriptPolicy(source);
  const transcript_strategy = source.transcript_strategy ?? "relevant_only";
  const transcript_max_items_per_run = source.transcript_max_items_per_run ?? 5;
  const transcript_max_bytes_per_run = source.transcript_max_bytes_per_run ?? 5 * 1024 * 1024;
  const transcript_timeout_budget_ms = source.transcript_timeout_budget_ms ?? 30_000;
  const transcript_host_qps = source.transcript_host_qps ?? 0.5;
  const transcript_policy_version = source.transcript_policy_version?.trim() || null;

  if (transcript_mode !== "off" && !transcript_policy_version) {
    throw new Error("transcript_policy_version_required");
  }
  if (
    !Number.isInteger(transcript_max_items_per_run) || transcript_max_items_per_run <= 0 ||
    !Number.isInteger(transcript_max_bytes_per_run) || transcript_max_bytes_per_run <= 0 ||
    !Number.isInteger(transcript_timeout_budget_ms) || transcript_timeout_budget_ms <= 0 ||
    !Number.isFinite(transcript_host_qps) || transcript_host_qps <= 0
  ) {
    throw new Error("invalid_transcript_policy_limits");
  }
  return {
    transcript_mode, transcript_strategy, transcript_max_items_per_run,
    transcript_max_bytes_per_run, transcript_timeout_budget_ms, transcript_host_qps,
    transcript_policy_version: transcript_mode === "off" ? null : transcript_policy_version,
  };
}

/** Only a policy version change can authorize a change to collector decision semantics. Adapter
 * versions are emitted with each acquisition fact; their rollout code must likewise bump it. */
function transcriptPolicySemantics(source: Source, policy: Required<TranscriptPolicy>): string {
  return JSON.stringify({
    mode: policy.transcript_mode, strategy: policy.transcript_strategy,
    max_items: policy.transcript_max_items_per_run, max_bytes: policy.transcript_max_bytes_per_run,
    timeout_ms: policy.transcript_timeout_budget_ms, host_qps: policy.transcript_host_qps,
    topic_ids: [...source.topic_ids].sort(),
  });
}

// ── Source ──
export function insertSource(db: DB, s: Source): void {
  const policy = transcriptPolicyForWrite(s);
  db.prepare(
    `INSERT INTO source (id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,
      transcript_mode,transcript_strategy,transcript_max_items_per_run,transcript_max_bytes_per_run,transcript_timeout_budget_ms,transcript_host_qps,transcript_policy_version)
     VALUES (@id,@name,@type,@endpoint,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container,
      @transcript_mode,@transcript_strategy,@transcript_max_items_per_run,@transcript_max_bytes_per_run,@transcript_timeout_budget_ms,@transcript_host_qps,@transcript_policy_version)`,
  ).run({
    id: s.id, name: s.name, type: s.type, endpoint: s.endpoint,
    topic_ids: j(s.topic_ids), fetch_interval: s.fetch_interval,
    backfill: s.backfill ? j(s.backfill) : null, enabled: b(s.enabled),
    fetch_mode: s.fetch_mode ?? "feed", content_container: s.content_container ?? null,
    ...policy,
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
    endpoint: r.endpoint as string,
    topic_ids: JSON.parse(r.topic_ids as string), fetch_interval: r.fetch_interval as string,
    backfill: r.backfill ? JSON.parse(r.backfill as string) : null, enabled: r.enabled === 1,
    // 旧库行（ensureColumn 前查到的）可能无该字段 → 取默认；空串视为未设
    fetch_mode: r.fetch_mode === "full_text" ? "full_text" : "feed",
    content_container: r.content_container ? (r.content_container as string) : null,
    transcript_mode: r.transcript_mode === "enabled" || r.transcript_mode === "observe" ? r.transcript_mode : "off",
    transcript_strategy: r.transcript_strategy === "all" ? "all" : "relevant_only",
    transcript_max_items_per_run: Number(r.transcript_max_items_per_run) || 5,
    transcript_max_bytes_per_run: Number(r.transcript_max_bytes_per_run) || 5 * 1024 * 1024,
    transcript_timeout_budget_ms: Number(r.transcript_timeout_budget_ms) || 30_000,
    transcript_host_qps: Number(r.transcript_host_qps) || 0.5,
    transcript_policy_version: typeof r.transcript_policy_version === "string" && r.transcript_policy_version.trim()
      ? r.transcript_policy_version.trim() : null,
    disabled_reason: (r.disabled_reason as string) || null,
    disabled_at: (r.disabled_at as string) || null,
    circuit_reset_at: (r.circuit_reset_at as string) || null,
    last_probe_at: (r.last_probe_at as string) || null,
  };
}
/** 更新 source（id 不变，覆盖表单字段）。**不碰熔断态列**（disabled_reason/disabled_at/circuit_reset_at）——
 *  那由 setCircuit/clearCircuit 专管。但**人工把系统熔断源拉回 enabled=1 → 自动 clearCircuit**（ADR-0008 决定②，
 *  评审🔴：否则留 enabled=1∧reason=circuit_open 脏态 + consecutiveFails 反扑）。返 changes 数。 */
export function updateSource(db: DB, s: Source): number {
  const prev = getSource(db, s.id);
  const policy = transcriptPolicyForWrite(s);
  if (
    prev && prev.transcript_mode !== "off" && policy.transcript_mode !== "off" &&
    transcriptPolicySemantics(prev, transcriptPolicyForWrite(prev)) !== transcriptPolicySemantics(s, policy) &&
    policy.transcript_policy_version === prev.transcript_policy_version
  ) {
    throw new Error("transcript_policy_version_must_change");
  }
  const r = db.prepare(
    `UPDATE source SET name=@name,type=@type,endpoint=@endpoint,
       topic_ids=@topic_ids,fetch_interval=@fetch_interval,backfill=@backfill,enabled=@enabled,
       fetch_mode=@fetch_mode,content_container=@content_container,
       transcript_mode=@transcript_mode,transcript_strategy=@transcript_strategy,
       transcript_max_items_per_run=@transcript_max_items_per_run,transcript_max_bytes_per_run=@transcript_max_bytes_per_run,
       transcript_timeout_budget_ms=@transcript_timeout_budget_ms,transcript_host_qps=@transcript_host_qps,
       transcript_policy_version=@transcript_policy_version,
       updated_at=datetime('now')
     WHERE id=@id`,
  ).run({
    id: s.id, name: s.name, type: s.type, endpoint: s.endpoint,
    topic_ids: j(s.topic_ids), fetch_interval: s.fetch_interval,
    backfill: s.backfill ? j(s.backfill) : null, enabled: b(s.enabled),
    fetch_mode: s.fetch_mode ?? "feed", content_container: s.content_container ?? null,
    ...policy,
  });
  // 人工拉回启用一个系统熔断源 → 清熔断态（写 circuit_reset_at 干净重数 consecutiveFails）
  if (s.enabled && prev?.disabled_reason === "circuit_open") clearCircuit(db, s.id);
  return r.changes;
}

/** Deterministic identity for a single acquisition stage. It deliberately excludes mutable
 * outcome payload so a semantic mismatch becomes an append-only conflict instead of a new fact. */
export function transcriptAcquisitionEventKey(
  fact: Omit<TranscriptAcquisitionFact, "event_key">,
): string {
  return `taf_${canonicalHash({
    source_id: fact.source_id, canonical_episode_url: fact.canonical_episode_url,
    candidate_hash: fact.candidate_hash, transcript_policy_version: fact.transcript_policy_version,
    mode: fact.mode, strategy: fact.strategy, execution_scope: fact.execution_scope,
    stage: fact.stage, attempt: fact.attempt,
  })}`;
}

function assertTranscriptAcquisitionFact(fact: TranscriptAcquisitionFact): void {
  if (fact.mode === "off") throw new Error("off_transcript_mode_cannot_emit_acquisition_fact");
  if (!fact.transcript_policy_version.trim()) throw new Error("transcript_policy_version_required");
  if ((fact.stage === "candidate" || fact.stage === "decision") && fact.attempt !== 0) {
    throw new Error("transcript_acquisition_attempt_invalid");
  }
  if ((fact.stage === "attempt" || fact.stage === "terminal") && fact.attempt < 1) {
    throw new Error("transcript_acquisition_attempt_invalid");
  }
  if (fact.execution_scope === "shadow" && fact.content_item_id) {
    throw new Error("shadow_transcript_cannot_link_production_content");
  }
  if (fact.evidence_status === "verified" && !fact.raw_ref) {
    throw new Error("verified_transcript_evidence_requires_raw_ref");
  }
  if (fact.outcome === "success" && (!fact.raw_ref || fact.evidence_status !== "verified")) {
    throw new Error("successful_transcript_requires_verified_raw_evidence");
  }
}

/** Transcript diagnostics are idempotent observations. `run_id` and `occurred_at` describe the
 * delivery attempt rather than the immutable acquisition stage, so they are deliberately outside
 * the semantic hash. A conflicting replay is retained in its own append-only table instead of
 * silently overwriting the original evidence. */
export function appendTranscriptAcquisitionFact(
  db: DB,
  fact: TranscriptAcquisitionFact,
): { replayed: boolean } {
  assertTranscriptAcquisitionFact(fact);
  if (fact.event_key !== transcriptAcquisitionEventKey(fact)) {
    throw new Error("transcript_acquisition_event_key_mismatch");
  }
  const semantic_payload_hash = canonicalHash({
    event_key: fact.event_key, source_id: fact.source_id, canonical_episode_url: fact.canonical_episode_url,
    candidate_hash: fact.candidate_hash, transcript_policy_version: fact.transcript_policy_version,
    mode: fact.mode, strategy: fact.strategy, execution_scope: fact.execution_scope, stage: fact.stage,
    adapter_version: fact.adapter_version, attempt: fact.attempt,
    decision: fact.decision, outcome: fact.outcome, reason_code: fact.reason_code, bytes: fact.bytes,
    duration_ms: fact.duration_ms, fallback_body_kind: fact.fallback_body_kind,
    content_item_id: fact.content_item_id, raw_ref: fact.raw_ref, evidence_status: fact.evidence_status,
  });
  const existing = db.prepare("SELECT semantic_payload_hash FROM transcript_acquisition_fact WHERE event_key=?").get(fact.event_key) as
    | { semantic_payload_hash: string }
    | undefined;
  if (existing) {
    if (existing.semantic_payload_hash === semantic_payload_hash) return { replayed: true };
    db.prepare(
      "INSERT INTO transcript_acquisition_conflict(id,event_key,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at) VALUES (lower(hex(randomblob(16))),?,?,?,?)",
    ).run(fact.event_key, existing.semantic_payload_hash, semantic_payload_hash, new Date().toISOString());
    throw new Error("transcript_acquisition_idempotency_conflict");
  }
  db.prepare(
    `INSERT INTO transcript_acquisition_fact
      (event_key,source_id,canonical_episode_url,candidate_hash,transcript_policy_version,mode,strategy,execution_scope,stage,adapter_version,attempt,decision,outcome,reason_code,bytes,duration_ms,fallback_body_kind,content_item_id,raw_ref,evidence_status,run_id,occurred_at,semantic_payload_hash)
     VALUES (@event_key,@source_id,@canonical_episode_url,@candidate_hash,@transcript_policy_version,@mode,@strategy,@execution_scope,@stage,@adapter_version,@attempt,@decision,@outcome,@reason_code,@bytes,@duration_ms,@fallback_body_kind,@content_item_id,@raw_ref,@evidence_status,@run_id,@occurred_at,@semantic_payload_hash)`,
  ).run({ ...fact, semantic_payload_hash });
  return { replayed: false };
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

/** 按源贡献（ADR-0008 决定⑦ 降级版 / 切片4）：每源在 sinceIso 后**已上报报告**里被引用的 distinct 洞察数。
 *  纯读时聚合、零新表——沿用 reports.ts 的 instr(insight_ids) JOIN 先例：
 *  report(done) → insight(在 insight_ids 里) → citation → content_item.source_id，按源数 distinct insight。
 *  multi-source 洞察对每个被引源各计 1（计数口径，非均摊——护稀疏权威源）。返 Map<source_id, 贡献数>。 */
export function sourceContribution(db: DB, sinceIso: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT ci.source_id AS source_id, COUNT(DISTINCT i.id) AS cnt
       FROM report r
       JOIN insight i ON instr(r.insight_ids, '"' || i.id || '"') > 0
       JOIN citation c ON c.insight_id = i.id
       JOIN content_item ci ON ci.id = c.content_item_id AND ci.reader_eligible=1
       WHERE r.status = 'done' AND r.generated_at >= @since
       GROUP BY ci.source_id`,
    )
    .all({ since: sinceIso }) as { source_id: string; cnt: number }[];
  return new Map(rows.map((r) => [r.source_id, r.cnt]));
}

/** 半开探测候选（切片3b-2）：系统熔断（enabled=0 ∧ circuit_open）且距上次探测 > throttleMs 的源，取前 limit 个。
 *  按 last_probe_at 升序（最久没探的优先），NULL（从未探）排最前。人工停用（reason≠circuit_open）不入选。 */
export function listProbeCandidates(db: DB, nowIso: string, throttleMs: number, limit: number): Source[] {
  const rows = db
    .prepare(
      `SELECT * FROM source
       WHERE enabled=0 AND disabled_reason='circuit_open'
         AND (last_probe_at IS NULL OR (julianday(@now) - julianday(last_probe_at)) * 86400000 > @throttle)
       ORDER BY last_probe_at IS NOT NULL, last_probe_at ASC LIMIT @limit`,
    )
    .all({ now: nowIso, throttle: throttleMs, limit }) as Record<string, unknown>[];
  return rows.map(rowToSource);
}

/** 记一次半开探测时间（节流锚点）。探测前调用——即便探测进程崩溃也已节流，防探测风暴。 */
export function setLastProbe(db: DB, id: string): void {
  db.prepare("UPDATE source SET last_probe_at=datetime('now') WHERE id=?").run(id);
}

/** 半开探测成功 → 自动复活：enabled=1 + 清熔断态 + 写 circuit_reset_at（重数 consecutiveFails）+ 清 last_probe_at。
 *  单条 UPDATE（原子，评审🟡）。 */
export function reviveSource(db: DB, id: string): void {
  db.prepare(
    "UPDATE source SET enabled=1, disabled_reason=NULL, disabled_at=NULL, circuit_reset_at=datetime('now'), last_probe_at=NULL WHERE id=?",
  ).run(id);
}
/** 物理删 source；被内容或已记录的 transcript policy 版本引用时，FK 会拒绝删除。 */
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
    `INSERT INTO topic (id,name,keywords,language,brief_schedule,enabled,archetype,facets)
     VALUES (@id,@name,@keywords,@language,@brief_schedule,@enabled,@archetype,@facets)`,
  ).run({
    id: t.id, name: t.name, keywords: j(t.keywords),
    language: t.language, brief_schedule: t.brief_schedule, enabled: b(t.enabled),
    archetype: t.archetype ?? "deep_vertical", // 写入边界兜底（fixture 可省，DB NOT NULL）
    facets: j(t.facets ?? []), // Step2c：industry 派生锚已退役，facets 处处显式；缺省落 '[]'
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
    language: r.language as Topic["language"],
    brief_schedule: r.brief_schedule as Topic["brief_schedule"], enabled: r.enabled === 1,
    // ADR-0010：存量行经 ensureColumn 默认 deep_vertical；仍兜底防 NULL（旧库/异常）。
    archetype: (r.archetype as Topic["archetype"]) ?? "deep_vertical",
    // ADR-0010 Step2c：facets 是分类唯一维度；migrate 已把存量从 industry 回填，读时纯解析。
    facets: parseFacets(r.facets),
  };
}

/** 更新 topic。返 changes 数。 */
export function updateTopic(db: DB, t: Topic): number {
  const r = db.prepare(
    `UPDATE topic SET name=@name,keywords=@keywords,
       language=@language,brief_schedule=@brief_schedule,enabled=@enabled,archetype=@archetype,facets=@facets,
       updated_at=datetime('now')
     WHERE id=@id`,
  ).run({
    id: t.id, name: t.name, keywords: j(t.keywords),
    language: t.language, brief_schedule: t.brief_schedule, enabled: b(t.enabled),
    archetype: t.archetype ?? "deep_vertical", // 写入边界兜底
    facets: j(t.facets ?? []),
  });
  return r.changes;
}
/** 物理删 topic；FK 违例（被 report / insight 引用）由调用方 catch 返友好错。 */
export function deleteTopic(db: DB, id: string): number {
  return db.prepare("DELETE FROM topic WHERE id = ?").run(id).changes;
}

// ── ContentItem ──
function speakerMapForWrite(item: ContentItem): {
  speaker_map_status: "not_applicable" | "unknown" | "verified";
  speaker_map_ref: string | null;
} {
  if (item.body_kind !== "transcript") {
    if ((item.speaker_map_status && item.speaker_map_status !== "not_applicable") || item.speaker_map_ref?.trim()) {
      throw new Error("speaker_map_not_applicable_required");
    }
    return { speaker_map_status: "not_applicable", speaker_map_ref: null };
  }
  const speaker_map_status = item.speaker_map_status ?? "unknown";
  const speaker_map_ref = item.speaker_map_ref?.trim() || null;
  if (speaker_map_status === "not_applicable") throw new Error("transcript_speaker_map_status_required");
  if (speaker_map_status === "verified" && !speaker_map_ref) throw new Error("verified_speaker_map_ref_required");
  if (speaker_map_status !== "verified" && speaker_map_ref) throw new Error("unverified_speaker_map_ref_forbidden");
  return { speaker_map_status, speaker_map_ref };
}

export function insertContentItem(db: DB, c: ContentItem): void {
  const speakerMap = speakerMapForWrite(c);
  db.prepare(
    `INSERT INTO content_item
       (id,source_id,url,title,author,published_at,fetched_at,language,topic_ids,tags,body,body_kind,speaker_map_status,speaker_map_ref,raw_ref,content_hash,fetch_status)
     VALUES (@id,@source_id,@url,@title,@author,@published_at,@fetched_at,@language,@topic_ids,@tags,@body,@body_kind,@speaker_map_status,@speaker_map_ref,@raw_ref,@content_hash,@fetch_status)`,
  ).run({
    id: c.id, source_id: c.source_id, url: c.url, title: c.title, author: c.author,
    published_at: c.published_at, fetched_at: c.fetched_at, language: c.language,
    topic_ids: j(c.topic_ids), tags: j(c.tags), body: c.body, body_kind: c.body_kind, ...speakerMap, raw_ref: c.raw_ref,
    content_hash: c.content_hash, fetch_status: c.fetch_status,
  });
}
export function getContentItem(db: DB, id: string): ContentItem | null {
  const r = db.prepare("SELECT * FROM content_item WHERE id = ? AND reader_eligible=1").get(id) as Record<string, unknown> | undefined;
  return r ? rowToContentItem(r) : null;
}
/** null is legacy/missing; false is the explicit raw-archive reader gate. */
export function contentReaderEligibility(db: DB, id: string): boolean | null {
  const row = db.prepare("SELECT reader_eligible FROM content_item WHERE id=?").get(id) as { reader_eligible: number } | undefined;
  return row ? row.reader_eligible === 1 : null;
}
/** Collection recovery is the sole reader of a raw-pending row. */
export function getPendingOrEligibleContentItem(db: DB, id: string): ContentItem | null {
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
/** 按规范化 url 查已存条目的稳定元数据（去重/更新判定 + B族不降级与 revision snapshot 用）。 */
export function getContentByUrl(
  db: DB,
  url: string,
): { id: string; source_id: string; published_at: string | null; content_hash: string; body_kind: ContentItem["body_kind"] } | null {
  const r = db.prepare("SELECT id, source_id, published_at, content_hash, body_kind FROM content_item WHERE url = ?").get(url) as
    | { id: string; source_id: string; published_at: string | null; content_hash: string; body_kind: ContentItem["body_kind"] }
    | undefined;
  return r ?? null;
}
/** 原地更新（data-collection AC2）：同 url 内容变化时刷新内容字段，保留 id / source_id / published_at。 */
export function updateContentItem(db: DB, c: ContentItem): void {
  const speakerMap = speakerMapForWrite(c);
  db.prepare(
    `UPDATE content_item
       SET title=@title, author=@author, fetched_at=@fetched_at, language=@language,
           tags=@tags, body=@body, body_kind=@body_kind, speaker_map_status=@speaker_map_status, speaker_map_ref=@speaker_map_ref,
           raw_ref=@raw_ref, content_hash=@content_hash, fetch_status=@fetch_status
     WHERE url=@url`,
  ).run({
    url: c.url, title: c.title, author: c.author, fetched_at: c.fetched_at, language: c.language,
    tags: j(c.tags), body: c.body, body_kind: c.body_kind, ...speakerMap, raw_ref: c.raw_ref, content_hash: c.content_hash,
    fetch_status: c.fetch_status,
  });
}
/** 取归属某主题、且在 since 之后采集的 ContentItem（调度管线按主题切片用）。
 *  topic_ids 以 JSON 数组文本存储，用带引号的子串匹配做包含判断（id 不含特殊字符，安全）。 */
export function listContentForTopic(
  db: DB,
  topicId: string,
  opts: { since?: string; until?: string; limit?: number } = {},
): ContentItem[] {
  const clauses = ["topic_ids LIKE @like", "reader_eligible=1"];
  const params: Record<string, unknown> = { like: `%"${topicId}"%`, limit: opts.limit ?? 200 };
  if (opts.since) {
    // dogfood feedback：用 published_at（真发布时间，已归一化 ISO 8601）做窗口过滤——
    // 之前用 fetched_at 导致几个月前的 GitHub Eng 文章今天还在 brief 里（"重抓 ≠ 新鲜"）。
    // COALESCE 在 published_at 为 null 时回退到 fetched_at，保证不解析的源仍能被收录。
    clauses.push("COALESCE(published_at, fetched_at) >= @since");
    params.since = opts.since;
  }
  if (opts.until) {
    // durable retry 必须复用原窗口上界；否则晚到的内容会混入历史 Brief。
    clauses.push("COALESCE(published_at, fetched_at) <= @until");
    params.until = opts.until;
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
  const body_kind = (r.body_kind as ContentItem["body_kind"]) ?? "article";
  return {
    id: r.id as string, source_id: r.source_id as string, url: r.url as string,
    title: r.title as string, author: (r.author as string) ?? null,
    published_at: (r.published_at as string) ?? null, fetched_at: r.fetched_at as string,
    language: r.language as ContentItem["language"], topic_ids: JSON.parse(r.topic_ids as string),
    tags: JSON.parse(r.tags as string), body: r.body as string,
    body_kind,
    ...(body_kind === "transcript" ? {
      speaker_map_status: r.speaker_map_status === "verified" ? "verified" : "unknown" as const,
      speaker_map_ref: r.speaker_map_status === "verified" && r.speaker_map_ref ? r.speaker_map_ref as string : null,
    } : {}),
    raw_ref: r.raw_ref as string,
    content_hash: r.content_hash as string, fetch_status: r.fetch_status as ContentItem["fetch_status"],
  };
}

// ── Run（Job Runner 状态机的持久化原语） ──
export function insertRun(db: DB, run: Run): void {
  const fields = {
    id: run.id, kind: run.kind, target: j(run.target), status: run.status,
    started_at: run.started_at, ended_at: run.ended_at, duration_ms: run.duration_ms,
    cost: run.cost ? j(run.cost) : null, error: run.error ? j(run.error) : null,
    retry_of: run.retry_of, trace_id: run.trace_id ?? null,
  };
  const hasTrace = (db.prepare("PRAGMA table_info(run)").all() as { name: string }[]).some((column) => column.name === "trace_id");
  db.prepare(
    hasTrace
      ? `INSERT INTO run (id,kind,target,status,started_at,ended_at,duration_ms,cost,error,retry_of,trace_id)
         VALUES (@id,@kind,@target,@status,@started_at,@ended_at,@duration_ms,@cost,@error,@retry_of,@trace_id)`
      : `INSERT INTO run (id,kind,target,status,started_at,ended_at,duration_ms,cost,error,retry_of)
         VALUES (@id,@kind,@target,@status,@started_at,@ended_at,@duration_ms,@cost,@error,@retry_of)`,
  ).run(fields);
}
export function finishRun(
  db: DB,
  id: string,
  outcome: { status: "done" | "failed"; cost?: Cost | null; error?: Run["error"]; duration_ms?: number },
): void {
  db.transaction(() => {
    const ended = new Date().toISOString();
    const hasTrace = (db.prepare("PRAGMA table_info(run)").all() as { name: string }[]).some((column) => column.name === "trace_id");
    const row = db.prepare(`SELECT started_at${hasTrace ? ",trace_id" : ""} FROM run WHERE id = ?`).get(id) as { started_at: string; trace_id?: string | null } | undefined;
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
    if (row.trace_id) projectTrace(db, row.trace_id);
  })();
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
 *  openDb 触发时把 running Run 标 failed，error.type="OrphanedOnRestart"，duration_ms 补。
 *
 *  ⚠️ **不一刀切**（质量 Q2 修）：openDb 每进程启动都调；共享卷多进程下（worktree/容器共卷），
 *  另一进程刚启动的并发 run（started_at 新）若被误杀，会污染 evaluateCircuit 的连续失败计数、
 *  误触熔断。故仅回收 running **超过 staleMs（最长合理时长）** 的——staleMs 内的视为可能存活、
 *  保留。真孤儿（崩溃残留）的回收：① openDb 启动清扫 + ② 每日 cron 入口周期清扫（见 api/cron），
 *  故长驻进程不重启也能在一个 cron 周期内清掉。默认 30 分钟（超 P50 ~10min + LLM 超时余量），
 *  `ORPHAN_RUN_STALE_MIN` 可调（上限 6h）。幂等。 */
export function recoverOrphanedRuns(db: DB, staleMs: number = orphanRunStaleMs()): number {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - staleMs).toISOString(); // ISO 字典序=时序，可直接比较
  const errorJson = JSON.stringify({
    type: "OrphanedOnRestart",
    message: "进程重启时该 Run 已 running 超过最长合理时长，判孤儿标 failed。可手动重试。",
  });
  const r = db.prepare(
    `UPDATE run
     SET status = 'failed',
         ended_at = ?,
         duration_ms = COALESCE(duration_ms, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
         error = ?
     WHERE status = 'running' AND started_at < ?`,
  ).run(now, now, errorJson, cutoff);
  return r.changes;
}

function orphanRunStaleMs(): number {
  const min = Number(process.env.ORPHAN_RUN_STALE_MIN);
  // 上限 360min（6h）防误填超大值把回收推到数十天后近乎禁用；下限/非法回退 30min
  return (Number.isFinite(min) && min > 0 ? Math.min(min, 360) : 30) * 60_000;
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
    trace_id: (r.trace_id as string) ?? null,
    inserted: r.inserted == null ? null : (r.inserted as number),
  };
}

/** 回填 ingest run 的本轮入库条数（切片3b-3 零产出看门狗）。collectSource 在 runJob 完成后调。 */
export function setRunInserted(db: DB, runId: string, inserted: number): void {
  db.prepare("UPDATE run SET inserted=? WHERE id=?").run(inserted, runId);
}
