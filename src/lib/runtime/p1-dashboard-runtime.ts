/** P1 dashboard is development-only until the INSI-25 production admission
 * evidence exists. Keep this gate separate from P1c anchor material: metrics
 * readers never need signing or object-store credentials. Production is
 * hard-denied here as well as in deployment, so editing .env.local and
 * restarting Compose cannot bypass the admission gate. */
type DashboardEnvironment = Readonly<Record<string, string | undefined>>;

export function p1DashboardEnabled(env: DashboardEnvironment = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const raw = env.P1_DASHBOARD_ENABLED;
  if (raw == null) return false;
  if (raw !== raw.trim()) return false;
  const value = raw.toLowerCase();
  if (value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  // Deployment rejects malformed configuration with an actionable error. At
  // request time the safe behavior is still an opaque disabled dashboard.
  return false;
}

/** All pre-INSI-25 P1 administrator HTTP seams share the same admission
 * boundary. The name stays separate from the dashboard reader because
 * lifecycle and integrity endpoints are different P1 surfaces, but neither
 * may become externally reachable in a production `isolated` image. */
export function p1ExternalSeamsEnabled(env: DashboardEnvironment = process.env): boolean {
  return p1DashboardEnabled(env);
}
