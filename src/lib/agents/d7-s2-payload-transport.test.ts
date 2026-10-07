import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ContentItem, Topic } from "../types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

// Real analyzer → callStructured → SDK/provider serialization → intercepted fetch.
// The transport cannot reach a network and never reads .env.local.
it.each(["anthropic", "volcengine-responses"])("D7 S2 captures actual %s request bytes with fixed identity changes", async (provider) => {
  vi.resetModules();
  for (const [key, value] of Object.entries({ LLM_PROVIDER: provider, LLM_API_KEY: "synthetic-no-network", LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
    ANTHROPIC_API_KEY: "synthetic-no-network", ANTHROPIC_BASE_URL: "https://provider.example.test", ANALYZER_MODEL: "synthetic-a",
    VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c", COVERAGE_MAX_TOKENS: "2048" })) vi.stubEnv(key, value);
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected transport; network forbidden");
    bodies.push(init.body);
    const tool = JSON.parse(init.body).tools[0].name as string;
    const data = { no_significant_event: true, insights: [] };
    const events = provider === "anthropic" ? [
      { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: "synthetic-a", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-tool", name: tool, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(data) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
    ] : [{ type: "response.function_call_arguments.done", name: tool, arguments: JSON.stringify(data) },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }];
    const sse = events.map((event) => `${provider === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(sse + (provider === "anthropic" ? "" : "data: [DONE]\n\n"), { headers: { "Content-Type": "text/event-stream" } });
  });
  const { analyze } = await import("./analyzer.js");
  const topic: Topic = { id: "t_tools_abcd", name: "Tools", keywords: ["tools"], language: "en", brief_schedule: "daily", enabled: true };
  const item: ContentItem = { id: "ci_synthetic", source_id: "src_feed_abcd", topic_ids: [topic.id], url: "https://example.test/synthetic", title: "Synthetic", author: null,
    published_at: null, fetched_at: "2026-10-07T00:00:00Z", language: "en", tags: [], body: "Synthetic supported fact.", body_kind: "article", raw_ref: "", content_hash: "synthetic", fetch_status: "ok" };
  const oldEvent = "evt_batch_abcd1234_0", newEvent = `evt_batch_${"a".repeat(32)}_0`;
  const timeWindow = { start: "2026-10-01", end: "2026-10-07" };
  const history = [{ event_id: oldEvent, statement: "Earlier fact.", date: "2026-10-01" }];
  await analyze(topic, [item], timeWindow, undefined, { history });
  await analyze({ ...topic, id: `t_tools_${"a".repeat(32)}` }, [{ ...item, source_id: `src_feed_${"a".repeat(32)}` }], timeWindow, undefined, { history: [{ ...history[0], event_id: newEvent }] });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0].replace(item.source_id, `src_feed_${"a".repeat(32)}`).replace(oldEvent, newEvent));
  expect(Buffer.byteLength(bodies[1]) - Buffer.byteLength(bodies[0])).toBe(52);
  console.info("D7 S2 serialized request", { provider, before_bytes: Buffer.byteLength(bodies[0]), after_bytes: Buffer.byteLength(bodies[1]),
    before_sha256: createHash("sha256").update(bodies[0]).digest("hex"), after_sha256: createHash("sha256").update(bodies[1]).digest("hex"), tokens: "unknown; synthetic usage is not evidence" });
});
