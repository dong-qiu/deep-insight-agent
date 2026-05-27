/** arXiv API 适配器：Source.endpoint = 完整的 arXiv API query URL（含 search_query）。 */
import type { Source } from "../types.js";
import { UA } from "./robots.js";
import { readTextCapped, safeFetch } from "./safe-fetch.js";
import type { RawItem } from "./types.js";
import { asArray, text, xml } from "./xml.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseArxiv(atom: string): RawItem[] {
  const feed = (xml.parse(atom) as any)?.feed;
  return asArray<any>(feed?.entry).map((e): RawItem => {
    const links = asArray<any>(e.link);
    const alt = links.find((l) => l["@_rel"] === "alternate")?.["@_href"];
    const authors = asArray<any>(e.author);
    return {
      url: text(alt) || text(e.id),
      title: text(e.title).replace(/\s+/g, " ").trim(),
      author: authors.length ? text(authors[0]?.name) || null : null,
      published_at: text(e.published) || null,
      body: text(e.summary).trim(),
      raw: JSON.stringify(e),
    };
  });
}

// arXiv 限速 3s/req（见 source-feasibility 风险表）：进程级最小间隔节流，
// 串行展开多个 cs.* query 时不再触 429。ARXIV_MIN_INTERVAL_MS 可覆盖。
const ARXIV_MIN_INTERVAL_MS = Number(process.env.ARXIV_MIN_INTERVAL_MS) || 3000;
let arxivGate: Promise<unknown> = Promise.resolve();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 串行排队 + 保证两次 arXiv 请求起点间隔 ≥ ARXIV_MIN_INTERVAL_MS。 */
function throttleArxiv<T>(fn: () => Promise<T>): Promise<T> {
  const run = arxivGate.then(() => fn());
  // 下一个请求需等「本请求完成 + 间隔」，把起点拉开 ≥ 3s
  arxivGate = run.then(() => sleep(ARXIV_MIN_INTERVAL_MS), () => sleep(ARXIV_MIN_INTERVAL_MS));
  return run;
}

export async function fetchArxiv(source: Source): Promise<RawItem[]> {
  return throttleArxiv(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await safeFetch(source.endpoint, { headers: { "user-agent": UA } });
      if (res.status === 429 && attempt < 2) {
        await sleep(ARXIV_MIN_INTERVAL_MS * (attempt + 2)); // 429 退避后重试
        continue;
      }
      if (!res.ok) throw new Error(`arxiv fetch ${res.status}：${source.endpoint}`);
      return parseArxiv(await readTextCapped(res));
    }
  });
}
