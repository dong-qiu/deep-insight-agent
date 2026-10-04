import { expect, it, vi } from "vitest";
import { createAnthropicUsageObserver, readReportedUsage } from "./model-usage.js";

it.each([undefined, {}, { input_tokens: -1, output_tokens: "0" }, { input_tokens: 1.5, output_tokens: Infinity }])("raw missing/invalid provider usage never becomes explicit zero: %j", (raw) => {
  expect(readReportedUsage(raw, "anthropic")).toEqual({ input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null });
});
it("provider zeros are distinct from absent cache and unsupported creation; cached input is not added to total input", () => {
  expect(readReportedUsage({ input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 7 } }, "volcengine-responses"))
    .toEqual({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: 7 });
});
it("split CRLF frames, cumulative deltas and missing fields retain exact counts, not delta sums", () => {
  const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe); const encode = new TextEncoder();
  const stream = [
    { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "message_delta", usage: { output_tokens: 2 } },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  for (let start = 0; start < stream.length; start += 3) ingest(encode.encode(stream.slice(start, start + 3)));
  ingest(undefined);
  expect(observe).toHaveBeenCalledTimes(4);
  expect(observe.mock.calls.at(-1)).toEqual([{ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: 0 }, true]);
});
it("oversized non-usage frame is bounded/skipped; later small usage frames still reach observation", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe); const encode = new TextEncoder();
    const frame = `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x".repeat(400_000) } })}\n\n`;
    for (let offset = 0; offset < frame.length; offset += 8192) ingest(encode.encode(frame.slice(offset, offset + 8192)));
    ingest(encode.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: {"type":"message_stop"}\n\n'));
    ingest(undefined);
    expect(warning).toHaveBeenCalledWith("usage_observation_incomplete");
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ input_tokens: 7, output_tokens: 3 }), false]);
  } finally { warning.mockRestore(); }
});
it("initial output zero without a terminal output snapshot is partial, not a zero-output completion", () => {
  const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe);
  ingest(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\ndata: {"type":"message_stop"}\n\n'));
  expect(observe.mock.calls.at(-1)?.[1]).toBe(false);
});
it.each(["\n", "\r\n", "\r"])("supports all SDK SSE newlines including split delimiters: %j", (newline) => {
  const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe);
  const stream = [{ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0 } } }, { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_stop" }]
    .map((value) => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`).join("");
  for (const character of stream) ingest(new TextEncoder().encode(character));
  ingest(undefined);
  expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ input_tokens: 7, output_tokens: 3 }), true]);
});
it("an oversized usage delta cannot promote the initial output zero to a complete estimate", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe);
    ingest(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n'));
    ingest(new TextEncoder().encode(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 }, ignored: "x".repeat(400_000) })}\n\n`));
    ingest(new TextEncoder().encode('data: {"type":"message_stop"}\n\n'));
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ output_tokens: 0 }), false]);
  } finally { warning.mockRestore(); }
});
it("invalid JSON and unrelated payloads stay with SDK; observation never accepts a model result", () => {
  const observe = vi.fn(); const ingest = createAnthropicUsageObserver(observe);
  ingest(new TextEncoder().encode('data: not-json\n\ndata: {"type":"content_block_delta","usage":{"output_tokens":100}}\n\n'));
  ingest(undefined); expect(observe).not.toHaveBeenCalled();
});
