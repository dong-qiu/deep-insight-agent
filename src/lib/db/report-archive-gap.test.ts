import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type DB, openDb } from "./index.js";
import { reportArchiveGap } from "./reports.js";

let db: DB;
let dataDir: string;
const priorDataDir = process.env.DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "report-archive-gap-"));
  mkdirSync(join(dataDir, "raw"));
  process.env.DATA_DIR = dataDir;
  db = openDb(":memory:");
  db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','zh','daily',1)").run();
  db.prepare("INSERT INTO source(id,name,type,endpoint,topic_ids,fetch_interval,enabled) VALUES ('s','S','rss','https://example.test','[\"t\"]','6h',1)").run();
  db.prepare("INSERT INTO analysis_batch(id,topic_id,time_window,status) VALUES ('b','t','{}','done')").run();
  db.prepare("INSERT INTO insight(id,batch_id,topic_id,type,statement,importance,importance_basis,source_count,multi_source,time_window,language) VALUES ('i','b','t','aggregation','statement',3,'test',1,0,'{}','en')").run();
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost) VALUES ('r','brief','t','done','2026-06-01T00:00:00Z','R','/not-read','[\"i\"]','[]',4,'{}')").run();
});
afterEach(() => {
  db.close();
  if (priorDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function cite(index: number, id: string, rawRef: string): void {
  db.prepare(`INSERT INTO content_item
    (id,source_id,url,title,fetched_at,language,topic_ids,tags,body,body_kind,raw_ref,reader_eligible,content_hash,fetch_status)
    VALUES (?,'s',?,?,'2026-06-01T00:00:00Z','en','["t"]','[]','quote','article',?,1,'hash','ok')`)
    .run(id, `https://example.test/${id}`, id, rawRef);
  db.prepare("INSERT INTO citation(insight_id,citation_index,content_item_id,quote,locator) VALUES ('i',?,?,'quote','{}')")
    .run(index, id);
  db.prepare(`INSERT INTO citation_check(batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict)
    VALUES ('b','i',?,'pass','ok','support','ok','pass')`).run(index);
}

it("counts only unavailable published pass/support archives without changing report records", () => {
  cite(0, "empty", "");
  cite(1, "dangling", "raw/missing.txt");
  cite(2, "present", "raw/present.txt");
  writeFileSync(join(dataDir, "raw", "present.txt"), "historical original");
  const outside = join(dataDir, "outside.txt");
  writeFileSync(outside, "not under raw root");
  symlinkSync(outside, join(dataDir, "raw", "link.txt"));
  cite(3, "symlink", "raw/link.txt");

  expect(reportArchiveGap(db, "r")).toEqual({ unavailableCitations: 3, unavailableContents: 3 });
  expect(db.prepare("SELECT status,insight_ids FROM report WHERE id='r'").get())
    .toEqual({ status: "done", insight_ids: '["i"]' });
});

it("does not flag an existing ordinary archive file", () => {
  writeFileSync(join(dataDir, "raw", "present.txt"), "historical original");
  cite(0, "present", "raw/present.txt");
  expect(reportArchiveGap(db, "r")).toEqual({ unavailableCitations: 0, unavailableContents: 0 });
});

it("marks a raw-pending historical citation unavailable even if an old file remains", () => {
  writeFileSync(join(dataDir, "raw", "pending.txt"), "old archive bytes");
  cite(0, "pending", "raw/pending.txt");
  db.prepare("UPDATE content_item SET reader_eligible=0 WHERE id='pending'").run();
  expect(reportArchiveGap(db, "r")).toEqual({ unavailableCitations: 1, unavailableContents: 1 });
});

it("does not follow a symlink in an intermediate archive directory", () => {
  mkdirSync(join(dataDir, "raw", "actual"));
  writeFileSync(join(dataDir, "raw", "actual", "item.txt"), "historical original");
  symlinkSync(join(dataDir, "raw", "actual"), join(dataDir, "raw", "alias"));
  cite(0, "nested-symlink", "raw/alias/item.txt");
  expect(reportArchiveGap(db, "r")).toEqual({ unavailableCitations: 1, unavailableContents: 1 });
});

it("does not follow a symlink used as the archive root", () => {
  mkdirSync(join(dataDir, "actual-raw"));
  writeFileSync(join(dataDir, "actual-raw", "item.txt"), "historical original");
  rmSync(join(dataDir, "raw"), { recursive: true });
  symlinkSync(join(dataDir, "actual-raw"), join(dataDir, "raw"));
  cite(0, "root-symlink", "raw/item.txt");
  expect(reportArchiveGap(db, "r")).toEqual({ unavailableCitations: 1, unavailableContents: 1 });
});
