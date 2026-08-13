#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DASHBOARD_LABEL = "io.insight-agent.symphony";
export const REPOSITORY = "dong-qiu/deep-insight-agent";
export const DASHBOARD_PORT = 4173;

function textMatch(text, expression) {
  return text.match(expression)?.[1] ?? null;
}

export function parseLaunchctlStatus(output) {
  return {
    state: textMatch(output, /^\s*state = ([^\n]+)$/m) ?? "unknown",
    activeCount: Number(textMatch(output, /^\s*active count = (\d+)$/m) ?? 0),
    runs: Number(textMatch(output, /^\s*runs = (\d+)$/m) ?? 0),
    lastExitCode: textMatch(output, /^\s*last exit code = (-?\d+)$/m),
  };
}

export function parseLockOwner(output) {
  const line = output.trim().split("\n").find((entry) => !entry.startsWith("COMMAND"));
  if (!line) return { held: false, command: null, pid: null };
  const [command, pid] = line.trim().split(/\s+/, 3);
  return { held: true, command, pid: Number(pid) };
}

async function command(commandName, args) {
  try {
    return (await execFileAsync(commandName, args, { encoding: "utf8", timeout: 2_000 })).stdout;
  } catch (error) {
    return error.stdout ?? "";
  }
}

async function workspaceCount(workspaceRoot) {
  try {
    return (await fs.readdir(workspaceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

export async function readStatus({
  home = os.homedir(),
  uid = process.getuid(),
  runCommand = command,
  countWorkspaces = workspaceCount,
} = {}) {
  const lockRoot = path.join(home, "locks");
  const workspaceRoot = path.join(home, "workspaces", "insight-agent");
  const runtimeRoot = path.join(home, "symphony-runtime", "openai-symphony");
  const lockPath = path.join(lockRoot, "symphony-github-dong-qiu--deep-insight-agent.lock");
  const domain = `gui/${uid}/${DASHBOARD_LABEL}`;
  const [launchctl, lock, revision, workspaces] = await Promise.all([
    runCommand("/bin/launchctl", ["print", domain]),
    runCommand("/usr/sbin/lsof", [lockPath]),
    runCommand("/usr/bin/git", ["-C", runtimeRoot, "rev-parse", "--short", "HEAD"]),
    countWorkspaces(workspaceRoot),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    service: parseLaunchctlStatus(launchctl),
    controllerLock: { held: parseLockOwner(lock).held },
    runtimeRevision: revision.trim() || null,
    workspaceCount: workspaces,
  };
}

export function renderDashboard() {
  const issueUrl = `https://github.com/${REPOSITORY}/issues`;
  const pullUrl = `https://github.com/${REPOSITORY}/pulls`;
  const actionUrl = `https://github.com/${REPOSITORY}/actions`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Insight Agent · Symphony 状态</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #111827; color: #e5e7eb; }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 26px; margin: 0 0 8px; } p { color: #9ca3af; line-height: 1.5; }
    #updated { font-size: 14px; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin: 24px 0; }
    .card { background: #1f2937; border: 1px solid #374151; border-radius: 10px; padding: 16px; }
    .label { color: #9ca3af; font-size: 13px; } .value { margin-top: 7px; font-size: 22px; font-weight: 650; overflow-wrap: anywhere; }
    .ok { color: #86efac; } .warn { color: #fcd34d; } .bad { color: #fca5a5; }
    .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
    a { color: #93c5fd; text-decoration: none; } a:hover { text-decoration: underline; }
    footer { font-size: 13px; margin-top: 28px; color: #9ca3af; }
  </style>
</head>
<body>
  <main>
    <h1>Insight Agent · Symphony 状态</h1>
    <p>仅本机只读健康页。不会显示日志正文、工作区名称、GitHub token 或任何凭据。</p>
    <p id="updated">读取中…</p>
    <section class="grid" aria-live="polite">
      <div class="card"><div class="label">控制器服务</div><div class="value" id="service">—</div></div>
      <div class="card"><div class="label">控制器锁</div><div class="value" id="lock">—</div></div>
      <div class="card"><div class="label">运行时版本</div><div class="value" id="revision">—</div></div>
      <div class="card"><div class="label">活动工作区</div><div class="value" id="workspaces">—</div></div>
    </section>
    <nav class="links" aria-label="GitHub 状态链接">
      <a href="${issueUrl}?q=is%3Aissue%20is%3Aopen%20label%3Aagent-ready" target="_blank" rel="noreferrer">待派发 Issue</a>
      <a href="${issueUrl}?q=is%3Aissue%20is%3Aopen%20label%3Aagent-working" target="_blank" rel="noreferrer">运行中的 Issue</a>
      <a href="${pullUrl}?q=is%3Apr%20is%3Aopen%20head%3Asymphony" target="_blank" rel="noreferrer">Symphony PR</a>
      <a href="${actionUrl}" target="_blank" rel="noreferrer">CI 运行记录</a>
    </nav>
    <footer>每 10 秒刷新。服务异常时使用 launchctl 与受限日志进行诊断。</footer>
  </main>
  <script>
    const set = (id, value, className = "") => { const node = document.getElementById(id); node.textContent = value; node.className = "value " + className; };
    async function refresh() {
      try {
        const status = await fetch("/api/status", { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(response.status));
        const running = status.service.state === "running" && status.service.activeCount > 0;
        set("service", running ? "运行中" : status.service.state, running ? "ok" : "bad");
        set("lock", status.controllerLock.held ? "已持有" : "未持有", status.controllerLock.held ? "ok" : "warn");
        set("revision", status.runtimeRevision || "不可用", status.runtimeRevision ? "" : "warn");
        set("workspaces", String(status.workspaceCount));
        document.getElementById("updated").textContent = "上次检查：" + new Date(status.checkedAt).toLocaleString();
      } catch {
        set("service", "状态不可用", "bad");
        document.getElementById("updated").textContent = "无法读取本机状态。";
      }
    }
    refresh(); setInterval(refresh, 10_000);
  </script>
</body>
</html>`;
}

export function createDashboardServer(options = {}) {
  const read = options.readStatus ?? readStatus;
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(renderDashboard());
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"status":"ok"}');
      return;
    }
    if (request.url === "/api/status") {
      try {
        const status = await read();
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(status));
      } catch {
        response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"status":"unavailable"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDashboardServer().listen(DASHBOARD_PORT, "127.0.0.1", () => {
    console.log(`Symphony dashboard: http://127.0.0.1:${DASHBOARD_PORT}`);
  });
}
