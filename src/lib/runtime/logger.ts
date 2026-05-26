/** 结构化日志（pino）+ 强制脱敏（architecture 安全设计「密钥管理」：日志中间件强制脱敏
 *  api_key / token / cookie / authorization 等字段清单）。runLogger 带 run_id/agent/stage 标签。 */
import pino, { type DestinationStream } from "pino";

/** 脱敏字段路径（顶层 + 任意一层嵌套 + 常见 header 位置）。 */
export const REDACT_PATHS = [
  "api_key", "apiKey", "token", "password", "secret", "cookie", "authorization",
  "*.api_key", "*.apiKey", "*.token", "*.password", "*.secret", "*.cookie", "*.authorization",
  "*.headers.authorization", "*.headers.cookie",
];

export function createLogger(dest?: DestinationStream) {
  return pino(
    { level: process.env.LOG_LEVEL ?? "info", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    dest,
  );
}

export const logger = createLogger();

/** 带管线标签的子 logger（architecture 可观测性：run_id / agent / stage）。 */
export function runLogger(bindings: { run_id?: string; agent?: string; stage?: string }) {
  return logger.child(bindings);
}
