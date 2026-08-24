// 触发定时管线（容器内 supercronic 按 ops/crontab 调用）。用 Node 内置 http/https，免在镜像里装 curl。
// 环境变量由 supercronic 从容器继承：APP_URL（默认 http://app:3000）、CRON_SECRET（必需）。
//
// 不用全局 fetch：历史上 /api/cron 会同步等待整条管线，undici 的默认 headersTimeout=5min
// 会把已成功的长任务误记为 fetch failed。现在日报会持久入队后由 dispatch worker 执行，
// 仍保留 node:http，避免采集阶段变慢时重新引入客户端超时耦合。
import http from "node:http";
import https from "node:https";

const base = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.CRON_SECRET;
const mode = process.env.CRON_MODE ?? "pipeline";
const ts = new Date().toISOString();

if (!secret) {
  console.error(`[cron ${ts}] CRON_SECRET 未设置，跳过触发`);
  process.exit(1);
}
if (mode !== "pipeline" && mode !== "collect" && mode !== "integrity") {
  console.error(`[cron ${ts}] CRON_MODE 必须是 pipeline、collect 或 integrity，当前为 ${mode}`);
  process.exit(1);
}

const url = new URL("/api/cron", base);
if (mode !== "pipeline") url.searchParams.set("mode", mode);
const mod = url.protocol === "https:" ? https : http;

const req = mod.request(
  url,
  { method: "POST", headers: { authorization: `Bearer ${secret}` } },
  (res) => {
    const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
    console.log(`[cron ${ts}] POST ${url.href} → HTTP ${res.statusCode}`);
    res.resume(); // 排空响应体，让连接正常结束后再退出
    res.on("end", () => process.exit(ok ? 0 : 1));
    res.on("error", (e) => {
      console.error(`[cron ${ts}] 读取响应失败：${e.message}`);
      process.exit(1);
    });
  },
);

req.on("error", (e) => {
  console.error(`[cron ${ts}] 触发失败：${e.message}`);
  process.exit(1);
});

req.end();
