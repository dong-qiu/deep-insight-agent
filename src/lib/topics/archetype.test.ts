/** archetype registry（纯）+ selectAnalysisItems 集成测（ADR-0010 Step1）。
 *  集成测专门堵第二轮评审 B-1：验证 topic.archetype 从 DB 经 rowToTopic 贯通到 rankAndDiversify 的 floor，
 *  避免「单测绿、线上 undefined 死代码」。 */
import { beforeEach, describe, expect, it } from "vitest";
import { selectAnalysisItems } from "../agents/scheduler.js";
import { type DB, openDb } from "../db/index.js";
import { getTopic, insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import type { ContentItem, Source, Topic } from "../types.js";
import { ARCHETYPE_REGISTRY, ARCHETYPE_VALUES, archetypeProfile, isArchetype } from "./archetype.js";

describe("archetype registry", () => {
  it("deep_vertical 无下限（软策略）；horizontal_pulse 有 relevanceFloor", () => {
    expect(ARCHETYPE_REGISTRY.deep_vertical.relevanceFloor).toBeUndefined();
    expect(ARCHETYPE_REGISTRY.horizontal_pulse.relevanceFloor).toBe(1);
  });
  it("isArchetype 校验合法值", () => {
    expect(isArchetype("horizontal_pulse")).toBe(true);
    expect(isArchetype("deep_vertical")).toBe(true);
    expect(isArchetype("bogus")).toBe(false);
    expect(isArchetype(undefined)).toBe(false);
  });
  it("archetypeProfile 未知/undefined 回退 deep_vertical（最保守）", () => {
    expect(archetypeProfile(undefined).relevanceFloor).toBeUndefined();
    expect(archetypeProfile("bogus").relevanceFloor).toBeUndefined();
    expect(archetypeProfile("horizontal_pulse").relevanceFloor).toBe(1);
  });
  it("ARCHETYPE_VALUES 覆盖 registry 全部 key", () => {
    expect([...ARCHETYPE_VALUES].sort()).toEqual(Object.keys(ARCHETYPE_REGISTRY).sort());
  });
});

describe("selectAnalysisItems × archetype（集成·字段贯通，B-1）", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    // content_item.source_id 有 FK → 先插入源 s1（否则插入失败、listContentForTopic 返 0）
    insertSource(db, {
      id: "s1", name: "S1", type: "rss", endpoint: "https://x/feed", industry: "ai-swe",
      topic_ids: [], fetch_interval: "24h", backfill: null, enabled: true,
    } as Source);
  });

  const mkTopic = (id: string, archetype: Topic["archetype"]): Topic => ({
    id, name: id, keywords: ["coding agent", "swe-bench"], industry: "ai-swe",
    language: "en", brief_schedule: "daily", enabled: true, archetype,
  });
  const mkCI = (id: string, topicId: string, text: string): ContentItem => ({
    id, source_id: "s1", url: `https://x/${id}`, title: text, author: null,
    published_at: "2026-06-22", fetched_at: "2026-06-22T00:00:00Z", language: "en",
    topic_ids: [topicId], tags: [], body: text, body_kind: "article", raw_ref: "",
    content_hash: `h_${id}`, fetch_status: "ok",
  });

  it("horizontal_pulse 主题：0 命中离题项被砍（archetype 经 DB→rowToTopic→floor 全程生效）", () => {
    insertTopic(db, mkTopic("t_h", "horizontal_pulse"));
    insertContentItem(db, mkCI("rel", "t_h", "a study on coding agent and SWE-bench"));
    insertContentItem(db, mkCI("noise", "t_h", "openai improves health diagnosis"));
    const topic = getTopic(db, "t_h")!;
    expect(topic.archetype).toBe("horizontal_pulse"); // 字段从 DB 读回（rowToTopic）
    const out = selectAnalysisItems(db, topic, { since: "2026-06-01", limit: 15 });
    expect(out.map((x) => x.id)).toEqual(["rel"]); // noise 被 floor 砍
  });

  it("deep_vertical 主题：同样两条全保留（软策略，护研究源）", () => {
    insertTopic(db, mkTopic("t_v", "deep_vertical"));
    insertContentItem(db, mkCI("rel", "t_v", "a study on coding agent"));
    insertContentItem(db, mkCI("noise", "t_v", "openai health diagnosis"));
    const out = selectAnalysisItems(db, getTopic(db, "t_v")!, { since: "2026-06-01", limit: 15 });
    expect(out.map((x) => x.id).sort()).toEqual(["noise", "rel"]); // 都在
  });

  it("horizontal 冷启动豁免：coldStart 时不过滤（首报给足份量）", () => {
    insertTopic(db, mkTopic("t_h2", "horizontal_pulse"));
    insertContentItem(db, mkCI("rel", "t_h2", "coding agent"));
    insertContentItem(db, mkCI("noise", "t_h2", "unrelated health news"));
    const out = selectAnalysisItems(db, getTopic(db, "t_h2")!, { since: "2026-06-01", limit: 15, coldStart: true });
    expect(out.length).toBe(2); // 冷启动不砍
  });
});
