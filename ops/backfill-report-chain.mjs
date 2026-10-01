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
 *  安全：只读预览。原地改 report.prev_report_id 会绕过发布溯源，旧写入口已停用。
 *
 *  用法：
 *    隔离预览：  REPORT_SNAPSHOT_DB_PATH=/path/to/standalone-snapshot.db node ops/backfill-report-chain.mjs
 */
import { openReadonlyReportSnapshot } from "./readonly-report-snapshot.mjs";

// db/reports.ts chainTypesFor 的对齐口径（改那边记得同步）
const CHAIN_GROUPS = [["brief", "initial_digest"], ["deep_dive"]];

if (process.argv.length !== 2) {
  console.error("仅支持无参数预览；--apply 已停用，历史报告修复须走正式发布协议。");
  process.exit(2);
}
function main() {
  const db = openReadonlyReportSnapshot(process.env.REPORT_SNAPSHOT_DB_PATH);
  const topics = db.prepare("SELECT DISTINCT topic_id FROM report WHERE status = 'done'").all();

  let linked = 0, chainsTouched = 0;
  try {
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
          linked += 1;
          touched = true;
          console.log(`  · ${cur.id} → prev=${expectedPrev}`);
        }
        if (touched) chainsTouched += 1;
      }
    }
  } finally {
    db.close();
  }

  console.log("\n只读预览（未写库；旧 --apply 已停用）：");
  console.log(`  串接 ${linked} 条前情链接 · 涉及 ${chainsTouched} 条链 · 主题 ${topics.length}`);
}

main();
