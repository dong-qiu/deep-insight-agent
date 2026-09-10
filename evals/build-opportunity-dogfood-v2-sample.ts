/** Build a blind, fixed sample inventory from an offline qualified-TechLead snapshot. */
import { readFileSync, writeFileSync } from "node:fs";
import { createBlindSampleManifest, type QualifiedLeadForSampling } from "./technology-opportunities/dogfood-v2.js";

const [inputPath, outputPath, seed, countArg] = process.argv.slice(2);
if (!inputPath || !outputPath || !seed) {
  throw new Error("Usage: tsx evals/build-opportunity-dogfood-v2-sample.ts <qualified-leads.json> <blind-manifest.json> <seed> [count=20]");
}
const input = JSON.parse(readFileSync(inputPath, "utf8")) as { snapshot_at: string; leads: QualifiedLeadForSampling[] };
if (!input || !Array.isArray(input.leads)) throw new Error("输入必须为 { snapshot_at, leads }；leads 来自合格 TechLead 总体，不得使用 opportunity pool");
const count = countArg === undefined ? 20 : Number(countArg);
const manifest = createBlindSampleManifest(input.leads, { generatedAt: input.snapshot_at, seed, count, pilot: count === 20 });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
