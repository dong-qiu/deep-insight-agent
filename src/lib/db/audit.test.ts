import { beforeEach, expect, it } from "vitest";
import { appendAudit, listAudit } from "./audit.js";
import { type DB, openDb } from "./index.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

it("append → list 往返（含 detail JSON），倒序、id 自增", () => {
  appendAudit(db, { actor: "admin", action: "login" });
  appendAudit(db, { actor: "admin", action: "source_add", target: "src_x", detail: { type: "rss" } });
  const rows = listAudit(db);
  expect(rows).toHaveLength(2);
  expect(rows[0].action).toBe("source_add"); // 倒序，最新在前
  expect(rows[0].detail).toEqual({ type: "rss" });
  expect(rows[1].action).toBe("login");
  expect(rows[1].detail).toBeNull();
  expect(rows[0].id).toBeGreaterThan(rows[1].id); // append-only 自增
});
