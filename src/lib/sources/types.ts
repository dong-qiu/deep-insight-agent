/** 源适配层的统一中间产物：各适配器把外部源解析成 RawItem，collector 再归一化为 ContentItem。 */
import type { BodyKind, Source } from "../types.js";

export interface RawItem {
  url: string;
  title: string;
  author: string | null;
  published_at: string | null; // 原始发布时间字符串（可能非 ISO，下游不强转）
  body: string;
  body_kind?: BodyKind; // 料源形态（ADR-0007）；适配器不设则归一化时默认 article
  transcript_url?: string; // 播客转写稿 URL（parseRss 从 <podcast:transcript> 解析；fetchRss 按开关抓取）
  raw: string; // 原始片段（JSON 串），collector 存档供校验反查
}

export interface SourceAdapter {
  fetch(source: Source): Promise<RawItem[]>;
}
