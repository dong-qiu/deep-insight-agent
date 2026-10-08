/** Isolated tooling: exact old bytes, never evaluate or rewrite candidate source. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const OLD_HEAD = "235045d6424640d79c79874a403749c6bd17b823";
export const OLD_TREE = "932ca0eee33ac2f27bc1b883991a9ec5fd685cbd";
export const OLD_FILES: Readonly<Record<string, string>> = Object.freeze({
  "src/lib/runtime/llm.ts": "4983114bac108d33e941f072c694ee65ae5a0cc4134d6c4096750614530ba21d",
  "src/lib/runtime/model-usage.ts": "1ce9ef0e1f63c9138f570dd69d7f2bdd679415e13ad5588dca7b3c7d0bfb11ba",
  "src/lib/runtime/volcengine-responses.ts": "845af1f1f6e0f5696893fe6c778dd340663e5da8d8b7963543d4fef7556f192e",
  "src/lib/agents/analyzer.ts": "e0ba58e47251169abc6b4519e440761146046a4b2c9e11d8dc617938558b293d",
  "src/lib/agents/validator.ts": "de105d95ada9f120040fae1b8dfe516e85827fe5560dc6c73ba641cbbedef37f",
  "src/lib/agents/reader-language.ts": "7b6860468e4aaff8d8a949121391a8e96615351fe30236b59703f26ab79b4422",
  "src/lib/types.ts": "c6d14861b73d035e0663349dac14b286e12ad79944959f585f08e7e59efdddb0",
  "package.json": "7b58785a6fe5d560722b33412be692964d2bc807fc6d14d9b5ef69c85ce668ef",
  "package-lock.json": "63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2",
  "evals/a1-prototype-safety-config.ts": "65532402426d51325bcbb6e5e6bcc3ba13a80320f4239ee2218c5d900ae54b43",
  "src/lib/runtime/llm-provider.ts": "49e66f3e7f920de4aac8e22b4d8482ac56b94d99c68a75a6893213495dfb7a1c"
});
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export type Operation = "analysis_generation" | "display_quote_primary" | "display_quote_countercheck" |
  "reader_language_repair" | "citation_repair_candidates" | "citation_consistency_single" | "citation_consistency_batch";
export interface WireSignature { operation: Operation; role: "analyzer" | "validator" | "coverage"; system: string; schema: string }

/** Only static strings/templates and constant names from these frozen files are interpreted. */
export function oldPromptStrings(candidate: string): Record<string, string> {
  const values = new Map<string, ts.Expression>();
  for (const file of ["src/lib/agents/analyzer.ts", "src/lib/agents/validator.ts", "src/lib/agents/reader-language.ts"]) {
    const text = readFileSync(join(candidate, file), "utf8");
    if (digest(text) !== OLD_FILES[file]) throw new Error("s2a_old_source_mismatch");
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          if (values.has(declaration.name.text)) throw new Error("s2a_ambiguous_source_constant");
          values.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const active = new Set<string>();
  function named(name: string): string {
    if (active.has(name) || !values.has(name)) throw new Error("s2a_unknown_source_constant");
    active.add(name); try { return expression(values.get(name)!); } finally { active.delete(name); }
  }
  function expression(node: ts.Expression): string {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return named(node.text);
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(part => expression(part.expression) + part.literal.text).join("");
    throw new Error("s2a_nonstatic_prompt");
  }
  return Object.fromEntries(["ANALYZER_SYSTEM", "QUOTE_COVERAGE_SYSTEM", "QUOTE_COVERAGE_COUNTERCHECK_SYSTEM", "COVERAGE_VERIFY_SYSTEM",
    "CONSISTENCY_SYSTEM", "CONSISTENCY_BATCH_SYSTEM", "READER_LANGUAGE_REPAIR_SYSTEM", "READER_LANGUAGE_EQUIVALENCE_RULE"].map(name => [name, named(name)]));
}

export function buildSignatures(prompts: Record<string, string>, schemas: Record<string, unknown>, toSchema: (schema: unknown) => unknown): readonly WireSignature[] {
  const entries: [Operation, WireSignature["role"], string, string][] = [
    ["analysis_generation", "analyzer", prompts.ANALYZER_SYSTEM, "AnalyzerOutputSchema"],
    ["display_quote_primary", "validator", prompts.QUOTE_COVERAGE_SYSTEM, "QuoteCoverageSchema"],
    ["display_quote_primary", "validator", prompts.QUOTE_COVERAGE_SYSTEM + prompts.READER_LANGUAGE_EQUIVALENCE_RULE, "QuoteCoverageSchema"],
    ["display_quote_countercheck", "coverage", prompts.QUOTE_COVERAGE_COUNTERCHECK_SYSTEM, "QuoteCoverageSchema"],
    ["citation_repair_candidates", "validator", prompts.COVERAGE_VERIFY_SYSTEM, "CoverageRepairSchema"],
    ["citation_consistency_single", "validator", prompts.CONSISTENCY_SYSTEM, "ConsistencyJudgeSchema"],
    ["citation_consistency_batch", "validator", prompts.CONSISTENCY_BATCH_SYSTEM, "ConsistencyBatchJudgeSchema"],
    ["reader_language_repair", "analyzer", prompts.READER_LANGUAGE_REPAIR_SYSTEM, "ReaderLanguageRepairSchema"],
  ];
  const signatures = entries.map(([operation, role, system, schema]) => Object.freeze({ operation, role, system: digest(system), schema: digest(JSON.stringify(toSchema(schemas[schema]))) }));
  if (new Set(signatures.map(entry => `${entry.system}:${entry.schema}`)).size !== signatures.length) throw new Error("s2a_ambiguous_signature");
  return Object.freeze(signatures);
}
