/** 离线评分：比较人工盲标与确定性机会映射，不调用模型或生产数据库。 */
import { readFileSync } from "node:fs";
import { scoreDogfoodLabels, type DogfoodLabelFile } from "./technology-opportunities/dogfood-v2.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: tsx evals/score-opportunity-map.ts <labels.json>");
const labels = JSON.parse(readFileSync(path, "utf8")) as DogfoodLabelFile;
const manifestPath = process.argv[3] ?? path.replace(/\.labels\.json$/, ".blind-manifest.json");
if (manifestPath === path) throw new Error("Usage: tsx evals/score-opportunity-map.ts <labels.json> [blind-manifest.json]");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(JSON.stringify(scoreDogfoodLabels(labels, manifest), null, 2));
