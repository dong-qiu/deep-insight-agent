/** Fixed isolated pre-open. Does not publish the application's singleton or initialize business schema. */
import { openV2BusinessTarget } from '../../../ops/maintenance/writers-v2.mjs';
import type { OperationCapabilityV2, PreopenResultV2 } from '../../../ops/maintenance/writers-v2.mjs';
export type { WorkerCapabilityV2, OperationCapabilityV2, BusinessTargetV2, PreopenResultV2, ScopeV2 } from '../../../ops/maintenance/writers-v2.mjs';
export function openV2Business(operation: OperationCapabilityV2): PreopenResultV2 {
  return openV2BusinessTarget(operation);
}
