import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisBatch, ContentItem, Topic } from "../src/lib/types.js";
import { a1RecoveryIdentity } from "./a1-recovery-identity.js";
import { dirtyFingerprintFromSnapshot, DIRTY_SOURCE_FINGERPRINT_ALGORITHM } from "./a1-source-state.js";
import { assertValidA1QualityCheckpoint, createA1QualityCheckpoint } from "./a1-quality-checkpoint.js";
import { isA1CoverageExecutionFailure } from "./a1-coverage-execution.js";

describe("D7 S2 A1 recovery source boundary", () => {
  it("ID generator expression changes invalidate recovery even with identical commit/status/config", () => {
    const snapshot = { status: " M src/lib/agents/analyzer.ts", staged_diff: "", untracked: [] };
    const source = { commit: "a".repeat(40), identity_complete: true, dirty_fingerprint_algorithm: DIRTY_SOURCE_FINGERPRINT_ALGORITHM };
    const oldIdentity = a1RecoveryIdentity({ ...source, dirty_fingerprint: dirtyFingerprintFromSnapshot({ ...snapshot, unstaged_diff: 'randomUUID().slice(0,8)' }) }, {}, {})!;
    const newIdentity = a1RecoveryIdentity({ ...source, dirty_fingerprint: dirtyFingerprintFromSnapshot({ ...snapshot, unstaged_diff: 'randomBytes(16).toString("hex")' }) }, {}, {})!;
    expect(newIdentity).not.toBe(oldIdentity);
    const context = { eval_config_sha256: "b".repeat(64), quality_dataset_sha256: "c".repeat(64), recovery_identity_sha256: oldIdentity };
    const checkpoint = createA1QualityCheckpoint(context);
    expect(() => assertValidA1QualityCheckpoint(checkpoint, context, [])).not.toThrow();
    expect(() => assertValidA1QualityCheckpoint(checkpoint, { ...context, recovery_identity_sha256: newIdentity }, [])).toThrow(/不匹配/);
    const changedCommit = a1RecoveryIdentity({ ...source, commit: "d".repeat(40), dirty_fingerprint: null }, {}, {})!;
    expect(() => assertValidA1QualityCheckpoint(checkpoint, { ...context, recovery_identity_sha256: changedCommit }, [])).toThrow(/不匹配/);
    expect(a1RecoveryIdentity({ ...source, identity_complete: false, dirty_fingerprint: null }, {}, {})).toBeNull();
  });
});

// This file has no llm mock: dynamic imports load the actual analyzer/SDK graph after
// synthetic configuration is installed. fetch never delegates to a real transport.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
const topic: Topic = { id: "t_synthetic", name: "Tools", keywords: ["tools"], language: "en", brief_schedule: "daily", enabled: true };
const quote = "Fact is supported.";
const item: ContentItem = { id: "ci_synthetic", source_id: "src_feed_abcd", topic_ids: [topic.id], url: "https://example.test/synthetic", title: "Synthetic", author: null,
  published_at: null, fetched_at: "2026-10-07T00:00:00Z", language: "en", tags: [], body: quote, body_kind: "article", raw_ref: "", content_hash: "synthetic", fetch_status: "ok" };
const window = { start: "2026-10-01", end: "2026-10-07" };
const oldEvent = "evt_batch_abcd1234_0";
const newEvent = `evt_batch_${"a".repeat(32)}_0`;
const newSource = `src_feed_${"a".repeat(32)}`;
function configureTransport(provider: string) {
  vi.resetModules();
  // No load-env import. All transport/model/execution settings used here are synthetic.
  for (const [key, value] of Object.entries({ LLM_PROVIDER: provider, LLM_API_KEY: "synthetic-no-network", LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
    ANTHROPIC_API_KEY: "synthetic-no-network", ANTHROPIC_BASE_URL: "https://provider.example.test", ANALYZER_MODEL: "synthetic-a",
    VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c", COVERAGE_MAX_TOKENS: "2048", VALIDATOR_THINKING: "0", COVERAGE_THINKING: "0",
    VALIDATOR_RETRIES: "0", LLM_MAX_RETRIES: "0", LLM_TRANSIENT_RETRIES: "0", COVERAGE_BACKFILL: "0", PROMPT_CACHE: "0" })) vi.stubEnv(key, value);
}
function sdkResponse(provider: string, tool: string, data: unknown) {
  const anthropic = provider === "anthropic";
  const events = anthropic ? [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: "synthetic-a", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-tool", name: tool, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(data) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
  ] : [{ type: "response.function_call_arguments.done", name: tool, arguments: JSON.stringify(data) },
    { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }];
  return new Response(events.map((event) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + (anthropic ? "" : "data: [DONE]\n\n"), { headers: { "Content-Type": "text/event-stream" } });
}

describe("S2b actual SDK request and future-history identity boundary", () => {
  it.each(["anthropic", "volcengine-responses"].flatMap((provider) => ["legal", "unknown", "empty"].map((mode) => [provider, mode] as const)))(
    "%s %s response preserves serialized identities through analyze and all fetch observations", async (provider, mode) => {
      configureTransport(provider);
      const bodies: string[] = [];
      let selectedEvent = oldEvent;
      vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
        if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected transport; network forbidden");
        bodies.push(init.body);
        const body = JSON.parse(init.body);
        const tool = body.tools[0];
        const properties = (provider === "anthropic" ? tool.input_schema : tool.parameters).properties;
        const data = properties.no_significant_event ? { no_significant_event: mode === "empty", insights: mode === "empty" ? [] : [{
          statement: quote, statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1], confidence: null,
          event_id: mode === "legal" ? selectedEvent : "evt_invented", is_followup: true, entities: [], tags: [], citations: [{ content_item_id: item.id, claim: quote, quote }],
        }] } : { verdicts: [{ index: 1, kind: "factual", supports: true, citation_indexes: [1],
          evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: quote.length, evidence_excerpt: quote }] }] };
        return sdkResponse(provider, tool.name, data);
      });
      const { analyze } = await import("../src/lib/agents/analyzer.js");
      const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
      const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
      const guard = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: 10000 });
      const groups: string[][] = [];
      const batches: AnalysisBatch[] = [];
      try {
        await withModelCallObserver(guard, async () => {
          // Repeat the current-input arm: newly allocated batch/candidate IDs must not
          // change current request bytes. Only explicit Source/history substitutions do.
          for (const [source, event] of [[item.source_id, oldEvent], [item.source_id, oldEvent], [newSource, oldEvent], [item.source_id, newEvent], [newSource, newEvent]]) {
            selectedEvent = event;
            const start = bodies.length;
            const batch = await analyze(topic, [{ ...item, source_id: source }], window, undefined, { history: [{ event_id: event, statement: "Earlier fact.", date: "2026-10-01" }], signal: guard.signal });
            guard.check();
            batches.push(batch);
            const requests = bodies.slice(start);
            groups.push(requests);
            expect(requests).toHaveLength(mode === "empty" ? 1 : 3);
            for (const request of requests) {
              expect(request).not.toContain(batch.id);
              for (const audit of batch.display_coverage_candidate_audits ?? []) expect(request).not.toContain(audit.candidate_id);
            }
            if (mode === "empty") expect(batch.insights).toEqual([]);
            else {
              expect(batch.insights[0].citations[0].content_item_id).toBe(item.id);
              expect(batch.insights[0].event_id).toBe(mode === "legal" ? event : `evt_${batch.id}_0`);
              expect(batch.insights[0].is_followup).toBe(mode === "legal");
            }
          }
          guard.check(); guard.finish(true);
        });
        expect(batches[1].id).not.toBe(batches[0].id);
        expect(groups[1]).toEqual(groups[0]);
        for (const [index, sourceChanged, eventChanged, delta] of [[2, true, false, 28], [3, false, true, 24], [4, true, true, 52]] as const) {
          let expected = groups[0][0];
          if (sourceChanged) expected = expected.replace(item.source_id, newSource);
          if (eventChanged) expected = expected.replace(oldEvent, newEvent);
          expect(groups[index][0]).toBe(expected);
          expect(Buffer.byteLength(groups[index][0]) - Buffer.byteLength(groups[0][0])).toBe(delta);
          expect(groups[index].slice(1)).toEqual(groups[0].slice(1));
        }
        expect(guard.snapshot()).toMatchObject({ execution_complete: true, transport_attempts: bodies.length });
        console.info("S2b intercepted SDK identity bytes", { provider, mode, requests: bodies.length,
          generation_bytes: groups.map((g) => Buffer.byteLength(g[0])), generation_sha256: groups.map((g) => createHash("sha256").update(g[0]).digest("hex")),
          actual_tokens: "unknown; synthetic usage is not model evidence" });
      } catch (error) { guard.incomplete(); guard.finish(false); throw error; }
      finally { guard.dispose(); }
    });

  it.each(["anthropic", "volcengine-responses"])("%s cap remains incomplete when analyze catches a transport stop", async (provider) => {
    configureTransport(provider);
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const { analyze } = await import("../src/lib/agents/analyzer.js");
    const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
    const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
    const guard = new A1AttemptDiagnostics({ max_attempts: 0, window_ms: 10000 });
    const completed = vi.fn();
    try {
      await expect(withModelCallObserver(guard, async () => {
        try {
          await analyze(topic, [item], window, undefined, { signal: guard.signal, onChunkComplete: completed });
          guard.check(); guard.finish(true);
        } catch (error) { guard.incomplete(); guard.finish(false); throw error; }
      })).rejects.toThrow();
      const terminal = guard.snapshot();
      expect(terminal).toMatchObject({ execution_complete: false, transport_attempts: 0, stop_reason: "attempt_limit" });
      expect(transport).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
      guard.finish(true); expect(guard.snapshot()).toEqual(terminal);
    } finally { guard.dispose(); }
  });

  it.each(["anthropic", "volcengine-responses"].flatMap((provider) => ["schema", "coverage"].map((failure) => [provider, failure] as const)))(
    "%s %s execution failure cannot complete the independent observer scope", async (provider, failure) => {
      configureTransport(provider);
      const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("Unexpected transport; network forbidden");
        const body = JSON.parse(init.body), tool = body.tools[0];
        const generation = (provider === "anthropic" ? tool.input_schema : tool.parameters).properties.no_significant_event;
        if (!generation) return new Response("synthetic failure", { status: 500 });
        return sdkResponse(provider, tool.name, failure === "schema" ? { insights: "invalid" } : { no_significant_event: false, insights: [{
          statement: quote, statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
          importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1], confidence: null,
          event_id: null, is_followup: false, entities: [], tags: [], citations: [{ content_item_id: item.id, claim: quote, quote }],
        }] });
      });
      vi.stubGlobal("fetch", transport);
      const { analyze } = await import("../src/lib/agents/analyzer.js");
      const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
      const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
      const guard = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: 10000 });
      const completed = vi.fn();
      try {
        await expect(withModelCallObserver(guard, async () => {
          try {
            await analyze(topic, [item], window, undefined, { signal: guard.signal,
              onStage: (stage) => { if (stage.status === "failed") guard.incomplete(); },
              onCoverageDecision: (decision) => {
                if (decision.claims.some((claim) => isA1CoverageExecutionFailure(claim.reason) || claim.countercheck?.error != null
                  || (claim.countercheck != null && isA1CoverageExecutionFailure(claim.countercheck.reason)))) guard.incomplete();
              },
              onChunkComplete: (chunk) => { guard.check(); completed(chunk); },
            });
            guard.check(); guard.finish(true);
          } catch (error) { guard.incomplete(); guard.finish(false); throw error; }
        })).rejects.toThrow();
        expect(completed).not.toHaveBeenCalled();
        const terminal = guard.snapshot();
        expect(terminal).toMatchObject({ execution_complete: false, stop_reason: "incomplete", transport_attempts: transport.mock.calls.length });
        const attempts = transport.mock.calls.length;
        await expect(withModelCallObserver(guard, () => analyze(topic, [item], window, undefined, { signal: guard.signal }))).rejects.toThrow();
        expect(transport).toHaveBeenCalledTimes(attempts);
        guard.finish(true); expect(guard.snapshot()).toEqual(terminal);
      } finally { guard.dispose(); }
    });
});
