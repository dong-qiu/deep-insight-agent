/** 追问问答（followup_qa）持久化。followup-qa spec。
 *  citations_used / validation / cost 以 JSON TEXT 存（与本库其他 JSON 字段一致）。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FollowupQA } from "../types.js";
import type { DB } from "./index.js";

const j = (v: unknown): string => JSON.stringify(v);

export function saveFollowup(db: DB, qa: FollowupQA): void {
  db.prepare(
    `INSERT INTO followup_qa
       (id,report_id,thread_id,turn_index,question,answer_md,citations_used,validation,cost,status,created_at)
     VALUES (@id,@report_id,@thread_id,@turn_index,@question,@answer_md,@citations_used,@validation,@cost,@status,@created_at)`,
  ).run({
    id: qa.id, report_id: qa.report_id, thread_id: qa.thread_id, turn_index: qa.turn_index,
    question: qa.question, answer_md: qa.answer_md, citations_used: j(qa.citations_used),
    validation: j(qa.validation), cost: j(qa.cost), status: qa.status, created_at: qa.created_at,
  });
}

/** 某报告的全部追问，按时间升序（页面初载展示历史 = 多轮读路径）。 */
export function listFollowups(db: DB, reportId: string): FollowupQA[] {
  const rows = db
    .prepare("SELECT * FROM followup_qa WHERE report_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(reportId) as any[];
  return rows.map(rowToFollowup);
}

function rowToFollowup(r: any): FollowupQA {
  return {
    id: r.id, report_id: r.report_id, thread_id: r.thread_id, turn_index: r.turn_index,
    question: r.question, answer_md: r.answer_md,
    citations_used: JSON.parse(r.citations_used),
    validation: JSON.parse(r.validation),
    cost: JSON.parse(r.cost), status: r.status, created_at: r.created_at,
  };
}
