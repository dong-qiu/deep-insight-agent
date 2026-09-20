import { describe, expect, it } from "vitest";
import type { ContentItem } from "../types.js";
import { contentItemRevision, contentItemRevisionSnapshot } from "./provenance-revisions.js";

const item: ContentItem = { id: "c1", source_id: "s1", url: "https://example.test/a", title: "A", author: null, published_at: "2026-09-01T00:00:00Z", fetched_at: "2026-09-02T00:00:00Z", language: "en", topic_ids: [], tags: [], body: "body", body_kind: "article", raw_ref: "private", content_hash: "hash", fetch_status: "ok" };

describe("content v4 review snapshot", () => {
  it("freezes display metadata but never body or raw_ref", () => {
    expect(contentItemRevisionSnapshot(item)).toEqual({ url: item.url, source_id: item.source_id, title: item.title, published_at: item.published_at, fetched_at: item.fetched_at, body_kind: "article", fetch_status: "ok", body_length: 4, content_hash: "hash" });
    expect(contentItemRevision(item)).toMatch(/^content-v4:[a-f0-9]{64}$/);
    expect(JSON.stringify(contentItemRevisionSnapshot(item))).not.toContain("private");
  });
});
