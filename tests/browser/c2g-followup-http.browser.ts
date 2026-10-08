/** True Chromium through unchanged login/report/panel, with a local synthetic SDK provider. */
import { test, expect } from "@playwright/test";
import { admin, quote, startC2gServer } from "../fixtures/c2g-followup-http.js";

test("C2g authenticated report question and retained history use real POST/GET", async ({ page, context }) => {
  const server = await startC2gServer(); const external: string[] = [];
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin === server.url) await route.continue();
    else { external.push(route.request().url()); await route.abort("blockedbyclient"); }
  });
  try {
    await page.goto(`${server.url}/reports/${server.report.id}`); await expect(page).toHaveURL(/\/login\?from=/);
    await page.getByPlaceholder("邮箱").fill(admin.email); await page.getByPlaceholder("密码").fill(admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
    await page.goto(`${server.url}/reports/${server.report.id}`); await expect(page.getByRole("heading", { name: "合成追问报告", exact: true })).toBeVisible();
    await page.getByPlaceholder("就这份报告继续提问…（最多 500 字）").fill("如何改善回归？");
    const received = page.waitForResponse(r => r.url().endsWith(`/api/reports/${server.report.id}/followup`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "提问", exact: true }).click(); const response = await received; expect(response.status()).toBe(200);
    const qa = await response.json(); expect(qa.citations_used).toHaveLength(1); expect(qa.citations_used[0].content_item_id).toBe("c2g-content-0");
    await expect(page.locator(".followup-qa")).toHaveCount(1); await expect(page.locator(".followup-qa")).toContainText(quote);
    await expect(page.getByPlaceholder("就这份报告继续提问…（最多 500 字）")).toHaveValue(""); expect(server.calls).toHaveLength(2);
    await page.reload(); await expect(page.locator(".followup-qa")).toHaveCount(1); await expect(page.locator(".followup-qa")).toContainText("如何改善回归？");
    const history = await context.request.get(`${server.url}/api/reports/${server.report.id}/followup`); expect(history.status()).toBe(200); expect((await history.json()).followups[0].id).toBe(qa.id);
    expect(external).toEqual([]);
  } finally { await server.stop(); }
});
