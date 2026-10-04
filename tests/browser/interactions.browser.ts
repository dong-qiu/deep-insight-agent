import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { hypothesis, sourceUrl, statement, viewer } from "./seed.js";

async function login(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/opportunities`);
  await expect(page).toHaveURL(/\/login\?from=/);
  await page.getByPlaceholder("邮箱").fill(viewer.email);
  await page.getByPlaceholder("密码").fill(viewer.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  // The existing login lands at /admin; middleware redirects viewers to /.
  await expect(page).toHaveURL(`${url}/`);
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
}

async function openEvidence(page: Page): Promise<Locator> {
  await page.getByRole("navigation").getByRole("link", { name: "技术规划", exact: true }).click();
  await expect(page.getByRole("heading", { name: "技术规划机会", exact: true })).toBeVisible();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "待验证机会", exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(hypothesis);
  const summary = card.locator("summary").filter({ hasText: "可追溯事实证据" });
  await expect(summary).toHaveText("可追溯事实证据（1 个来源页面 · 1 段原文 · 2 条引用记录）");
  await summary.click();
  const details = card.locator("details").filter({ has: page.locator("summary", { hasText: "可追溯事实证据" }) });
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("li")).toHaveCount(1);
  await expect(details.locator("li")).toContainText(`「${statement}」`);
  await expect(details).toContainText("同一原文关联 2 条引用记录");
  await expect(details.getByRole("link", { name: "合成来源", exact: true })).toHaveAttribute("href", sourceUrl);
  return details;
}

async function applyGraph(page: Page, topic: string, days: string): Promise<void> {
  await page.getByRole("combobox", { name: /^主题/ }).selectOption(topic);
  await page.getByRole("combobox", { name: /^时间窗/ }).selectOption(days);
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`topic=${topic}&days=${days}$`));
}

async function threshold(page: Page, value: 1 | 2): Promise<void> {
  const slider = page.getByRole("slider");
  await slider.focus();
  await slider.press(value === 1 ? "Home" : "End");
  await expect(slider).toHaveValue(String(value));
}

async function assertGraph(page: Page, names: string[], pairs: string[]): Promise<void> {
  const graph = page.getByRole("img", { name: "实体共现图", exact: true });
  await expect(graph.locator("circle")).toHaveCount(names.length);
  await expect(graph.locator("line")).toHaveCount(pairs.length);
  await expect.poll(async () => (await graph.locator("text").allTextContents()).sort()).toEqual([...names].sort());
  // Existing SVG titles expose edge endpoints; counts alone cannot detect wrong wiring.
  await expect.poll(async () => (await graph.locator("line title").allTextContents())
    .map(title => title.split("：")[0]).sort()).toEqual([...pairs].sort());
}

/** Scroll normally, then prove the visible center belongs to the target, not an overlay. */
async function accessibleControl(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(el => {
    return [...el.getClientRects()].some(r => {
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return r.left >= 0 && r.right <= innerWidth && y >= 0 && y < innerHeight && !!hit && (hit === el || el.contains(hit));
    });
  })).toBe(true);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { message: "no unexpected page-level horizontal overflow" }).toBeLessThanOrEqual(1);
}

test("登录、viewer 访问控制和退出恢复保护", async ({ page, app }) => {
  await login(page, app.url);
  await page.goto(`${app.url}/admin`);
  await expect(page).toHaveURL(`${app.url}/`);
  await expect(page.getByRole("navigation").getByRole("link", { name: "管理看板", exact: true })).toHaveCount(0);
  await page.goto(`${app.url}/opportunities`);
  await expect(page.getByRole("heading", { name: "技术规划机会", exact: true })).toBeVisible();
  const sessionCookieCount = async () => (await page.context().cookies(app.url))
    .filter(cookie => /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(cookie.name)).length;
  await expect.poll(sessionCookieCount, { message: "synthetic browser has an authenticated session" }).toBeGreaterThan(0);
  // DOM alone does not prove logout has finished. Observe the real server-action
  // response and session-cookie removal before requesting a protected page again.
  const [signoutResponse] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST"
      && response.url() === `${app.url}/opportunities`),
    page.getByRole("button", { name: "退出", exact: true }).click(),
  ]);
  expect(signoutResponse.status()).toBeLessThan(400);
  await expect.poll(sessionCookieCount, { message: "logout removes synthetic session cookies" }).toBe(0);
  await expect(page).toHaveURL(`${app.url}/login`);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "退出", exact: true })).toHaveCount(0);
  await page.goto(`${app.url}/opportunities`);
  await expect(page).toHaveURL(/\/login\?from=/);
  await expect(page.getByRole("heading", { name: "技术规划机会", exact: true })).toHaveCount(0);
});

test("展开机会证据：假设、摘录、来源定位与去重计数", async ({ page, app }) => {
  await login(page, app.url);
  const details = await openEvidence(page);
  await expect(details).toContainText(app.observedDate);
  await details.locator("summary").click();
  await expect(details).not.toHaveAttribute("open", "");
  await expect(details.getByRole("link", { name: "合成来源", exact: true })).toBeHidden();
});

test.describe("原文不满足 reader 门的合法空态", () => {
  test.use({ missingArchive: true });
  test("旧 pass 引用不能复活缺失归档的机会", async ({ page, app }) => {
    await login(page, app.url);
    await page.getByRole("navigation").getByRole("link", { name: "技术规划", exact: true }).click();
    await expect(page.getByText("暂无机会候选。新一轮通过校验的技术线索会自动进入匹配或方向校准队列。", { exact: true })).toBeVisible();
    await expect(page.locator("article.opportunity-card")).toHaveCount(0);
    await expect(page.getByText(statement, { exact: false })).toHaveCount(0);
  });
});

test("图谱主题、时间窗、阈值、节点侧栏与空白复位", async ({ page, app }) => {
  await login(page, app.url);
  await page.getByRole("navigation").getByRole("link", { name: "关系图", exact: true }).click();
  await applyGraph(page, "smoke-main", "0");
  await threshold(page, 1);
  await assertGraph(page, ["Atlas", "Beacon", "Cedar", "Delta"], ["Atlas ⇄ Beacon", "Cedar ⇄ Delta"]);
  await threshold(page, 2);
  await assertGraph(page, ["Atlas", "Beacon"], ["Atlas ⇄ Beacon"]);
  await threshold(page, 1);
  await applyGraph(page, "smoke-main", "30");
  await threshold(page, 1);
  await assertGraph(page, ["Atlas", "Beacon"], ["Atlas ⇄ Beacon"]);
  const graph = page.getByRole("img", { name: "实体共现图", exact: true });
  await graph.locator("g").filter({ has: page.locator("circle title", { hasText: /^Atlas：/ }) }).last().locator("circle").click();
  const aside = page.locator("aside");
  await expect(aside.getByRole("heading", { name: "Atlas", exact: true })).toBeVisible();
  await expect(aside).toContainText(statement);
  await expect(aside).toContainText("相同表述 2 条");
  await aside.locator("summary").filter({ hasText: "展开全部原始记录" }).click();
  await expect(aside.locator("details li")).toHaveCount(2);
  await expect(aside.locator("details")).toContainText("未入报告");
  // Find background by DOM hit-test, never by a layout-specific node position.
  const background = await graph.evaluate(svg => {
    const r = svg.getBoundingClientRect();
    for (const x of [0.05, 0.95, 0.5]) for (const y of [0.05, 0.95]) {
      const px = r.left + r.width * x, py = r.top + r.height * y;
      if (document.elementFromPoint(px, py)?.tagName.toLowerCase() === "rect") return { x: px, y: py };
    }
    return null;
  });
  expect(background).not.toBeNull();
  await page.mouse.click(background!.x, background!.y);
  await expect(aside.getByRole("heading", { name: "Atlas", exact: true })).toHaveCount(0);
  await expect(aside.getByText("点节点看「关于它的洞察」、点边看「两实体共现的洞察」——每条可点进所在报告。", { exact: true })).toBeVisible();
  await applyGraph(page, "smoke-sparse", "0");
  await expect(page.getByText("当前阈值下无边——调低「最小共现」，或放宽时间窗。", { exact: true })).toBeVisible();
  await assertGraph(page, [], []);
  await threshold(page, 1);
  await assertGraph(page, ["Echo", "Foxtrot"], ["Echo ⇄ Foxtrot"]);
  await threshold(page, 2);
  await assertGraph(page, [], []);
  await applyGraph(page, "smoke-empty", "0");
  await expect(page.getByText("该主题（窗口内）没有可连成图的实体共现——洞察太少、或实体彼此不在同一条洞察里出现。试试放宽时间窗。", { exact: true })).toBeVisible();
  await expect(graph).toHaveCount(0);
});

test("390px 窄屏：导航、证据和关键按钮可访问且页面无横向溢出", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, app.url);
  await noHorizontalOverflow(page);
  for (const name of ["技术规划", "关系图", "报告库"]) {
    await accessibleControl(page.getByRole("navigation").getByRole("link", { name, exact: true }));
  }
  const details = await openEvidence(page);
  await accessibleControl(details.locator("summary"));
  await accessibleControl(details.getByRole("link", { name: "合成来源", exact: true }));
  await expect(details.locator("li")).toContainText(statement);
  await noHorizontalOverflow(page);
  await page.getByRole("navigation").getByRole("link", { name: "关系图", exact: true }).click();
  await applyGraph(page, "smoke-main", "30");
  await accessibleControl(page.getByRole("button", { name: "应用", exact: true }));
  await accessibleControl(page.getByRole("slider"));
  await noHorizontalOverflow(page);
  await accessibleControl(page.getByRole("button", { name: "退出", exact: true }));
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/login`);
});
