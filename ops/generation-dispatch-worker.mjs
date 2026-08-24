/** 独立容器循环唤醒 app 内的 fenced dispatch executor；app 重启时下一轮自然重试。
 *
 * SIGTERM means drain, not abandon: stop asking the app to claim fresh work,
 * let an in-flight request finish, and after one lease window exit so another
 * worker can safely recover it.  The app owns the actual DB claim/fencing. */
import { rmSync, writeFileSync } from "node:fs";

const appUrl = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.DISPATCH_WORKER_SECRET;
if (!secret) throw new Error("DISPATCH_WORKER_SECRET is required");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_DELAY_MS = 5_000;
const DRAIN_TIMEOUT_MS = Math.max(120_000, Number(process.env.DISPATCH_DRAIN_TIMEOUT_MS) || 130_000);
const drainMarker = process.env.DISPATCH_DRAIN_MARKER ?? "/tmp/generation-dispatch-worker.draining";
let draining = false;
let inFlight = false;
let forceExitTimer;

function exitAfterDrain() {
  if (forceExitTimer) clearTimeout(forceExitTimer);
  try { rmSync(drainMarker, { force: true }); } catch { /* process exits anyway */ }
  process.exit(0);
}

function beginDrain(signal) {
  if (draining) return;
  draining = true;
  try { writeFileSync(drainMarker, `${new Date().toISOString()} ${signal}\n`, { mode: 0o600 }); } catch (error) {
    console.error("dispatch worker: could not create drain marker", error instanceof Error ? error.message : error);
  }
  console.log(`dispatch worker: ${signal} received; draining`);
  if (!inFlight) exitAfterDrain();
  forceExitTimer = setTimeout(() => {
    console.warn("dispatch worker: drain lease window elapsed; exiting for safe recovery");
    exitAfterDrain();
  }, DRAIN_TIMEOUT_MS);
  forceExitTimer.unref();
}

process.once("SIGTERM", () => beginDrain("SIGTERM"));
process.once("SIGINT", () => beginDrain("SIGINT"));

while (!draining) {
  let response;
  try {
    inFlight = true;
    response = await fetch(`${appUrl}/api/internal/generation-dispatch`, {
      method: "POST", headers: { "x-dispatch-worker-secret": secret }, signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (error) {
    console.error("dispatch worker request failed", error instanceof Error ? error.message : error);
  } finally {
    inFlight = false;
  }
  if (draining) break;
  if (!response) {
    await sleep(2_000);
    continue;
  }
  try {
    if (!response.ok) {
      console.error(`dispatch worker: HTTP ${response.status}`);
      await sleep(RETRY_DELAY_MS);
    }
    else if (!(await response.json()).claimed) await sleep(2_000);
  } catch (error) {
    console.error("dispatch worker response handling failed", error instanceof Error ? error.message : error);
    await sleep(2_000);
  }
}
exitAfterDrain();
