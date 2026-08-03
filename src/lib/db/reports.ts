/** 报告持久化：正文（.md/.html）落 FS，元数据 + 索引 + FTS5 落 SQLite。增量5。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { domainFacet, isDomainValue, isLensValue, lensFacet, parseFacets } from "../topics/facets.js";
import type { Report, ReportIndexEntry } from "../types.js";
import type { DB } from "./index.js";

const j = (v: unknown): string => JSON.stringify(v);

function defaultBodyDir(): string {
  return join(process.env.DATA_DIR ?? ".data", "reports");
}

function hasFailureColumn(db: DB): boolean {
  return (db.prepare("PRAGMA table_info(report)").all() as { name: string }[]).some((column) => column.name === "failure");
}

function hasReportEffectTable(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_effect'").get();
}

interface ReportArtifact { target: string; sha256: string; size: number; report_id: string }
const digest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
function safeTarget(root: string, target: string): string {
  if (!/^[A-Za-z0-9_-]+\.(md|html)$/.test(target)) throw new Error("invalid report artifact target");
  const resolved = resolve(root, target);
  if (relative(root, resolved).startsWith("..")) throw new Error("report artifact escaped its root");
  return resolved;
}

function insertReportIndex(db: DB, report: Report, index: ReportIndexEntry): void {
  db.prepare(
    `INSERT INTO report_index (report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count,freshest_candidate_at,freshest_citation_at,freshness_lag_hours)
     VALUES (@report_id,@type,@topic_id,@facets,@date,@source_ids,@title,@summary,@highlights,@tags,@entity_names,@importance,@event_ids,@milestone_count,@freshest_candidate_at,@freshest_citation_at,@freshness_lag_hours)`,
  ).run({
    report_id: index.report_id, type: index.type, topic_id: index.topic_id, facets: j(index.facets ?? []),
    date: index.date, source_ids: j(index.source_ids), title: index.title, summary: index.summary,
    highlights: j(index.highlights), tags: j(index.tags), entity_names: j(index.entity_names), importance: index.importance,
    event_ids: j(index.event_ids), milestone_count: index.milestone_count,
    freshest_candidate_at: index.freshest_candidate_at ?? null, freshest_citation_at: index.freshest_citation_at ?? null,
    freshness_lag_hours: index.freshness_lag_hours ?? null,
  });
  db.prepare(`INSERT INTO report_fts (report_id,title,summary,body) VALUES (?,?,?,?)`).run(
    report.id, index.title, index.summary, report.body_md,
  );
}

function insertReportMetadata(
  db: DB,
  report: Report,
  bodyPath: string | null,
  failure: { reason_code: string; message?: string } | null = null,
): void {
  const fields = {
    id: report.id, type: report.type, topic_id: report.topic_id, status: report.status,
    generated_at: report.generated_at, title: report.title, body_path: bodyPath,
    insight_ids: j(report.insight_ids), event_ids: j(report.event_ids), prev_report_id: report.prev_report_id,
    citation_count: report.citation_count, cost: j(report.cost), failure: failure ? j(failure) : null,
  };
  if (hasFailureColumn(db)) {
    db.prepare(
      `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
       VALUES (@id,@type,@topic_id,@status,@generated_at,@title,@body_path,@insight_ids,@event_ids,@prev_report_id,@citation_count,@cost,@failure)`,
    ).run(fields);
    return;
  }
  // 本地历史库仍可读取/测试，但生产 writer 由 PROVENANCE_SCHEMA_REQUIRED 阻止绕开显式 migration。
  db.prepare(
    `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
     VALUES (@id,@type,@topic_id,@status,@generated_at,@title,@body_path,@insight_ids,@event_ids,@prev_report_id,@citation_count,@cost)`,
  ).run({ ...fields, body_path: bodyPath ?? "" });
}

/** 记录一次不可公开的生成尝试。它没有 artifact/index/FTS，因此普通 reader 永远不可见。 */
export function saveFailedReport(
  db: DB,
  input: Omit<Report, "id" | "status" | "body_md" | "body_html"> & { id?: string; reasonCode: string; message?: string; afterSave?: (id: string) => void },
): string {
  const id = input.id ?? `rep_${randomUUID().slice(0, 8)}`;
  db.transaction(() => {
    insertReportMetadata(db, { ...input, id, status: "failed", body_md: "", body_html: "" }, null,
      { reason_code: input.reasonCode, ...(input.message ? { message: input.message.slice(0, 256) } : {}) });
    input.afterSave?.(id);
  })();
  return id;
}

/** P0a 已迁移库的发布协议：意图 + manifest 先入库，双 artifact 通过 staging 原子换名后才公开索引。 */
function saveReportWithEffect(db: DB, report: Report, index: ReportIndexEntry, dir: string, afterPublish?: () => void): void {
  const root = resolve(dir);
  const effectId = `effect_${randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  const artifacts: Array<{ target: string; body: string }> = [
    { target: `${report.id}.md`, body: report.body_md },
    { target: `${report.id}.html`, body: report.body_html },
  ];
  const manifest: ReportArtifact[] = artifacts.map(({ target, body }) => ({
    target, sha256: digest(body), size: Buffer.byteLength(body, "utf8"), report_id: report.id,
  }));
  // 先写 intent。publication_payload 仅存 index 元数据，正文只存在 staging/final artifact。
  db.transaction(() => {
    insertReportMetadata(db, { ...report, status: "generating" }, null);
    db.prepare(`INSERT INTO generation_effect
      (id,trace_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at)
      VALUES (@id,NULL,@report_id,'report_file',@idempotency_key,@artifact_manifest,@publication_payload,'planned',NULL,@now,@now)`)
      .run({ id: effectId, report_id: report.id, idempotency_key: `report_file:${report.id}`,
        artifact_manifest: j(manifest), publication_payload: j(index), now });
  })();

  const stagingRoot = resolve(root, ".staging", effectId);
  try {
    mkdirSync(stagingRoot, { recursive: true });
    for (const artifact of artifacts) {
      const staged = safeTarget(stagingRoot, artifact.target);
      writeFileSync(staged, artifact.body);
      if (digest(readFileSync(staged, "utf8")) !== manifest.find((entry) => entry.target === artifact.target)!.sha256) {
        throw new Error(`report artifact hash mismatch: ${artifact.target}`);
      }
    }
    mkdirSync(root, { recursive: true });
    db.prepare("UPDATE generation_effect SET status='attempted',updated_at=? WHERE id=? AND status='planned'").run(new Date().toISOString(), effectId);
    for (const artifact of manifest) renameSync(safeTarget(stagingRoot, artifact.target), safeTarget(root, artifact.target));
    db.transaction(() => {
      for (const artifact of manifest) {
        const finalPath = safeTarget(root, artifact.target);
        if (!existsSync(finalPath) || digest(readFileSync(finalPath, "utf8")) !== artifact.sha256) {
          throw new Error(`report artifact is incomplete: ${artifact.target}`);
        }
      }
      const published = db.prepare("UPDATE report SET status='done',body_path=?,failure=NULL WHERE id=? AND status='generating'")
        .run(resolve(join(root, report.id)), report.id);
      if (published.changes !== 1) throw new Error(`report ${report.id} is no longer generating`);
      insertReportIndex(db, report, index);
      db.prepare("UPDATE generation_effect SET status='committed',updated_at=? WHERE id=? AND status='attempted'")
        .run(new Date().toISOString(), effectId);
      afterPublish?.();
    })();
  } catch (error) {
    // 已出现的半成品不进入 reader；保留 effect/failed Report 供后续 reconciliation 或人工诊断。
    const message = error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256);
    db.transaction(() => {
      db.prepare("UPDATE generation_effect SET status='unknown',error=?,updated_at=? WHERE id=? AND status <> 'committed'")
        .run(j({ reason_code: "report_persistence_failed", message }), new Date().toISOString(), effectId);
      db.prepare("UPDATE report SET status='failed',body_path=NULL,failure=? WHERE id=? AND status='generating'")
        .run(j({ reason_code: "report_persistence_failed", message }), report.id);
    })();
    throw error;
  }
}

/** 写正文到 FS + 落 report / report_index / report_fts。dir 可注入（测试用临时目录）。
 *  body_path **始终写绝对路径**——dogfood 2026-06-06 发现"相对路径在跨环境（本地 dev →
 *  容器，cwd 不同）时失效"是 5/31 practice-log "worktree 相对 DB 路径陷阱"的同根复发。
 *  resolve() 把任何相对 path 锚到当时 cwd 取绝对，存进 DB 后跨环境也能直接 readFile。 */
export function saveReport(
  db: DB,
  report: Report,
  index: ReportIndexEntry,
  opts: { dir?: string; afterPublish?: () => void } = {},
): void {
  if (report.status !== "done") {
    // lifecycle 的非发布态只记录元数据；禁止给 failed/generating 写正文、索引或 FTS。
    insertReportMetadata(
      db,
      report,
      null,
      report.status === "failed" ? { reason_code: "report_not_published" } : null,
    );
    return;
  }
  const dir = opts.dir ?? defaultBodyDir();
  if (hasReportEffectTable(db)) {
    saveReportWithEffect(db, report, index, dir, opts.afterPublish);
    return;
  }
  const prefix = resolve(join(dir, report.id));
  const lifecycleSchema = hasFailureColumn(db);
  // 先持久化生成意图，任何文件/索引异常都会留下不可公开但可由 admin 生命周期页诊断的尝试。
  db.transaction(() => {
    insertReportMetadata(db, { ...report, status: "generating" }, null);
  })();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${prefix}.md`, report.body_md);
    writeFileSync(`${prefix}.html`, report.body_html);
    db.transaction(() => {
      const published = db.prepare(
        lifecycleSchema
          ? "UPDATE report SET status='done', body_path=?, failure=NULL WHERE id=? AND status='generating'"
          : "UPDATE report SET status='done', body_path=? WHERE id=? AND status='generating'",
      ).run(prefix, report.id);
      if (published.changes !== 1) throw new Error(`report ${report.id} is no longer generating`);
      db.prepare(
        `INSERT INTO report_index (report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count,freshest_candidate_at,freshest_citation_at,freshness_lag_hours)
         VALUES (@report_id,@type,@topic_id,@facets,@date,@source_ids,@title,@summary,@highlights,@tags,@entity_names,@importance,@event_ids,@milestone_count,@freshest_candidate_at,@freshest_citation_at,@freshness_lag_hours)`,
      ).run({
        report_id: index.report_id, type: index.type, topic_id: index.topic_id,
        // facets 是领域分类维度（Step2c：industry 已退役）；写入端取 topic.facets，缺省落 '[]'。
        facets: j(index.facets ?? []),
        date: index.date, source_ids: j(index.source_ids), title: index.title, summary: index.summary,
        highlights: j(index.highlights), tags: j(index.tags), entity_names: j(index.entity_names), importance: index.importance,
        event_ids: j(index.event_ids), milestone_count: index.milestone_count,
        freshest_candidate_at: index.freshest_candidate_at ?? null,
        freshest_citation_at: index.freshest_citation_at ?? null,
        freshness_lag_hours: index.freshness_lag_hours ?? null,
      });
      db.prepare(`INSERT INTO report_fts (report_id,title,summary,body) VALUES (?,?,?,?)`).run(
        report.id, index.title, index.summary, report.body_md,
      );
      opts.afterPublish?.();
    })();
  } catch (e) {
    // 失败报告永不拥有 artifact/index/FTS；正文清理失败也不能把半成品暴露给 published reader。
    for (const ext of [".md", ".html"]) rmSync(`${prefix}${ext}`, { force: true });
    if (lifecycleSchema) {
      db.prepare(
        "UPDATE report SET status='failed', body_path=NULL, failure=? WHERE id=? AND status='generating'",
      ).run(j({ reason_code: "report_persistence_failed", message: (e as Error).message.slice(0, 256) }), report.id);
    } else {
      db.prepare("UPDATE report SET status='failed', body_path='' WHERE id=? AND status='generating'").run(report.id);
    }
    throw e;
  }
}

/** 启动恢复：只处理留下 generating Report 的 report_file effect；无法验证双文件时 fail-closed。 */
export function reconcileReportEffects(db: DB, opts: { dir?: string } = {}): { committed: number; failed: number } {
  if (!hasReportEffectTable(db)) return { committed: 0, failed: 0 };
  const root = resolve(opts.dir ?? defaultBodyDir());
  const rows = db.prepare(`SELECT e.*, r.* FROM generation_effect e JOIN report r ON r.id=e.report_id
    WHERE e.kind='report_file' AND r.status='generating' AND e.status IN ('planned','attempted','unknown')`).all() as any[];
  let committed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const manifest = JSON.parse(row.artifact_manifest) as ReportArtifact[];
      const index = JSON.parse(row.publication_payload) as ReportIndexEntry;
      const staging = resolve(root, ".staging", row.id);
      for (const artifact of manifest) {
        const finalPath = safeTarget(root, artifact.target);
        const stagedPath = safeTarget(staging, artifact.target);
        if (!existsSync(finalPath) && existsSync(stagedPath)
          && digest(readFileSync(stagedPath, "utf8")) === artifact.sha256) {
          mkdirSync(root, { recursive: true });
          renameSync(stagedPath, finalPath);
        }
        if (!existsSync(finalPath) || digest(readFileSync(finalPath, "utf8")) !== artifact.sha256) {
          throw new Error(`report artifact is incomplete: ${artifact.target}`);
        }
      }
      const report: Report = {
        id: row.report_id, type: row.type, topic_id: row.topic_id, status: "done", generated_at: row.generated_at,
        title: row.title, body_md: readFileSync(safeTarget(root, `${row.report_id}.md`), "utf8"),
        body_html: readFileSync(safeTarget(root, `${row.report_id}.html`), "utf8"),
        insight_ids: JSON.parse(row.insight_ids), event_ids: JSON.parse(row.event_ids), prev_report_id: row.prev_report_id,
        citation_count: row.citation_count, cost: JSON.parse(row.cost),
      };
      db.transaction(() => {
        db.prepare("UPDATE report SET status='done',body_path=?,failure=NULL WHERE id=? AND status='generating'")
          .run(resolve(join(root, row.report_id)), row.report_id);
        insertReportIndex(db, report, index);
        db.prepare("UPDATE generation_effect SET status='committed',error=NULL,updated_at=? WHERE id=?")
          .run(new Date().toISOString(), row.id);
      })();
      committed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256);
      db.transaction(() => {
        db.prepare("UPDATE generation_effect SET status='unknown',error=?,updated_at=? WHERE id=?")
          .run(j({ reason_code: "report_reconcile_failed", message }), new Date().toISOString(), row.id);
        db.prepare("UPDATE report SET status='failed',body_path=NULL,failure=? WHERE id=? AND status='generating'")
          .run(j({ reason_code: "report_reconcile_failed", message }), row.report_id);
      })();
      failed += 1;
    }
  }
  return { committed, failed };
}

export function getReport(db: DB, id: string): Report | null {
  const r = db.prepare("SELECT * FROM report WHERE id = ? AND status = 'done'").get(id) as any;
  if (!r) return null;
  // FS 正文兜底：DB 有行但磁盘正文缺失（写盘中断 / 卷未挂 / 手动删除）时不抛、不让阅读页崩，
  // 返回占位正文并告警，由看板/重生流程兜底。
  let body_md: string;
  let body_html: string;
  try {
    body_md = readFileSync(`${r.body_path}.md`, "utf8");
    body_html = readFileSync(`${r.body_path}.html`, "utf8");
  } catch (e) {
    console.warn(`getReport: 报告 ${id} 正文文件缺失（${r.body_path}.*）：${(e as Error).message}`);
    body_md = `# ${r.title}\n\n_正文文件缺失，请重新生成本报告。_`;
    body_html = `<h1>${r.title}</h1><p><em>正文文件缺失，请重新生成本报告。</em></p>`;
  }
  return {
    id: r.id, type: r.type, topic_id: r.topic_id, status: r.status, generated_at: r.generated_at,
    title: r.title,
    body_md,
    body_html,
    insight_ids: JSON.parse(r.insight_ids), event_ids: JSON.parse(r.event_ids),
    prev_report_id: r.prev_report_id ?? null, citation_count: r.citation_count, cost: JSON.parse(r.cost),
  };
}

/** 该主题是否已有任意报告——冷启动检测（无 → 首版综述 initial_digest）。 */
export function topicHasReport(db: DB, topicId: string): boolean {
  return !!db.prepare("SELECT 1 FROM report WHERE topic_id = ? AND status = 'done' LIMIT 1").get(topicId);
}

/** 报告生命周期（admin 看板 · spec line 301）：全状态计数（含 draft/generating/failed/archived），
 *  区别于 report_index（仅发布层 done）。给看板呈现状态流，让"生成中/失败"瞬态也可观测。 */
export function reportStatusCounts(db: DB): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM report GROUP BY status").all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** 近 N 份报告（全状态，倒序）——看板生命周期列表。轻量：不读正文文件（区别于 getReport）。 */
export interface RecentReport {
  id: string;
  type: string;
  topic_id: string;
  status: string;
  generated_at: string;
  title: string;
  citation_count: number;
  cost: Report["cost"];
}
export function listRecentReports(db: DB, limit = 15): RecentReport[] {
  const rows = db
    .prepare(
      "SELECT id, type, topic_id, status, generated_at, title, citation_count, cost FROM report ORDER BY generated_at DESC LIMIT ?",
    )
    .all(limit) as Array<Omit<RecentReport, "cost"> & { cost: string }>;
  return rows.map((r) => ({ ...r, cost: JSON.parse(r.cost) as Report["cost"] }));
}

/** 某主题在 sinceIso 之后产出的最新**已完成深挖**报告（进度透明 3.3）：深挖完成后给前端可点链接。
 *  - `type='deep_dive'`：深挖按钮的完成信号只认深挖产物——否则同主题的每日 brief cron 若在轮询窗口内
 *    落库一份 brief，会被误判为"深挖完成"并把链接指到错报告（review 实锤，brief/cron 是独立路径，
 *    `hasRunningRun` 拦不住）；
 *  - `status='done'`：排除 generating/failed/draft 等中间/失败态，只有真正出片才算完成；
 *  - generated_at ≥ since 把本次触发的产物与历史报告隔开；倒序取最新一条。返回 null = 还没出。 */
export function latestReportForTopicSince(
  db: DB,
  topicId: string,
  sinceIso: string,
): { id: string; title: string; type: string } | null {
  const r = db
    .prepare(
      `SELECT id, title, type FROM report
       WHERE topic_id = ? AND type = 'deep_dive' AND status = 'done' AND generated_at >= ?
       ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(topicId, sinceIso) as { id: string; title: string; type: string } | undefined;
  return r ?? null;
}

/** 报告链——按 type 把同主题报告串成「演化链」，新报告生成时取本批之前的最新一篇作前情。
 *  - `brief` / `initial_digest` 同属「每日节奏链」：initial_digest 是冷启动首报（链头），后续
 *    每日 brief 接续——对应产品定义「首份 brief 定义为初始摘要，并以此设定不复报基线」；
 *  - `deep_dive` 独立成「深挖链」（用户触发的回顾，与日度节奏不同节拍，不混链）；
 *  - 只认 status='done'：排除 generating/failed/draft，避免链指到半成品；
 *  - 在 runReportGen **之前**调用——此刻本报告尚未落库，"最新 done" 必是上一篇，不会自指。
 *  注意：新增 report type 时必须同步 `ops/backfill-report-chain.mjs` 的 CHAIN_GROUPS（决定它进哪条链）。 */
export function chainTypesFor(type: string): string[] {
  return type === "deep_dive" ? ["deep_dive"] : ["brief", "initial_digest"];
}

export function previousReportForTopic(db: DB, topicId: string, type: string): string | null {
  const types = chainTypesFor(type);
  const placeholders = types.map(() => "?").join(",");
  const r = db
    .prepare(
      `SELECT id FROM report
       WHERE topic_id = ? AND type IN (${placeholders}) AND status = 'done'
       ORDER BY generated_at DESC, id DESC LIMIT 1`, // id 兜底：与 backfill 脚本同序，防同秒落两篇时在线/回填选出不同 prev
    )
    .get(topicId, ...types) as { id: string } | undefined;
  return r?.id ?? null;
}

/** 报告阅读页的前后导航：prev = 本报告显式记录的前情（report.prev_report_id），
 *  next = 反查「谁把本报告记为前情」（同链下一篇）。各返 {id,title,type}，title 供链接文案。
 *  - next 反查可能命中多条（同一前情被重生成过的链分叉）→ 取最新 done 一条，稳定指向当前活跃链；
 *  - 轻量查询，不读正文文件（区别于 getReport），列表/导航用。
 *  已知边界：两端都过滤 status='done'——链中段某篇被 archived/deleted 会让链从该点静默断成两截
 *  （不链到非 done 是"不指半成品"的有意取舍）；当前产品不归档历史报告，故暂不缝合。 */
export interface ReportNeighbor {
  id: string;
  title: string;
  type: string;
}
export function reportNeighbors(
  db: DB,
  report: { id: string; prev_report_id: string | null },
): { prev: ReportNeighbor | null; next: ReportNeighbor | null } {
  const prev = report.prev_report_id
    ? (db
        .prepare("SELECT id, title, type FROM report WHERE id = ? AND status = 'done'")
        .get(report.prev_report_id) as ReportNeighbor | undefined) ?? null
    : null;
  const next =
    (db
      .prepare(
        `SELECT id, title, type FROM report
         WHERE prev_report_id = ? AND status = 'done'
         ORDER BY generated_at DESC, id DESC LIMIT 1`, // 分叉（同 prev 被重生成多篇引用）取最新，id 兜底防同秒抖动
      )
      .get(report.id) as ReportNeighbor | undefined) ?? null;
  return { prev, next };
}

/** 校验下钻条目：本报告涉及洞察的所有被 validator 屏蔽的引用（含理由与 quote 全文）。
 *  - 经 report.insight_ids → insight.batch_id 关联到 citation_check；
 *  - 联表 citation 拿原始 quote 与 content_item_id；
 *  - 评审用：让"不可见的把关"可下钻，外露 validator 真实抓到的具体案例。 */
export interface BlockedCheck {
  insight_id: string;
  statement: string; // 洞察 statement（截断由 UI 决定）
  citation_index: number;
  quote: string;
  content_item_id: string;
  reachability: "pass" | "fail";
  reachability_reason: string;
  consistency: "support" | "not_support" | "uncertain" | "not_evaluated";
  consistency_reason: string;
  reason: string; // 选定的真实理由（reachability fail → reachability_reason；否则 → consistency_reason）
}

export function listBlockedChecksForReport(db: DB, reportId: string): BlockedCheck[] {
  const rows = db.prepare(`
    SELECT
      cc.insight_id AS insight_id,
      i.statement AS statement,
      cc.citation_index AS citation_index,
      c.quote AS quote,
      c.content_item_id AS content_item_id,
      cc.reachability AS reachability,
      cc.reachability_reason AS reachability_reason,
      cc.consistency AS consistency,
      cc.consistency_reason AS consistency_reason
    FROM report r
    JOIN insight i ON instr(r.insight_ids, '"' || i.id || '"') > 0
    JOIN citation_check cc ON cc.insight_id = i.id
    JOIN citation c ON c.insight_id = cc.insight_id AND c.citation_index = cc.citation_index
    WHERE r.id = ? AND r.status = 'done' AND cc.verdict = 'blocked'
    ORDER BY i.id, cc.citation_index
  `).all(reportId) as Omit<BlockedCheck, "reason">[];
  return rows.map((r) => ({
    ...r,
    reason: r.reachability === "fail" ? r.reachability_reason : r.consistency_reason,
  }));
}

/** 已发布报告实际采用的 pass/support 引用；仅管理端下钻使用，避免把未入选或 flagged 项混入证据链。 */
export interface PassCheck { insight_id: string; statement: string; citation_index: number; quote: string; content_item_id: string; url: string }
export function listPassChecksForReport(db: DB, reportId: string): PassCheck[] {
  return db.prepare(`
    SELECT cc.insight_id,i.statement,cc.citation_index,c.quote,c.content_item_id,ci.url
    FROM report r JOIN insight i ON instr(r.insight_ids, '"' || i.id || '"') > 0
    JOIN citation_check cc ON cc.insight_id=i.id
    JOIN citation c ON c.insight_id=cc.insight_id AND c.citation_index=cc.citation_index
    JOIN content_item ci ON ci.id=c.content_item_id
    WHERE r.id=? AND r.status='done' AND cc.verdict='pass' AND cc.consistency='support'
    ORDER BY i.id,cc.citation_index`).all(reportId) as PassCheck[];
}

/** 每日节奏中已发布 event 的成功校验证据；brief 与 initial_digest 共用基线，deep_dive 不参与。 */
export interface PublishedEventEvidence {
  event_id: string;
  statement: string;
  date: string;
  content_item_ids: string[];
}

export function listRecentPublishedEventEvidence(
  db: DB,
  topicId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): PublishedEventEvidence[] {
  const sinceDays = opts.sinceDays ?? 14;
  const limit = Math.min(opts.limit ?? 200, 200);
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const reports = db.prepare(`
    SELECT ri.date AS date, r.insight_ids AS insight_ids
    FROM report_index ri JOIN report r ON r.id = ri.report_id
    WHERE ri.topic_id = ? AND ri.type IN ('brief','initial_digest') AND r.status = 'done' AND ri.date >= ?
    ORDER BY ri.date DESC, r.generated_at DESC, r.id DESC
  `).all(topicId, since) as Array<{ date: string; insight_ids: string }>;
  const byEvent = new Map<string, PublishedEventEvidence>();
  for (const report of reports) {
    const ids: string[] = JSON.parse(report.insight_ids);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    const insightRows = db.prepare(`
      SELECT id, event_id, statement, batch_id
      FROM insight WHERE id IN (${placeholders}) AND event_id IS NOT NULL
    `).all(...ids) as Array<{ id: string; event_id: string; statement: string; batch_id: string }>;
    for (const insight of insightRows) {
      if (byEvent.has(insight.event_id) || byEvent.size >= limit) continue;
      byEvent.set(insight.event_id, {
        event_id: insight.event_id, statement: insight.statement, date: report.date, content_item_ids: [],
      });
    }
    const rows = db.prepare(`
      SELECT i.event_id, c.content_item_id, cc.verdict, cc.consistency
      FROM insight i
      JOIN citation c ON c.insight_id = i.id
      JOIN citation_check cc ON cc.batch_id = i.batch_id AND cc.insight_id = c.insight_id AND cc.citation_index = c.citation_index
      WHERE i.id IN (${placeholders}) AND i.event_id IS NOT NULL
    `).all(...ids) as Array<{
      event_id: string; statement: string; content_item_id: string;
      verdict: "pass" | "blocked" | "flagged";
      consistency: "support" | "not_support" | "uncertain" | "not_evaluated";
    }>;
    for (const row of rows) {
      const event = byEvent.get(row.event_id);
      if (!event) continue;
      // 与发布白名单对齐：只有明确 support 的 pass 才是可作为新增判断的成功证据。
      if (row.verdict === "pass" && row.consistency === "support") {
        if (!event.content_item_ids.includes(row.content_item_id)) event.content_item_ids.push(row.content_item_id);
      }
    }
  }
  return [...byEvent.values()];
}

/** P1 不复报：查已发布事件清单，喂 analyzer 做 event 对齐 / followup 判定。 */
export interface RecentBriefEvent {
  event_id: string;
  statement: string;
  date: string;
}
export function listRecentBriefEvents(
  db: DB,
  topicId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): RecentBriefEvent[] {
  return listRecentPublishedEventEvidence(db, topicId, { ...opts, limit: opts.limit ?? 50 })
    .map(({ event_id, statement, date }) => ({ event_id, statement, date }));
}

/** FTS5 全文检索，按相关度返回 report_id。 */
export function searchReports(db: DB, query: string): string[] {
  const rows = db
    .prepare(`SELECT f.report_id FROM report_fts f
      JOIN report r ON r.id=f.report_id AND r.status='done'
      WHERE report_fts MATCH ? ORDER BY rank`)
    .all(query) as any[];
  return rows.map((x) => x.report_id as string);
}

/** snippet() 命中词的包裹标记——用控制字符（正文里不会出现），渲染端据此拆词加 <mark>，避免注入。 */
export const SNIPPET_OPEN = "\u0001";
export const SNIPPET_CLOSE = "\u0002";

/** 把用户原始查询消毒成「永不抛错、永不静默丢弃」的 FTS5 MATCH 表达式。
 *  - 按空白拆词，去掉词内双引号（防破坏短语语法）；
 *  - 每词包成 `"term"*`：双引号中和 FTS 操作符（裸 `-`/`*`/`:`/`(` 等不再报错），尾随 `*` 做前缀匹配；
 *    实测对中英文都成立，尤其无空格中文（`"软件工程"*` 命中，而精确短语 `"软件工程"` 不命中）；
 *  - 词间空格 = FTS5 隐式 AND（Google 式：全词都需命中）。
 *  - 全部被过滤（如纯空白/纯标点）→ 返回空串，调用方据此当作「无 q」处理（列全部，不报错）。 */
export function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

/** report_index 里某 JSON 数组列的去重值集合（升序）——报告库筛选下拉的选项来源。
 *  - column 是**代码内枚举**（非用户输入），白名单约束后才拼进 SQL，无注入面；
 *  - 经 json_each 展开数组、跳过空串；source_ids 返回的是**源 id**（展示名由调用方 join source 表映射）。 */
export function distinctIndexValues(
  db: DB,
  column: "source_ids" | "tags" | "entity_names",
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT je.value AS v
       FROM report_index ri JOIN report r ON r.id=ri.report_id AND r.status='done', json_each(ri.${column}) je
       WHERE je.value IS NOT NULL AND je.value <> ''
       ORDER BY je.value`,
    )
    .all() as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

/** 报告索引列表（报告库列表/筛选用），按日期倒序。 */
export function listReportIndex(db: DB, opts: { limit?: number } = {}): ReportIndexEntry[] {
  const rows = db
    .prepare("SELECT ri.* FROM report_index ri JOIN report r ON r.id=ri.report_id AND r.status='done' ORDER BY ri.date DESC LIMIT ?")
    .all(opts.limit ?? 100) as any[];
  return rows.map(rowToIndex);
}

/** 各主题的报告统计（条数 + 最新日期），一次 GROUP BY 拿全——主题列表页用，避免逐主题 N+1 查询。 */
export function topicReportStats(db: DB): Map<string, { count: number; latestDate: string }> {
  const rows = db
    .prepare(`SELECT ri.topic_id, COUNT(*) AS count, MAX(ri.date) AS latest
      FROM report_index ri JOIN report r ON r.id=ri.report_id AND r.status='done' GROUP BY ri.topic_id`)
    .all() as Array<{ topic_id: string; count: number; latest: string }>;
  const m = new Map<string, { count: number; latestDate: string }>();
  for (const r of rows) m.set(r.topic_id, { count: r.count, latestDate: r.latest });
  return m;
}

function rowToIndex(r: any): ReportIndexEntry {
  return {
    report_id: r.report_id, type: r.type, topic_id: r.topic_id,
    facets: parseFacets(r.facets), date: r.date,
    source_ids: JSON.parse(r.source_ids), title: r.title, summary: r.summary,
    highlights: JSON.parse(r.highlights ?? "[]"),
    tags: JSON.parse(r.tags), entity_names: JSON.parse(r.entity_names), importance: r.importance,
    event_ids: JSON.parse(r.event_ids), milestone_count: r.milestone_count ?? 0,
    freshest_candidate_at: r.freshest_candidate_at ?? null,
    freshest_citation_at: r.freshest_citation_at ?? null,
    freshness_lag_hours: r.freshness_lag_hours ?? null,
    snippet: r._snippet ?? undefined,
  };
}

/** 报告库查询：FTS5 + 筛选 + 排序。
 *  - q: 走 FTS5 → 取 report_id 集合再过滤；
 *  - type / domain / from / to (yyyy-mm-dd inclusive)：白名单 + 参数化 SQL；
 *  - topic / source / tag / entity / domain：参数化精确匹配（数组列经 json_each 展开做"含某值"）；
 *  - sort: "date"|"importance"，dir: "asc"|"desc"，默认 date desc——白名单查表映射常量列名；
 *  - 无效字段静默忽略走默认（UI 不应被 400 打断）。
 *  - ADR-0010 Step2b：分类筛选由 industry 等值迁为 domain 分面包含（facets 列 json_each）。
 *    ORDER BY 用 SORT_COLS 常量映射隔离任意字符串拼接面。 */
export interface ReportQuery {
  q?: string;
  type?: string;
  /** ADR-0010 Step2b：领域筛选（裸 domain 值，如 "software-engineering"）；匹配 facets 含 domain:<值>。 */
  domain?: string;
  /** ADR-0010 后续：视角筛选（裸 lens 值，如 "business"）；匹配 facets 含 lens:<值>。 */
  lens?: string;
  topic?: string;
  source?: string;
  tag?: string;
  entity?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  limit?: number;
}
const REPORT_TYPES = new Set(["brief", "deep_dive", "initial_digest"]);
const SORT_COLS = { date: "report_index.date", importance: "report_index.importance" } as const;
const SORT_DIRS = { asc: "ASC", desc: "DESC" } as const;
// snippet 取自 body 列（cols: 0 report_id,1 title,2 summary,3 body），命中词以控制字符标记包裹、首尾省略号。
const SNIPPET_EXPR = `snippet(report_fts, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 12)`;

export function queryReportIndex(db: DB, opts: ReportQuery = {}): ReportIndexEntry[] {
  // report_index 是发布时才写入的派生层；这一道 JOIN 仍是强制边界，兼容旧库中可能遗留的失败索引行。
  const where: string[] = ["EXISTS (SELECT 1 FROM report r WHERE r.id=report_index.report_id AND r.status='done')"];
  const args: unknown[] = [];

  if (opts.type && REPORT_TYPES.has(opts.type)) {
    where.push("report_index.type = ?"); args.push(opts.type);
  }
  // 领域筛选（Step2b）：白名单裸 domain 值 → facets 含 domain:<值>（json_each 展开数组列，参数化）。
  if (opts.domain && isDomainValue(opts.domain)) {
    where.push("EXISTS (SELECT 1 FROM json_each(report_index.facets) WHERE value = ?)");
    args.push(domainFacet(opts.domain));
  }
  // 视角筛选（ADR-0010 后续 lens 轴）：白名单裸 lens 值 → facets 含 lens:<值>（与 domain 同口径，可叠加）。
  if (opts.lens && isLensValue(opts.lens)) {
    where.push("EXISTS (SELECT 1 FROM json_each(report_index.facets) WHERE value = ?)");
    args.push(lensFacet(opts.lens));
  }
  // topic_id 是自由字符串（topic 主键），无固定白名单可校验——靠参数化（topic_id = ?）杜绝注入。
  if (opts.topic && opts.topic.trim()) {
    where.push("report_index.topic_id = ?"); args.push(opts.topic.trim());
  }
  // source / tag / entity 命中存于 JSON 数组列（source_ids/tags/entity_names）——用 json_each 相关子查询
  // 做"数组含某值"的精确匹配（exact，非 LIKE 模糊），值参数化杜绝注入。下拉选项来自 distinctIndexValues。
  if (opts.source && opts.source.trim()) {
    where.push("EXISTS (SELECT 1 FROM json_each(report_index.source_ids) WHERE value = ?)");
    args.push(opts.source.trim());
  }
  if (opts.tag && opts.tag.trim()) {
    where.push("EXISTS (SELECT 1 FROM json_each(report_index.tags) WHERE value = ?)");
    args.push(opts.tag.trim());
  }
  if (opts.entity && opts.entity.trim()) {
    where.push("EXISTS (SELECT 1 FROM json_each(report_index.entity_names) WHERE value = ?)");
    args.push(opts.entity.trim());
  }
  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    where.push("report_index.date >= ?"); args.push(opts.from);
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    where.push("report_index.date <= ?"); args.push(opts.to);
  }

  // 全文检索：消毒成永不抛错的 MATCH 表达式（空串 = 视作无 q）。命中时 JOIN report_fts 以取 bm25 排序 + snippet。
  const match = opts.q && opts.q.trim() ? sanitizeFtsQuery(opts.q) : "";
  const useFts = match.length > 0;

  // 列名/方向走"输入键 → 常量值"映射（不是字符串校验后拼接），完全消除 ORDER BY 拼接面。
  // 相关度排序仅在有 q 时有效：显式选 relevance 或「有 q 且未指定 sort」→ 按 bm25（负值，越小越相关）升序。
  const wantRelevance = opts.sort === "relevance" || (useFts && !opts.sort);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  let orderBy: string;
  if (wantRelevance && useFts) {
    orderBy = "bm25(report_fts) ASC";
  } else {
    const sortCol = SORT_COLS[(opts.sort ?? "date") as keyof typeof SORT_COLS] ?? "report_index.date";
    const dir = SORT_DIRS[(opts.dir ?? "desc") as keyof typeof SORT_DIRS] ?? "DESC";
    orderBy = `${sortCol} ${dir}${sortCol.endsWith("importance") ? ", report_index.date DESC" : ""}`;
  }

  if (useFts) {
    // MATCH 必须是 WHERE 第一个条件 → match 参数排在筛选参数之前
    const sql = `SELECT report_index.*, ${SNIPPET_EXPR} AS _snippet
      FROM report_index JOIN report_fts ON report_fts.report_id = report_index.report_id
      WHERE report_fts MATCH ?${where.length ? ` AND ${where.join(" AND ")}` : ""}
      ORDER BY ${orderBy} LIMIT ${limit}`;
    return (db.prepare(sql).all(match, ...args) as any[]).map(rowToIndex);
  }
  const sql = `SELECT report_index.* FROM report_index${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY ${orderBy} LIMIT ${limit}`;
  return (db.prepare(sql).all(...args) as any[]).map(rowToIndex);
}

// ——— 主题持续聚合（ADR-0005）：确定性视图聚合，纯函数、零 LLM、零成本 ———
// 数据源为报告级 report_index 行；调用方传入已查到的报告序列（如 queryReportIndex 结果），本层不再查库。

/** 主题演化时间线的一个时间点（ADR-0005 ①）：某报告的焦点快照。
 *  焦点取该报告 tags/entity_names 前 N——report_index 数组前缀≈高重要性洞察（ADR-0005 选项 3）。 */
export interface EvolutionPoint {
  date: string;
  report_id: string;
  type: ReportIndexEntry["type"];
  title: string;
  importance: number;
  major: boolean; // importance >= 4
  focus_tags: string[];
  focus_entities: string[];
}

/** 按日期升序比较器（演化从过去到现在）；同日保持入参原序（V8 稳定排序）。 */
const byDateAsc = (a: ReportIndexEntry, b: ReportIndexEntry): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/** 把主题报告序列折成「焦点演化」时间点（日期升序）。纯函数、确定性，不查库。
 *  **只保留有焦点的点**：tags/entities 皆空的报告（如标签/实体抽取激活前生成的老报告）对「演化」无意义，
 *  在此过滤——故调用方按返回长度判降级（有焦点点 <3 时整体隐藏，ADR-0005 选项 5）。 */
export function topicEvolution(reports: ReportIndexEntry[], focusN = 3): EvolutionPoint[] {
  return [...reports]
    .sort(byDateAsc)
    .map((r) => ({
      date: r.date,
      report_id: r.report_id,
      type: r.type,
      title: r.title,
      importance: r.importance,
      major: r.importance >= 4,
      focus_tags: r.tags.slice(0, focusN),
      focus_entities: r.entity_names.slice(0, focusN),
    }))
    .filter((p) => p.focus_tags.length > 0 || p.focus_entities.length > 0);
}

export type Trend = "up" | "down" | "flat";

/** 实体热度趋势（ADR-0005 ②）。total = 出现的**报告覆盖数**（非提及次数，受报告级粒度所限）。 */
export interface EntityTrend {
  name: string;
  total: number;
  buckets: number[]; // 按报告时间序位等分桶的出现计数，供 sparkline
  trend: Trend;
}

/** 跨报告聚合实体热度趋势：时间序位分桶画 sparkline + 前后半比较判趋势。纯函数、确定性。
 *  返回按 total 降序的 Top `limit`（对齐主题页关键实体口径）。
 *  - buckets：报告按日期升序后等分 N=min(8, 报告数) 桶（rank-based，规避稀疏期空桶/离群日期）；
 *  - trend：后半段出现数 vs 前半段；total<2 → flat（少样本防抖，ADR-0005 选项 4）。 */
export function entityTrends(reports: ReportIndexEntry[], limit = 15): EntityTrend[] {
  const sorted = [...reports].sort(byDateAsc);
  const len = sorted.length;
  if (len === 0) return [];
  const bucketCount = Math.min(8, len);
  const mid = Math.floor(len / 2);

  const acc = new Map<string, { buckets: number[]; first: number; second: number; total: number }>();
  sorted.forEach((r, i) => {
    const bIdx = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / len));
    const seen = new Set<string>(); // entity_names 本已去重，防御脏数据重复计数
    for (const raw of r.entity_names) {
      const name = raw.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      let e = acc.get(name);
      if (!e) {
        e = { buckets: new Array(bucketCount).fill(0), first: 0, second: 0, total: 0 };
        acc.set(name, e);
      }
      e.buckets[bIdx] += 1;
      e.total += 1;
      if (i < mid) e.first += 1;
      else e.second += 1;
    }
  });

  const out: EntityTrend[] = [];
  for (const [name, e] of acc) {
    let trend: Trend = "flat";
    if (e.total >= 2) {
      if (e.second > e.first) trend = "up";
      else if (e.second < e.first) trend = "down";
    }
    out.push({ name, total: e.total, buckets: e.buckets, trend });
  }
  // total 降序；同频保持 Map 迭代序（≈首次出现序）稳定
  return out.sort((a, b) => b.total - a.total).slice(0, limit);
}
