/** 源适配注册表：按 Source.type 分发。新增源类型只在此加一支。 */
import type { Source } from "../types.js";
import { fetchArxiv } from "./arxiv.js";
import { applyGoldenSource } from "./podcast-golden.js";
import { fetchRss } from "./rss.js";
import type { RawItem, SourceFetchOptions } from "./types.js";

export type { RawItem, SourceAdapter } from "./types.js";

export function fetchFromSource(source: Source, opts: SourceFetchOptions = {}): Promise<RawItem[]> {
  opts.signal?.throwIfAborted();
  switch (source.type) {
    case "arxiv":
      if (opts.signal !== undefined) throw new Error("source_cancellation_unsupported");
      return fetchArxiv(source);
    case "rss":
      // rss 解析后过金牌源后处理（6d）：标题筛子 + 转写 URL 推导；非注册源原样透传。
      return fetchRss(source, opts).then((items) => {
        opts.signal?.throwIfAborted();
        return applyGoldenSource(source, items);
      });
    case "api":
      throw new Error(`source type 'api' 适配器待实现（${source.id}）`);
    default:
      throw new Error(`未知 source.type：${(source as Source).type}`);
  }
}
