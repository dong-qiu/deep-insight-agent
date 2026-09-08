/** Read-only contracts. No task, PR, CI, credential, deploy, IAM or notification mutation exists here. */
import type { Freshness } from "./replay.js";

export interface RuntimeTaskSnapshot {
  task_id: string;
  state: "queued" | "leased" | "running" | "completed" | "failed" | "cancelled";
  lease_id?: string;
  runtime_id?: string;
  runtime_identity?: string;
  lease_fencing_token?: string;
  lease_expires_at?: string;
  result?: "completed" | "failed";
  checkpoint_ref?: string;
}

export interface RuntimeSnapshot {
  observed_at: string;
  heartbeat_at?: string;
  tasks: readonly RuntimeTaskSnapshot[];
}

export interface RuntimeSnapshotPort { readRuntimeSnapshot(deliveryId: string): Promise<RuntimeSnapshot>; }

export interface GitHubEvidenceSnapshot {
  observed_at: string;
  snapshot?: { id: string; immutable_ref: string; payload_hash: string; freshness: Freshness; observed_at: string };
  ci?: { id: string; immutable_ref: string; payload_hash: string; freshness: Freshness; conclusion: "passed" | "failed"; observed_at: string };
  review?: { id: string; immutable_ref: string; payload_hash: string; freshness: Freshness; conclusion: "approved" | "failed"; observed_at: string };
}

export interface GitHubEvidencePort { readGitHubEvidenceSnapshot(deliveryId: string): Promise<GitHubEvidenceSnapshot>; }

/** Local persistence only. A caller may claim a plan, but this PR has no sender. */
export interface NotificationOutboxPort {
  claimNotification(dedupeKey: string, claimToken: string, claimedAt: string): { kind: "claimed" | "already_claimed" | "missing" };
}

export const capabilityDeniedTransport = Object.freeze({
  denied: Object.freeze(["merge", "deploy", "credentials", "iam", "task_mutation", "notification_delivery"]),
  assertDenied(capability: string): never { throw new Error(`capability_denied:${capability}`); },
});
