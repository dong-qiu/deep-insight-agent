import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedBrowserDb } from "./seed.js";

interface App { url: string; observedDate: string }

async function unusedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("smoke_port_unavailable"));
        else resolvePort(address.port);
      });
    });
  });
}

async function stopApp(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null || !app.pid) return;
  await new Promise<void>(resolveExit => {
    const timer = setTimeout(() => app.kill("SIGKILL"), 5_000);
    app.once("exit", () => { clearTimeout(timer); resolveExit(); });
    app.kill("SIGTERM");
  });
}

async function waitForApp(app: ChildProcess, url: string, failed: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (failed() || app.exitCode !== null || app.signalCode !== null) throw new Error("smoke_server_exited_before_ready");
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json() as { status?: string }).status === "ok") return;
    } catch { /* Poll a verifiable condition; do not print runtime config or server logs. */ }
    await new Promise(resolvePoll => setTimeout(resolvePoll, 100));
  }
  throw new Error("smoke_server_ready_timeout");
}

export const test = base.extend<{ app: App; missingArchive: boolean }>({
  missingArchive: [false, { option: true }],
  app: async ({ missingArchive }, provide) => {
    const root = mkdtempSync(join(tmpdir(), "insight-browser-smoke-"));
    const dataDir = join(root, "data");
    const runtimeDir = join(root, "runtime");
    let app: ChildProcess | undefined;
    try {
      mkdirSync(dataDir);
      mkdirSync(runtimeDir);
      const dbPath = join(dataDir, "insight.db");
      const previousDataDir = process.env.DATA_DIR;
      let seed: ReturnType<typeof seedBrowserDb>;
      try {
        process.env.DATA_DIR = dataDir;
        seed = seedBrowserDb(dbPath, missingArchive);
      } finally {
        if (previousDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previousDataDir;
      }
      // Serve the verified real build from a clean directory: Next must never load
      // the worktree's .env.local (which can contain real provider/notification keys).
      symlinkSync(resolve(".next"), join(runtimeDir, ".next"), "dir");
      symlinkSync(resolve("node_modules"), join(runtimeDir, "node_modules"), "dir");
      symlinkSync(resolve("public"), join(runtimeDir, "public"), "dir");
      const port = await unusedPort();
      const url = `http://127.0.0.1:${port}`;
      let failed = false;
      app = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", runtimeDir,
        "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: runtimeDir,
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
          DATA_DIR: dataDir, DB_PATH: dbPath, AUTH_SECRET: "synthetic-browser-smoke-auth-secret",
          ADMIN_EMAIL: "admin@example.test", ADMIN_PASSWORD: "synthetic-admin-password" },
        stdio: "ignore",
      });
      app.on("error", () => { failed = true; });
      await waitForApp(app, url, () => failed);
      await provide({ url, ...seed });
    } finally {
      try { if (app) await stopApp(app); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  },
  context: async ({ context, app }, provide) => {
    const unexpected: string[] = [];
    await context.route("**/*", async route => {
      if (new URL(route.request().url()).origin === app.url) await route.continue();
      else { unexpected.push("external_request_blocked"); await route.abort("blockedbyclient"); }
    });
    await provide(context);
    expect(unexpected, "browser must only contact its own synthetic service").toEqual([]);
  },
});
export { expect };
