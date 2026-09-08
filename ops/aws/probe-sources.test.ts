/** Exercise the exact self-contained probe payload with deterministic fetch responses. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const shell = readFileSync(fileURLToPath(new URL("./probe-sources.sh", import.meta.url)), "utf8");
const probe = shell.match(/read -r -d '' PROBE <<'JS' \|\| true\n([\s\S]*?)\nJS\n/)?.[1];
if (!probe) throw new Error("could not extract production probe payload");

function runProbe({ feed, mode = "feed", article = "", robots = "", robotsStatus = 404 }: {
  feed: string; mode?: "feed" | "full_text"; article?: string; robots?: string; robotsStatus?: number;
}) {
  const candidate = `const CANDIDATES = [{ id: "test", name: "Test", url: "https://feed.test/rss", mode: "${mode}", guesses: [] }];`;
  const payload = probe!.replace(/const CANDIDATES = \[[\s\S]*?\n\];/, candidate);
  const mock = `global.fetch = async (url) => {
    const u = String(url), robots = u.endsWith('/robots.txt'), article = u === 'https://article.test/release';
    return new Response(robots ? ${JSON.stringify(robots)} : article ? ${JSON.stringify(article)} : ${JSON.stringify(feed)}, {
      status: robots ? ${robotsStatus} : 200,
      headers: { 'content-type': robots ? 'text/plain' : article ? 'text/html' : 'application/rss+xml' },
    });
  };`;
  return spawnSync(process.execPath, ["-e", `${mock}\n${payload}`], { encoding: "utf8" });
}

it("passes a feed only when the same body field selected by rss.ts meets the minimum", () => {
  const long = "x".repeat(220);
  const pass = runProbe({ feed: `<rss><channel><item><content:encoded><![CDATA[${long}]]></content:encoded><description>short</description></item></channel></rss>` });
  expect(pass.status, pass.stderr).toBe(0);
  expect(JSON.parse(pass.stdout).feed).toMatchObject({ selectedChars: 220, pass: true });

  // rss.ts uses content:encoded when it exists; it must not silently fall back to
  // a longer description, or a probe pass would not predict production ingestion.
  const fail = runProbe({ feed: `<rss><channel><item><content:encoded>short</content:encoded><description>${long}</description></item></channel></rss>` });
  expect(fail.status).toBe(1);
  expect(JSON.parse(fail.stdout)).toMatchObject({ pass: false, blocked: "feed body below minimum" });
});

it("returns non-zero when feed robots disallow the candidate", () => {
  const blocked = runProbe({ feed: "<rss><channel><item><description>ignored</description></item></channel></rss>", robots: "User-agent: InsightAgentBot\nDisallow: /rss\n", robotsStatus: 200 });
  expect(blocked.status).toBe(1);
  expect(JSON.parse(blocked.stdout)).toMatchObject({ pass: false, blocked: "robots(feed)" });
});

it("fails a full-text candidate when the linked article is too short", () => {
  const feed = "<feed><entry><link href=\"https://article.test/release\" /></entry></feed>";
  const fail = runProbe({ feed, mode: "full_text", article: "<html><body>short</body></html>" });
  expect(fail.status).toBe(1);
  expect(JSON.parse(fail.stdout)).toMatchObject({ pass: false, blocked: "article body below minimum or unavailable" });

  const pass = runProbe({ feed, mode: "full_text", article: `<html><body>${"x".repeat(220)}</body></html>` });
  expect(pass.status, pass.stderr).toBe(0);
  expect(JSON.parse(pass.stdout)).toMatchObject({ pass: true, article: { pass: true } });
});
