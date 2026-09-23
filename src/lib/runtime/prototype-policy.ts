/**
 * The product currently has one externally visible operating posture: an internal prototype.
 * Keep this declaration static rather than creating another persisted release-state machine.
 * A future public/commercial release must replace this policy through an ADR and implementation
 * work; changing copy or an environment variable must not silently widen the boundary.
 */
export const PROTOTYPE_POLICY_VERSION = "prototype-policy-v1";

export const PROTOTYPE_POLICY = {
  version: PROTOTYPE_POLICY_VERSION,
  stage: "prototype",
  audience: "authenticated_users",
  source_terms: "deferred_not_authorization",
  raw_content: "admin_only",
  commercial_use: false,
  public_api_export: false,
  model_training: false,
} as const;

/** Compact, user-visible boundary; it deliberately makes no permission or quality claim. */
export const PROTOTYPE_POLICY_NOTICE = "内部原型：仅限已认证用户；原文仅管理员核验；不得公开、商用或用于模型训练。";

/**
 * These controls remain hard requirements even though formal baseline/DCP and per-source
 * permission attestation are deferred for the prototype stage.
 */
export const PROTOTYPE_HARD_GUARDS = [
  "validator_whitelist_required",
  "verified_raw_archive_required",
  "raw_content_admin_only",
  "admin_kill_or_hide_path_required",
] as const;
