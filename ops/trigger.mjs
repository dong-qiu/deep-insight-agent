// 触发定时管线（容器内 supercronic 按 ops/crontab 调用）。用 Node 内置 http/https，免在镜像里装 curl。
// 环境变量由 supercronic 从容器继承：APP_URL（默认 http://app:3000）、CRON_SECRET（必需）。
//
// 不用全局 fetch：undici 的 fetch 默认 headersTimeout=5min，而 /api/cron 同步把整条管线
// （采集→分析→校验→brief，约 10+ 分钟）跑完才返回响应头——5min 一到 fetch 即 reject
// "fetch failed"，任务实际已成功却被记成失败（2026-06-06 17:14 实锤）。node:http 客户端
// 默认无 headersTimeout，会一直等到响应到达，故改用它。
import http from "node:http";
import https from "node:https";

const base = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.CRON_SECRET;
const ts = new Date().toISOString();

if (!secret) {
  console.error(`[cron ${ts}] CRON_SECRET 未设置，跳过触发`);
  process.exit(1);
}

const url = new URL("/api/cron", base);
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
