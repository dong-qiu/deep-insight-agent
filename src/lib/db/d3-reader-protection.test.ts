import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createD3Fixture, modes, since } from "../../../evals/fixtures/d3-reader.js";
import { openReadonlyDb, type DB } from "./connection.js";
import { buildTopicGraphData, groupDrillInsights, insightsCooccurring, insightsMentioningEntity, loadTopicInsights, reportLinksByInsight } from "./graph.js";

let db: DB;
vi.mock("./index.js", async importOriginal => ({ ...await importOriginal<typeof import("./index.js")>(), getDb: () => db }));
import { GET } from "../../app/api/graph/drill/route.js";
let root: string;
let expected: string[];
const previousDataDir = process.env.DATA_DIR;
const fingerprint = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "d3-protection-"));
  process.env.DATA_DIR = root;
  const fixture = createD3Fixture(root, 50);
  expected = fixture.expected;
  db = openReadonlyDb(fixture.dbPath);
});
afterEach(() => {
  db?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe("D3 original reader/API contract", () => {
  it("keeps exact rowid order, second citation binding, every secondary citation and report visibility without writes", async () => {
    const before = fingerprint(join(root, "synthetic.db"));
    const rawBefore = readdirSync(join(root, "raw")).map(name => [name, fingerprint(join(root, "raw", name))]);
    const changes = db.prepare("SELECT total_changes() AS n").get();
    const rows = loadTopicInsights(db, "target");
    expect(rows.map(row => row.id)).toEqual(expected);
    expect(rows.length).toBe(14);
    for (const row of rows) {
      expect(row.statement_citation_index).toBe(2);
      expect(row.citations.map(c => c.citation_ref)).toEqual([0, 1, 2].map(n => `${row.id}:cite${n}`));
      expect(row.citations[2]!.speaker_attribution).toEqual({ status: "none" });
    }
    expect(insightsMentioningEntity(db, "target", "Atlas")).toEqual(rows);
    expect(insightsCooccurring(db, "target", "Atlas", "Beacon").map(row => row.id)).toEqual(expected.filter(id => Number(id.split("-i")[1]) % 2 === 0));
    const links = reportLinksByInsight(db, "target");
    expect(links.get(expected[0]!)).toEqual([0, 1, 2, 3].map(n => ({ report_id: `report-${n}`, date: `2026-09-0${n + 1}` })));
    const groups = groupDrillInsights(rows, links);
    expect(groups.map(g => g.occurrence_count).sort()).toEqual([1, 1, 2, 2, 4, 4]);
    expect(groups.flatMap(g => g.occurrences).map(o => o.id).sort()).toEqual([...expected].sort());
    for (const occurrence of groups.flatMap(g => g.occurrences)) {
      expect(occurrence.quotes).toEqual([rows.find(row => row.id === occurrence.id)!.citations[1]!.quote]);
    }
    expect(groups.flatMap(g => g.occurrences).every(o => o.quotes.length === 1 && o.report_links.length === 4)).toBe(true);
    const response = await GET(new NextRequest("http://example.test/api/graph/drill?topic=target&a=Atlas"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: groups });
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(fingerprint(join(root, "synthetic.db"))).toBe(before);
    expect(readdirSync(join(root, "raw")).map(name => [name, fingerprint(join(root, "raw", name))])).toEqual(rawBefore);
  });

  it("uses inclusive batch.created_at boundary, keeps ties, full graph counts and legal empty paths", async () => {
    const inWindow = expected.filter(id => Math.floor(Number(id.split("-i")[1]) / modes.length) % 6 >= 1);
    expect(insightsMentioningEntity(db, "target", "Atlas", since).map(row => row.id)).toEqual(inWindow);
    expect(inWindow.length).toBe(11);
    const graph = buildTopicGraphData(db, "target");
    expect(graph.insightCount).toBe(14);
    expect(graph.withEntities).toBe(14);
    expect(graph.nodes.map(n => [n.name, n.mentions])).toEqual([["Atlas", 14], ["Beacon", 9], ["Cedar", 5]]);
    expect(graph.candidateEdges.map(e => [e.a, e.b, e.weight])).toEqual([["Atlas", "Beacon", 9], ["Atlas", "Cedar", 5]]);
    expect(insightsMentioningEntity(db, "target", "Absent")).toEqual([]);
    expect(loadTopicInsights(db, "empty")).toEqual([]);
    expect(insightsCooccurring(db, "target", "Atlas", "Beacon", "2030-01-01")).toEqual([]);
    const response = await GET(new NextRequest("http://example.test/api/graph/drill?topic=empty&a=Atlas"));
    expect(await response.json()).toEqual({ items: [] });
  });

  it.each(["missing", "corrupt", "unreadable", "symlink"])("rechecks archive %s on next request without positive cache persistence", mode => {
    const id = expected[0]!;
    const insight = insightsMentioningEntity(db, "target", "Atlas").find(row => row.id === id)!;
    const row = db.prepare("SELECT raw_ref FROM content_item WHERE id=?").get(insight.citations[1]!.content_item_id) as { raw_ref: string };
    const path = join(root, row.raw_ref);
    expect(insight).toBeDefined();
    if (mode === "missing") unlinkSync(path);
    if (mode === "corrupt") writeFileSync(path, "corrupt");
    if (mode === "unreadable") chmodSync(path, 0);
    if (mode === "symlink") {
      const bytes = readFileSync(path);
      unlinkSync(path);
      const replacement = join(root, "replacement");
      writeFileSync(replacement, bytes);
      symlinkSync(replacement, path);
    }
    try {
      expect(insightsMentioningEntity(db, "target", "Atlas").map(row => row.id)).not.toContain(id);
    } finally { if (mode === "unreadable") chmodSync(path, 0o600); }
  });
});
