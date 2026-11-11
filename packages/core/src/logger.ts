import { redact } from "./redact.js";
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
const order: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
export interface Logger {
  error(m: string, ...a: unknown[]): void;
  warn(m: string, ...a: unknown[]): void;
  info(m: string, ...a: unknown[]): void;
  debug(m: string, ...a: unknown[]): void;
}
/** Logs go to STDERR only (stdout is reserved for MCP / JSON output). Secrets are redacted. */
export function createLogger(
  level: LogLevel = "warn",
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): Logger {
  const mk =
    (lv: LogLevel) =>
    (m: string, ...a: unknown[]) => {
      if (order[lv] > order[level]) return;
      const extra = a.length ? " " + a.map((x) => (typeof x === "string" ? x : safeJson(x))).join(" ") : "";
      sink(redact(`[repo-scout] ${lv}: ${m}${extra}`));
    };
  return { error: mk("error"), warn: mk("warn"), info: mk("info"), debug: mk("debug") };
}
function safeJson(x: unknown) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
export const nullLogger: Logger = createLogger("silent");
