/** 结构化日志（pino）+ 强制脱敏（architecture 安全设计「密钥管理」：日志中间件强制脱敏
 *  api_key / token / cookie / authorization 等字段清单）。runLogger 带 run_id/agent/stage 标签。 */
import pino, { type DestinationStream, type Logger, type Bindings, type ChildLoggerOptions } from "pino";
import { redactDiagnostic, redactLogLine } from "./diagnostics.js";

/** 脱敏字段路径（顶层 + 任意一层嵌套 + 常见 header 位置）。 */
export const REDACT_PATHS = [
  "api_key", "apiKey", "token", "password", "secret", "cookie", "authorization",
  "*.api_key", "*.apiKey", "*.token", "*.password", "*.secret", "*.cookie", "*.authorization",
  "*.headers.authorization", "*.headers.cookie",
];

/** Pino serializes bindings at creation/update, before logMethod: protect those inputs too. */
function protectBindings(instance: Logger): Logger {
  const child = instance.child;
  const setBindings = instance.setBindings;
  // Children inherit these wrappers. Dynamic this is essential: binding to the root loses parent context.
  instance.child = function <Levels extends string = never>(this: Logger, bindings: Bindings, options?: ChildLoggerOptions<Levels>) {
    return child.call(this, redactDiagnostic(bindings) as Bindings, options) as Logger<Levels>;
  };
  instance.setBindings = function (bindings) { setBindings.call(this, redactDiagnostic(bindings) as Bindings); };
  return instance;
}

export function createLogger(dest?: DestinationStream) {
  return protectBindings(pino(
    { level: process.env.LOG_LEVEL ?? "info", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      hooks: {
        logMethod(args, method) { method.apply(this, args.map(redactDiagnostic) as typeof args); },
        streamWrite: redactLogLine,
      } },
    dest,
  ));
}

export const logger = createLogger();

/** 带管线标签的子 logger（architecture 可观测性：run_id / agent / stage）。 */
export function runLogger(bindings: { run_id?: string; agent?: string; stage?: string }) {
  return logger.child(bindings);
}
