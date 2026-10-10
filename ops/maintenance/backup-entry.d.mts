export interface IsolatedBackupTarget {
  region: 'isolated'; instanceId: string; volumeId: string; dataPath: string; serviceSet: string[];
}
export interface BackupInput {
  schema: 'r2-backup-input-v1'; operationId: string; requestId: string; ownerId: string;
  executionIdentity: string; target: IsolatedBackupTarget; DB_PATH: string; DATA_DIR: string;
  keep: number; includeRaw: boolean; windowMs: number; deadlineAt: number;
}
export interface BackupDenial {
  readonly kind: 'denied'; readonly attemptId: null; readonly code: string;
  readonly publication: 'not_attempted'; readonly controlReceipt: 'confirmed' | 'unknown';
  readonly durability: 'not_applicable'; readonly positive_admission_ready: false;
}
/** No capability, stage/publish/prune, signal replacement or readiness method. */
export function createBackupEntry(root: string): {
  prepare(input: BackupInput, signal: AbortSignal): Promise<BackupDenial>;
  close(): void;
};
