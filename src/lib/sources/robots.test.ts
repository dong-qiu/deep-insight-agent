import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, rulesForStatus } from "./robots.js";

const ROBOTS = `# sample
User-agent: *
Disallow: /private
Disallow: /tmp
Allow: /public

User-agent: BadBot
Disallow: /
`;

describe("parseRobots / isAllowed", () => {
  it("默认 UA 取 * 组的 Disallow", () => {
    const r = parseRobots(ROBOTS);
    expect(r.disallow.sort()).toEqual(["/private", "/tmp"]);
    expect(isAllowed(r, "/public/x")).toBe(true);
    expect(isAllowed(r, "/private/x")).toBe(false);
    expect(isAllowed(r, "/")).toBe(true);
  });

  it("精确 UA 组优先于 *", () => {
    const r = parseRobots(ROBOTS, "BadBot");
    expect(r.disallow).toEqual(["/"]);
    expect(isAllowed(r, "/anything")).toBe(false);
  });

  it("空 Disallow（如全允许）→ 全放行", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/x")).toBe(true);
  });
});

describe("rulesForStatus（5xx vs 404 区分）", () => {
  it("2xx → 解析正文规则", () => {
    expect(rulesForStatus(200, ROBOTS).disallow.sort()).toEqual(["/private", "/tmp"]);
  });

  it("404（无 robots.txt）→ 不限制、全放行", () => {
    const r = rulesForStatus(404, "");
    expect(r.disallow).toEqual([]);
    expect(isAllowed(r, "/anything")).toBe(true);
  });

  it("其它 4xx（如 403）→ 不限制", () => {
    expect(rulesForStatus(403, "").disallow).toEqual([]);
  });

  it("5xx → 保守全站禁止", () => {
    const r = rulesForStatus(503, "");
    expect(r.disallow).toEqual(["/"]);
    expect(isAllowed(r, "/anything")).toBe(false); // 服务器异常时不越权抓取
  });
});
