/** P0b revision registry 的共享实现。
 *
 * 采集与主题流水线都引用 ContentItem；把 revision 规则收在 DB 边界，避免两条链路
 * 对同一 content_hash 生成不兼容的历史版本。snapshot 只保留可解释元数据，不含正文或 raw_ref。 */
import type { ContentItem, Source } from "../types.js";
import { canonicalHash, type EntityRef } from "./provenance-facts.js";

const CONTENT_REVISION_V2 = "content-v2";

export function contentItemRevision(item: ContentItem): string {
  return `${CONTENT_REVISION_V2}:${item.content_hash}`;
}

export function contentItemRevisionSnapshot(item: ContentItem): Record<string, unknown> {
  return {
    url: item.url,
    source_id: item.source_id,
    published_at: item.published_at,
    body_length: item.body.length,
    content_hash: item.content_hash,
  };
}

export function contentItemRef(item: ContentItem, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "content_item", locator: { kind: "id", id: item.id }, revision: contentItemRevision(item), role };
}

/** Source 没有业务 version 字段，故由脱敏、规范化配置生成 revision；topic_ids 的先后不影响配置语义。 */
export function sourceConfigSnapshot(source: Source): Record<string, unknown> {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    endpoint: source.endpoint,
    topic_ids: [...source.topic_ids].sort(),
    fetch_interval: source.fetch_interval,
    // canonical JSON v1 intentionally仅接受整数；预算可以是小数，故以稳定十进制字符串进入脱敏 snapshot。
    backfill: source.backfill == null ? null : { depth: source.backfill.depth, max_cost: String(source.backfill.max_cost) },
    enabled: source.enabled,
    fetch_mode: source.fetch_mode ?? "feed",
    content_container: source.content_container ?? null,
  };
}

export function sourceConfigRevision(source: Source): string {
  return `source-v1:${canonicalHash(sourceConfigSnapshot(source))}`;
}

export function sourceConfigRef(source: Source, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "source", locator: { kind: "id", id: source.id }, revision: sourceConfigRevision(source), role };
}
