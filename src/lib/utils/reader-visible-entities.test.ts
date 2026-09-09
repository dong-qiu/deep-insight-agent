import { describe, expect, it } from "vitest";
import { entitiesMentionedInStatement } from "./reader-visible-entities.js";

describe("reader-visible graph entities", () => {
  it("keeps only exact statement mentions and refuses translation/fuzzy inference", () => {
    expect(entitiesMentionedInStatement("OpenAI 发布了模型。", [
      { name: "OpenAI", type: "organization" },
      { name: "Cursor", type: "product" },
      { name: "开放人工智能", type: "organization" },
    ])).toEqual([{ name: "OpenAI", type: "organization" }]);
  });

  it("does not let a short ASCII entity match a longer word", () => {
    expect(entitiesMentionedInStatement("FAIR reduces error while AI is separately evaluated.", [
      { name: "AI", type: "product" },
      { name: "FAIR", type: "project" },
    ])).toEqual([{ name: "AI", type: "product" }, { name: "FAIR", type: "project" }]);
    expect(entitiesMentionedInStatement("FAIR reduces error.", [{ name: "AI", type: "product" }])).toEqual([]);
    expect(entitiesMentionedInStatement("The score is 12.", [{ name: "2", type: "project" }])).toEqual([]);
  });
});
