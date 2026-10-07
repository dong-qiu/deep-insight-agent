import { RuntimeConfigError } from "./env.js";

/** Call-time notification preflight; preserve the existing blank/zero safe defaults. */
function notificationInteger(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (value === 0) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RuntimeConfigError(name, `必须是 1–${max} 范围内的安全整数（空白或 0 使用默认值）`);
  }
  return value;
}

export const smtpPort = (): number => notificationInteger("SMTP_PORT", 465, 65_535);
export const alertTimeoutMs = (): number => notificationInteger("ALERT_TIMEOUT_MS", 5000, 2_147_483_647);
