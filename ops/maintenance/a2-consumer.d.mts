import type { DrainToken } from './drain.mjs';
export interface ConsumerIdentity {
  repository: string; revision: string; platform: 'linux/amd64';
  index_digest: string; manifest_digest: string; config_digest: string; compose_sha256: string;
}
export interface ConsumerContext {
  operation_id: string; maintenance_holder: string; operator: string;
  schema_sha256: string; migrations_sha256: string; configuration_sha256: string; data_sample_sha256: string;
  release: ConsumerIdentity;
}
export interface ConsumerClaim {
  scope: string; result: 'pass' | 'fail' | 'not-run'; issued_at: string; expires_at: string; receipt_sha256: string;
  binding: ConsumerContext & { rollback: ConsumerIdentity }; checks: Record<string, boolean>;
}
export type ConsumerRole = 'schema' | 'migrations' | 'configuration' | 'data_sample' | 'compose' | 'identity' | 'security'
  | 'isolated_compatibility' | 'production_compatibility' | 'approval';
export type ConsumerEvidenceRole = 'identity' | 'security' | 'isolated_compatibility' | 'production_compatibility' | 'approval';
export interface ConsumerInput {
  schema_version: 'a2-a3-isolated-consumer-v1';
  a2: {
    schema_version: 'a2-a3-handoff-v1';
    phase: 'before-writer-stop' | 'writers-stopped' | 'backup' | 'migration' | 'deployment-record' | 'readiness' | 'rollback-readiness';
    context: ConsumerContext; rollback: ConsumerIdentity;
    evidence: Record<'identity' | 'security' | 'isolated_compatibility', ConsumerClaim>
      & Partial<Record<'production_compatibility' | 'approval', ConsumerClaim>>;
  };
  a3: { token: DrainToken; binding: Omit<DrainToken, 'revision'> & { commandId: string | null; submitToken: string | null; requestHash: string | null } };
  artifacts: Record<Exclude<ConsumerRole, 'production_compatibility' | 'approval'>, { size: number; sha256: string }>
    & Partial<Record<'production_compatibility' | 'approval', { size: number; sha256: string }>>;
}
export interface ConsumerBlocked {
  deployment_permitted: false; rollback_permitted: false; production_permitted: false;
  database_restore_permitted: false; inverse_migration_permitted: false; drain_ready: false; writer_quiescence: false;
  approved_safe_rollback: null; observation_atomic: false; controller_uniqueness: 'unknown'; process_termination: 'unknown';
  all_writer_coverage: false; commands_executed: false;
}
export interface DocumentaryAssessment {
  schema_version: 'a2-diagnostic-v1'; interface_version: 'a2-a3-handoff-v1'; location: 'local-documentary-assessment';
  production_entry_integrated: false; deployment_permitted: false; rollback_permitted: false; approved_safe_rollback: null;
  phase: string; declarations: Record<ConsumerEvidenceRole, { structurally_complete: boolean; verified: false }>;
  blockers: string[]; failure_disposition: string; a3_obligation: string;
  database_restore_permitted: false; inverse_migration_permitted: false; health_is_security_acceptance: false; commands_executed: false;
}
export interface ConsumerSuccess extends ConsumerBlocked {
  schema_version: 'a2-a3-isolated-consumer-result-v1'; isolated_consumer_integrated: true;
  binding_sha256: string; a2: DocumentaryAssessment; modules: string[]; blockers: string[];
  engineering_fixture_scope: 'synthetic-current-code-only'; policy_identity_scope: 'frozen447-byte-declaration-only';
  inherited_reader_capacity_atomic: false; phase_verified: false;
  a3: { state: string; disposition: string; admission: 'open' | 'closed'; queued: number; claimedCurrent: number;
    claimedExpired: number; unknown: number; registered_tasks: number; remote_subwork: 'unknown' };
  artifacts: Record<ConsumerRole, { size?: number; sha256?: string; missing: boolean; bytes_bound: boolean; authenticated: false }>;
}
export interface ConsumerFailure extends ConsumerBlocked {
  schema_version: 'a2-a3-isolated-consumer-result-v1'; isolated_consumer_integrated: false;
  a2?: DocumentaryAssessment | null; reason: string; blockers?: string[];
}
export type ConsumerResult = ConsumerSuccess | ConsumerFailure;
export function consumeA2Isolated(input: { root: string; artifactRoot: string; input: unknown; now?: number }): ConsumerResult;
export function main(args?: string[]): ConsumerResult;
