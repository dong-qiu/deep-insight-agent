/** 一次性脚本：把 C-2 commit (61b04da) 之前生成的报告 body_md 回填 [N] 行内引用标记。
 *
 *  C-2 实现了"全局连续 [N] inline + 列表项 [N] 前缀 + 锚链接"，但报告 markdown 是
 *  FS 落盘文件——已生成的报告不会动态重渲染。本脚本解析现有 markdown 结构：
 *    - 找每条 `## N. <statement>` 或 `### N. <statement>` heading；
 *    - 找其后的 `- 引用（M）：` + 紧跟 M 条 `  - 「quote」— \`ci\`` 列表项；
 *    - 全局连续编号：heading 末尾追加 `[k][k+1]...`、列表项前缀 `[k] `；
 *    - 〔待核实〕标记保持在末尾。
 *  幂等：检测到任意 `  - [N] ` 列表项即跳过（防重复注入）。
 *
 *  用法（容器内）：
 *    docker compose exec -T app node /app/ops/regenerate-reports-cites.mjs
 *  本地：
 *    DB_PATH=.data/insight.db REPORTS_DIR=.data/reports node ops/regenerate-reports-cites.mjs */
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

/** 把单个报告的 markdown body 转成带 [N] 标记的新版本；幂等。 */
function regenerateMarkdown(md) {
  // 幂等检查：列表项已有 [N] 前缀 → 跳过
  if (/^  - \[\d+\] /m.test(md)) return { md, changed: false, injected: 0, reason: "already has [N]" };

  const lines = md.split("\n");
  // Pass 1：找所有 insight 块的 heading + citation list 范围
  /** @type {Array<{headingIdx: number; count: number; listStartIdx: number}>} */
  const insights = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{2,3} \d+\. /.test(lines[i])) continue;
    // heading 后 15 行内找 `- 引用（M）：`
    for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
      const m = lines[j].match(/^- 引用（(\d+)）：$/);
      if (m) {
        const count = parseInt(m[1], 10);
        if (count > 0) insights.push({ headingIdx: i, count, listStartIdx: j + 1 });
        break;
      }
      // 遇到下一条 heading 就停（防止跨 insight 错配）
      if (/^#{2,3} \d+\. /.test(lines[j])) break;
    }
  }
  if (insights.length === 0) return { md, changed: false, injected: 0, reason: "no citation blocks" };

  // Pass 2：全局连续编号，改写 heading 与列表项
  let cite = 1;
  for (const ins of insights) {
    const refs = Array.from({ length: ins.count }, (_, k) => `[${cite + k}]`).join("");
    const head = lines[ins.headingIdx];
    // 〔待核实〕标记保持在最末尾
    const flaggedIdx = head.lastIndexOf("〔待核实〕");
    if (flaggedIdx > 0) {
      lines[ins.headingIdx] = head.slice(0, flaggedIdx).trimEnd() + " " + refs + " " + head.slice(flaggedIdx);
    } else {
      lines[ins.headingIdx] = head + " " + refs;
    }
    // 列表项前缀
    for (let k = 0; k < ins.count; k++) {
      const idx = ins.listStartIdx + k;
      if (idx >= lines.length) break;
      const cm = lines[idx].match(/^(  - )(.+)$/);
      if (cm) lines[idx] = cm[1] + `[${cite + k}] ` + cm[2];
    }
    cite += ins.count;
  }
  return { md: lines.join("\n"), changed: true, injected: cite - 1, reason: null };
}

const dbPath = process.env.DB_PATH || "/data/insight.db";
const db = new Database(dbPath, { readonly: true });
const reports = db.prepare("SELECT id, body_path FROM report ORDER BY generated_at DESC").all();
console.log(`扫描 ${reports.length} 份报告…\n`);

let processed = 0, skipped = 0, totalInjected = 0;
for (const r of reports) {
  const mdPath = `${r.body_path}.md`;
  let md;
  try {
    md = readFileSync(mdPath, "utf8");
  } catch (e) {
    console.log(`  ⚠ ${r.id} 跳过：FS 正文缺失（${mdPath}）`);
    skipped++;
    continue;
  }
  const { md: newMd, changed, injected, reason } = regenerateMarkdown(md);
  if (!changed) {
    console.log(`  · ${r.id} 跳过（${reason}）`);
    skipped++;
    continue;
  }
  writeFileSync(mdPath, newMd);
  console.log(`  ✓ ${r.id} 注入 ${injected} 个 [N] 标记`);
  processed++;
  totalInjected += injected;
}

console.log(`\n完成：处理 ${processed} 份 · 跳过 ${skipped} 份 · 注入 ${totalInjected} 个 [N]`);
