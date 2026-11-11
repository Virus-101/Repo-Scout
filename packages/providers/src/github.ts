import { ScoutError, parseRepoRef, sanitizeText } from "@repo-scout/core";
import type { Resource } from "@repo-scout/schemas";
import {
  authHeader,
  enc,
  makeResource,
  unavailableIfOffline,
  type Provider,
  type ProviderContext,
  type ProviderQuery,
} from "./types.js";

const API = "https://api.github.com";

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}
export interface GithubExtras {
  readme?: string;
  languages?: Record<string, number>;
  contributors?: number;
  releases: Array<{ tag: string; publishedAt?: string; prerelease?: boolean; url?: string }>;
  commitActivity90d?: number;
  openPulls?: number;
  openIssuesOnly?: number;
  tree?: { entries: RepoTreeEntry[]; truncated: boolean };
  securityPolicy?: boolean;
}

export class GithubProvider implements Provider {
  readonly id = "github";
  readonly name = "GitHub";
  readonly description =
    "Repository search, metadata, README, languages, contributors, releases, commit activity, issues/PRs, license, manifests, structure (REST API).";
  readonly resourceTypes = ["repository" as const];
  readonly auth = "optional" as const;
  readonly credentialEnv = ["GITHUB_TOKEN", "GH_TOKEN"];
  readonly docsUrl = "https://docs.github.com/en/rest";
  readonly defaultSearch = true;
  readonly limitations = [
    "Unauthenticated: 60 core / 10 search requests per hour per IP; set GITHUB_TOKEN for 5000/h.",
    "GraphQL is not used; REST covers all required fields.",
    "Commit-activity statistics may return 202 while GitHub computes them.",
  ];
  constructor(private ctx: ProviderContext) {}

  availability() {
    return unavailableIfOffline(this.ctx);
  }
  private headers() {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...authHeader(this.ctx.config.credentials.githubToken),
    };
  }
  /** Search API has its own (much lower) quota than the core API: use a separate local rate-limit bucket. */
  private js<T>(path: string) {
    return this.ctx.http.json<T>(API + path, {
      provider: "github-search",
      headers: this.headers(),
      timeoutMs: this.ctx.config.providers.timeoutMs.github ?? 15000,
    });
  }
  private j<T>(path: string, timeoutMs?: number) {
    return this.ctx.http.json<T>(path.startsWith("http") ? path : API + path, {
      provider: this.id,
      headers: this.headers(),
      timeoutMs: timeoutMs ?? this.ctx.config.providers.timeoutMs.github ?? 15000,
    });
  }

  normalize(r: any): Resource {
    return makeResource(this.ctx, {
      id: `github:repository:${String(r.full_name).toLowerCase()}`,
      type: "repository",
      provider: this.id,
      name: r.name,
      fullName: r.full_name,
      canonicalUrl: r.html_url,
      description: sanitizeText(r.description, 500),
      language: r.language ?? undefined,
      topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
      license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined,
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      watchers: r.subscribers_count ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      pushedAt: r.pushed_at,
      archived: r.archived,
      fork: r.fork,
      ecosystem: "github",
      homepage: r.homepage || undefined,
      metadata: {
        defaultBranch: r.default_branch,
        size: r.size,
        hasIssues: r.has_issues,
        disabled: r.disabled,
        licenseName: r.license?.name,
      },
    });
  }

  async search(q: ProviderQuery): Promise<Resource[]> {
    const parts = [q.text.trim()];
    if (q.language) parts.push(`language:${q.language}`);
    if (q.minStars) parts.push(`stars:>=${q.minStars}`);
    if (q.pushedAfter) parts.push(`pushed:>=${q.pushedAfter}`);
    if (q.createdAfter) parts.push(`created:>=${q.createdAfter}`);
    if (q.topic) parts.push(`topic:${q.topic}`);
    parts.push("archived:false");
    const sort =
      q.sort === "stars" ? "&sort=stars&order=desc" : q.sort === "updated" ? "&sort=updated&order=desc" : "";
    const data = await this.js<{ items: any[] }>(
      `/search/repositories?q=${enc(parts.join(" "))}&per_page=${Math.min(q.limit ?? 20, 50)}${sort}`,
    );
    return (data.items ?? []).map((r) => this.normalize(r));
  }

  async get(ref: string): Promise<Resource | undefined> {
    const { owner, repo } = parseRepoRef(ref);
    try {
      return this.normalize(await this.j<any>(`/repos/${enc(owner)}/${enc(repo)}`));
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }

  /** Optional deep metadata. Every sub-request fails soft: absent data is reported as missing, never guessed. */
  async getExtras(
    ref: string,
    opts: { tree?: boolean } = {},
  ): Promise<{ extras: GithubExtras; errors: string[] }> {
    const { owner, repo } = parseRepoRef(ref);
    const base = `/repos/${enc(owner)}/${enc(repo)}`;
    const errors: string[] = [];
    const soft = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        errors.push(`${label}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const [readme, languages, contributors, releases, activity, pulls, tree] = await Promise.all([
      soft("readme", async () => {
        const t = await this.getReadme(ref);
        if (t === undefined) throw new ScoutError("NOT_FOUND", "no README found");
        return t;
      }),
      soft("languages", () => this.j<Record<string, number>>(`${base}/languages`)),
      soft("contributors", async () => {
        const r = await this.ctx.http.request(`${API}${base}/contributors?per_page=1&anon=true`, {
          provider: this.id,
          headers: this.headers(),
        });
        if (r.status >= 400) throw new ScoutError("PROVIDER_ERROR", `HTTP ${r.status}`);
        const last = r.headers.get("link")?.match(/[?&]page=(\d+)>; rel="last"/);
        return last ? Number(last[1]) : (JSON.parse(r.text) as any[]).length;
      }),
      soft("releases", () => this.j<any[]>(`${base}/releases?per_page=10`)),
      soft("commit_activity", async () => {
        const r = await this.ctx.http.request(`${API}${base}/stats/commit_activity`, {
          provider: this.id,
          headers: this.headers(),
        });
        if (r.status === 202)
          throw new ScoutError("PROVIDER_UNAVAILABLE", "statistics still being computed (HTTP 202)");
        if (r.status >= 400) throw new ScoutError("PROVIDER_ERROR", `HTTP ${r.status}`);
        const weeks = JSON.parse(r.text) as Array<{ total: number }>;
        return weeks.slice(-13).reduce((a, w) => a + w.total, 0);
      }),
      soft("pulls", async () => {
        // core API (not the scarce search quota): count open PRs via the pagination Link header
        const r = await this.ctx.http.request(`${API}${base}/pulls?state=open&per_page=1`, {
          provider: this.id,
          headers: this.headers(),
        });
        if (r.status >= 400) throw new ScoutError("PROVIDER_ERROR", `HTTP ${r.status}`);
        const last = r.headers.get("link")?.match(/[?&]page=(\d+)>; rel="last"/);
        return last ? Number(last[1]) : (JSON.parse(r.text) as unknown[]).length;
      }),
      opts.tree
        ? soft("tree", async () => {
            const d = await this.j<{
              tree: Array<{ path: string; type: string; size?: number }>;
              truncated: boolean;
            }>(`${base}/git/trees/HEAD?recursive=1`);
            return {
              entries: d.tree
                .filter((t) => t.type === "blob" || t.type === "tree")
                .map((t) => ({ path: t.path, type: t.type as "blob" | "tree", size: t.size })),
              truncated: d.truncated,
            };
          })
        : Promise.resolve(undefined),
    ]);
    return {
      errors,
      extras: {
        readme: readme ? sanitizeText(readme, 20000) : undefined,
        languages,
        contributors,
        releases: (Array.isArray(releases) ? releases : []).map((r: any) => ({
          tag: r.tag_name,
          publishedAt: r.published_at ?? undefined,
          prerelease: r.prerelease,
          url: r.html_url,
        })),
        commitActivity90d: activity,
        openPulls: pulls,
        tree,
      },
    };
  }

  /** README text. raw.githubusercontent.com first (does not consume REST API quota), REST API as fallback. */
  async getReadme(ref: string): Promise<string | undefined> {
    for (const name of ["README.md", "readme.md", "README.rst", "README", "Readme.md"]) {
      const t = await this.getRaw(ref, name, 1_000_000);
      if (t !== undefined) return t;
    }
    const { owner, repo } = parseRepoRef(ref);
    try {
      return await this.ctx.http.text(`${API}/repos/${enc(owner)}/${enc(repo)}/readme`, {
        provider: this.id,
        headers: { ...this.headers(), accept: "application/vnd.github.raw+json" },
        maxBytes: 1_000_000,
      });
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
  private async getRaw(ref: string, filePath: string, maxBytes: number): Promise<string | undefined> {
    const { owner, repo } = parseRepoRef(ref);
    try {
      return await this.ctx.http.text(
        `https://raw.githubusercontent.com/${enc(owner)}/${enc(repo)}/HEAD/${filePath.split("/").map(enc).join("/")}`,
        { provider: "github-raw", maxBytes, timeoutMs: 10000 },
      );
    } catch (e) {
      if (e instanceof ScoutError && (e.code === "NOT_FOUND" || e.code === "PROVIDER_ERROR"))
        return undefined;
      throw e;
    }
  }

  /** Fetch a single file's text (manifests): raw host first, contents API as fallback. */
  async getFile(ref: string, filePath: string, maxBytes = 500_000): Promise<string | undefined> {
    const { owner, repo } = parseRepoRef(ref);
    if (filePath.includes("..") || filePath.startsWith("/"))
      throw new ScoutError("SECURITY_BLOCKED", "Unsafe file path");
    try {
      const raw = await this.getRaw(ref, filePath, maxBytes);
      if (raw !== undefined) return raw;
    } catch {
      /* fall through to API */
    }
    try {
      return await this.ctx.http.text(
        `${API}/repos/${enc(owner)}/${enc(repo)}/contents/${filePath.split("/").map(enc).join("/")}`,
        {
          provider: this.id,
          headers: { ...this.headers(), accept: "application/vnd.github.raw+json" },
          maxBytes,
        },
      );
    } catch (e) {
      if (e instanceof ScoutError && (e.code === "NOT_FOUND" || e.code === "PROVIDER_ERROR"))
        return undefined;
      throw e;
    }
  }
}
