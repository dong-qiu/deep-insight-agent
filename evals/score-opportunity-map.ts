/** 离线评分：比较人工盲标与确定性机会映射，不调用模型或生产数据库。 */
import { readFileSync } from "node:fs";
import { scoreDogfoodLabels, type BlindSampleManifest, type DeterministicMappingExport, type DogfoodLabelFile, type QualifiedTechLeadSnapshot, type SealedExpectedArtifact } from "./technology-opportunities/dogfood-v2.js";

const [labelsPath, snapshotPath, manifestPath, sealedPath, mappingPath] = process.argv.slice(2);
if (!labelsPath || !snapshotPath || !manifestPath || !sealedPath || !mappingPath) throw new Error("Usage: tsx evals/score-opportunity-map.ts <labels.json> <qualified-snapshot.json> <blind-manifest.json> <sealed.json> <deterministic-mapping.json>");
const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as DogfoodLabelFile;
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as QualifiedTechLeadSnapshot;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BlindSampleManifest;
const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedExpectedArtifact;
const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as DeterministicMappingExport;
console.log(JSON.stringify(scoreDogfoodLabels(labels, snapshot, manifest, sealed, mapping), null, 2));
