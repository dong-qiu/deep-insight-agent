import { expect, it } from "vitest";
import { openDb } from "./index.js";
import { finishRun, insertRun } from "./repos.js";
import type { Run } from "../types.js";

it("insert and finish protect the raw stored Run error independently of runJob", () => {
  const db = openDb(":memory:");
  try {
    const run: Run = { id: "run_private", kind: "analyze", target: { topic_id: "t" }, status: "running", started_at: new Date().toISOString(), ended_at: null, duration_ms: null, cost: null, retry_of: null,
      error: { type: "synthetic-private-type", message: "synthetic-private-message", stack: "synthetic-private-stack" } };
    insertRun(db, run);
    const raw = () => (db.prepare("SELECT error FROM run WHERE id=?").get(run.id) as { error: string }).error;
    expect(JSON.parse(raw())).toEqual({ type: "Error", message: "operation_failed" });
    finishRun(db, run.id, { status: "failed", error: run.error });
    expect(raw()).not.toContain("synthetic-private");
    expect(run.error?.message).toBe("synthetic-private-message");
  } finally { db.close(); }
});
