/** Test-only preload: real A1/agents/SDK, synthetic transport, no env-file or real network. */
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.env.C4B_SYNTHETIC_PROVIDER !== "1") throw new Error("C4b fixture requires explicit synthetic mode");
const mode = process.env.C4B_MOCK_MODE ?? "empty";
const stats = { requests: [] as Array<{ role: string; operation: string; sha256: string }>, retries: 0, source_reads: 0, source_bytes: 0 };
const checkpointPath = process.env.A1_RESUME_FROM ? join(process.env.A1_RESUME_FROM, "quality-checkpoint.json") : null;
const originalRead = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  const value = originalRead(...args);
  const path = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
  if (path === checkpointPath) { stats.source_reads++; stats.source_bytes += Buffer.byteLength(value); }
  return value;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
const save = () => { if (process.env.C4B_STATS_PATH) fs.writeFileSync(process.env.C4B_STATS_PATH, JSON.stringify(stats)); };
process.on("exit", save);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.C4B_READ_STRATEGY === "two" && specifier === "./a1-quality-checkpoint.js"
      && context.parentURL && new URL(context.parentURL).pathname.endsWith("/evals/run-a1.ts")) {
      return { url: new URL("./c4b-two-read-checkpoint.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === new URL("../load-env.ts", import.meta.url).href) return { format: "module", source: "export {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

function response(data: object, anthropic: boolean, tool: string, truncated: boolean): Response {
  const events = anthropic ? [
    { type: "message_start", message: { id: "synthetic-message", type: "message", role: "assistant", model: "synthetic", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-tool", name: tool, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(data) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: truncated ? "max_tokens" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { type: "response.function_call_arguments.done", name: tool, arguments: JSON.stringify(data) },
    { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const text = events.map((event) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text + (anthropic ? "" : "data: [DONE]\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let analyzerCalls = 0;
let primaryCalls = 0;
let eofSeen = false;
let sdkRetrySeen = false;
globalThis.fetch = async (_input, init) => {
  if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected fixture transport");
  const body = JSON.parse(init.body);
  const anthropic = process.env.LLM_PROVIDER === "anthropic";
  const tool = body.tools[0];
  const properties = (anthropic ? tool.input_schema : tool.parameters).properties;
  const user: string = anthropic ? body.messages[0].content : body.input;
  const role = body.model === "synthetic-a" ? "analyzer" : body.model === "synthetic-v" ? "validator" : "coverage";
  const operation = properties.no_significant_event ? "analysis" : properties.consistency ? "judge" : properties.statement ? "translation" : "coverage";
  stats.requests.push({ role, operation, sha256: createHash("sha256").update(init.body).digest("hex") });
  save();
  if (mode === "sdk_retry" && !sdkRetrySeen) {
    sdkRetrySeen = true; stats.retries++; save();
    return new Response("synthetic failure", { status: 500, headers: { "retry-after-ms": "0" } });
  }
  if (mode === "eof_retry" && operation === "analysis" && !eofSeen) {
    eofSeen = true; stats.retries++;
    return new Response("data: {\"type\":\"response.in_progress\"}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  if (operation === "analysis") {
    analyzerCalls++;
    if (mode === "cancel" || mode === "deadline") await new Promise<void>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    if (["fail_second", "fail_second_nonempty"].includes(mode) && analyzerCalls === 2) return new Response("synthetic failure", { status: 500 });
    if (mode === "invalid_analysis") return response({ insights: "invalid" }, anthropic, tool.name, false);
    if (mode === "split_success" && analyzerCalls === 1) return response({ insights: "invalid" }, anthropic, tool.name, false);
    if (["empty", "fail_second", "eof_retry", "truncated_empty", "split_success"].includes(mode)) {
      return response({ no_significant_event: true, insights: [] }, anthropic, tool.name, mode === "truncated_empty");
    }
    const id = user.match(/<untrusted-source id="([^"]+)"/)?.[1];
    if (!id) throw new Error("Synthetic source not found");
    const quote = "Fact is supported.";
    return response({ no_significant_event: false, insights: [{
      statement: quote, statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
      importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1],
      confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
      citations: [{ content_item_id: id, quote, claim: quote }],
    }] }, anthropic, tool.name, false);
  }
  if (operation === "judge") {
    if (mode === "validator_error") return new Response("synthetic failure", { status: 500 });
    const consistency = mode === "uncertain" ? "uncertain" : mode === "not_support" ? "not_support" : "support";
    return response({ consistency, consistency_reason: consistency === "support" ? "ok" : consistency === "uncertain" ? "uncertain" : "exaggeration", rationale: "synthetic" }, anthropic, tool.name, mode === "truncated_validator");
  }
  if (operation === "translation") {
    if (mode === "translation_error") return new Response("synthetic failure", { status: 500 });
    return response({ statement: "Still English." }, anthropic, tool.name, false);
  }
  if (role === "validator") primaryCalls++;
  if (mode === "coverage_error" && role === "coverage") return new Response("synthetic failure", { status: 500 });
  const quote = user.match(/displayed_quote：([^\n]+)/)?.[1] ?? user.match(/<displayed_quote>\n([^\n]+)/)?.[1];
  // Only our synthetic quality quote is supported; repository benchmark negatives are never accepted.
  const supports = quote === "Fact is supported.";
  const data = { verdicts: [{ index: 1, kind: "factual", supports,
    citation_indexes: supports ? [1] : [], evidence_spans: supports ? [{ citation_index: 1, quote_start: 0, quote_end: quote!.length, evidence_excerpt: quote }] : [],
  }] };
  if (mode === "invalid_coverage" && primaryCalls === 1) data.verdicts.push(data.verdicts[0]!);
  return response(data, anthropic, tool.name, false);
};
