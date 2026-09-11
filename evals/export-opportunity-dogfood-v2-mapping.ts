/** The only permitted actual-value producer: a read-only deterministic export from one snapshot. */
import { readFileSync, writeFileSync } from "node:fs";
import { createDeterministicMappingExport, type QualifiedTechLeadSnapshot } from "./technology-opportunities/dogfood-v2.js";

const [snapshotPath, outputPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath) throw new Error("Usage: tsx evals/export-opportunity-dogfood-v2-mapping.ts <qualified-snapshot.json> <mapping.json>");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as QualifiedTechLeadSnapshot;
writeFileSync(outputPath, `${JSON.stringify(createDeterministicMappingExport(snapshot), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
