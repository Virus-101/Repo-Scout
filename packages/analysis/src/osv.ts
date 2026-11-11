import type { Dependency, Vulnerability } from "@repo-scout/schemas";
import { pLimit, type SafeHttp } from "@repo-scout/core";
import { declaredVersion } from "./manifests.js";

const OSV_ECO: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  go: "Go",
  maven: "Maven",
  packagist: "Packagist",
  rubygems: "RubyGems",
};

export interface VulnReport {
  performed: "performed" | "not_performed" | "partial";
  vulnerabilities: Vulnerability[];
  checked: number;
  skipped: number;
  note: string;
}

/** Known-vulnerability lookup via OSV.dev (https://osv.dev). Only dependencies with a derivable version are checked. */
export async function checkVulnerabilities(
  http: SafeHttp,
  deps: Dependency[],
  opts: { max?: number; includeDev?: boolean } = {},
): Promise<VulnReport> {
  const cand = deps.filter((d) => (opts.includeDev ?? true) || !d.dev);
  const seen = new Set<string>();
  const queries: Array<{ dep: Dependency; version: string; eco: string }> = [];
  let skipped = 0;
  for (const d of cand) {
    const eco = OSV_ECO[d.ecosystem];
    const version = declaredVersion(d.spec);
    const key = `${eco}:${d.name}@${version}`;
    if (!eco || !version) {
      skipped++;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ dep: d, version, eco });
  }
  const limited = queries.slice(0, opts.max ?? 100);
  skipped += queries.length - limited.length;
  if (!limited.length)
    return {
      performed: "not_performed",
      vulnerabilities: [],
      checked: 0,
      skipped,
      note: "No dependencies with a derivable version to check.",
    };
  const res = await http.json<{ results: Array<{ vulns?: Array<{ id: string }> }> }>(
    "https://api.osv.dev/v1/querybatch",
    {
      provider: "osv",
      method: "POST",
      headers: { "content-type": "application/json" },
      timeoutMs: 20_000,
      body: JSON.stringify({
        queries: limited.map((q) => ({
          package: { name: q.dep.name, ecosystem: q.eco },
          version: q.version,
        })),
      }),
    },
  );
  const hits: Array<{ id: string; q: (typeof limited)[number] }> = [];
  res.results.forEach((r, i) => (r.vulns ?? []).forEach((v) => hits.push({ id: v.id, q: limited[i]! })));
  const limit = pLimit(5);
  const vulns = await Promise.all(
    hits.slice(0, 40).map((h) =>
      limit(async (): Promise<Vulnerability> => {
        try {
          const d = await http.json<any>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(h.id)}`, {
            provider: "osv",
            timeoutMs: 10_000,
          });
          const sev = d.database_specific?.severity ?? d.severity?.[0]?.score;
          return {
            id: h.id,
            summary: String(d.summary ?? "").slice(0, 200),
            severity: sev ? String(sev) : undefined,
            aliases: d.aliases ?? [],
            package: h.q.dep.name,
            ecosystem: h.q.dep.ecosystem,
            version: h.q.version,
            url: `https://osv.dev/vulnerability/${h.id}`,
          };
        } catch {
          return {
            id: h.id,
            aliases: [],
            package: h.q.dep.name,
            ecosystem: h.q.dep.ecosystem,
            version: h.q.version,
            url: `https://osv.dev/vulnerability/${h.id}`,
          };
        }
      }),
    ),
  );
  const partial = skipped > 0;
  return {
    performed: partial ? "partial" : "performed",
    vulnerabilities: vulns,
    checked: limited.length,
    skipped,
    note: `OSV.dev lookup on ${limited.length} dependencies using the minimum declared version${partial ? `; ${skipped} dependencies could not be checked (no pinned version or over limit)` : ""}. Ranges may resolve to newer, patched versions.`,
  };
}

export interface DepHealth {
  name: string;
  deprecated?: string;
  latest?: string;
  declared?: string;
  majorsBehind?: number;
}
/** npm dependency health: deprecation + major-version lag (best-effort, top N runtime deps). */
export async function npmDependencyHealth(
  http: SafeHttp,
  deps: Dependency[],
  max = 15,
): Promise<DepHealth[]> {
  const limit = pLimit(5);
  const list = deps.filter((d) => d.ecosystem === "npm" && !d.dev).slice(0, max);
  const out = await Promise.all(
    list.map((d) =>
      limit(async (): Promise<DepHealth | undefined> => {
        try {
          const j = await http.json<any>(
            `https://registry.npmjs.org/${encodeURIComponent(d.name).replace("%40", "@")}/latest`,
            { provider: "npm", timeoutMs: 8000 },
          );
          const declared = declaredVersion(d.spec);
          const behind =
            declared && j.version
              ? Number(j.version.split(".")[0]) - Number(declared.split(".")[0])
              : undefined;
          return {
            name: d.name,
            deprecated: typeof j.deprecated === "string" ? j.deprecated.slice(0, 120) : undefined,
            latest: j.version,
            declared,
            majorsBehind: behind,
          };
        } catch {
          return undefined;
        }
      }),
    ),
  );
  return out.filter((x): x is DepHealth => !!x);
}
