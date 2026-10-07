import type { WriterGenerationToken, WriterTaskToken, WriterOutcome, WriterAdmission } from "../../src/lib/runtime/writer-admission.js";
export type { WriterGenerationToken, WriterTaskToken, WriterOutcome, WriterAdmission } from "../../src/lib/runtime/writer-admission.js";
export interface WriterSnapshot {
  schema: 'a3-writer-admission-v1'; scope: 'isolated'; entryPoint: 'generation-dispatch'; coreCoverage: 'runGenerationDispatchOnce';
  marker: object; admission: 'open' | 'closed';
  workers: { workerId: string; entryPoint: string }[];
  tasks: { taskId: string; workerId: string; outcome: WriterOutcome | null; remote_subwork: 'unknown' }[];
  writer_quiescence: false; production_permitted: false;
}
export function initializeWriters(root: string): void;
export function openWriters(root: string): {
  register(workerId: string, entryPoint: 'generation-dispatch'): WriterGenerationToken;
  admit(worker: WriterGenerationToken): WriterTaskToken;
  finish(task: WriterTaskToken, outcome: WriterOutcome): void;
  closeAdmission(): void;
  admissionFor(worker: WriterGenerationToken): WriterAdmission;
  inspect(): WriterSnapshot;
  close(): void;
};
