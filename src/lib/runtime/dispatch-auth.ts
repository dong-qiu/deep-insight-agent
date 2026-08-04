/** Machine-to-machine authentication shared by the dispatch worker and middleware.
 *
 * The route validates the same secret again; middleware only uses this to exempt
 * the trusted worker from browser session and per-IP rate-limit gates.
 */
export function hasDispatchWorkerSecret(provided: string | null, expected: string | undefined): boolean {
  return expected !== undefined && expected.length > 0 && provided !== null && provided === expected;
}
