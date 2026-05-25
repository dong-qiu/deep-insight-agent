import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "./robots.js";

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
