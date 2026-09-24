import { describe, expect, it, vi } from "vitest";
import { runProviderAdmissionCanary, type ProviderAdmissionCall } from "./provider-admission-canary-lib.js";

const input = {
  provider: "volcengine-responses",
  structuredTransportVersion: "volcengine-responses-forced-function-v3",
  models: { analyzer: "analyzer-model", validator: "validator-model", coverage: "coverage-model" },
  thinking: { analyzer: false, validator: false, coverage: false },
};

describe("runProviderAdmissionCanary", () => {
  it("serially checks all A1 roles with their effective thinking settings", async () => {
    const call = vi.fn<ProviderAdmissionCall>(async () => ({ ok: true, usage: { input_tokens: 3, output_tokens: 2 } }));

    const result = await runProviderAdmissionCanary({ ...input, call });

    expect(result).toMatchObject({ supported: true, provider: "volcengine-responses" });
    expect(call.mock.calls.map(([request]) => request)).toEqual([
      { role: "analyzer", thinking: false },
      { role: "validator", thinking: false },
      { role: "coverage", thinking: false },
    ]);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "analyzer", model: "analyzer-model", supported: true }),
      expect.objectContaining({ role: "validator", model: "validator-model", usage: { input_tokens: 3, output_tokens: 2 } }),
      expect.objectContaining({ role: "coverage", model: "coverage-model", supported: true }),
    ]));
  });

  it("reports a role-local safe failure without exposing mutable error metadata", async () => {
    const rejected = Object.assign(new Error("credential=secret"), { name: "token=secret", status: 999 });
    const call = vi.fn<ProviderAdmissionCall>(async ({ role }) => {
      if (role === "validator") throw rejected;
      return { ok: true, usage: { input_tokens: 1, output_tokens: 1 } };
    });

    const result = await runProviderAdmissionCanary({ ...input, call });

    expect(result.supported).toBe(false);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "validator", supported: false, error_type: "UnknownError" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("credential=secret");
    expect(JSON.stringify(result)).not.toContain("token=secret");
    expect(JSON.stringify(result)).not.toContain("999");
    expect(result.results).toHaveLength(3);
  });
});
