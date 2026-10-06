import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createD3Fixture } from "../../../evals/fixtures/d3-reader.js";
import { loadFrozenD3 } from "../../../evals/fixtures/d3-frozen.js";
import { openReadonlyDb } from "./connection.js";
import { insightsMentioningEntity } from "./graph.js";
let trial: Awaited<ReturnType<typeof loadFrozenD3>>;
let frozen: Awaited<ReturnType<typeof loadFrozenD3>>;
beforeAll(async () => { frozen = await loadFrozenD3(); trial = await loadFrozenD3(true); });
afterAll(() => { rmSync(frozen.directory, { recursive: true, force: true }); rmSync(trial.directory, { recursive: true, force: true }); });
describe("D3 offline trial passed-ID boundary against frozen original reader", () => {
  it.each([0, 1, 399, 400, 401, 800, 801])("preserves every DTO and order with %i passed IDs", size => {
    const root = mkdtempSync(join(tmpdir(), "d3-boundary-"));
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = root;
    const fixture = createD3Fixture(root, size, true);
    const db = openReadonlyDb(fixture.dbPath);
    try {
      const original = frozen.graph.insightsMentioningEntity(db, "target", "Atlas");
      expect(original.map(row => row.id)).toEqual(fixture.expected);
      expect(original.length).toBe(size);
      let citationExecutions = 0;
      const instrumented = new Proxy(db, { get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^SELECT \* FROM citation WHERE insight_id/.test(sql)) return statement;
          return new Proxy(statement, { get(stmt, member) {
            const value = Reflect.get(stmt, member);
            if (member === "all") return (...args: unknown[]) => {
              citationExecutions++;
              return stmt.all(...args);
            };
            return typeof value === "function" ? value.bind(stmt) : value;
          } });
        };
      } });
      expect(insightsMentioningEntity(db, "target", "Atlas")).toEqual(original);
      expect(trial.graph.insightsMentioningEntity(instrumented, "target", "Atlas")).toEqual(original);
      expect(citationExecutions).toBe(Math.ceil(size / 400));
    } finally {
      db.close();
      if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
