import { describe, expect, it } from "vitest";
import {
  DOMAIN_VALUES, deriveFacetsFromIndustry, domainFacet, domainValueOf, facetLabel,
  isDomainValue, isValidFacet, parseFacetsOrDerive,
} from "./facets.js";

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

describe("facets 取值/标签辅助（ADR-0010 Step2b）", () => {
  it("isDomainValue 校验裸 domain 值白名单", () => {
    expect(isDomainValue("ai-swe")).toBe(true);
    expect(isDomainValue("ai-industry")).toBe(true);
    expect(isDomainValue("garbage")).toBe(false);
    expect(isDomainValue("domain:ai-swe")).toBe(false); // 这是 facet 不是裸值
    expect(isDomainValue(null)).toBe(false);
  });

  it("domainValueOf 剥前缀回裸值；非法 → null", () => {
    expect(domainValueOf("domain:ai-swe")).toBe("ai-swe");
    expect(domainValueOf("domain:unknown")).toBeNull();
    expect(domainValueOf("ai-swe")).toBeNull();
  });

  it("facetLabel 映人类标签；未知/非 domain 回退原串", () => {
    expect(facetLabel("domain:ai-swe")).toBe("AI 软件工程");
    expect(facetLabel("domain:ai-industry")).toBe("AI 产业动态");
    expect(facetLabel("topic:foo")).toBe("topic:foo"); // 非 domain facet 原样返
  });

  it("parseFacetsOrDerive：非空数组原样、空/坏 JSON 派生自 industry", () => {
    expect(parseFacetsOrDerive('["domain:ai-industry"]', "ai-swe")).toEqual(["domain:ai-industry"]);
    expect(parseFacetsOrDerive("[]", "ai-security")).toEqual(["domain:ai-security"]);
    expect(parseFacetsOrDerive("not json", "ai-swe")).toEqual(["domain:ai-swe"]);
    expect(parseFacetsOrDerive(undefined, "ai-swe")).toEqual(["domain:ai-swe"]);
  });
});
