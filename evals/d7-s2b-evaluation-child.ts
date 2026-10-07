/** Both entry points dynamically load only the pinned candidate's production modules. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentItem, Topic } from "../src/lib/types.js";
import type { HistoricalEvent } from "../src/lib/agents/analyzer.js";
import { digest, privateJson } from "./d7-s2b-evaluation-budget.js";

async function main(): Promise<void> {
  const bridge = globalThis.d7EvaluationBridge;
  const candidate = process.env.D7_EVALUATION_CANDIDATE!, root = process.env.D7_EVALUATION_ROOT!;
  if (!bridge) throw new Error("evaluation_preload_missing");
  const load = (name: string) => import(pathToFileURL(resolve(candidate, name)).href);
  await load("evals/load-env.ts");
  bridge.check();
  if (process.env.D7_EVALUATION_MODE === "a1") { await load("evals/run-a1.ts"); return; }
  if (process.env.D7_EVALUATION_MODE !== "identity") throw new Error("evaluation_unknown_mode");
  const bytes = readFileSync(join(root, "identity-input.json"));
  if (digest(bytes) !== "056a6748ad961d4785ae36f1a5706ca1efda3af692613a681d4137f0f6d14c37") throw new Error("identity_input_drift");
  const input = JSON.parse(bytes.toString()) as { topic: Topic; item: ContentItem; time_window: { start: string; end: string }; history: HistoricalEvent;
    cases: Array<{ name: string; source_id: string; event_id: string }> };
  const { analyze } = await load("src/lib/agents/analyzer.ts") as typeof import("../src/lib/agents/analyzer.js");
  const { validateBatch } = await load("src/lib/agents/validator.ts") as typeof import("../src/lib/agents/validator.js");
  const { isA1CoverageExecutionFailure } = await load("evals/a1-coverage-execution.ts") as typeof import("./a1-coverage-execution.js");
  const { A1AttemptDiagnostics } = await load("evals/a1-attempt-diagnostics.ts") as typeof import("./a1-attempt-diagnostics.js");
  const { withModelCallObserver } = await load("src/lib/runtime/model-call-observer.ts") as typeof import("../src/lib/runtime/model-call-observer.js");
  const diagnostics = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: Math.max(1, bridge.budget.check().deadline - Date.now()) });
  const outcomes: unknown[] = [], generations: string[] = [];
  try {
    await withModelCallObserver(diagnostics, async () => {
      for (const arm of input.cases) {
        bridge.segment(arm.name);
        const before = bridge.budget.check().attempts.length;
        const item = { ...input.item, source_id: arm.source_id };
        const batch = await analyze(input.topic, [item], input.time_window, undefined, {
          history: [{ ...input.history, event_id: arm.event_id }], signal: diagnostics.signal,
          onStage: (stage) => { if (stage.status === "failed") diagnostics.incomplete(); },
          onCoverageDecision: (decision) => {
            if (decision.claims.some((claim) => isA1CoverageExecutionFailure(claim.reason) || claim.countercheck?.error != null
              || (claim.countercheck != null && isA1CoverageExecutionFailure(claim.countercheck.reason)))) diagnostics.incomplete();
          },
          onChunkComplete: () => diagnostics.check(),
        });
        diagnostics.check();
        if (!/^batch_[0-9a-f]{32}$/.test(batch.id)) throw new Error("batch_contract_failed");
        for (const insight of batch.insights) {
          if (insight.event_id !== arm.event_id && !insight.event_id?.startsWith(`evt_${batch.id}_`)) throw new Error("history_binding_failed");
          if (insight.is_followup !== (insight.event_id === arm.event_id)) throw new Error("followup_binding_failed");
          for (const citation of insight.citations) {
            if (citation.content_item_id !== item.id || !citation.quote || !item.body.includes(citation.quote)) throw new Error("citation_binding_failed");
          }
        }
        const validation = await validateBatch(batch.insights, [item], undefined, undefined, diagnostics.signal);
        diagnostics.check();
        if (validation.report.errored !== 0) throw new Error("validator_execution_incomplete");
        const requests = bridge.budget.check().attempts;
        const index = requests.findIndex((entry, i) => i >= before && entry.operation === "analysis_generation");
        if (index < before) throw new Error("generation_transport_missing");
        const body = readFileSync(join(root, `request-${index + 1}.json`), "utf8");
        if (!body.includes(arm.source_id) || !body.includes(arm.event_id) || body.includes(batch.id)) throw new Error("serialized_identity_failed");
        for (const audit of batch.display_coverage_candidate_audits ?? []) if (body.includes(audit.candidate_id)) throw new Error("current_candidate_leaked_into_input");
        generations.push(body);
        outcomes.push({ name: arm.name, source_id: arm.source_id, history_event: arm.event_id, batch, validation });
        privateJson(join(root, "identity-progress.json"), { execution_complete: false, cases: outcomes.length });
      }
      for (const [index, arm] of input.cases.entries()) {
        const expected = generations[0].replace(input.item.source_id, arm.source_id).replace(input.history.event_id, arm.event_id);
        if (generations[index] !== expected) throw new Error("serialized_bytes_drift");
      }
      diagnostics.check(); diagnostics.finish(true); bridge.check();
      privateJson(join(root, "identity-result.json"), { execution_complete: true, input_sha256: digest(bytes),
        cases: outcomes, generation: generations.map((body) => ({ sha256: digest(body), bytes: Buffer.byteLength(body) })),
        diagnostics: diagnostics.snapshot(), limitations: ["four identity cases are not a statistical quality equivalence or baseline", "unknown event/no-output only observed, never forced"] });
      bridge.check();
    });
  } catch (error) { diagnostics.finish(false); throw error; }
  finally { diagnostics.dispose(); }
}

main().catch(() => {
  // SDK errors can contain endpoint/request data. Detailed outputs stay private, console is aggregate only.
  globalThis.d7EvaluationBridge?.budget.fail("child_execution_incomplete");
  process.exitCode = 1;
});
