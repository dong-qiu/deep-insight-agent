import { describe, expect, it } from "vitest";
import { DOMAIN_VALUES, deriveFacetsFromIndustry, domainFacet, isValidFacet } from "./facets.js";

describe("facets 受控词表（ADR-0010 Step2a）", () => {
  it("domainFacet 构造 domain:<值>", () => {
    expect(domainFacet("ai-swe")).toBe("domain:ai-swe");
    expect(domainFacet("ai-industry")).toBe("domain:ai-industry");
  });

  it("isValidFacet 认所有受控 domain 值", () => {
    for (const d of DOMAIN_VALUES) expect(isValidFacet(domainFacet(d))).toBe(true);
  });

  it("isValidFacet 拒未知值 / 缺前缀 / 非串", () => {
    expect(isValidFacet("domain:unknown")).toBe(false); // 词表外
    expect(isValidFacet("ai-swe")).toBe(false); // 缺 domain: 前缀
    expect(isValidFacet("topic:foo")).toBe(false); // 维度未支持
    expect(isValidFacet("")).toBe(false);
    expect(isValidFacet(null)).toBe(false);
    expect(isValidFacet(42)).toBe(false);
  });

  it("deriveFacetsFromIndustry 把 industry slug 映成单个 domain facet", () => {
    expect(deriveFacetsFromIndustry("ai-swe")).toEqual(["domain:ai-swe"]);
    expect(deriveFacetsFromIndustry("ai-security")).toEqual(["domain:ai-security"]);
  });

  it("派生结果必然是合法 facet（派生即正确）", () => {
    for (const ind of ["ai-swe", "ai-security"] as const) {
      expect(deriveFacetsFromIndustry(ind).every(isValidFacet)).toBe(true);
    }
  });
});
