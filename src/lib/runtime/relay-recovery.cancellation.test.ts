import { afterEach, expect, it, vi } from "vitest";
import { RelayRecoveryGate } from "./relay-recovery.js";
afterEach(() => vi.useRealTimers());
it("cancelled recovery leader releases real backoff timer; follower retries its own operation", async () => {
  vi.useFakeTimers();
  const gate = new RelayRecoveryGate({ delaysMs: [100], maxJitterMs: 0 });
  const external = new AbortController();
  const leaderWork = vi.fn(async () => { throw Object.assign(new Error("synthetic-private-capacity"), { status: 429 }); });
  const first = gate.execute(leaderWork, external.signal); const rejected = expect(first).rejects.toThrow("caller cancelled");
  await vi.advanceTimersByTimeAsync(0);
  const followerWork = vi.fn(async () => "follower"); const follower = gate.execute(followerWork);
  external.abort(new Error("caller cancelled"));
  // reason is assigned after abort, so assert after collecting result too.
  await rejected;
  await expect(follower).resolves.toBe("follower");
  expect(leaderWork).toHaveBeenCalledOnce(); expect(followerWork).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);

});
