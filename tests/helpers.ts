import type { FetchFn } from "@repo-scout/core";
import { loadConfig, type Config } from "@repo-scout/core";
import { Store } from "@repo-scout/cache";
import { Engine } from "@repo-scout/discovery";
import { ProviderRegistry } from "@repo-scout/providers";
import { RateLimiter, SafeHttp } from "@repo-scout/core";
import type { Resource } from "@repo-scout/schemas";

export type Route = {
  match: RegExp | string;
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  fn?: (url: string, init?: RequestInit) => Response;
};
export function mockFetch(routes: Route[]): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    for (const r of routes) {
      const ok = typeof r.match === "string" ? url.includes(r.match) : r.match.test(url);
      if (!ok) continue;
      if (r.fn) return r.fn(url, init);
      const body = r.body ?? JSON.stringify(r.json ?? {});
      return new Response(body, {
        status: r.status ?? 200,
        headers: {
          "content-type": r.json !== undefined ? "application/json" : "text/plain",
          ...(r.headers ?? {}),
        },
      });
    }
    return new Response("not mocked: " + url, { status: 599 });
  }) as FetchFn & { calls: string[] };
  f.calls = calls;
  return f;
}
export function testConfig(over: Partial<Record<string, unknown>> = {}): Config {
  return loadConfig(
    { REPO_SCOUT_HOME: "/nonexistent-home-not-used", REPO_SCOUT_CONFIG: "/nonexistent.json" } as any,
    { dbPath: ":memory:", ...over },
  );
}
export function testEngine(routes: Route[], over: Partial<Record<string, unknown>> = {}, now?: () => number) {
  const fetchImpl = mockFetch(routes);
  const config = testConfig(over);
  const engine = new Engine({
    config,
    fetchImpl,
    store: new Store(":memory:", now),
    now,
    limiter: new RateLimiter(100000),
  });
  return { engine, fetchImpl };
}
export function testRegistry(routes: Route[], over: Partial<Record<string, unknown>> = {}) {
  const fetchImpl = mockFetch(routes);
  const config = testConfig(over);
  const http = new SafeHttp({ fetchImpl });
  return { registry: ProviderRegistry.create(config, http), fetchImpl, http, config };
}
export function res(over: Partial<Resource> & { name: string }): Resource {
  const now = new Date().toISOString();
  return {
    id: `github:repository:${(over.fullName ?? over.name).toLowerCase()}`,
    type: "repository",
    provider: "github",
    canonicalUrl: `https://github.com/${over.fullName ?? over.name}`,
    description: "",
    topics: [],
    metadata: {},
    evidence: [
      { id: "e1", status: "verified", source: "github", detail: "api", url: "https://api.github.com" },
    ],
    freshness: { retrievedAt: now, ageSeconds: 0, fromCache: false, stale: false },
    stars: 100,
    forks: 10,
    language: "Python",
    license: "MIT",
    pushedAt: now,
    createdAt: new Date(Date.now() - 400 * 86400000).toISOString(),
    ...over,
  } as Resource;
}
export const ghRepo = (full: string, o: Record<string, unknown> = {}) => {
  const [owner, name] = full.split("/");
  return {
    full_name: full,
    name,
    owner: { login: owner },
    html_url: `https://github.com/${full}`,
    description: "desc " + full,
    language: "TypeScript",
    topics: ["mcp"],
    license: { spdx_id: "MIT", name: "MIT License" },
    stargazers_count: 120,
    forks_count: 12,
    open_issues_count: 3,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    pushed_at: new Date().toISOString(),
    archived: false,
    fork: false,
    default_branch: "main",
    ...o,
  };
};
