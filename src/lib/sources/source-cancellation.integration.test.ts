/** Real source/robots/transport/parser paths; only DNS and HTTP/stream boundaries are controlled. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "../types.js";
import { fetchArticle, fetchArticleBody } from "./article.js";
import { fetchFromSource } from "./index.js";
import { fetchRobots } from "./robots.js";
import { fetchPodcastProgramPage, fetchRss, fetchTranscript } from "./rss.js";
import { fetchWithRetry, readTextCapped, safeFetch } from "./safe-fetch.js";

const { dns } = vi.hoisted(() => ({ dns: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns }));
const ORIGIN = "https://public.example";
const FEED = `${ORIGIN}/feed`;
const ARTICLE = `${ORIGIN}/article`;
const XML = `<rss><channel><item><title>Normal</title><link>/article</link><description>Original summary</description></item></channel></rss>`;
const PAGE = `<body><nav>omit</nav><article>${"Full article paragraph. ".repeat(30)}</article></body>`;
const source: Source = { id: "synthetic", name: "Synthetic", type: "rss", endpoint: FEED, topic_ids: [], enabled: true, fetch_interval: "1h", backfill: null };
const rss = fetchRss;
const registry = fetchFromSource;
const article = fetchArticle;
const articleBody = fetchArticleBody;
const transport = safeFetch;
const retry = fetchWithRetry;
const robots = fetchRobots;
const read = readTextCapped;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  const state = { settled: false };
  const result = promise.then((value) => { state.settled = true; return { status: "ok", value } as const; },
    (reason: unknown) => { state.settled = true; return { status: "error", reason } as const; });
  return { state, result };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function rejection(promise: Promise<unknown>, reason: unknown) {
  const out = await observe(promise).result;
  expect(out.status).toBe("error");
  if (out.status === "error") expect(out.reason).toBe(reason);
}
function recorded(input: string | URL | Request) {
  const url = String(input);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:");
  if (url === FEED) return new Response(XML);
  if (url === ARTICLE) return new Response(PAGE, { headers: { "content-type": "text/html" } });
  return new Response("unknown", { status: 404 });
}
beforeEach(() => {
  dns.mockReset().mockResolvedValue([{ address: "8.8.8.8" }]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => recorded(input));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("source native cancellation identity", () => {
  it.each([null, 0, false, "opaque-reason", { opaque: true }])("preserves an already-aborted reason %j at every real entry", async (reason) => {
    const controller = new AbortController(); controller.abort(reason);
    const opts = { signal: controller.signal };
    await rejection(rss(source, opts), reason);
    await rejection(article(ARTICLE, undefined, opts), reason);
    await rejection(articleBody(ARTICLE, undefined, opts), reason);
    await rejection(robots(ORIGIN, undefined, opts), reason);
    await rejection(transport(FEED, opts), reason);
    await rejection(retry(FEED, opts, []), reason);
    const response = new Response(XML);
    await rejection(read(response, undefined, opts), reason);
    expect(response.bodyUsed).toBe(false);
    let thrown = false;
    try { registry({ ...source, type: "arxiv" }, opts); }
    catch (error) { thrown = true; expect(error).toBe(reason); }
    expect(thrown).toBe(true);
    expect(dns).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("live arxiv opt-in rejects synchronously before queue; undefined retains its normal Promise", async () => {
    const controller = new AbortController();
    expect(() => registry({ ...source, type: "arxiv" }, { signal: controller.signal })).toThrow("source_cancellation_unsupported");
    expect(fetch).not.toHaveBeenCalled();
    expect(() => registry({ ...source, type: "api" })).toThrow("待实现");
    expect(() => registry({ ...source, type: "unknown" } as unknown as Source)).toThrow("未知");
    const pending = registry({ ...source, type: "arxiv" }, { signal: undefined });
    expect(pending).toBeInstanceOf(Promise); await expect(pending).resolves.toEqual([]);
  });

  it.each(["resolve", "reject"] as const)("joins DNS %s after cancellation before any HTTP", async (mode) => {
    const wait = deferred<{ address: string }[]>(); dns.mockImplementation(() => wait.promise);
    const controller = new AbortController(); const reason = { first: mode };
    const work = observe(transport(FEED, { signal: controller.signal }));
    await turn(); controller.abort(reason); await turn();
    expect(work.state.settled).toBe(false); expect(fetch).not.toHaveBeenCalled();
    if (mode === "resolve") wait.resolve([{ address: "8.8.8.8" }]); else wait.reject(new Error("late dns failure"));
    const out = await work.result; expect(out).toEqual({ status: "error", reason });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("joins QPS hook %s without a later transport", async (mode) => {
    const gate = deferred<void>(); const entered = deferred<void>();
    const controller = new AbortController();
    const work = observe(transport(FEED, { signal: controller.signal, beforeRequest: async () => { entered.resolve(); await gate.promise; } }));
    await entered.promise; controller.abort(null); await turn(); expect(work.state.settled).toBe(false);
    if (mode === "resolve") gate.resolve(); else gate.reject(new Error("hook failure"));
    expect(await work.result).toEqual({ status: "error", reason: null }); expect(fetch).not.toHaveBeenCalled();
  });

  it("actual fetch receives task signal plus existing timeout; late body cleanup is joined and preserves null", async () => {
    const pending = deferred<Response>(); const entered = deferred<void>(); const cleanup = deferred<void>();
    let requestSignal: AbortSignal | null | undefined;
    vi.mocked(fetch).mockImplementation(async (_input, init) => { requestSignal = init?.signal; entered.resolve(); return pending.promise; });
    const controller = new AbortController(); const work = observe(transport(FEED, { signal: controller.signal }));
    await entered.promise; expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal).not.toBe(controller.signal); controller.abort(null);
    expect(requestSignal?.aborted).toBe(true);
    const cancel = vi.fn(() => cleanup.promise);
    pending.resolve({ status: 200, body: { cancel } } as unknown as Response);
    await turn(); expect(cancel).toHaveBeenCalledOnce(); expect(work.state.settled).toBe(false);
    cleanup.reject(new Error("cleanup failed"));
    expect(await work.result).toEqual({ status: "error", reason: null }); expect(fetch).toHaveBeenCalledOnce();
  });

  it("late rejected HTTP preserves opaque reason and does not retry", async () => {
    const pending = deferred<Response>(); const entered = deferred<void>();
    vi.mocked(fetch).mockImplementation(async () => { entered.resolve(); return pending.promise; });
    const controller = new AbortController(); const reason = { first: "cancel" };
    const work = observe(retry(FEED, { signal: controller.signal }, [0, 0]));
    await entered.promise; controller.abort(reason); pending.reject(new Error("late network"));
    expect(await work.result).toEqual({ status: "error", reason }); expect(fetch).toHaveBeenCalledOnce();
  });

  it("retry rechecks cancellation in the child-return await gap and joins response cleanup", async () => {
    const controller = new AbortController(); const response = new Response("late body");
    const cancel = vi.spyOn(response.body!, "cancel");
    // Schedule the owner cancellation at safeFetch's last synchronous response check, before
    // fetchWithRetry resumes its await. Retain a real Response/body rather than mocking wrappers.
    vi.spyOn(response, "status", "get").mockImplementation(() => {
      queueMicrotask(() => controller.abort(null)); return 200;
    });
    vi.mocked(fetch).mockResolvedValue(response);
    await rejection(retry(FEED, { signal: controller.signal }, []), null);
    expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["5xx", "network"] as const)("cancels %s retry delay with null and clears its timer", async (mode) => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementation(async () => { if (mode === "network") throw new Error("network"); return new Response("unavailable", { status: 503 }); });
      const controller = new AbortController(); const work = observe(retry(FEED, { signal: controller.signal }, [1_000, 3_000]));
      await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledOnce();
      controller.abort(null); await vi.advanceTimersByTimeAsync(0);
      expect(await work.result).toEqual({ status: "error", reason: null });
      await vi.advanceTimersByTimeAsync(10_000); expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a redirect cancellation after the actual response prevents the next DNS and HTTP hop", async () => {
    const cleanup = deferred<void>(); const entered = deferred<void>();
    const cancel = vi.fn(() => { entered.resolve(); return cleanup.promise; });
    vi.mocked(fetch).mockResolvedValue({ status: 302, headers: new Headers({ location: `${ORIGIN}/next` }), body: { cancel } } as unknown as Response);
    const controller = new AbortController(); const work = observe(transport(FEED, { signal: controller.signal }));
    await entered.promise; controller.abort(false); cleanup.resolve();
    expect(await work.result).toEqual({ status: "error", reason: false });
    expect(fetch).toHaveBeenCalledOnce(); expect(dns).toHaveBeenCalledOnce();
  });
});

describe("controlled body reader true join", () => {
  it.each([null, { opaque: "body" }])("joins pending read and rejecting cancel before lock cleanup: %j", async (reason) => {
    const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>(); const cleanup = deferred<void>();
      const reader = { read: vi.fn(() => pendingRead.promise), cancel: vi.fn(() => cleanup.promise), releaseLock: vi.fn(() => { throw new Error("release also rejects"); }) };
    const response = { body: { getReader: () => reader } } as unknown as Response;
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const work = observe(read(response, undefined, { signal: controller.signal }));
    await turn(); controller.abort(reason); await turn();
    expect(reader.cancel).toHaveBeenCalledWith(reason); expect(work.state.settled).toBe(false);
    cleanup.reject(new Error("cancel rejects")); await turn();
    expect(work.state.settled).toBe(false); expect(reader.releaseLock).not.toHaveBeenCalled();
    pendingRead.reject(new Error("read rejects later"));
    expect(await work.result).toEqual({ status: "error", reason });
    expect(reader.releaseLock).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("real ReadableStream cancel causes reader termination and unlocks the body", async () => {
    const started = deferred<void>(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { started.resolve(); }, cancel });
    const response = new Response(stream); const controller = new AbortController();
    const work = observe(read(response, undefined, { signal: controller.signal }));
    await started.promise; controller.abort(0);
    expect(await work.result).toEqual({ status: "error", reason: 0 });
    expect(cancel).toHaveBeenCalledWith(0); expect(stream.locked).toBe(false);
  });

  it("fallback text() is truly joined and cannot return a late body after cancellation", async () => {
    const pending = deferred<string>(); const text = vi.fn(() => pending.promise);
    const response = { body: null, text } as unknown as Response;
    const controller = new AbortController(); const work = observe(read(response, undefined, { signal: controller.signal }));
    controller.abort(null); await turn(); expect(work.state.settled).toBe(false);
    pending.resolve("late body"); expect(await work.result).toEqual({ status: "error", reason: null });
  });

  it("RSS and article cannot turn an aborted robots reader into allow-all/null", async () => {
    for (const entry of ["rss", "article"] as const) {
      const started = deferred<void>(); const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const getReader = stream.getReader.bind(stream);
      vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); started.resolve(); return reader; });
      vi.mocked(fetch).mockResolvedValue(new Response(stream));
      const controller = new AbortController();
      const work = observe<unknown>(entry === "rss" ? rss(source, { signal: controller.signal }) : article(ARTICLE, null, { signal: controller.signal })); await started.promise; controller.abort(null);
      expect(await work.result).toEqual({ status: "error", reason: null }); expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce(); vi.mocked(fetch).mockClear();
    }
  });

  it.each(["rss", "article"] as const)("%s payload reader receives cancellation after robots succeeds", async (entry) => {
    const started = deferred<void>(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel }); const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); started.resolve(); return reader; });
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? recorded(input)
      : new Response(stream, { headers: { "content-type": entry === "rss" ? "application/xml" : "text/html" } }));
    const controller = new AbortController(); const reason = { first: entry };
    const work = observe<unknown>(entry === "rss" ? rss(source, { signal: controller.signal }) : article(ARTICLE, null, { signal: controller.signal }));
    await started.promise; controller.abort(reason); controller.abort(new Error("second"));
    expect(await work.result).toEqual({ status: "error", reason }); expect(cancel).toHaveBeenCalledWith(reason);
    expect(fetch).toHaveBeenCalledTimes(2); expect(stream.locked).toBe(false);
  });
});

describe("source normal-path parity and safety", () => {
  it("RSS registry and article preserve exact normal outputs with live signal and without signal", async () => {
    const controller = new AbortController();
    expect(await registry(source, { signal: controller.signal })).toEqual(await registry(source));
    const result = await article(ARTICLE, null, { signal: controller.signal });
    expect(result).toEqual(await article(ARTICLE)); expect(result?.raw_html).toBe(PAGE);
    expect(await articleBody(ARTICLE, null, { signal: controller.signal })).toBe(result?.body_html);
  });

  it("normal robots network fail-open, 404, 5xx, onBytes and cap remain unchanged", async () => {
    const controller = new AbortController(); const opts = { signal: controller.signal };
    vi.mocked(fetch).mockRejectedValue(new Error("network"));
    expect(await robots(ORIGIN, undefined, opts)).toEqual({ disallow: [] });
    for (const status of [404, 503]) {
      vi.mocked(fetch).mockResolvedValue(new Response("", { status }));
      expect(await robots(ORIGIN, undefined, opts)).toEqual(await fetchRobots(ORIGIN));
    }
    vi.mocked(fetch).mockImplementation(async () => new Response("User-agent: *\nDisallow: /private"));
    const onBytes = vi.fn(); await robots(ORIGIN, undefined, { ...opts, onBytes });
    expect(onBytes).toHaveBeenCalledWith(Buffer.byteLength("User-agent: *\nDisallow: /private"));
    await expect(robots(ORIGIN, undefined, { ...opts, maxBytes: 4 })).rejects.toMatchObject({ code: "response_size_limit" });
  });

  it("normal article non-ok, non-HTML, short body and network failure remain null", async () => {
    const controller = new AbortController();
    for (const reply of [() => new Response("", { status: 404 }), () => new Response("pdf", { headers: { "content-type": "application/pdf" } }), () => new Response("<article>short</article>", { headers: { "content-type": "text/html" } })]) {
      vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? new Response("", { status: 404 }) : reply());
      expect(await article(ARTICLE, null, { signal: controller.signal })).toBeNull();
    }
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /article") : recorded(input));
    expect(await article(ARTICLE, null, { signal: controller.signal })).toBeNull();
    expect(await article("file:///invalid", null, { signal: controller.signal })).toBeNull();
  });

  it("ordinary article network errors keep the original two retries and null result", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      vi.mocked(fetch).mockImplementation(async (input) => {
        if (String(input).endsWith("/robots.txt")) return recorded(input);
        throw new Error("network unavailable");
      });
      const work = observe(article(ARTICLE, null, { signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await work.result).toEqual({ status: "ok", value: null });
      expect(fetch).toHaveBeenCalledTimes(4); expect(controller.signal.aborted).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("request timeout remains transient/fail-open when task signal is live", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"));
    expect(await robots(ORIGIN, undefined, { signal: controller.signal })).toEqual({ disallow: [] });
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"));
    expect((await retry(FEED, { signal: controller.signal }, [0, 0])).status).toBe(200);
    expect(controller.signal.aborted).toBe(false);
  });

  it("registry golden source filtering and podcast metadata are unchanged with opt-in signal", async () => {
    const lex = { ...source, endpoint: "https://lexfridman.com/feed" };
    const episode = (title: string) => `<item><title>${title}</title><link>https://lexfridman.com/episode/</link><description>show notes</description><enclosure type="audio/mpeg" url="https://audio.example/ep.mp3"/></item>`;
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? recorded(input) : new Response(`<rss><channel>${episode("AI and NVIDIA")}${episode("Vikings")}</channel></rss>`));
    const output = await registry(lex, { signal: new AbortController().signal });
    expect(output).toEqual(await registry(lex)); expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ body: "show notes", body_kind: "show_notes", is_podcast_episode: true, transcript_url: "https://lexfridman.com/episode-transcript/" });
    expect(fetch).toHaveBeenCalledTimes(4); // two feed+robots pairs, no transcript transport
  });

  it("article container overrides keep the original raw response and extraction", async () => {
    const body = `<body><article>${"generic ".repeat(40)}</article><div class="custom">${"preferred ".repeat(40)}</div></body>`;
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? recorded(input) : new Response(body, { headers: { "content-type": "text/html" } }));
    const result = await article(ARTICLE, "custom", { signal: new AbortController().signal });
    expect(result).toEqual(await article(ARTICLE, "custom"));
    expect(result?.raw_html).toBe(body); expect(result?.body_html).toContain("preferred"); expect(result?.body_html).not.toContain("generic");
  });

  it("normal live-signal retry count, QPS hop ordering and redirect SSRF remain unchanged", async () => {
    const controller = new AbortController(); const beforeRequest = vi.fn(async () => {});
    vi.mocked(fetch).mockImplementationOnce(async () => new Response("", { status: 503 })).mockImplementationOnce(async () => new Response("ok"));
    expect((await retry(FEED, { signal: controller.signal, beforeRequest }, [0, 0])).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2); expect(beforeRequest).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockClear().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(transport(FEED, { signal: controller.signal })).rejects.toThrow("SSRF"); expect(fetch).toHaveBeenCalledOnce();
  });

  it("cap truncation and repair preserve original bytes and source metadata", async () => {
    const controller = new AbortController();
    const stream = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("abc")); c.enqueue(new TextEncoder().encode("defgh")); c.close(); } }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await read(stream(), 5, { truncate: true, signal: controller.signal })).toBe(await readTextCapped(stream(), 5, { truncate: true }));
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/robots.txt") ? recorded(input) : new Response(`<rss><channel><item><title>One</title><link>/article</link><description><![CDATA[ok]]></description></item><item><description><![CDATA[trunc`));
    expect(await rss(source, { signal: controller.signal })).toEqual(await fetchRss(source));
  });

  it("unchanged no-signal podcast consumers retain their structured outcomes and gates", async () => {
    const gate = vi.fn(async () => {});
    const transcript = await fetchTranscript(ARTICLE, { beforeRequest: gate });
    expect(transcript.outcome).toBe("success"); expect(gate).toHaveBeenCalledTimes(2);
    gate.mockClear(); const program = await fetchPodcastProgramPage(ARTICLE, { beforeRequest: gate });
    expect(program.outcome).toBe("success"); expect(gate).toHaveBeenCalledTimes(2);
  });
});
