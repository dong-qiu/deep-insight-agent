import { describe, expect, it } from "vitest";
import { PROTOTYPE_HARD_GUARDS, PROTOTYPE_POLICY, PROTOTYPE_POLICY_NOTICE, PROTOTYPE_POLICY_VERSION } from "./prototype-policy.js";

describe("prototype release policy", () => {
  it("is an explicit internal-only policy rather than an implicit release default", () => {
    expect(PROTOTYPE_POLICY).toEqual({
      version: PROTOTYPE_POLICY_VERSION,
      stage: "prototype",
      audience: "authenticated_users",
      source_terms: "deferred_not_authorization",
      raw_content: "admin_only",
      commercial_use: false,
      public_api_export: false,
      model_training: false,
    });
  });

  it("keeps the four non-negotiable safety guards", () => {
    expect(PROTOTYPE_HARD_GUARDS).toEqual([
      "validator_whitelist_required",
      "verified_raw_archive_required",
      "raw_content_admin_only",
      "admin_kill_or_hide_path_required",
    ]);
  });

  it("uses user-facing wording that does not claim a source permission or formal quality approval", () => {
    expect(PROTOTYPE_POLICY_NOTICE).toContain("内部原型");
    expect(PROTOTYPE_POLICY_NOTICE).not.toMatch(/来源授权|合规|质量认证|质量批准/);
  });
});
