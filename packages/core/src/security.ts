import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ScoutError } from "./errors.js";

// ---------------------------------------------------------------- Safe URL / SSRF
const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
}
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(
      ([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    return (
      l.startsWith("fc") ||
      l.startsWith("fd") ||
      l.startsWith("fe8") ||
      l.startsWith("fe9") ||
      l.startsWith("fea") ||
      l.startsWith("feb") ||
      l.startsWith("ff")
    );
  }
  return false;
}
const BLOCKED_HOST = /(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/i;

export interface UrlPolicy {
  allowHttp?: boolean;
  allowLoopback?: boolean;
  allowedHosts?: string[];
}
/** Static URL validation (no DNS). Throws SECURITY_BLOCKED. */
export function assertSafeUrl(raw: string, policy: UrlPolicy = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ScoutError("INVALID_INPUT", `Invalid URL: ${raw.slice(0, 100)}`);
  }
  if (u.protocol !== "https:" && !(policy.allowHttp && u.protocol === "http:"))
    throw new ScoutError("SECURITY_BLOCKED", `Blocked URL scheme ${u.protocol}`);
  if (u.username || u.password)
    throw new ScoutError("SECURITY_BLOCKED", "URLs with embedded credentials are blocked");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (policy.allowedHosts?.includes(host)) return u;
  const loop = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (policy.allowLoopback && loop) return u;
  if (net.isIP(host) ? isPrivateIp(host) : BLOCKED_HOST.test(host) || !host.includes("."))
    throw new ScoutError("SECURITY_BLOCKED", `Blocked private/internal host: ${host}`);
  return u;
}

// ---------------------------------------------------------------- Input validation
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export function parseRepoRef(input: string): { owner: string; repo: string; host: string } {
  let s = input.trim();
  let host = "github.com";
  const m = s.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) {
    host = m[1]!.toLowerCase();
    s = m[2]!;
  }
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2)
    throw new ScoutError("INVALID_INPUT", `Expected owner/repo, got "${input.slice(0, 80)}"`);
  const [owner, repo] = parts as [string, string];
  if (!NAME.test(owner) || !NAME.test(repo) || owner === ".." || repo === "..")
    throw new ScoutError("INVALID_INPUT", `Invalid repository reference "${input.slice(0, 80)}"`);
  return { owner, repo: repo.replace(/\.git$/, ""), host };
}

// ---------------------------------------------------------------- Paths
/** Resolve `rel` inside `root`; reject traversal and (existing) symlink escapes. */
export function safeJoin(root: string, rel: string): string {
  if (rel.includes("\0")) throw new ScoutError("SECURITY_BLOCKED", "NUL byte in path");
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep))
    throw new ScoutError("SECURITY_BLOCKED", `Path traversal blocked: ${rel}`);
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep))
      throw new ScoutError("SECURITY_BLOCKED", `Symlink escape blocked: ${rel}`);
  } catch (e) {
    if (e instanceof ScoutError) throw e; // non-existent path is fine
  }
  return target;
}
/** Safe relative path inside a repository tree listing (rejects absolute / traversal). */
export function isSafeRepoPath(p: string): boolean {
  return (
    !!p &&
    !p.includes("\0") &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split(/[\\/]/).includes("..")
  );
}
export function makeSecureTempDir(prefix = "repo-scout-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // mode 0700 by mkdtemp
}

// ---------------------------------------------------------------- Untrusted content
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i, "instruction-override phrase"],
  [/disregard (the )?(system|previous|above)/i, "instruction-override phrase"],
  [/you are now (a|an|the) /i, "role reassignment phrase"],
  [
    /(reveal|print|send|exfiltrate|leak|show).{0,40}(api[_ -]?key|token|password|secret|credential|\.env|ssh key)/i,
    "credential exfiltration phrase",
  ],
  [/(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba)?sh/i, "pipe-to-shell command"],
  [/<\s*(system|assistant|tool_call|function_call)\s*>/i, "fake role/tool tag"],
  [/(delete|remove|overwrite)\s+(all|every)\s+files?/i, "destructive instruction"],
  [/(do not|don't) (tell|inform|ask) the (user|developer)/i, "concealment instruction"],
  [
    /\b(AI|assistant|agent|LLM|Claude|GPT)\b.{0,30}\b(must|should|always)\b.{0,60}\b(run|execute|install|download)\b/i,
    "agent-directed command phrase",
  ],
];
export function scanForPromptInjection(text: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of INJECTION_PATTERNS) if (re.test(text)) found.add(label);
  return [...found];
}
/** Strip control chars / zero-width / bidi overrides, collapse size. Output is data, never instructions. */
export function sanitizeText(s: unknown, max = 2000): string {
  if (typeof s !== "string") return "";
  const cleaned = s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}
/** Escape for markdown tables / inline use. */
export function mdEscape(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}
