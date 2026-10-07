/** Synthetic-only child process for exported entrances not exercised by P0 A1. */
import { readFileSync, writeFileSync } from "node:fs";
import { A1AttemptDiagnostics, a1DiagnosticLimits } from "../a1-attempt-diagnostics.js";
import { withModelCallObserver } from "../../src/lib/runtime/model-call-observer.js";
import { repairCoverage } from "../../src/lib/agents/analyzer.js";
import { judgeWithRetry } from "../../src/lib/agents/validator.js";
import type { Insight } from "../../src/lib/types.js";
if (process.env.C4B_SYNTHETIC_PROVIDER !== "1") throw new Error("synthetic_only");
const d = new A1AttemptDiagnostics(a1DiagnosticLimits()!);
const entry = process.argv[2];
await withModelCallObserver(d, async () => {
  try {
    if (entry === "backfill") {
      const { items } = JSON.parse(readFileSync(process.env.A1_QUALITY_FILE!, "utf8").split("\n")[0]);
      const item = { ...items[0], body: "Accuracy improves to 38.33% overall." };
      const insight = { statement: "Accuracy improves to 38.33% overall.", entities: [], citations: [{ content_item_id: item.id, quote: "Accuracy improves.", claim: "Accuracy improves." }] } as unknown as Insight;
      await repairCoverage([insight], new Map([[item.id, item]]), undefined, d.signal);
    } else if (entry === "validator_retry") {
      await judgeWithRetry("Synthetic fact.", "Synthetic fact.", undefined, undefined, undefined, d.signal);
    } else throw new Error("unknown_synthetic_entry");
    d.check(); d.finish(true);
  } catch { d.finish(false); }
});
d.dispose();
writeFileSync(process.env.TD14_ENTRANCE_OUT!, JSON.stringify(d.snapshot()));
