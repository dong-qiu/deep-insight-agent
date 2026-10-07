import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ANALYZER_SYSTEM } from "../../src/lib/agents/analyzer.js";
import { privateWrite, type PreparedData } from "../rich-brief-stage0/data.js";
import { buildMachineInput } from "./input.js";
import { callLedgerContract, summarizeLedger } from "./ledger.js";
import { checkExecutionPreflight, type ExecutionPlan } from "./preflight.js";
import { recoverReplayAttempts } from "./snapshot.js";
import { fileResource, nonempty, resourceSchema, verifyResource } from "./common.js";

const configSchema = z.object({ upstream_input: resourceSchema, scorer_labels: resourceSchema,
  snapshots: z.array(z.object({ run_id: nonempty, db_path: nonempty, backup_manifest: resourceSchema, exporter_manifest: resourceSchema }).strict()).min(1) }).strict();
export function candidateFirstExtractionPrompt(base: string): string {
  const original = "8. 去重：同一来源的同一发现只产出一条洞察，不拆成多条。";
  if (base.split(original).length !== 2) throw new Error("baseline_dedup_rule_changed_requires_review");
  return base.replace(original, "8. 去重以重要命题为单位：同一来源的同一重要命题只产出一条；同一真实事件中，不重复且会改变读者对主要主张理解的机制、比较、结果、范围或局限，可分别作为独立原子候选。每项必须独立满足前述唯一主 citation、连续自足 quote、必要限定和事实/来源观点归属契约。只处理本次输入可见正文，不以标题、元数据、摘要未述内容、节目简介推演嘉宾发言，不补背景或我们的推论。不得以句数/候选数为目标；缺乏重要或自足证据时宁可少产出。历史命题与同义改写仍按规则 13 保守排除。")
    + "\n\n首次提取离线候选补充：先在可见正文中辨认与主题相关的真实事件，再分别寻找主张、来源明确机制或依据、比较对象及必要条件/局限。上述维度不是必填栏；每条只写原文直接支持的重要原子命题，限定贴近对应结论。不得接收人工事件/重要维度金标、固定理解题或实验评分反馈。输出继续严格符合同一 AnalyzerOutputSchema；后续展示审计、quote-only 独立复核和 validator 不放宽。";
}

export function prepareC1(configPath: string, outputDir: string) {
  const configResource = fileResource(configPath), config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  verifyResource(config.upstream_input); verifyResource(config.scorer_labels);
  const data = JSON.parse(readFileSync(config.upstream_input.path, "utf8")) as PreparedData;
  for (const resource of data.resources) verifyResource(resource);
  const replays = recoverReplayAttempts(data, config.snapshots);
  const localPaths = ["common.ts", "input.ts", "ledger.ts", "snapshot.ts", "preflight.ts", "prepare.ts"];
  const productionPaths = ["../../src/lib/agents/analyzer.ts", "../../src/lib/agents/validator.ts", "../../src/lib/agents/reader-language.ts", "../../src/lib/types.ts",
    "../../src/lib/runtime/llm.ts", "../../src/lib/runtime/llm-provider.ts", "../../src/lib/runtime/env.ts", "../../src/lib/db/repos.ts", "../../src/lib/db/reports.ts", "../../src/lib/db/integrity-lifecycle.ts",
    "../../src/lib/utils/display-coverage-audit.ts", "../../src/lib/utils/citation-verdict.ts"];
  const toolResources = localPaths.map((path) => fileResource(fileURLToPath(new URL(path, import.meta.url))));
  const productionResources = productionPaths.map((path) => fileResource(fileURLToPath(new URL(path, import.meta.url))));
  const machine = buildMachineInput(data, config.upstream_input.sha256, replays, [...toolResources, ...productionResources]);
  privateWrite(process.cwd(), outputDir, {
    "machine-input.json": machine, "ledger-contract.json": callLedgerContract,
    "scorer-bindings.json": { schema_version: "rich-brief-c1-scorer-bindings-v1", status: "pending_human_gold_not_execution_input", upstream_input: config.upstream_input,
      labels_resource: config.scorer_labels, inherited_confirmations: data.inherited_labels, occurrence_ids: data.occurrences.map((o) => o.occurrence_id), config_resource: configResource },
    "empty-ledger-summary.json": summarizeLedger([], data.attempts.map((a) => ({ run_id: a.run_id, attempt_id: a.attempt_id }))),
  });
  // Preserve exact prompt bytes; no Markdown newline or normalization may alter the registered system hash.
  writeFileSync(join(outputDir, "baseline-system.md"), ANALYZER_SYSTEM, { flag: "wx", mode: 0o600 });
  writeFileSync(join(outputDir, "candidate-system.md"), candidateFirstExtractionPrompt(ANALYZER_SYSTEM), { flag: "wx", mode: 0o600 });
  const plan: ExecutionPlan = { schema_version: "rich-brief-c1-execution-plan-v1", status: "prepared_not_executable", production_enabled: false,
    c1_prompt_injection: "missing_reviewed_shadow_interface", baseline: "analyze_including_filterByQuoteCoverage_then_validateBatch", c1: "same_analyze_output_schema_derivation_and_common_real_gates",
    machine_resource: fileResource(join(outputDir, "machine-input.json")), ledger_contract_resource: fileResource(join(outputDir, "ledger-contract.json")),
    baseline_prompt_resource: fileResource(join(outputDir, "baseline-system.md")), candidate_prompt_resource: fileResource(join(outputDir, "candidate-system.md")),
    production_code_resources: productionResources, intervention: "first_extraction_prompt_only", human_gold_to_extractor: false };
  writeFileSync(join(outputDir, "execution-plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const readiness = checkExecutionPreflight(plan.machine_resource, fileResource(join(outputDir, "execution-plan.json")), null);
  writeFileSync(join(outputDir, "preflight.json"), JSON.stringify(readiness, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { ...readiness, artifacts: { machine: plan.machine_resource.sha256, ledger: plan.ledger_contract_resource.sha256, baseline_prompt: plan.baseline_prompt_resource.sha256,
    c1_prompt: plan.candidate_prompt_resource.sha256, execution_plan: fileResource(join(outputDir, "execution-plan.json")).sha256 },
    cutoff_safe_history_events: replays.map((r) => r.history.events.length), excluded_later_occurrences: replays.map((r) => r.history.excluded_after_cutoff), unproven_publication_occurrences: replays.map((r) => r.history.unproven_publication_occurrences) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "prepare" && first && second) console.log(JSON.stringify(prepareC1(resolve(first), resolve(second))));
  else if (command === "check" && first && second) {
    console.log(JSON.stringify(checkExecutionPreflight(fileResource(resolve(first)), fileResource(resolve(second)), third ? fileResource(resolve(third)) : null)));
    process.exitCode = 2;
  } else throw new Error("Usage: prepare.ts prepare PRIVATE_CONFIG NEW_PRIVATE_DIR | check MACHINE_INPUT EXECUTION_PLAN [TRUE_FROZEN_PROTOCOL]");
}
