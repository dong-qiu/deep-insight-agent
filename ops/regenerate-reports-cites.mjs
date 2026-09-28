/** 历史报告格式差异预览：不得原地改写已发布 artifact。
 *
 *  两件事：
 *  1. [N] 行内引用标记（C-2 commit 61b04da 加的）
 *  2. quote 包成 markdown 链接 [「quote」](url) + 源名替代 ci_xxx 显示（dogfood feedback）
 *
 *  报告 markdown 是 FS 落盘——已生成的不会动态重渲染。本脚本仅预览：
 *  - Pass 1（[N] 注入）：解析 heading + `- 引用（M）：` + M 条 `  - 「quote」— \`ci\`` 列表项，
 *    全局连续 [k] 注入 heading 末尾 + 列表项前缀；
 *  - Pass 2（quote 链接 + 源名）：从 DB 查 ci_id → {source_name, url, published_at}，
 *    把 `「quote」— \`ci_xxx\`` 改成 `[「quote」](url) — 源名 · YYYY-MM-DD`。
 *
 *  幂等：Pass 1 检测到 `  - [N] ` 跳过；Pass 2 检测到 `](http` 跳过。
 *
 *  用法：DB_PATH=/path/to/standalone-snapshot.db node ops/regenerate-reports-cites.mjs [--report-id rep_xxx]
 *  --apply 始终拒绝：直接改 .md 会绕过 report_index/FTS/generation_effect/完整性锚。 */
import { readFileSync } from "node:fs";
import { openReadonlyReportSnapshot } from "./readonly-report-snapshot.mjs";

const args = process.argv.slice(2);
if (args.includes("--apply")) {
  console.error("拒绝 --apply：已发布报告不可原地改写；请通过正式报告重生成流程创建新 Report/Trace。");
  process.exit(2);
}
let reportId;
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--report-id" || reportId !== undefined || i + 1 >= args.length) {
    console.error("用法：regenerate-reports-cites.mjs [--report-id rep_xxx]（仅预览）");
    process.exit(2);
  }
  reportId = args[++i];
  if (!/^rep_[a-z0-9]+$/.test(reportId)) {
    console.error("报告 ID 格式无效；仅接受 rep_ 后跟小写字母或数字。");
    process.exit(2);
  }
}
const db = openReadonlyReportSnapshot(process.env.DB_PATH);

/** Pass 1：注入 [N] 行内 + 列表项前缀。返回 { md, changed }。幂等。 */
function injectCiteNumbers(md) {
  if (/^  - \[\d+\] /m.test(md)) return { md, changed: false }; // 已注入
  const lines = md.split("\n");
  const insights = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{2,3} \d+\. /.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
      const m = lines[j].match(/^- 引用（(\d+)）：$/);
      if (m) {
        const count = parseInt(m[1], 10);
        if (count > 0) insights.push({ headingIdx: i, count, listStartIdx: j + 1 });
        break;
      }
      if (/^#{2,3} \d+\. /.test(lines[j])) break;
    }
  }
  if (insights.length === 0) return { md, changed: false };

  let cite = 1;
  for (const ins of insights) {
    const refs = Array.from({ length: ins.count }, (_, k) => `[${cite + k}]`).join("");
    const head = lines[ins.headingIdx];
    const flaggedIdx = head.lastIndexOf("〔待核实〕");
    if (flaggedIdx > 0) {
      lines[ins.headingIdx] = head.slice(0, flaggedIdx).trimEnd() + " " + refs + " " + head.slice(flaggedIdx);
    } else {
      lines[ins.headingIdx] = head + " " + refs;
    }
    for (let k = 0; k < ins.count; k++) {
      const idx = ins.listStartIdx + k;
      if (idx >= lines.length) break;
      const cm = lines[idx].match(/^(  - )(.+)$/);
      if (cm) lines[idx] = cm[1] + `[${cite + k}] ` + cm[2];
    }
    cite += ins.count;
  }
  return { md: lines.join("\n"), changed: true };
}

/** Pass 2：用 DB 查 content_item + source，把 ci_xxx 替换为可读源名 + URL 链接。
 *  原行：`  - [N] 「quote」— \`ci_xxx\``
 *  新行：`  - [N] [「quote」](url) — 源名 · YYYY-MM-DD`
 *  幂等：已含 `](http` 跳过。 */
function enrichCitations(md) {
  if (/\]\(http/.test(md)) return { md, changed: false, missed: 0 }; // 已 enrich

  const ciRegex = /`(ci_[a-z0-9]+)`/g;
  const ciIds = new Set();
  let m;
  while ((m = ciRegex.exec(md)) !== null) ciIds.add(m[1]);
  if (ciIds.size === 0) return { md, changed: false, missed: 0 };

  // 批量查
  const lookup = new Map();
  let missed = 0;
  for (const ciId of ciIds) {
    const row = db.prepare(`
      SELECT ci.url, ci.published_at, s.name AS source_name
      FROM content_item ci LEFT JOIN source s ON s.id = ci.source_id
      WHERE ci.id = ?
    `).get(ciId);
    if (row && row.url) {
      lookup.set(ciId, {
        url: row.url,
        source_name: row.source_name || ciId,
        date: row.published_at ? row.published_at.slice(0, 10) : null,
      });
    } else {
      missed++;
    }
  }

  // 把 `  - [N] 「quote」— \`ci_xxx\`` 替换成富格式
  const newMd = md.replace(
    /^(  - \[\d+\] )「(.+?)」— `(ci_[a-z0-9]+)`$/gm,
    (_full, prefix, quote, ciId) => {
      const info = lookup.get(ciId);
      if (!info) return _full; // 查不到保持原样
      const datePart = info.date ? ` · ${info.date}` : "";
      return `${prefix}[「${quote}」](${info.url}) — ${info.source_name}${datePart}`;
    },
  );

  return { md: newMd, changed: newMd !== md, missed };
}

/** Pass 3：把引用行的日期统一成 YYYY-MM-DD 格式（dogfood feedback v2）。
 *  - 旧报告里可能是 "Tue, 02 Ju" 这种截断垃圾、或 ISO、或缺失；
 *  - 现在 published_at 已全归一化 ISO 8601，从 URL 反查 DB 拿真发布日，重写一致；
 *  - 没有 published_at 的源（部分 API）→ 删掉旧的乱日期段、不补新。
 *  幂等：YYYY-MM-DD 形式且与 DB 一致时不动。 */
function reformatCitationDates(md) {
  // 匹配：`  - [N] [「quote」](url) — Source[ · 任意旧日期]` 行末
  const re = /^(  - \[\d+\] \[[^\]]+\]\(([^)]+)\) — )([^\n·]+?)(?:\s*·\s*[^\n]+)?$/gm;
  let changed = false;
  const newMd = md.replace(re, (full, prefix, url, sourceLabel) => {
    const row = db.prepare("SELECT published_at FROM content_item WHERE url = ?").get(url);
    const iso = row?.published_at;
    const dateIso = iso && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null;
    const datePart = dateIso ? ` · ${dateIso}` : "";
    const next = `${prefix}${sourceLabel.trim()}${datePart}`;
    if (next !== full) changed = true;
    return next;
  });
  return { md: newMd, changed };
}

/** Pass 4：清掉源名内的 " 最新" 后缀（dogfood feedback：defaults.yaml 源名 papermark）。
 *  仅在引用行的源名段（` — 源名` 至行末）做替换，避免误吃 quote 内容里的"最新"。 */
function stripSourceLatestSuffix(md) {
  const re = /^(  - \[\d+\] [^\n]+? — [^\n]*?) 最新(\s*)$/gm;
  const newMd = md.replace(re, "$1$2");
  return { md: newMd, changed: newMd !== md };
}

try {
  const reports = reportId
    ? db.prepare("SELECT id, body_path FROM report WHERE id = ?").all(reportId)
    : db.prepare("SELECT id, body_path FROM report ORDER BY generated_at DESC").all();
  if (reportId && reports.length === 0) throw new Error(`未找到报告 ${reportId}`);
  console.log(`只读预览：扫描 ${reports.length} 份报告…\n`);

  const stats = { p1Done: 0, p1Skip: 0, p2Done: 0, p2Skip: 0, p3Done: 0, p3Skip: 0, p4Done: 0, p4Skip: 0, missedTotal: 0, fileMiss: 0 };
  for (const r of reports) {
    const mdPath = `${r.body_path}.md`;
    let md;
    try {
      md = readFileSync(mdPath, "utf8");
    } catch {
      console.log(`  ⚠ ${r.id} 跳过：FS 正文缺失`);
      stats.fileMiss++;
      continue;
    }
    const p1 = injectCiteNumbers(md);
    if (p1.changed) stats.p1Done++; else stats.p1Skip++;
    const p2 = enrichCitations(p1.md);
    if (p2.changed) stats.p2Done++; else stats.p2Skip++;
    stats.missedTotal += p2.missed;
    const p3 = reformatCitationDates(p2.md);
    if (p3.changed) stats.p3Done++; else stats.p3Skip++;
    const p4 = stripSourceLatestSuffix(p3.md);
    if (p4.changed) stats.p4Done++; else stats.p4Skip++;

    if (p4.md !== md) {
      const parts = [];
      if (p1.changed) parts.push("注入 [N]");
      if (p2.changed) parts.push("富化引用");
      if (p3.changed) parts.push("日期 → YYYY-MM-DD");
      if (p4.changed) parts.push("去'最新'");
      console.log(`  ◇ ${r.id} · 待变更：${parts.join(" + ")}${p2.missed > 0 ? ` · ${p2.missed} 条 ci 查不到` : ""}`);
    } else {
      console.log(`  · ${r.id} 跳过（已是最新格式 / 无引用）`);
    }
  }

  console.log(`\n预览完成，未写入正文或数据库：`);
  console.log(`  Pass 1 [N] 注入：${stats.p1Done} 改 / ${stats.p1Skip} 跳`);
  console.log(`  Pass 2 富化：${stats.p2Done} 改 / ${stats.p2Skip} 跳`);
  console.log(`  Pass 3 日期 → YYYY-MM-DD：${stats.p3Done} 改 / ${stats.p3Skip} 跳`);
  console.log(`  Pass 4 去'最新'后缀：${stats.p4Done} 改 / ${stats.p4Skip} 跳`);
  console.log(`  累计查不到 ci 的引用：${stats.missedTotal}`);
  console.log(`  FS 文件缺失：${stats.fileMiss}`);
} finally {
  db.close();
}
