import type { ConsumerBlocked, ConsumerResult } from './a2-consumer.mjs';
import type { DrainLeaseSample, DrainToken } from './drain.mjs';
export interface OwnedDrainResult extends Readonly<ConsumerBlocked> {
  readonly schema: 'a2-a3-owned-drain-result-v1'; readonly profile: 'held-before-cooperative-drain';
  readonly consumer: ConsumerResult | null; readonly reason: string; readonly token: DrainToken | null;
  readonly sample: DrainLeaseSample | null; readonly polls: number; readonly phase_verified: false;
  readonly entry_hold: 'not_attempted' | 'committed' | 'unknown';
  readonly final_hold: 'not_attempted' | 'committed' | 'unknown'; readonly admission: 'open' | 'closed' | 'unknown';
}
export function consumeOwnedDrainIsolated(input: {
  readonly root: string; readonly artifactRoot: string; readonly inputJson: string;
  readonly deadlineAt: number; readonly pollEveryMs: number; readonly signal?: AbortSignal;
}): Promise<OwnedDrainResult>;
/** Fixed process CLI, with no injectable clock/window/arguments/transport. */
export function runOwnedDrainCli(): Promise<void>;
