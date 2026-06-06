/** 失败告警手测探针（DCP-3 ② 占位期）：
 *  读 ALERT_WEBHOOK env，构造一条 fake FailureAlert，调用 sendAlert 一次。
 *
 *  用法：
 *    本地：    ALERT_WEBHOOK=https://webhook.site/xxx-yyy node ops/probe-alert.mjs
 *    容器内：  docker compose exec -e ALERT_WEBHOOK=https://webhook.site/xxx-yyy \\
 *              app node /app/ops/probe-alert.mjs
 *
 *  退出码 0 = sendAlert resolve（按设计永不抛——传不传到也 resolve；payload 是否落 webhook.site 看那边）
 *  退出码 1 = ALERT_WEBHOOK 未设置（明显配置错） */
const url = process.env.ALERT_WEBHOOK;
if (!url) {
  console.error("❌ ALERT_WEBHOOK 未设置——本探针专测告警链路，需要一个 webhook URL（例如 https://webhook.site/{uuid}）。");
  process.exit(1);
}

const payload = {
  text: `🔴 Run 失败：smoke · TestError：本条来自 ops/probe-alert.mjs 的手测，时间 ${new Date().toISOString()}`,
  runId: "probe-" + Math.random().toString(36).slice(2, 10),
  kind: "smoke",
  target: null,
  error: { type: "TestError", message: "本条是探针烟雾测试 / 非真实故障 / 用于验证告警链路到达" },
};

console.log(`📡 POST → ${url}`);
console.log(`   payload.text = ${payload.text}`);

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 5000);
try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  });
  console.log(`✅ HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) console.warn("   ⚠️ 非 2xx——多数 webhook 服务（含 webhook.site）仍会展示请求体；Slack 等严格端可能 4xx 表示 payload 不符。");
} catch (e) {
  console.error(`❌ 发送失败：${e instanceof Error ? e.message : String(e)}`);
  console.error("   常见原因：① 网络不通；② URL 错；③ webhook 服务挂；④ 容器内 fetch 被防火墙拦。");
} finally {
  clearTimeout(timer);
}

console.log("\n👀 现在去浏览器看 webhook.site 对应 inbox，应该看到上面这条 payload。");
