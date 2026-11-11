import dns from "node:dns/promises";
import { ScoutError } from "./errors.js";
import { assertSafeUrl, isPrivateIp, type UrlPolicy } from "./security.js";
import { redact } from "./redact.js";
import type { Logger } from "./logger.js";
import { nullLogger } from "./logger.js";
import net from "node:net";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Token-bucket style limiter: at most `perInterval` requests per `intervalMs`, per key. */
export class RateLimiter {
  private stamps = new Map<string, number[]>();
  private overrides = new Map<string, number>();
  setLimit(key: string, perInterval: number) {
    this.overrides.set(key, perInterval);
    return this;
  }
  constructor(
    private perInterval = 30,
    private intervalMs = 60_000,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async acquire(key: string, maxWaitMs = 75_000): Promise<void> {
    const start = this.now();
    for (;;) {
      const t = this.now();
      const arr = (this.stamps.get(key) ?? []).filter((s) => t - s < this.intervalMs);
      if (arr.length < (this.overrides.get(key) ?? this.perInterval)) {
        arr.push(t);
        this.stamps.set(key, arr);
        return;
      }
      const wait = this.intervalMs - (t - arr[0]!) + 1;
      if (t - start + wait > maxWaitMs)
        throw new ScoutError(
          "RATE_LIMITED",
          `Local rate limit reached for ${key}`,
          "Retry later or add credentials for higher limits.",
        );
      await this.sleep(wait);
    }
  }
}

export interface SafeFetchOptions {
  fetchImpl?: FetchFn;
  logger?: Logger;
  limiter?: RateLimiter;
  /** Resolve & verify host IPs (SSRF). Disabled for mocked fetch or when an egress proxy is configured. */
  resolveDns?: boolean;
}
export interface RequestOpts {
  provider: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  policy?: UrlPolicy;
  maxRedirects?: number;
  retries?: number;
}
const hasProxy = () => !!(process.env.HTTPS_PROXY || process.env.https_proxy);

export class SafeHttp {
  private fetchImpl: FetchFn;
  private logger: Logger;
  private limiter: RateLimiter;
  private resolveDns: boolean;
  private rateRemaining = new Map<string, { remaining: number; resetAt: number }>();
  constructor(o: SafeFetchOptions = {}) {
    this.fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
    this.logger = o.logger ?? nullLogger;
    this.limiter = o.limiter ?? new RateLimiter();
    this.resolveDns = o.resolveDns ?? (!o.fetchImpl && !hasProxy());
  }

  private async checkHost(u: URL, policy?: UrlPolicy) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!this.resolveDns || net.isIP(host) || policy?.allowLoopback) return;
    try {
      const addrs = await dns.lookup(host, { all: true });
      for (const a of addrs)
        if (isPrivateIp(a.address))
          throw new ScoutError("SECURITY_BLOCKED", `Host ${host} resolves to a private address`);
    } catch (e) {
      if (e instanceof ScoutError) throw e;
      throw new ScoutError("NETWORK", `DNS lookup failed for ${host}`);
    }
  }

  async request(
    rawUrl: string,
    o: RequestOpts,
  ): Promise<{ status: number; headers: Headers; text: string; url: string }> {
    const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    const retries = o.retries ?? 1;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(rawUrl, o, maxBytes);
      } catch (e) {
        const se = e as ScoutError;
        const retryable = se.code === "NETWORK";
        if (!retryable || attempt >= retries) throw e;
        attempt++;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }

  private async once(rawUrl: string, o: RequestOpts, maxBytes: number) {
    let url = assertSafeUrl(rawUrl, o.policy).toString();
    await this.limiter.acquire(o.provider);
    const rl = this.rateRemaining.get(o.provider);
    if (rl && rl.remaining <= 0 && rl.resetAt > Date.now())
      throw new ScoutError(
        "RATE_LIMITED",
        `${o.provider} rate limit exhausted until ${new Date(rl.resetAt).toISOString()}`,
        "Set a provider token for higher limits.",
      );
    const max = o.maxRedirects ?? 3;
    for (let hop = 0; hop <= max; hop++) {
      const u = assertSafeUrl(url, o.policy);
      await this.checkHost(u, o.policy);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: o.method ?? "GET",
          body: o.body,
          redirect: "manual",
          signal: ctl.signal,
          headers: {
            "user-agent": "repo-scout/0.1 (+local-first; no-telemetry)",
            accept: "application/json, text/plain, */*",
            ...(o.headers ?? {}),
          },
        });
      } catch (e) {
        clearTimeout(timer);
        if ((e as Error).name === "AbortError")
          throw new ScoutError("TIMEOUT", `${o.provider}: request timed out`);
        throw new ScoutError("NETWORK", `${o.provider}: ${redact((e as Error).message)}`);
      }
      clearTimeout(timer);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, url);
        // never forward credentials to a different host
        if (next.host !== u.host && o.headers)
          o = {
            ...o,
            headers: Object.fromEntries(
              Object.entries(o.headers).filter(
                ([k]) => !/^(authorization|private-token|x-.*key.*)$/i.test(k),
              ),
            ),
          };
        if (hop >= max) {
          return { status: res.status, headers: res.headers, text: "", url };
        }
        url = next.toString();
        continue;
      }
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining !== null && reset)
        this.rateRemaining.set(o.provider, { remaining: Number(remaining), resetAt: Number(reset) * 1000 });
      const text = await readCapped(res, maxBytes);
      this.logger.debug(`${o.provider} ${o.method ?? "GET"} ${u.origin}${u.pathname} -> ${res.status}`);
      return { status: res.status, headers: res.headers, text, url };
    }
    throw new ScoutError("SECURITY_BLOCKED", "Too many redirects");
  }

  async json<T = unknown>(url: string, o: RequestOpts): Promise<T> {
    const r = await this.request(url, o);
    if (r.status === 404)
      throw new ScoutError("NOT_FOUND", `${o.provider}: not found (${new URL(url).pathname})`);
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      const rateLimited = r.status === 429 || r.headers.get("x-ratelimit-remaining") === "0";
      throw new ScoutError(
        rateLimited ? "RATE_LIMITED" : "PROVIDER_ERROR",
        `${o.provider}: HTTP ${r.status}${rateLimited ? " (rate limited)" : ""}`,
        rateLimited || r.status === 401
          ? "Provide a token via environment variable for higher limits / access."
          : undefined,
      );
    }
    if (r.status >= 400) throw new ScoutError("PROVIDER_ERROR", `${o.provider}: HTTP ${r.status}`);
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new ScoutError("PROVIDER_ERROR", `${o.provider}: invalid JSON response`);
    }
  }
  async text(url: string, o: RequestOpts): Promise<string> {
    const r = await this.request(url, o);
    if (r.status === 404) throw new ScoutError("NOT_FOUND", `${o.provider}: not found`);
    if (r.status >= 400) throw new ScoutError("PROVIDER_ERROR", `${o.provider}: HTTP ${r.status}`);
    return r.text;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new ScoutError("PROVIDER_ERROR", `Response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
