import type { Dependency, Inspection, Resource, SecuritySignals } from "@repo-scout/schemas";
import {
  isSafeRepoPath,
  sanitizeText,
  scanForPromptInjection,
  type SafeHttp,
  ScoutError,
} from "@repo-scout/core";
import type { GithubProvider, RepoTreeEntry } from "@repo-scout/providers";
import { detectFrameworks, LOCKFILES, MANIFEST_FILES, parseManifest } from "./manifests.js";
import { checkVulnerabilities, npmDependencyHealth, type DepHealth } from "./osv.js";

const SKIP_DIR =
  /(^|\/)(node_modules|vendor|third_party|dist|build|\.git|test|tests|__tests__|examples?|docs?|fixtures?|samples?)(\/|$)/i;

export function classifyTree(
  entries: RepoTreeEntry[],
  truncated = false,
): NonNullable<Inspection["structure"]> & {
  hasSecurityPolicy: boolean;
  lockfiles: string[];
  manifests: string[];
} {
  const paths = entries.map((e) => e.path).filter(isSafeRepoPath);
  const top = [...new Set(paths.map((p) => p.split("/")[0]!))].sort();
  const lower = paths.map((p) => p.toLowerCase());
  return {
    topLevel: top.slice(0, 60),
    hasTests: lower.some(
      (p) =>
        /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/.test(p) ||
        /\.(test|spec)\.[a-z]+$/.test(p) ||
        /(^|\/)test_[^/]+\.py$/.test(p) ||
        /_test\.(go|py|rs)$/.test(p),
    ),
    hasCI: lower.some(
      (p) =>
        p.startsWith(".github/workflows/") ||
        p === ".gitlab-ci.yml" ||
        p.startsWith(".circleci/") ||
        p === "azure-pipelines.yml" ||
        p === ".travis.yml" ||
        p === "jenkinsfile" ||
        p.startsWith(".woodpecker"),
    ),
    hasDocsDir: lower.some((p) => /^(docs?|documentation|wiki)(\/|$)/.test(p)),
    hasDockerfile: lower.some((p) => /(^|\/)(dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(p)),
    fileCount: paths.length,
    truncated,
    hasSecurityPolicy: lower.some(
      (p) => p === "security.md" || p === ".github/security.md" || p === "docs/security.md",
    ),
    lockfiles: paths.filter((p) => LOCKFILES.includes(p.split("/").pop()!) && p.split("/").length <= 3),
    manifests: paths.filter(
      (p) => MANIFEST_FILES.includes(p.split("/").pop()!) && !SKIP_DIR.test(p) && p.split("/").length <= 3,
    ),
  };
}

export function detectArchitecture(
  entries: RepoTreeEntry[],
  deps: Dependency[],
  apiSurface: string[],
): string[] {
  const dirs = new Set(entries.filter((e) => e.type === "tree").map((e) => e.path));
  const paths = entries.map((e) => e.path.toLowerCase());
  const out: string[] = [];
  if (
    dirs.has("packages") ||
    dirs.has("apps") ||
    paths.includes("pnpm-workspace.yaml") ||
    paths.includes("lerna.json") ||
    paths.includes("nx.json") ||
    paths.includes("turbo.json")
  )
    out.push("monorepo / workspaces");
  if (paths.some((p) => /(^|\/)(plugins?|extensions?)\//.test(p)))
    out.push("plugin / extension architecture");
  if (paths.filter((p) => /docker-compose|compose\.ya?ml/.test(p)).length)
    out.push("multi-service (docker compose)");
  if (paths.some((p) => /(^|\/)(routes?|controllers?|handlers?|api)\//.test(p)))
    out.push("layered HTTP/API structure");
  if (paths.some((p) => /(^|\/)(migrations?|alembic)\//.test(p))) out.push("database migrations");
  if (paths.some((p) => p === "tsconfig.json" || p.endsWith("/tsconfig.json")))
    out.push("typed (TypeScript config)");
  if (paths.some((p) => /mypy\.ini|py\.typed|pyrightconfig/.test(p)))
    out.push("typed (Python type-checking config)");
  if (paths.some((p) => /\.eslintrc|eslint\.config|\.prettierrc|ruff\.toml|\.flake8|clippy/.test(p)))
    out.push("lint/format configuration");
  if (paths.some((p) => /(^|\/)(src\/main|app\/main|cmd\/)/.test(p)) || apiSurface.includes("CLI"))
    out.push("executable entry points");
  if (deps.some((d) => /^@modelcontextprotocol\/sdk$|^mcp$|^fastmcp$/.test(d.name)))
    out.push("MCP server/client");
  if (paths.some((p) => /^(helm|charts|k8s|kubernetes|deploy)\//.test(p)))
    out.push("Kubernetes/deployment manifests");
  if (paths.some((p) => /\.proto$/.test(p))) out.push("protobuf/gRPC interfaces");
  if (paths.some((p) => /openapi|swagger/.test(p))) out.push("OpenAPI specification");
  return out;
}

export interface InspectDeps {
  github: GithubProvider;
  http: SafeHttp;
  now?: () => number;
}
export interface InspectOptions {
  vulnerabilityCheck?: boolean;
  maxManifests?: number;
}
export interface InspectResult {
  inspection: Inspection;
  depHealth: DepHealth[];
  errors: string[];
  extrasEvidence: string[];
}

/**
 * LEVEL 3 deep inspection. Static analysis only: reads the repository tree, manifests and README through the hosting API.
 * Nothing is cloned, built, installed or executed.
 */
export async function inspectRepository(
  resource: Resource,
  deps: InspectDeps,
  opts: InspectOptions = {},
): Promise<InspectResult> {
  if (resource.type !== "repository" || !resource.fullName)
    throw new ScoutError("INVALID_INPUT", "Deep inspection requires a repository resource");
  const ref = resource.fullName;
  const errors: string[] = [],
    limitations: string[] = [];
  const { extras, errors: ex } = await deps.github.getExtras(ref, { tree: true });
  errors.push(...ex);
  const entries = extras.tree?.entries ?? [];
  if (!extras.tree)
    limitations.push("Repository tree unavailable: structure, tests, CI and manifest detection skipped.");
  if (extras.tree?.truncated)
    limitations.push("Repository tree was truncated by the hosting API; some files are not visible.");
  const cls = classifyTree(entries, extras.tree?.truncated);
  let manifestPaths = cls.manifests
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, opts.maxManifests ?? 8);
  if (!extras.tree) {
    manifestPaths = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml"];
    limitations.push(
      "Tree unavailable: probing well-known root manifests only (nested manifests, tests and CI cannot be detected).",
    );
  }
  const files = await Promise.all(
    manifestPaths.map(async (p) => {
      try {
        const t = await deps.github.getFile(ref, p, 300_000);
        return t ? { path: p, text: t } : undefined;
      } catch (e) {
        errors.push(`${p}: ${(e as Error).message}`);
        return undefined;
      }
    }),
  );
  const parsed = files
    .filter((f): f is { path: string; text: string } => !!f)
    .map((f) => ({ path: f.path, info: parseManifest(f.path, f.text) }));
  const allDeps: Dependency[] = [];
  const seen = new Set<string>();
  for (const p of parsed)
    for (const d of p.info.dependencies) {
      const k = `${d.ecosystem}:${d.name}`;
      if (!seen.has(k)) {
        seen.add(k);
        allDeps.push(d);
      }
    }
  const { frameworks, apiSurface: depApi } = detectFrameworks(allDeps);
  const apiSurface = [...new Set([...parsed.flatMap((p) => p.info.apiSurface), ...depApi])];
  const installScripts = parsed.flatMap((p) => p.info.installScripts);
  if (entries.some((e) => /(^|\/)build\.rs$/.test(e.path)))
    installScripts.push("build.rs executes at compile time");
  const runtime = [
    ...new Set([
      ...parsed.flatMap((p) => p.info.runtime),
      ...(cls.hasDockerfile ? ["docker"] : []),
      ...(allDeps.some((d) => /^(torch|tensorflow|cupy|onnxruntime-gpu)$/.test(d.name))
        ? ["gpu-capable (CUDA likely)"]
        : []),
    ]),
  ];
  const readme = extras.readme ?? "";
  const injection = readme ? scanForPromptInjection(readme) : [];
  let vuln: SecuritySignals["vulnerabilityCheck"] = "not_performed";
  let vulns: SecuritySignals["vulnerabilities"] = [];
  const disclaimers = [
    "Static metadata inspection only. This is NOT a security audit; no code was executed, built or installed.",
    "Vulnerability data comes from OSV.dev for declared dependency versions and may be incomplete.",
  ];
  let depHealth: DepHealth[] = [];
  if (opts.vulnerabilityCheck !== false && allDeps.length) {
    try {
      const r = await checkVulnerabilities(deps.http, allDeps);
      vuln = r.performed;
      vulns = r.vulnerabilities;
      disclaimers.push(r.note);
      depHealth = await npmDependencyHealth(deps.http, allDeps);
    } catch (e) {
      errors.push(`osv: ${(e as Error).message}`);
      limitations.push("Vulnerability lookup failed; security score has no vulnerability data.");
    }
  } else if (!allDeps.length)
    limitations.push("No dependency manifests found: vulnerability lookup not applicable/performed.");
  if (injection.length)
    disclaimers.push(
      "README contains text resembling instructions aimed at AI agents; it has been treated strictly as untrusted data.",
    );
  const security: SecuritySignals = {
    vulnerabilityCheck: vuln,
    vulnerabilities: vulns,
    hasSecurityPolicy: extras.tree ? cls.hasSecurityPolicy : undefined,
    hasLockfile: extras.tree ? cls.lockfiles.length > 0 : undefined,
    installScripts,
    promptInjectionFindings: injection,
    disclaimers,
  };
  if (!extras.commitActivity90d) limitations.push("Commit-activity statistics unavailable.");
  const inspection: Inspection = {
    level: "3-deep",
    structure: extras.tree
      ? {
          topLevel: cls.topLevel,
          hasTests: cls.hasTests,
          hasCI: cls.hasCI,
          hasDocsDir: cls.hasDocsDir,
          hasDockerfile: cls.hasDockerfile,
          fileCount: cls.fileCount,
          truncated: cls.truncated,
        }
      : undefined,
    manifests: parsed.map((p) => p.path),
    dependencies: allDeps.slice(0, 300),
    frameworks,
    architecturePatterns: detectArchitecture(entries, allDeps, apiSurface),
    apiSurface,
    runtime,
    security,
    releaseCount: extras.releases.length,
    contributors: extras.contributors,
    commitActivity90d: extras.commitActivity90d,
    readmeExcerpt: readme ? sanitizeText(readme, 1500) : undefined,
    limitations,
  };
  return {
    inspection,
    depHealth,
    errors,
    extrasEvidence: [
      `GitHub REST: tree, ${manifestPaths.length} manifest(s), README, releases, contributors`,
    ],
  };
}

/** Merge extras (README length, releases, languages) back into a Resource as verified metadata. */
export function enrichResource(
  r: Resource,
  extras: {
    readme?: string;
    languages?: Record<string, number>;
    releases?: Array<{ tag: string; publishedAt?: string; prerelease?: boolean; url?: string }>;
    contributors?: number;
  },
): Resource {
  const out: Resource = { ...r, metadata: { ...r.metadata } };
  if (extras.readme !== undefined) {
    out.metadata.readmeHead = extras.readme.slice(0, 4000);
    out.metadata.readmeLength = extras.readme.length;
  }
  if (extras.languages) out.languages = extras.languages;
  const rel = extras.releases?.find((x) => !x.prerelease) ?? extras.releases?.[0];
  if (rel) out.latestRelease = rel;
  if (extras.contributors !== undefined) out.metadata.contributors = extras.contributors;
  return out;
}
