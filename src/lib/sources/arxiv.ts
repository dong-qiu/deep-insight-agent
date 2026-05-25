/** arXiv API 适配器：Source.endpoint = 完整的 arXiv API query URL（含 search_query）。 */
import type { Source } from "../types.js";
import { UA } from "./robots.js";
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

export async function fetchArxiv(source: Source): Promise<RawItem[]> {
  const res = await fetch(source.endpoint, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`arxiv fetch ${res.status}：${source.endpoint}`);
  return parseArxiv(await res.text());
}
