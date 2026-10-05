import { test, expect } from "./fixtures.js";
import { statement, viewer } from "./seed.js";

test("D3 真实 HTTP 节点/边下钻保留 occurrence，匿名及退出后的会话拒绝", async ({ page, app }) => {
  const node = `${app.url}/api/graph/drill?topic=smoke-main&a=Atlas`;
  expect((await page.request.get(node)).status()).toBe(401);
  await page.goto(`${app.url}/graph`);
  await page.getByPlaceholder("邮箱").fill(viewer.email);
  await page.getByPlaceholder("密码").fill(viewer.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/`);
  const response = await page.request.get(node);
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0]).toMatchObject({ statement, occurrence_count: 2,
    occurrences: [{ id: "recent-0", quotes: [statement], report_links: [] }, { id: "recent-1", quotes: [statement], report_links: [] }] });
  const edge = await page.request.get(`${node}&b=Beacon`);
  expect(edge.status()).toBe(200);
  expect(await edge.json()).toEqual(payload);
  expect((await page.request.get(`${app.url}/api/admin/users`)).status()).toBe(403);
  const empty = await page.request.get(`${app.url}/api/graph/drill?topic=smoke-empty&a=Atlas`);
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toEqual({ items: [] });
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(`${app.url}/login`);
  await expect.poll(async () => (await page.request.get(node)).status()).toBe(401);
});

test.describe("D3 真实 HTTP 原文缺失合法空态", () => {
  test.use({ missingArchive: true });
  test("pass/support 不复活缺失归档的节点或边下钻", async ({ page, app }) => {
    await page.goto(`${app.url}/graph`);
    await page.getByPlaceholder("邮箱").fill(viewer.email);
    await page.getByPlaceholder("密码").fill(viewer.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(`${app.url}/`);
    for (const query of ["topic=smoke-main&a=Atlas", "topic=smoke-main&a=Atlas&b=Beacon"]) {
      const response = await page.request.get(`${app.url}/api/graph/drill?${query}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ items: [] });
    }
  });
});
