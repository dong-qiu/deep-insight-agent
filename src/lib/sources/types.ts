/** 源适配层的统一中间产物：各适配器把外部源解析成 RawItem，collector 再归一化为 ContentItem。 */
import type { BodyKind, Source } from "../types.js";

export interface RawItem {
  url: string;
  title: string;
  author: string | null;
  published_at: string | null; // 原始发布时间字符串（可能非 ISO，下游不强转）
  body: string;
  body_kind?: BodyKind; // 料源形态；播客单集的 RSS 正文必须显式为 show_notes
  /** 由适配器按 enclosure / iTunes / Podcast Namespace 元数据识别，不能由正文长短猜测。 */
  is_podcast_episode?: boolean;
  transcript_url?: string; // 播客转写稿 URL（parseRss 从 <podcast:transcript> 解析；fetchRss 不抓取）
  raw: string; // 原始片段（JSON 串），collector 存档供校验反查
}

/** A transcript response is deliberately structured: failures remain observable without being
 * mistaken for a successful RSS collection. `requested_url` is never persisted in the evidence
 * envelope because providers may place expiring signatures in its query string. */
export type TranscriptFetchResult =
  | {
    outcome: "success";
    stable_url: string;
    raw_payload: string;
    cleaned_body: string;
    bytes: number;
    duration_ms: number;
    content_type: string | null;
  }
  | {
    outcome: "robots_denied" | "http_error" | "size_limited" | "timeout" | "parse_empty" | "transient_error";
    stable_url: string;
    bytes: number | null;
    duration_ms: number;
    reason_code: string | null;
  };

export interface SourceAdapter {
  fetch(source: Source): Promise<RawItem[]>;
}
