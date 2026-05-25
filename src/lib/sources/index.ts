/** 源适配注册表：按 Source.type 分发。新增源类型只在此加一支。 */
import type { Source } from "../types.js";
import { fetchArxiv } from "./arxiv.js";
import { fetchRss } from "./rss.js";
import type { RawItem } from "./types.js";

export type { RawItem, SourceAdapter } from "./types.js";

export function fetchFromSource(source: Source): Promise<RawItem[]> {
  switch (source.type) {
    case "arxiv":
      return fetchArxiv(source);
    case "rss":
      return fetchRss(source);
    case "api":
      throw new Error(`source type 'api' 适配器待实现（${source.id}）`);
    default:
      throw new Error(`未知 source.type：${(source as Source).type}`);
  }
}
