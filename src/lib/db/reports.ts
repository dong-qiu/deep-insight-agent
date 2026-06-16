/** 报告持久化：正文（.md/.html）落 FS，元数据 + 索引 + FTS5 落 SQLite。增量5。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Industry, Report, ReportIndexEntry } from "../types.js";
import type { DB } from "./index.js";
import { INDUSTRY_VALUES } from "./validate.js";

const j = (v: unknown): string => JSON.stringify(v);

function defaultBodyDir(): string {
  return join(process.env.DATA_DIR ?? ".data", "reports");
}

/** 写正文到 FS + 落 report / report_index / report_fts。dir 可注入（测试用临时目录）。
 *  body_path **始终写绝对路径**——dogfood 2026-06-06 发现"相对路径在跨环境（本地 dev →
 *  容器，cwd 不同）时失效"是 5/31 practice-log "worktree 相对 DB 路径陷阱"的同根复发。
 *  resolve() 把任何相对 path 锚到当时 cwd 取绝对，存进 DB 后跨环境也能直接 readFile。 */
export function saveReport(
  db: DB,
  report: Report,
  index: ReportIndexEntry,
  opts: { dir?: string } = {},
): void {
  const dir = opts.dir ?? defaultBodyDir();
  mkdirSync(dir, { recursive: true });
  const prefix = resolve(join(dir, report.id));
  writeFileSync(`${prefix}.md`, report.body_md);
  writeFileSync(`${prefix}.html`, report.body_html);

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO report (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
         VALUES (@id,@type,@topic_id,@status,@generated_at,@title,@body_path,@insight_ids,@event_ids,@prev_report_id,@citation_count,@cost)`,
      ).run({
        id: report.id, type: report.type, topic_id: report.topic_id, status: report.status,
        generated_at: report.generated_at, title: report.title, body_path: prefix,
        insight_ids: j(report.insight_ids), event_ids: j(report.event_ids),
        prev_report_id: report.prev_report_id, citation_count: report.citation_count, cost: j(report.cost),
      });
      db.prepare(
        `INSERT INTO report_index (report_id,type,topic_id,industry,date,source_ids,title,summary,tags,entity_names,importance,event_ids,milestone_count)
         VALUES (@report_id,@type,@topic_id,@industry,@date,@source_ids,@title,@summary,@tags,@entity_names,@importance,@event_ids,@milestone_count)`,
      ).run({
        report_id: index.report_id, type: index.type, topic_id: index.topic_id, industry: index.industry,
        date: index.date, source_ids: j(index.source_ids), title: index.title, summary: index.summary,
        tags: j(index.tags), entity_names: j(index.entity_names), importance: index.importance,
        event_ids: j(index.event_ids), milestone_count: index.milestone_count,
      });
      db.prepare(`INSERT INTO report_fts (report_id,title,summary,body) VALUES (?,?,?,?)`).run(
        report.id, index.title, index.summary, report.body_md,
      );
    })();
  } catch (e) {
    // 落库失败：清理已写出的 FS 正文，避免 DB 无行但磁盘有孤儿文件
    for (const ext of [".md", ".html"]) rmSync(`${prefix}${ext}`, { force: true });
    throw e;
  }
}

export function getReport(db: DB, id: string): Report | null {
  const r = db.prepare("SELECT * FROM report WHERE id = ?").get(id) as any;
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
  return !!db.prepare("SELECT 1 FROM report WHERE topic_id = ? LIMIT 1").get(topicId);
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
    WHERE r.id = ? AND cc.verdict = 'blocked'
    ORDER BY i.id, cc.citation_index
  `).all(reportId) as Omit<BlockedCheck, "reason">[];
  return rows.map((r) => ({
    ...r,
    reason: r.reachability === "fail" ? r.reachability_reason : r.consistency_reason,
  }));
}

/** P1 不复报（2026-06-06）：查某主题近 sinceDays 天 brief 报告里的 event_id + statement，喂 analyzer
 *  作为"已报告事件"清单做事件对齐 / followup 判定。
 *  - 只取 brief（每日节奏，followup 主要发生在同节奏跨日；deep_dive 是用户触发的回顾，加进去会污染）；
 *  - 走 report_index 取 date（避免 report.generated_at 时区差），用 insight_ids 反查 insight 表拿 event_id；
 *  - 去重：同 event_id 只留最新 statement（取最新的 brief 那条，避免清单膨胀）；
 *  - 上限保护：硬上限 50 条，防超长清单挤压 analyzer 上下文。 */
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
  const sinceDays = opts.sinceDays ?? 14;
  const limit = Math.min(opts.limit ?? 50, 200);
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  // 报告日期降序 → 同 event_id 保留最新；只取 brief。
  const rows = db
    .prepare(`
      SELECT ri.date AS date, r.insight_ids AS insight_ids
      FROM report_index ri
      JOIN report r ON r.id = ri.report_id
      WHERE ri.topic_id = ? AND ri.type = 'brief' AND ri.date >= ?
      ORDER BY ri.date DESC
    `)
    .all(topicId, since) as Array<{ date: string; insight_ids: string }>;
  const seen = new Set<string>();
  const out: RecentBriefEvent[] = [];
  for (const r of rows) {
    const ids: string[] = JSON.parse(r.insight_ids);
    if (!ids.length) continue;
    // 联表 insight 拿 event_id + statement（按 ids 的顺序，IN 子句的参数注入需逐条 prepare 或拼接 ?）
    const placeholders = ids.map(() => "?").join(",");
    const insRows = db
      .prepare(`SELECT event_id, statement FROM insight WHERE id IN (${placeholders}) AND event_id IS NOT NULL`)
      .all(...ids) as Array<{ event_id: string; statement: string }>;
    for (const ir of insRows) {
      if (seen.has(ir.event_id)) continue;
      seen.add(ir.event_id);
      out.push({ event_id: ir.event_id, statement: ir.statement, date: r.date });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** FTS5 全文检索，按相关度返回 report_id。 */
export function searchReports(db: DB, query: string): string[] {
  const rows = db
    .prepare("SELECT report_id FROM report_fts WHERE report_fts MATCH ? ORDER BY rank")
    .all(query) as any[];
  return rows.map((x) => x.report_id as string);
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
       FROM report_index ri, json_each(ri.${column}) je
       WHERE je.value IS NOT NULL AND je.value <> ''
       ORDER BY je.value`,
    )
    .all() as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

/** 报告索引列表（报告库列表/筛选用），按日期倒序。 */
export function listReportIndex(db: DB, opts: { limit?: number } = {}): ReportIndexEntry[] {
  const rows = db
    .prepare("SELECT * FROM report_index ORDER BY date DESC LIMIT ?")
    .all(opts.limit ?? 100) as any[];
  return rows.map(rowToIndex);
}

/** 各主题的报告统计（条数 + 最新日期），一次 GROUP BY 拿全——主题列表页用，避免逐主题 N+1 查询。 */
export function topicReportStats(db: DB): Map<string, { count: number; latestDate: string }> {
  const rows = db
    .prepare("SELECT topic_id, COUNT(*) AS count, MAX(date) AS latest FROM report_index GROUP BY topic_id")
    .all() as Array<{ topic_id: string; count: number; latest: string }>;
  const m = new Map<string, { count: number; latestDate: string }>();
  for (const r of rows) m.set(r.topic_id, { count: r.count, latestDate: r.latest });
  return m;
}

function rowToIndex(r: any): ReportIndexEntry {
  return {
    report_id: r.report_id, type: r.type, topic_id: r.topic_id, industry: r.industry, date: r.date,
    source_ids: JSON.parse(r.source_ids), title: r.title, summary: r.summary,
    tags: JSON.parse(r.tags), entity_names: JSON.parse(r.entity_names), importance: r.importance,
    event_ids: JSON.parse(r.event_ids), milestone_count: r.milestone_count ?? 0,
  };
}

/** 报告库查询：FTS5 + 筛选 + 排序。
 *  - q: 走 FTS5 → 取 report_id 集合再过滤；
 *  - type / industry / from / to (yyyy-mm-dd inclusive)：白名单 + 参数化 SQL；
 *  - topic / source / tag / entity：参数化精确匹配（source/tag/entity 经 json_each 展开数组列）；
 *  - sort: "date"|"importance"，dir: "asc"|"desc"，默认 date desc——白名单查表映射常量列名；
 *  - 无效字段静默忽略走默认（UI 不应被 400 打断）。
 *  - Sonnet R1 review (2026-06-06)：industry 白名单与 validateSourceInput 复用；
 *    ORDER BY 用 SORT_COLS 常量映射隔离任意字符串拼接面。 */
export interface ReportQuery {
  q?: string;
  type?: string;
  industry?: string;
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
const SORT_COLS = { date: "date", importance: "importance" } as const;
const SORT_DIRS = { asc: "ASC", desc: "DESC" } as const;

export function queryReportIndex(db: DB, opts: ReportQuery = {}): ReportIndexEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (opts.type && REPORT_TYPES.has(opts.type)) {
    where.push("type = ?"); args.push(opts.type);
  }
  if (opts.industry && INDUSTRY_VALUES.has(opts.industry as Industry)) {
    where.push("industry = ?"); args.push(opts.industry);
  }
  // topic_id 是自由字符串（topic 主键），无固定白名单可校验——靠参数化（topic_id = ?）杜绝注入。
  if (opts.topic && opts.topic.trim()) {
    where.push("topic_id = ?"); args.push(opts.topic.trim());
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
    where.push("date >= ?"); args.push(opts.from);
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    where.push("date <= ?"); args.push(opts.to);
  }
  if (opts.q && opts.q.trim()) {
    where.push("report_id IN (SELECT report_id FROM report_fts WHERE report_fts MATCH ?)");
    args.push(opts.q.trim());
  }

  // 列名/方向走"输入键 → 常量值"映射（不是字符串校验后拼接），完全消除 ORDER BY 拼接面
  const sortCol = SORT_COLS[(opts.sort ?? "date") as keyof typeof SORT_COLS] ?? "date";
  const dir = SORT_DIRS[(opts.dir ?? "desc") as keyof typeof SORT_DIRS] ?? "DESC";
  const tiebreak = sortCol === "importance" ? ", date DESC" : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const sql = `SELECT * FROM report_index ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY ${sortCol} ${dir}${tiebreak} LIMIT ${limit}`;
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
