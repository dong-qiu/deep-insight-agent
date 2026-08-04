import { describe, expect, it } from "vitest";
import { hasDispatchWorkerSecret } from "./dispatch-auth.js";

describe("hasDispatchWorkerSecret", () => {
  it("only accepts a non-empty exact match", () => {
    expect(hasDispatchWorkerSecret("worker-secret", "worker-secret")).toBe(true);
    expect(hasDispatchWorkerSecret("wrong", "worker-secret")).toBe(false);
    expect(hasDispatchWorkerSecret(null, "worker-secret")).toBe(false);
    expect(hasDispatchWorkerSecret("", "")).toBe(false);
    expect(hasDispatchWorkerSecret("worker-secret", undefined)).toBe(false);
  });
});
