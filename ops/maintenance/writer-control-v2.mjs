/** Real same-registry observation/permanent close. Never a drain/quiescence grant. */
import { openWritersV2 } from './writers-v2.mjs';
export function inspectWritersV2(root) {
  const writers = openWritersV2(root);
  try { return writers.inspect(); } finally { writers.close(); }
}
export function closeWritersV2(root) {
  const writers = openWritersV2(root);
  try { return writers.closeAdmission(); } finally { writers.close(); }
}
