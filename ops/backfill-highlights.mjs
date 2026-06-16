/** 一次性脚本：给 headline 方案上线前生成的历史报告回填 report_index.highlights（+ insight.headline）。
 *
 *  背景：headline 方案让 analyzer 为每条洞察产出一句话 headline，列表卡片改渲染要点列表（highlights）。
 *  但已落库的旧报告 highlights='[]'、旧洞察 headline=''——前端虽会回退到 summary（拼接长串），
 *  仍是"一面墙"。本脚本把旧卡片也变成可扫读的要点列表，无需重跑整条 LLM 管线。
 *
 *  为什么确定性（不调 LLM）：生产容器是 Next standalone 构建，**不含 tsx / 源码 / agents 代码**，
 *  跑不了复用 callStructured 的回填；且 ops 全部 .mjs 脚本都在容器内 `docker compose exec app node` 跑。
 *  故这里从已存的 statement 做"句首/子句 + 截断"的确定性浓缩——质量略逊真 LLM headline，但零成本、
 *  零 API 暴露、可在容器内直接跑。**新报告仍由 analyzer 产出真正的 LLM headline**，本脚本只管历史。
 *
 *  做什么（与 report-gen.buildReport 的 highlights 口径一致）：
 *  - 取 report.insight_ids（= 已纳入校验的洞察）→ 查 insight 拿 statement/importance/headline；
 *  - headline 为空的洞察：把 statement 浓缩成 ≤HEADLINE_MAX 字的一句话，写回 insight.headline；
 *  - 按 importance 降序取前 HIGHLIGHTS_MAX 条 headline，写 report_index.highlights。
 *
 *  幂等：highlights 已非空（'[]' 以外）的报告跳过；insight.headline 已非空的洞察不覆盖。
 *  安全：默认 **dry-run**（只打印将改什么，不写库）；加 `--apply` 才真正落库。
 *
 *  用法：
 *    本地预览：  DB_PATH=.data/insight.db node ops/backfill-highlights.mjs
 *    本地落库：  DB_PATH=.data/insight.db node ops/backfill-highlights.mjs --apply
 *    容器内：    docker compose exec -T app node /app/ops/backfill-highlights.mjs --apply
 */
import Database from "better-sqlite3";

// report-gen.ts 同名常量的对齐口径（改那边记得同步）
const HIGHLIGHTS_MAX = 5;
const HEADLINE_MAX = 40; // 一句话要点上限（CJK 按字计）

const APPLY = process.argv.includes("--apply");
const dbPath = process.env.DB_PATH || "/data/insight.db";

/** 把完整 statement 浓缩成一句话要点（≤HEADLINE_MAX 字）。确定性、无 LLM：
 *  1. 去首尾空白 + 去结尾句末标点（headline 不需要句号）；
 *  2. 不超长 → 原样返回；
 *  3. 超长 → 优先在 [MIN, MAX] 区间内的句末/分句标点处断（。．！？；;），
 *     退而求其次在子句标点处断（，、,），都没有则硬截，统一补"…"。 */
// 句末标点全集——结尾剥离与"句末断点"搜索共用同一集合，避免两处漏字符不一致（如 ASCII . ! 被漏判）。
const SENT_END = ["。", "．", "！", "？", ".", "!", "?", "；", ";"];
export function toHeadline(statement, max = HEADLINE_MAX) {
  const stripped = statement.trim().replace(new RegExp(`[${SENT_END.join("")}]+$`, "u"), "");
  const chars = Array.from(stripped);
  if (chars.length <= max) return chars.join("");
  const MIN = Math.floor(max * 0.5);
  const head = chars.slice(0, max);
  const text = head.join("");
  const sentenceBreak = Math.max(...SENT_END.map((p) => text.lastIndexOf(p)));
  const clauseBreak = Math.max(...["，", "、", ","].map((p) => text.lastIndexOf(p)));
  const spaceBreak = text.lastIndexOf(" "); // 英文/混排词边界，避免硬切在词中间（如 "针对 L…"）
  const cut =
    sentenceBreak >= MIN ? sentenceBreak
    : clauseBreak >= MIN ? clauseBreak
    : spaceBreak >= MIN ? spaceBreak
    : -1;
  return (cut > 0 ? text.slice(0, cut) : text).trimEnd() + "…";
}

/** 幂等补列（与 db/index.ts migrate 同款）：脚本可能在 app 重启迁移**之前**跑，
 *  raw better-sqlite3 不会触发应用层 migrate，故自带列存在性保障，独立可跑。 */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function main() {
  const db = new Database(dbPath, { readonly: false });
  ensureColumn(db, "insight", "headline", "headline TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "report_index", "highlights", "highlights TEXT NOT NULL DEFAULT '[]'");
  // 旧报告：highlights 缺省（'[]' / NULL）。已有要点的（手动 / 新管线）跳过，保证幂等。
  const reports = db
    .prepare(
      `SELECT ri.report_id AS report_id, ri.highlights AS highlights, r.insight_ids AS insight_ids
       FROM report_index ri JOIN report r ON r.id = ri.report_id
       WHERE ri.highlights IS NULL OR ri.highlights = '[]' OR ri.highlights = ''
       ORDER BY ri.date DESC`,
    )
    .all();

  const getIns = db.prepare("SELECT id, statement, importance, headline FROM insight WHERE id = ?");
  const setHeadline = db.prepare("UPDATE insight SET headline = ? WHERE id = ?");
  const setHighlights = db.prepare("UPDATE report_index SET highlights = ? WHERE report_id = ?");

  let changed = 0, skippedNoIns = 0, headlinesFilled = 0;
  const apply = db.transaction(() => {
    for (const r of reports) {
      let ids;
      try {
        ids = JSON.parse(r.insight_ids ?? "[]");
      } catch {
        ids = [];
      }
      const rows = ids.map((id) => getIns.get(id)).filter(Boolean);
      if (!rows.length) {
        skippedNoIns += 1; // 报告无可查洞察（数据缺失）——不造空 highlights，跳过
        continue;
      }
      // headline 缺失的洞察：确定性浓缩 statement 并写回（不覆盖已有 headline）
      for (const row of rows) {
        if (!row.headline || !row.headline.trim()) {
          row.headline = toHeadline(row.statement);
          if (APPLY) setHeadline.run(row.headline, row.id);
          headlinesFilled += 1;
        }
      }
      // 与 buildReport 一致：按 importance 降序取前 N 条 headline
      const highlights = [...rows]
        .sort((a, b) => b.importance - a.importance)
        .slice(0, HIGHLIGHTS_MAX)
        .map((row) => (row.headline?.trim() ? row.headline.trim() : row.statement));
      if (APPLY) setHighlights.run(JSON.stringify(highlights), r.report_id);
      changed += 1;
      console.log(`  ${APPLY ? "✓" : "·"} ${r.report_id} → ${highlights.length} 条要点`);
      for (const h of highlights) console.log(`      • ${h}`);
    }
  });
  apply();

  console.log(`\n${APPLY ? "完成（已落库）" : "DRY-RUN（未写库，加 --apply 落库）"}：`);
  console.log(`  待回填报告：${reports.length} · 回填 ${changed} · 无洞察跳过 ${skippedNoIns}`);
  console.log(`  填充洞察 headline：${headlinesFilled} 条`);
  db.close();
}

// 作为脚本直接运行时执行 main；被 import（单测 toHeadline）时不跑。
if (import.meta.url === `file://${process.argv[1]}`) main();
