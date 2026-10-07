import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { getContentItem, getSource, getTopic, insertContentItem, insertSource, insertTopic, listSources, listTopics } from "./repos.js";
import { planRawArchive, writePlannedRawArchive } from "./raw-archive.js";
import { validateSourceInput, validateTopicInput, type Validated } from "./validate.js";
import { StaticSourceConfigSchema } from "../config/types.js";
import { getEffectiveSources, seedDefaults } from "../config/index.js";
import { rawToContentItem } from "../sources/normalize.js";
import { POST as topicPost } from "../../app/api/admin/topics/route.js";
import { PUT as topicPut } from "../../app/api/admin/topics/[id]/route.js";
import { POST as sourcePost } from "../../app/api/admin/sources/route.js";
import { PUT as sourcePut, DELETE as sourceDelete } from "../../app/api/admin/sources/[id]/route.js";

const state = vi.hoisted(() => ({ db: undefined as DB | undefined }));
vi.mock("./index.js", async (original) => ({ ...await original<typeof import("./index.js")>(), getDb: () => state.db! }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
const topicInput = { name: "AI Tools", keywords: ["tools"], facets: ["domain:software-engineering"], language: "en" };
const sourceInput = { name: "AI Feed", type: "rss", endpoint: "https://example.test/feed", topic_ids: [] };
const suffix = "000102030405060708090a0b0c0d0e0f";
function value<T>(result: Validated<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message); return result.value; }
const req = (body: unknown) => new Request("http://localhost/api/admin/config", { method: "POST", body: JSON.stringify(body) });
let db: DB;
let root: string;
beforeEach(() => {
  vi.mocked(randomBytes).mockClear();
  db = openDb(":memory:"); applyProvenanceMigrations(db); state.db = db;
  root = mkdtempSync(join(tmpdir(), "ia-d7-s2a-")); vi.stubEnv("DATA_DIR", root);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.mocked(randomBytes).mockReset(); });

describe("D7 S2a baseline consumers", () => {
  it("mixed opaque IDs round-trip config/seed and exact relations without renumbering", () => {
    const topics = ["t_ai_tools_abcd", `t_ai_tools_${suffix}`].map((id) => value(validateTopicInput({ ...topicInput, id })));
    const sources = ["src_ai_feed_abcd", `src_ai_feed_${suffix}`].map((id, i) => value(validateSourceInput({ ...sourceInput, id, topic_ids: [topics[i].id] })));
    const config = StaticSourceConfigSchema.parse({ defaultTopics: topics, defaultSources: sources });
    expect(seedDefaults(db, config)).toEqual({ topics: 2, sources: 2 });
    expect(seedDefaults(db, config)).toEqual({ topics: 0, sources: 0 });
    expect(listTopics(db)).toHaveLength(2); expect(getEffectiveSources(db, config)).toEqual(listSources(db));
    for (const [i, source] of sources.entries()) {
      expect(getTopic(db, topics[i].id)).toEqual(topics[i]); expect(getSource(db, source.id)).toMatchObject(source);
      const item = rawToContentItem({ url: `https://example.test/${i}`, title: "Synthetic", body: "Fact is supported.", raw: "synthetic raw", author: null, published_at: null }, source, "2026-10-07T00:00:00Z");
      insertContentItem(db, item);
      const raw = JSON.stringify({ source_id: source.id, topic_ids: source.topic_ids, body: item.body });
      const plan = planRawArchive(db, { contentId: item.id, raw });
      writePlannedRawArchive(db, plan, raw);
      expect(getContentItem(db, item.id)).toMatchObject({ id: item.id, source_id: source.id, topic_ids: [topics[i].id], raw_ref: plan.rawRef });
      expect(readFileSync(join(root, plan.rawRef), "utf8")).toBe(raw);
      expect(planRawArchive(db, { contentId: item.id, raw })).toEqual(plan);
    }
    expect(getSource(db, `${sources[0].id}_wrong`)).toBeNull();
    expect(() => insertTopic(db, topics[0])).toThrow(/UNIQUE/);
    expect(() => insertSource(db, sources[0])).toThrow(/UNIQUE/);
  });

  it("POST/PUT keep explicit identities; duplicate409, FK and transaction failure stay visible", async () => {
    for (const id of ["t_ai_tools_abcd", `t_ai_tools_${suffix}`]) {
      expect((await topicPost(req({ ...topicInput, id }))).status).toBe(201);
      expect((await topicPost(req({ ...topicInput, id }))).status).toBe(409);
      const response = await topicPut(req({ ...topicInput, id: "ignored", name: "Updated" }), { params: Promise.resolve({ id }) });
      expect(await response.json()).toMatchObject({ topic: { id, name: "Updated" } });
    }
    const source = value(validateSourceInput({ ...sourceInput, id: `src_ai_feed_${suffix}`, topic_ids: ["t_ai_tools_abcd"] }));
    expect((await sourcePost(req(source))).status).toBe(201);
    expect((await sourcePost(req(source))).status).toBe(409);
    expect(await (await sourcePut(req({ ...source, id: "ignored" }), { params: Promise.resolve({ id: source.id }) })).json()).toMatchObject({ source: { id: source.id } });
    const item = rawToContentItem({ url: "https://example.test/fk", title: "Synthetic", body: "Fact.", raw: "raw", author: null, published_at: null }, source, "2026-10-07T00:00:00Z");
    insertContentItem(db, item);
    expect((await sourceDelete(req({}), { params: Promise.resolve({ id: source.id }) })).status).toBe(409);
    expect(() => insertContentItem(db, { ...item, id: "ci_missing", url: "https://example.test/missing", source_id: "missing" })).toThrow(/FOREIGN KEY/);
    expect(() => db.transaction(() => { insertTopic(db, { ...value(validateTopicInput(topicInput, { existingId: "t_rollback" })) }); insertContentItem(db, { ...item, id: "ci_rollback", url: "https://example.test/rollback", source_id: "missing" }); })()).toThrow(/FOREIGN KEY/);
    expect(getTopic(db, "t_rollback")).toBeNull();
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it.each(["../escape", "/absolute", "a/b", "a\\b", "a\0b", "a.b", "a%2fb", "a b", "a\"b"])("rejects unsafe explicit and existing ID %j", (id) => {
    for (const opts of [{}, { existingId: id }]) {
      expect(validateTopicInput({ ...topicInput, id }, opts).ok).toBe(false);
      expect(validateSourceInput({ ...sourceInput, id }, opts).ok).toBe(false);
    }
    expect(() => planRawArchive(db, { contentId: id, raw: "raw" })).toThrow(/invalid/);
  });
});

describe("D7 S2a new generation contract (red before implementation)", () => {
  it("uses exactly16 bytes per automatic ID, preserves slug and full encoding", () => {
    vi.mocked(randomBytes).mockImplementation(((size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i))) as typeof randomBytes);
    expect(value(validateTopicInput(topicInput)).id).toBe(`t_ai_tools_${suffix}`);
    expect(value(validateSourceInput(sourceInput)).id).toBe(`src_ai_feed_${suffix}`);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16]]);
  });
  it("real Node CSPRNG wiring retains nonASCII folding and maximum slug", async () => {
    // Restore the actual implementation; no injected RNG in this test.
    const crypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    vi.mocked(randomBytes).mockImplementation(crypto.randomBytes);
    expect(value(validateTopicInput({ ...topicInput, name: "行业洞察" })).id).toMatch(/^t___[a-f0-9]{32}$/);
    expect(value(validateSourceInput({ ...sourceInput, name: "A".repeat(80) })).id).toMatch(/^src_a{30}_[a-f0-9]{32}$/);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16]]);
  });
  it("does not allocate for explicit/updates, but still allocates before later input rejection", () => {
    vi.mocked(randomBytes).mockImplementation(((size: number) => Buffer.alloc(size)) as typeof randomBytes);
    expect(value(validateTopicInput({ ...topicInput, id: " Static-ID " })).id).toBe("Static-ID");
    expect(value(validateSourceInput({ ...sourceInput, id: " Static-Source " })).id).toBe("Static-Source");
    expect(value(validateTopicInput({ ...topicInput, id: "ignored" }, { existingId: "t_old_abcd" })).id).toBe("t_old_abcd");
    expect(value(validateSourceInput(sourceInput, { existingId: "src_old_abcd" })).id).toBe("src_old_abcd");
    expect(validateTopicInput({ ...topicInput, name: " " }).ok).toBe(false);
    expect(validateSourceInput({ ...sourceInput, name: " " }).ok).toBe(false);
    expect(validateTopicInput(topicInput, { existingId: " untrimmed " }).ok).toBe(false);
    expect(randomBytes).not.toHaveBeenCalled();
    expect(validateTopicInput({ ...topicInput, keywords: [] }).ok).toBe(false);
    expect(validateSourceInput({ ...sourceInput, type: "api" }).ok).toBe(false);
    expect(value(validateTopicInput({ ...topicInput, id: " " })).id).toMatch(/^t_ai_tools_0{32}$/);
    expect(value(validateSourceInput({ ...sourceInput, id: " " })).id).toMatch(/^src_ai_feed_0{32}$/);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16], [16], [16]]);
  });
  it("actual POST auto generation and collision409 do not retry", async () => {
    vi.mocked(randomBytes).mockImplementation(((size: number) => Buffer.alloc(size, 0x1a)) as typeof randomBytes);
    for (const [post, body, prefix] of [[topicPost, topicInput, "t_ai_tools"], [sourcePost, sourceInput, "src_ai_feed"]] as const) {
      const created = await post(req(body)); expect(created.status).toBe(201);
      const json = await created.json(); expect((json.topic ?? json.source).id).toBe(`${prefix}_${"1a".repeat(16)}`);
      expect((await post(req(body))).status).toBe(409);
    }
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16], [16], [16]]);
  });
});
