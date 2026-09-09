import { describe, expect, it, vi } from "vitest";
import {
  RelayRecoveryGate,
  RelayUnavailableError,
  isRelayCapacityError,
  type RelayRecoveryStats,
} from "./relay-recovery.js";

function stats(): RelayRecoveryStats {
  return {
    policy_version: "relay-half-open-v1",
    capacity_errors: 0, recovery_cycles: 0, probes: 0, recovered: 0, exhausted: 0,
    fast_failed_while_open: 0, total_backoff_wait_ms: 0, gate_count: 0,
  };
}

function unavailable(): Error {
  return new Error("500 relay: 无可用渠道 / no available channel");
}

describe("relay half-open recovery", () => {
  it("只识别明确的 relay 容量/路由错误，不误吞 schema 或认证问题", () => {
    expect(isRelayCapacityError(unavailable())).toBe(true);
    expect(isRelayCapacityError(new Error("429 rate limited"))).toBe(true);
    expect(isRelayCapacityError(Object.assign(new Error("rate limited by upstream"), { status: 429 }))).toBe(true);
    expect(isRelayCapacityError(new Error("503 service overloaded"))).toBe(true);
    expect(isRelayCapacityError(new Error("500 structured output schema invalid"))).toBe(false);
    expect(isRelayCapacityError(new Error("401 unauthorized"))).toBe(false);
  });

  it("容量故障后按限时 half-open probe 恢复，并返回 probe 的真实结果", async () => {
    const waits: number[] = [];
    const counters = stats();
    const gate = new RelayRecoveryGate({
      delaysMs: [10, 20, 40], maxJitterMs: 0, stats: counters,
      sleep: async (ms) => { waits.push(ms); },
    });
    let attempts = 0;
    await expect(gate.execute(async () => {
      attempts++;
      if (attempts < 3) throw unavailable();
      return "support";
    })).resolves.toBe("support");

    expect(waits).toEqual([10, 20]);
    expect(counters).toMatchObject({ capacity_errors: 2, recovery_cycles: 1, probes: 2, recovered: 1, exhausted: 0, total_backoff_wait_ms: 30 });
  });

  it("持续容量故障受 probe 与等待上限约束，最终保留 typed failure", async () => {
    const waits: number[] = [];
    const counters = stats();
    const gate = new RelayRecoveryGate({
      delaysMs: [10, 20, 40], maxJitterMs: 0, stats: counters,
      sleep: async (ms) => { waits.push(ms); },
    });
    const operation = vi.fn(async () => { throw unavailable(); });

    await expect(gate.execute(operation)).rejects.toBeInstanceOf(RelayUnavailableError);
    // The same outage is latched: later claims/groups fail fast instead of each spending another
    // 10+20+40s recovery budget.
    await expect(gate.execute(operation)).rejects.toBeInstanceOf(RelayUnavailableError);
    expect(operation).toHaveBeenCalledTimes(4); // initial request + exactly three half-open probes
    expect(waits).toEqual([10, 20, 40]);
    expect(counters).toMatchObject({ capacity_errors: 4, recovery_cycles: 1, probes: 3, recovered: 0, exhausted: 1, fast_failed_while_open: 1, total_backoff_wait_ms: 70 });
  });

  it("exhausted cooldown 后才允许一个新的 recovery cycle", async () => {
    let now = 100;
    const waits: number[] = [];
    const gate = new RelayRecoveryGate({
      delaysMs: [10], maxJitterMs: 0, exhaustedCooldownMs: 50, now: () => now,
      sleep: async (ms) => { waits.push(ms); },
    });
    let attempts = 0;
    const operation = async (): Promise<string> => {
      attempts++;
      if (attempts <= 2) throw unavailable();
      return "recovered-after-cooldown";
    };

    await expect(gate.execute(operation)).rejects.toBeInstanceOf(RelayUnavailableError);
    now += 49;
    await expect(gate.execute(operation)).rejects.toBeInstanceOf(RelayUnavailableError);
    now += 1;
    await expect(gate.execute(operation)).resolves.toBe("recovered-after-cooldown");
    expect(waits).toEqual([10]); // second cycle's direct request recovered; no extra probe
  });

  it("cooldown 到期的 half-open probe 同样共享：并发 caller 不会重新形成 stampede", async () => {
    let now = 100;
    let release!: () => void;
    let enteredProbe!: () => void;
    const probeEntered = new Promise<void>((resolve) => { enteredProbe = resolve; });
    const counters = stats();
    const gate = new RelayRecoveryGate({
      delaysMs: [10], maxJitterMs: 0, exhaustedCooldownMs: 50, now: () => now, stats: counters,
      sleep: async () => {},
    });
    let calls = 0;
    const operation = async (): Promise<string> => {
      calls++;
      if (calls <= 2) throw unavailable(); // initial request + first delayed probe exhaust the cycle
      if (calls === 3) {
        enteredProbe();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return `ok-${calls}`;
    };

    await expect(gate.execute(operation)).rejects.toBeInstanceOf(RelayUnavailableError);
    now += 50;
    const first = gate.execute(operation);
    await probeEntered;
    const second = gate.execute(operation);
    const third = gate.execute(operation);
    expect(calls).toBe(3); // exactly one wire request registered as the half-open probe

    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual(["ok-3", "ok-4", "ok-5"]);
    expect(counters).toMatchObject({ recovery_cycles: 2, probes: 2, recovered: 1, exhausted: 1 });
  });

  it("并发 callers 共用一个 half-open probe，恢复后各自才继续自己的请求", async () => {
    const counters = stats();
    let release!: () => void;
    let sleeping!: () => void;
    const enteredSleep = new Promise<void>((resolve) => { sleeping = resolve; });
    const gate = new RelayRecoveryGate({
      delaysMs: [10], maxJitterMs: 0, stats: counters,
      sleep: async () => {
        sleeping();
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    let calls = 0;
    const operation = vi.fn(async () => {
      calls++;
      if (calls === 1) throw unavailable();
      return `ok-${calls}`;
    });

    const first = gate.execute(operation);
    await enteredSleep;
    const second = gate.execute(operation);
    const third = gate.execute(operation);
    expect(operation).toHaveBeenCalledTimes(1); // the two followers wait behind the gate

    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual(["ok-2", "ok-3", "ok-4"]);
    expect(counters).toMatchObject({ recovery_cycles: 1, probes: 1, recovered: 1, exhausted: 0 });
  });

  it("leader 取消只取消自己的等待，不会取消共享 probe 或 follower", async () => {
    let release!: () => void;
    let sleeping!: () => void;
    const enteredSleep = new Promise<void>((resolve) => { sleeping = resolve; });
    const gate = new RelayRecoveryGate({
      delaysMs: [10], maxJitterMs: 0,
      sleep: async () => {
        sleeping();
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    let calls = 0;
    const operation = async (): Promise<string> => {
      calls++;
      if (calls === 1) throw unavailable();
      return "recovered";
    };
    const controller = new AbortController();
    const first = gate.execute(operation, controller.signal);
    await enteredSleep;
    const follower = gate.execute(operation);
    controller.abort(new Error("caller cancelled"));

    await expect(first).rejects.toThrow("caller cancelled");
    release();
    await expect(follower).resolves.toBe("recovered");
  });
});
