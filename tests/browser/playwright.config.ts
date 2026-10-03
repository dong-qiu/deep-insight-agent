import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  // Cookie-bearing traces/storageState are unnecessary for this synthetic smoke.
  outputDir: "../../.cache/browser-smoke",
  use: { browserName: "chromium", headless: true, viewport: { width: 1280, height: 900 },
    trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" },
});
