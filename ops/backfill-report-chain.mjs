/** 一次性脚本：给前情链接（prev_report_id）上线前生成的历史报告回填演化链。
 *
 *  背景：报告阅读页新增「前一篇 / 后一篇」演化链导航（reportNeighbors），新报告由 scheduler
 *  在生成时写 prev_report_id（previousReportForTopic）。但已落库的旧报告 prev_report_id=null，
 *  链全断——导航对历史报告（生产 27 份）完全不显示，要等每个主题攒够 2 篇新报告才亮。
 *  本脚本把历史报告也串成链，让导航在存量数据上立即可用，无需重跑 LLM 管线。
 *
 *  为什么确定性（不调 LLM）：纯按 (topic, 链组, generated_at) 排序把每篇的 prev 指向同链上一篇——
 *  与 scheduler.previousReportForTopic 同口径，零成本、零 API 暴露、容器内可直接跑。
 *
 *  链组（与 db/reports.ts chainTypesFor 同口径，改那边记得同步）：
 *  - brief / initial_digest 同属「每日节奏链」（initial_digest 是冷启动链头）；
 *  - deep_dive 独立成「深挖链」。
 *  各组内按 generated_at 升序，第 i 篇的 prev = 第 i-1 篇（链头 prev 保持 null）。
 *
 *  幂等：只填 prev_report_id IS NULL 的报告（链头本就该 null，不动；已填的不覆盖）。
 *  安全：默认 **dry-run**（只打印将改什么，不写库）；加 `--apply` 才真正落库。
 *
 *  用法：
 *    本地预览：  DB_PATH=.data/insight.db node ops/backfill-report-chain.mjs
 *    本地落库：  DB_PATH=.data/insight.db node ops/backfill-report-chain.mjs --apply
 *    容器内：    docker compose exec -T app node /app/ops/backfill-report-chain.mjs --apply
 */
import Database from "better-sqlite3";

// db/reports.ts chainTypesFor 的对齐口径（改那边记得同步）
const CHAIN_GROUPS = [["brief", "initial_digest"], ["deep_dive"]];

const APPLY = process.argv.includes("--apply");
const dbPath = process.env.DB_PATH || "/data/insight.db";

function main() {
  const db = new Database(dbPath, { readonly: false });
  const topics = db.prepare("SELECT DISTINCT topic_id FROM report WHERE status = 'done'").all();
  const setPrev = db.prepare("UPDATE report SET prev_report_id = ? WHERE id = ?");

  let linked = 0, chainsTouched = 0;
  const run = db.transaction(() => {
    for (const { topic_id } of topics) {
      for (const group of CHAIN_GROUPS) {
        const ph = group.map(() => "?").join(",");
        // 同主题同链组所有 done 报告，按时间升序（id 兜底定序，防 generated_at 同值不稳定）
        const reports = db
          .prepare(
            `SELECT id, prev_report_id FROM report
             WHERE topic_id = ? AND type IN (${ph}) AND status = 'done'
             ORDER BY generated_at ASC, id ASC`,
          )
          .all(topic_id, ...group);
        if (reports.length < 2) continue; // 单篇/空链无前情可串
        let touched = false;
        for (let i = 1; i < reports.length; i++) {
          const cur = reports[i];
          const expectedPrev = reports[i - 1].id;
          if (cur.prev_report_id) continue; // 已有前情（新管线写的 / 已回填）——不覆盖，保幂等
          if (APPLY) setPrev.run(expectedPrev, cur.id);
          linked += 1;
          touched = true;
          console.log(`  ${APPLY ? "✓" : "·"} ${cur.id} → prev=${expectedPrev}`);
        }
        if (touched) chainsTouched += 1;
      }
    }
  });
  run();

  console.log(`\n${APPLY ? "完成（已落库）" : "DRY-RUN（未写库，加 --apply 落库）"}：`);
  console.log(`  串接 ${linked} 条前情链接 · 涉及 ${chainsTouched} 条链 · 主题 ${topics.length}`);
  db.close();
}

main();
