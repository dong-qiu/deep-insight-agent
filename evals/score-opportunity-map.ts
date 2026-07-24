/** 离线评分脚手架：比较人工标注与确定性机会映射，不调用模型或生产数据库。 */
import { readFileSync } from "node:fs";

interface Label {
  id: string;
  expected_direction_id: string | null;
  expected_lane: string;
  actual_direction_id: string | null;
  actual_lane: string;
}

const path = process.argv[2];
if (!path) throw new Error("Usage: tsx evals/score-opportunity-map.ts <labels.json>");
const rows = JSON.parse(readFileSync(path, "utf8")) as Label[];
if (!Array.isArray(rows) || !rows.length) throw new Error("标签文件必须是非空 JSON 数组");
const required = rows.every((row) => row.id && row.expected_lane && row.actual_lane && "expected_direction_id" in row && "actual_direction_id" in row);
if (!required) throw new Error("每条标签必须包含 id、expected/actual direction_id 与 lane");
const laneCorrect = rows.filter((row) => row.expected_lane === row.actual_lane).length;
const directionCorrect = rows.filter((row) => row.expected_direction_id === row.actual_direction_id).length;
const exact = rows.filter((row) => row.expected_lane === row.actual_lane && row.expected_direction_id === row.actual_direction_id).length;
console.log(JSON.stringify({ total: rows.length, lane_accuracy: laneCorrect / rows.length, direction_accuracy: directionCorrect / rows.length, exact_accuracy: exact / rows.length }, null, 2));
