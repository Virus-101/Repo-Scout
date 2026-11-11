export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK"
  | "TIMEOUT"
  | "SECURITY_BLOCKED"
  | "CONFIG"
  | "DATABASE"
  | "INTERNAL";

export class ScoutError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public exitCode = 1,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}
export function toScoutError(e: unknown): ScoutError {
  if (e instanceof ScoutError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new ScoutError("INTERNAL", redact(msg));
}
import { redact } from "./redact.js";
