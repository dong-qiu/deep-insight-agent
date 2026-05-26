// 触发定时管线（容器内 supercronic 按 ops/crontab 调用）。用 Node 全局 fetch，免在镜像里装 curl。
// 环境变量由 supercronic 从容器继承：APP_URL（默认 http://app:3000）、CRON_SECRET（必需）。
const base = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.CRON_SECRET;
const ts = new Date().toISOString();

if (!secret) {
  console.error(`[cron ${ts}] CRON_SECRET 未设置，跳过触发`);
  process.exit(1);
}

try {
  const res = await fetch(`${base}/api/cron`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  console.log(`[cron ${ts}] POST ${base}/api/cron → HTTP ${res.status}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error(`[cron ${ts}] 触发失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
