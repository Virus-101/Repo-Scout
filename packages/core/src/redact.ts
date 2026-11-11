const PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /(authorization["']?\s*[:=]\s*["']?)(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi,
];
/** Remove anything that looks like a credential from a string. */
export function redact(s: string): string {
  let out = s;
  for (const re of PATTERNS)
    out = out.replace(re, (m, p1) => (typeof p1 === "string" ? `${p1}[REDACTED]` : "[REDACTED]"));
  return out;
}
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v))
      o[k] = /token|secret|password|api[_-]?key|authorization/i.test(k) ? "[REDACTED]" : redactDeep(val);
    return o as T;
  }
  return v;
}
