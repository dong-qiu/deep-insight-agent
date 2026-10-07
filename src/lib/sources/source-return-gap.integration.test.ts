import { afterEach, expect, it, vi } from "vitest";
import { fetchRss } from "./rss.js";
import { fetchArticle } from "./article.js";
import { fetchRobots } from "./robots.js";
import type { Source } from "../types.js";
const { dns } = vi.hoisted(() => ({ dns: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns }));
const origin = "https://public.example";
const source: Source = { id: "review", name: "Review", type: "rss", endpoint: `${origin}/feed`, topic_ids: [], enabled: true, fetch_interval: "1h", backfill: null };
function deferred() { let resolve!: () => void; let reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { vi.restoreAllMocks(); });
/** Real source child-return ownership gap from the independent reviewer. Every test joins its
 * cleanup before asserting, including rejection, so a red test cannot leave detached work. */
const cases = (["robots", "rss", "article"] as const).flatMap(entry =>
 (["resolve", "reject"] as const).map(cleanupMode => ({ entry, cleanupMode })));
it.each(cases)("$entry joins an owned body cleanup $cleanupMode in the child-return await gap", async ({ entry, cleanupMode }) => {
 dns.mockResolvedValue([{ address: "8.8.8.8" }]);
 const controller = new AbortController(); const cleanup = deferred();
 const reason = cleanupMode === "resolve" ? null : { opaque: entry };
 const bodyCancel = vi.fn(() => cleanup.promise);
 const stream = new ReadableStream<Uint8Array>({ cancel: bodyCancel });
 const response = new Response(stream, { headers: { "content-type": "text/html" } });
 let statusReads = 0;
 vi.spyOn(response, "status", "get").mockImplementation(() => {
   statusReads += 1;
   // safeFetch last check for robots, retry last check for RSS/article.
   if (statusReads === (entry === "robots" ? 1 : 2)) queueMicrotask(() => controller.abort(reason));
   return 200;
 });
 vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
   if (entry !== "robots" && String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:");
   return response;
 });
 let settled = false;
 const promise = entry === "robots" ? fetchRobots(origin, undefined, { signal: controller.signal })
  : entry === "rss" ? fetchRss(source, { signal: controller.signal })
  : fetchArticle(`${origin}/article`, undefined, { signal: controller.signal });
 const observed = promise.then(value => { settled = true; return { ok: true, value }; }, reason => { settled = true; return { ok: false, reason }; });
 await new Promise<void>(resolve => setImmediate(resolve));
 const facts = { settledBeforeCleanup: settled, cancelCalls: bodyCancel.mock.calls.length, statusReads, bodyLocked: stream.locked, bodyUsed: response.bodyUsed };
 if (cleanupMode === "resolve") cleanup.resolve(); else cleanup.reject(new Error("cleanup failed"));
 const result = await observed;
 console.log(entry, cleanupMode, JSON.stringify(facts));
 expect(result.ok).toBe(false);
 if (!result.ok && "reason" in result) expect(result.reason).toBe(reason);
 expect(facts.cancelCalls).toBe(1);
 expect(facts.settledBeforeCleanup).toBe(false);
 expect(facts.bodyUsed).toBe(true);
 expect(facts.bodyLocked).toBe(false);
 expect(bodyCancel).toHaveBeenCalledWith(reason);
 expect(fetch).toHaveBeenCalledTimes(entry === "robots" ? 1 : 2);
});
