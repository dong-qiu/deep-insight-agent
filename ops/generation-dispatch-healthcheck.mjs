import { existsSync } from "node:fs";

const appUrl = process.env.APP_URL ?? "http://app:3000";
const secret = process.env.DISPATCH_WORKER_SECRET;
if (!secret) process.exit(1);
if (existsSync(process.env.DISPATCH_DRAIN_MARKER ?? "/tmp/generation-dispatch-worker.draining")) process.exit(1);

try {
  const response = await fetch(`${appUrl}/api/internal/generation-dispatch/health`, {
    headers: { "x-dispatch-worker-secret": secret },
    signal: AbortSignal.timeout(5_000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
