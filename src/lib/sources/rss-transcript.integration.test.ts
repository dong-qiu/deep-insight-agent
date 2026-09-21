/** Recorded-response integration coverage for the production transcript path. It retains
 * safeFetch, robots and streaming size-cap behavior; only the network boundary is replaced. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTranscript } from "./rss.js";

const ORIGIN = "https://8.8.8.8"; // public IP literal: safeFetch still performs its normal guard without DNS I/O.
const TRANSCRIPT = `${ORIGIN}/transcript.vtt?format=vtt&sig=ephemeral`;

function recordedFetch(input: string | URL | Request): Response {
  const url = String(input);
  if (url === `${ORIGIN}/robots.txt`) return new Response("User-agent: *\nAllow: /", { status: 200 });
  if (url === TRANSCRIPT) return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello world", {
    status: 200, headers: { "content-type": "text/vtt" },
  });
  return new Response("not found", { status: 404 });
}

afterEach(() => vi.restoreAllMocks());

describe("fetchTranscript production transport path", () => {
  it("checks robots, streams the recorded response, and preserves semantic query parameters in evidence identity", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => recordedFetch(input));
    const result = await fetchTranscript(TRANSCRIPT);
    expect(result).toMatchObject({
      outcome: "success", stable_url: `${ORIGIN}/transcript.vtt?format=vtt`, raw_payload: expect.stringContaining("Hello world"),
      cleaned_body: "Hello world", content_type: "text/vtt",
    });
    expect(network.mock.calls.map(([input]) => String(input))).toEqual([`${ORIGIN}/robots.txt`, TRANSCRIPT]);
  });

  it("does not request a transcript that robots denies", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return url === `${ORIGIN}/robots.txt`
        ? new Response("User-agent: *\nDisallow: /transcript.vtt", { status: 200 })
        : new Response("unexpected", { status: 500 });
    });
    await expect(fetchTranscript(TRANSCRIPT)).resolves.toMatchObject({ outcome: "robots_denied", reason_code: "robots_denied" });
    expect(network).toHaveBeenCalledOnce();
  });

  it("returns stable HTTP, cap, and timeout outcomes without relying on error text", async () => {
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === `${ORIGIN}/robots.txt` ? new Response("", { status: 404 }) : new Response("missing", { status: 404 }));
    await expect(fetchTranscript(TRANSCRIPT)).resolves.toMatchObject({ outcome: "http_error", reason_code: "http_404" });
    http.mockRestore();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === `${ORIGIN}/robots.txt` ? new Response("", { status: 404 }) : new Response("oversized", { status: 200 }));
    await expect(fetchTranscript(TRANSCRIPT, { maxBytes: 4 })).resolves.toMatchObject({ outcome: "size_limited", reason_code: "response_size_limit" });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/robots.txt`) return new Response("", { status: 404 });
      throw new DOMException("deadline", "TimeoutError");
    });
    await expect(fetchTranscript(TRANSCRIPT)).resolves.toMatchObject({ outcome: "timeout", reason_code: "request_timeout" });
  });

  it("records parse-empty and transient failures as structured outcomes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === `${ORIGIN}/robots.txt`
        ? new Response("", { status: 404 })
        : new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000", { status: 200 }),
    );
    await expect(fetchTranscript(TRANSCRIPT)).resolves.toMatchObject({
      outcome: "parse_empty", reason_code: "cleaned_body_empty",
    });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/robots.txt`) return new Response("", { status: 404 });
      throw new TypeError("network unavailable");
    });
    await expect(fetchTranscript(TRANSCRIPT)).resolves.toMatchObject({
      outcome: "transient_error", reason_code: "request_error",
    });
  });
});
