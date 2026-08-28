/** P1 dashboard is development-only until the INSI-25 production admission
 * evidence exists. Keep this gate separate from P1c anchor material: metrics
 * readers never need signing or object-store credentials. */
type DashboardEnvironment = Readonly<Record<string, string | undefined>>;

export function p1DashboardEnabled(env: DashboardEnvironment = process.env): boolean {
  const raw = env.P1_DASHBOARD_ENABLED;
  if (raw == null) return false;
  if (raw !== raw.trim()) throw new Error("p1_dashboard_enabled_invalid");
  const value = raw.toLowerCase();
  if (value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("p1_dashboard_enabled_invalid");
}
