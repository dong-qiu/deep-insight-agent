/** 独立容器循环唤醒 app 内的 fenced dispatch executor；app 重启时下一轮自然重试。 */
const appUrl = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.DISPATCH_WORKER_SECRET;
if (!secret) throw new Error("DISPATCH_WORKER_SECRET is required");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (;;) {
  try {
    const response = await fetch(`${appUrl}/api/internal/generation-dispatch`, {
      method: "POST", headers: { "x-dispatch-worker-secret": secret }, signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!response.ok) console.error(`dispatch worker: HTTP ${response.status}`);
    else if (!(await response.json()).claimed) await sleep(2_000);
  } catch (error) {
    console.error("dispatch worker request failed", error instanceof Error ? error.message : error);
    await sleep(2_000);
  }
}
