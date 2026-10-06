import { describe, expect, it } from "vitest";
import { newObjectId } from "./object-id.js";

describe("D7 production CSPRNG wiring (without mocks)", () => {
  it.each(["run", "rep", "fup", "lead", "opp"] as const)("emits the bounded %s format", prefix => {
    const id = newObjectId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}_[a-f0-9]{32}$`));
    expect(id.length).toBe(prefix.length + 33);
  });
});
