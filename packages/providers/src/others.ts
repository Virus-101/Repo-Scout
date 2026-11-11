import { ScoutError, sanitizeText } from "@repo-scout/core";
import type { Resource } from "@repo-scout/schemas";
import {
  authHeader,
  canonicalizeUrl,
  enc,
  makeResource,
  unavailableIfOffline,
  type Provider,
  type ProviderContext,
  type ProviderQuery,
} from "./types.js";

abstract class Base {
  constructor(protected ctx: ProviderContext) {}
  availability() {
    return unavailableIfOffline(this.ctx);
  }
  protected timeout(id: string) {
    return this.ctx.config.providers.timeoutMs[id] ?? 15000;
  }
}
const lim = (q: ProviderQuery, d = 20, max = 50) => Math.min(q.limit ?? d, max);

// ---------------------------------------------------------------- npm
export class NpmProvider extends Base implements Provider {
  readonly id = "npm";
  readonly defaultSearch = true;
  readonly name = "npm registry";
  readonly description =
    "JavaScript/TypeScript packages with npms-style quality/popularity/maintenance scores.";
  readonly resourceTypes = ["package" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md";
  readonly limitations = [
    "Search relevance is registry-defined.",
    "Download counts require a second endpoint (api.npmjs.org) used only in get().",
  ];
  normalize(o: any): Resource {
    const p = o.package ?? o;
    const repo = p.links?.repository ?? (typeof p.repository === "string" ? p.repository : p.repository?.url);
    return makeResource(this.ctx, {
      id: `npm:package:${p.name}`,
      type: "package",
      provider: this.id,
      name: p.name,
      fullName: p.name,
      canonicalUrl: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
      description: sanitizeText(p.description, 500),
      topics: (p.keywords ?? []).map(String),
      license: typeof p.license === "string" ? p.license : undefined,
      version: p.version,
      ecosystem: "npm",
      updatedAt: p.date,
      repositoryUrl: repo ? normalizeRepoUrl(repo) : undefined,
      homepage: p.links?.homepage ?? p.homepage,
      language: "JavaScript",
      authors: p.publisher?.username ? [p.publisher.username] : undefined,
      metadata: { npmScore: o.score?.detail, searchScore: o.searchScore, dependents: o.dependents },
    });
  }
  async search(q: ProviderQuery) {
    const d = await this.ctx.http.json<{ objects: any[] }>(
      `https://registry.npmjs.org/-/v1/search?text=${enc(q.text)}&size=${lim(q)}`,
      { provider: this.id, timeoutMs: this.timeout(this.id) },
    );
    return (d.objects ?? []).map((o) => this.normalize(o));
  }
  async get(name: string) {
    try {
      const d = await this.ctx.http.json<any>(
        `https://registry.npmjs.org/${enc(name).replace("%40", "@")}/latest`,
        { provider: this.id, timeoutMs: this.timeout(this.id) },
      );
      const r = this.normalize({
        package: { ...d, links: { npm: `https://www.npmjs.com/package/${name}` } },
      });
      try {
        const dl = await this.ctx.http.json<{ downloads: number }>(
          `https://api.npmjs.org/downloads/point/last-month/${enc(name).replace("%40", "@")}`,
          { provider: this.id },
        );
        r.downloads = dl.downloads;
      } catch {
        /* optional */
      }
      return r;
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
}

// ---------------------------------------------------------------- PyPI
export class PypiProvider extends Base implements Provider {
  readonly id = "pypi";
  readonly defaultSearch = true;
  readonly name = "PyPI";
  readonly description = "Python packages (exact/probable-name resolution + JSON metadata).";
  readonly resourceTypes = ["package" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://docs.pypi.org/api/json/";
  readonly limitations = [
    "PyPI has no public search API (XML-RPC search is disabled; HTML search is not scraped). search() therefore resolves candidate package names derived from the query terms and verifies them via the JSON API.",
  ];
  normalize(d: any): Resource {
    const i = d.info;
    const urls: Record<string, string> = i.project_urls ?? {};
    const repo =
      Object.values(urls).find((u) => /github\.com|gitlab\.com|codeberg\.org/.test(String(u))) ??
      (/github\.com|gitlab\.com/.test(i.home_page ?? "") ? i.home_page : undefined);
    const classifiers: string[] = i.classifiers ?? [];
    const lic = classifiers
      .find((c) => c.startsWith("License :: OSI Approved ::"))
      ?.split("::")
      .pop()
      ?.trim();
    const uploaded =
      d.urls?.[0]?.upload_time_iso_8601 ??
      Object.values(d.releases ?? {})
        .flat()
        .map((f: any) => f.upload_time_iso_8601)
        .sort()
        .pop();
    return makeResource(this.ctx, {
      id: `pypi:package:${String(i.name).toLowerCase()}`,
      type: "package",
      provider: this.id,
      name: i.name,
      fullName: i.name,
      canonicalUrl: i.package_url ?? `https://pypi.org/project/${i.name}/`,
      description: sanitizeText(i.summary, 500),
      version: i.version,
      ecosystem: "pypi",
      language: "Python",
      license: i.license_expression || (i.license && i.license.length < 40 ? i.license : lic) || undefined,
      topics: String(i.keywords ?? "")
        .split(/[,\s]+/)
        .filter(Boolean)
        .slice(0, 15),
      updatedAt: uploaded,
      repositoryUrl: repo ? normalizeRepoUrl(String(repo)) : undefined,
      homepage: i.home_page || urls.Homepage,
      metadata: { requiresPython: i.requires_python, requiresDist: (i.requires_dist ?? []).slice(0, 60) },
    });
  }
  async get(name: string) {
    try {
      return this.normalize(
        await this.ctx.http.json<any>(`https://pypi.org/pypi/${enc(name)}/json`, {
          provider: this.id,
          timeoutMs: this.timeout(this.id),
        }),
      );
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
  async search(q: ProviderQuery) {
    const words = q.text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const cands = new Set<string>(words.slice(0, 6));
    if (words.length > 1) {
      cands.add(words.slice(0, 2).join("-"));
      cands.add(words.slice(0, 2).join(""));
      cands.add(words.join("-"));
    }
    const out: Resource[] = [];
    const errors: unknown[] = [];
    const list = [...cands].slice(0, 8);
    await Promise.all(
      list.map(async (c) => {
        try {
          const r = await this.get(c);
          if (r) out.push(r);
        } catch (e) {
          errors.push(e);
        }
      }),
    );
    if (!out.length && errors.length === list.length && errors.length) throw errors[0]; // every lookup failed (not merely "not found")
    return out.slice(0, lim(q));
  }
}

// ---------------------------------------------------------------- crates.io
export class CratesProvider extends Base implements Provider {
  readonly id = "crates";
  readonly defaultSearch = true;
  readonly name = "crates.io";
  readonly description = "Rust crates.";
  readonly resourceTypes = ["package" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://crates.io/data-access";
  readonly limitations = [
    "crates.io requires a descriptive User-Agent and allows 1 request/second; some egress networks block it.",
  ];
  normalize(c: any): Resource {
    return makeResource(this.ctx, {
      id: `crates:package:${c.id ?? c.name}`,
      type: "package",
      provider: this.id,
      name: c.name,
      fullName: c.name,
      canonicalUrl: `https://crates.io/crates/${c.name}`,
      description: sanitizeText(c.description, 500),
      version: c.max_stable_version ?? c.max_version,
      ecosystem: "crates",
      language: "Rust",
      downloads: c.recent_downloads ?? c.downloads,
      topics: [...(c.keywords ?? []), ...(c.categories ?? [])].map(String),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      repositoryUrl: c.repository ? normalizeRepoUrl(c.repository) : undefined,
      homepage: c.homepage ?? undefined,
      metadata: { totalDownloads: c.downloads },
    });
  }
  async search(q: ProviderQuery) {
    const d = await this.ctx.http.json<{ crates: any[] }>(
      `https://crates.io/api/v1/crates?q=${enc(q.text)}&per_page=${lim(q)}&sort=relevance`,
      { provider: this.id, timeoutMs: this.timeout(this.id) },
    );
    return (d.crates ?? []).map((c) => this.normalize(c));
  }
  async get(name: string) {
    try {
      const d = await this.ctx.http.json<{ crate: any }>(`https://crates.io/api/v1/crates/${enc(name)}`, {
        provider: this.id,
      });
      return this.normalize(d.crate);
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
}

// ---------------------------------------------------------------- Maven Central
export class MavenProvider extends Base implements Provider {
  readonly id = "maven";
  readonly defaultSearch = false;
  readonly name = "Maven Central";
  readonly description = "JVM artifacts via the Central search API.";
  readonly resourceTypes = ["package" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://central.sonatype.org/search/rest-api-guide/";
  readonly limitations = [
    "Search API exposes coordinates and latest version only: no description, license or repository link (those would need POM parsing, not implemented).",
  ];
  normalize(d: any): Resource {
    return makeResource(this.ctx, {
      id: `maven:package:${d.g}:${d.a}`,
      type: "package",
      provider: this.id,
      name: d.a,
      fullName: `${d.g}:${d.a}`,
      canonicalUrl: `https://central.sonatype.com/artifact/${d.g}/${d.a}`,
      description: "",
      version: d.latestVersion ?? d.v,
      ecosystem: "maven",
      language: "Java",
      updatedAt: d.timestamp ? new Date(d.timestamp).toISOString() : undefined,
      topics: d.tags ?? [],
      metadata: { versionCount: d.versionCount, packaging: d.p },
    });
  }
  async search(q: ProviderQuery) {
    const d = await this.ctx.http.json<{ response: { docs: any[] } }>(
      `https://search.maven.org/solrsearch/select?q=${enc(q.text)}&rows=${lim(q)}&wt=json`,
      { provider: this.id, timeoutMs: this.timeout(this.id) },
    );
    return (d.response?.docs ?? []).map((x) => this.normalize(x));
  }
}

// ---------------------------------------------------------------- GitLab / Codeberg
export class GitlabProvider extends Base implements Provider {
  readonly id = "gitlab";
  readonly defaultSearch = true;
  readonly name = "GitLab.com";
  readonly description = "Public GitLab projects.";
  readonly resourceTypes = ["repository" as const];
  readonly auth = "optional" as const;
  readonly credentialEnv = ["GITLAB_TOKEN"];
  readonly docsUrl = "https://docs.gitlab.com/ee/api/projects.html";
  readonly limitations = [
    "License is not returned by the list endpoint; reported as missing unless a token-authenticated detail call is made.",
  ];
  normalize(p: any): Resource {
    return makeResource(this.ctx, {
      id: `gitlab:repository:${String(p.path_with_namespace).toLowerCase()}`,
      type: "repository",
      provider: this.id,
      name: p.name,
      fullName: p.path_with_namespace,
      canonicalUrl: p.web_url,
      description: sanitizeText(p.description, 500),
      topics: p.topics ?? p.tag_list ?? [],
      stars: p.star_count,
      forks: p.forks_count,
      openIssues: p.open_issues_count,
      createdAt: p.created_at,
      updatedAt: p.last_activity_at,
      pushedAt: p.last_activity_at,
      archived: p.archived,
      ecosystem: "gitlab",
      license: p.license?.key ? String(p.license.nickname ?? p.license.key).toUpperCase() : undefined,
      metadata: { defaultBranch: p.default_branch },
    });
  }
  async search(q: ProviderQuery) {
    const d = await this.ctx.http.json<any[]>(
      `https://gitlab.com/api/v4/projects?search=${enc(q.text)}&order_by=${q.sort === "updated" ? "last_activity_at" : "star_count"}&sort=desc&per_page=${lim(q)}&visibility=public`,
      {
        provider: this.id,
        headers: authHeader(this.ctx.config.credentials.gitlabToken, "Bearer"),
        timeoutMs: this.timeout(this.id),
      },
    );
    return d.map((p) => this.normalize(p));
  }
  async get(ref: string) {
    try {
      return this.normalize(
        await this.ctx.http.json<any>(`https://gitlab.com/api/v4/projects/${enc(ref)}?license=true`, {
          provider: this.id,
          headers: authHeader(this.ctx.config.credentials.gitlabToken),
        }),
      );
    } catch (e) {
      if (e instanceof ScoutError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
}
export class CodebergProvider extends Base implements Provider {
  readonly id = "codeberg";
  readonly defaultSearch = false;
  readonly name = "Codeberg (Forgejo/Gitea API)";
  readonly description = "Public Codeberg repositories; the adapter works with any Gitea-compatible host.";
  readonly resourceTypes = ["repository" as const];
  readonly auth = "optional" as const;
  readonly credentialEnv = ["CODEBERG_TOKEN"];
  readonly docsUrl = "https://codeberg.org/api/swagger";
  readonly limitations = ["Codeberg rate-limits aggressively and may answer 429 to anonymous clients."];
  constructor(
    ctx: ProviderContext,
    private base = "https://codeberg.org",
  ) {
    super(ctx);
  }
  normalize(r: any): Resource {
    return makeResource(this.ctx, {
      id: `codeberg:repository:${String(r.full_name).toLowerCase()}`,
      type: "repository",
      provider: this.id,
      name: r.name,
      fullName: r.full_name,
      canonicalUrl: r.html_url,
      description: sanitizeText(r.description, 500),
      language: r.language || undefined,
      topics: r.topics ?? [],
      stars: r.stars_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      pushedAt: r.updated_at,
      archived: r.archived,
      fork: r.fork,
      ecosystem: "codeberg",
      homepage: r.website || undefined,
    });
  }
  async search(q: ProviderQuery) {
    const d = await this.ctx.http.json<{ data: any[] }>(
      `${this.base}/api/v1/repos/search?q=${enc(q.text)}&sort=${q.sort === "updated" ? "updated" : "stars"}&order=desc&limit=${lim(q)}`,
      {
        provider: this.id,
        headers: authHeader(this.ctx.config.credentials.codebergToken, "token"),
        timeoutMs: this.timeout(this.id),
      },
    );
    return (d.data ?? []).map((r) => this.normalize(r));
  }
}

// ---------------------------------------------------------------- Research
export class ArxivProvider extends Base implements Provider {
  readonly id = "arxiv";
  readonly defaultSearch = true;
  readonly name = "arXiv";
  readonly description = "Research paper metadata (Atom API). Papers are type 'paper', never 'repository'.";
  readonly resourceTypes = ["paper" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://info.arxiv.org/help/api/user-manual.html";
  readonly limitations = [
    "arXiv asks clients to make at most one request every 3 seconds; Repo Scout issues at most one per search.",
    "Implementation links are extracted only when the abstract/comment contains a repository URL.",
  ];
  parse(xml: string): Resource[] {
    const out: Resource[] = [];
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1]!;
      const tag = (t: string) =>
        decodeXml(
          (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "").replace(/\s+/g, " ").trim(),
        );
      const idUrl = tag("id");
      const arxivId = idUrl.replace(/^.*\/abs\//, "");
      const summary = tag("summary");
      const repoUrl = (summary + " " + tag("arxiv:comment")).match(
        /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+/,
      )?.[0];
      const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((x) => x[1]!);
      out.push(
        makeResource(this.ctx, {
          id: `arxiv:paper:${arxivId}`,
          type: "paper",
          provider: this.id,
          name: tag("title"),
          fullName: arxivId,
          canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
          description: sanitizeText(summary, 600),
          topics: cats,
          createdAt: tag("published"),
          updatedAt: tag("updated"),
          ecosystem: "arxiv",
          authors: [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)]
            .map((x) => decodeXml(x[1]!))
            .slice(0, 8),
          repositoryUrl: repoUrl ? normalizeRepoUrl(repoUrl) : undefined,
          metadata: { pdf: `https://arxiv.org/pdf/${arxivId}` },
        }),
      );
    }
    return out;
  }
  async search(q: ProviderQuery) {
    const terms = q.text
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 8)
      .map((w) => `all:${w}`)
      .join("+AND+");
    const xml = await this.ctx.http.text(
      `https://export.arxiv.org/api/query?search_query=${terms}&max_results=${lim(q, 10, 25)}&sortBy=relevance`,
      { provider: this.id, timeoutMs: this.timeout(this.id), headers: { accept: "application/atom+xml" } },
    );
    return this.parse(xml);
  }
}
export class PapersWithCodeProvider extends Base implements Provider {
  readonly id = "paperswithcode";
  readonly defaultSearch = false;
  readonly name = "Papers with Code";
  readonly description = "Papers linked to code implementations (where the API is still accessible).";
  readonly resourceTypes = ["paper" as const];
  readonly auth = "none" as const;
  readonly docsUrl = "https://paperswithcode.com/api/v1/docs/";
  readonly limitations = [
    "paperswithcode.com now redirects to Hugging Face; when the legacy API answers with a redirect or non-JSON this provider reports itself unavailable instead of failing silently. Repo links are covered by arXiv abstract parsing.",
  ];
  async search(q: ProviderQuery): Promise<Resource[]> {
    const r = await this.ctx.http.request(
      `https://paperswithcode.com/api/v1/papers/?q=${enc(q.text)}&items_per_page=${lim(q, 10, 25)}`,
      { provider: this.id, maxRedirects: 0, timeoutMs: this.timeout(this.id) },
    );
    if (r.status >= 300 || !r.text.trim().startsWith("{"))
      throw new ScoutError(
        "PROVIDER_UNAVAILABLE",
        "Papers with Code API is not accessible (redirected/non-JSON).",
      );
    const d = JSON.parse(r.text) as { results: any[] };
    return (d.results ?? []).map((p) =>
      makeResource(this.ctx, {
        id: `paperswithcode:paper:${p.id}`,
        type: "paper",
        provider: this.id,
        name: p.title,
        fullName: String(p.arxiv_id ?? p.id),
        canonicalUrl: p.url_abs ?? `https://paperswithcode.com/paper/${p.id}`,
        description: sanitizeText(p.abstract, 600),
        createdAt: p.published,
        ecosystem: "paperswithcode",
        authors: p.authors,
        metadata: { arxivId: p.arxiv_id },
      }),
    );
  }
}

// ---------------------------------------------------------------- Curated collections (awesome lists)
export class AwesomeProvider extends Base implements Provider {
  readonly id = "awesome";
  readonly defaultSearch = true;
  readonly name = "Awesome lists";
  readonly description =
    "Community-curated 'awesome' lists discovered via GitHub; list entries are extracted from README markdown.";
  readonly resourceTypes = ["collection" as const, "repository" as const];
  readonly auth = "optional" as const;
  readonly credentialEnv = ["GITHUB_TOKEN"];
  readonly docsUrl = "https://github.com/sindresorhus/awesome";
  readonly limitations = [
    "Entries are taken from README link lists; stars/licence are NOT known for entries (marked missing) until enriched via the GitHub provider.",
  ];
  /** Extract `- [name](url) - description` bullets. Exposed for tests. */
  parseEntries(
    md: string,
    listUrl: string,
  ): Array<{ name: string; url: string; description: string; section: string }> {
    const out: Array<{ name: string; url: string; description: string; section: string }> = [];
    let section = "";
    for (const line of md.split(/\r?\n/)) {
      const h = line.match(/^#{2,4}\s+(.+)/);
      if (h) {
        section = h[1]!.replace(/[[\]()*_`]/g, "").trim();
        continue;
      }
      const m = line.match(/^\s*[-*+]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(?:[-–—:]\s*)?(.*)$/);
      if (m && !/^#/.test(m[2]!) && canonicalizeUrl(m[2]!) !== canonicalizeUrl(listUrl))
        out.push({ name: m[1]!, url: m[2]!, description: sanitizeText(m[3], 300), section });
    }
    return out;
  }
  async search(q: ProviderQuery): Promise<Resource[]> {
    const gh = new (await import("./github.js")).GithubProvider(this.ctx);
    const lists = await gh.search({
      text: `awesome ${q.text} in:name,description,topics`,
      limit: 5,
      sort: "stars",
    });
    const awesome = lists.filter((l) => /awesome/i.test(l.name) || l.topics.includes("awesome"));
    const terms = q.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const out: Resource[] = awesome.map((l) => ({
      ...l,
      id: l.id.replace("github:repository", "awesome:collection"),
      type: "collection" as const,
      provider: this.id,
    }));
    for (const l of awesome.slice(0, 2)) {
      const branch = (l.metadata.defaultBranch as string) ?? "HEAD";
      let md: string;
      try {
        md = await this.ctx.http.text(`https://raw.githubusercontent.com/${l.fullName}/${branch}/README.md`, {
          provider: this.id,
          maxBytes: 1_500_000,
          timeoutMs: this.timeout(this.id),
        });
      } catch {
        continue;
      }
      for (const e of this.parseEntries(md, l.canonicalUrl)) {
        const hay = `${e.name} ${e.description} ${e.section}`.toLowerCase();
        if (!terms.some((t) => hay.includes(t))) continue;
        const gm = e.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/);
        out.push(
          makeResource(
            this.ctx,
            {
              id: gm
                ? `github:repository:${gm[1]!.toLowerCase()}/${gm[2]!.toLowerCase()}`
                : `awesome:website:${canonicalizeUrl(e.url)}`,
              type: gm ? "repository" : "website",
              provider: this.id,
              name: gm ? gm[2]! : e.name,
              fullName: gm ? `${gm[1]}/${gm[2]}` : undefined,
              canonicalUrl: e.url,
              description: e.description,
              metadata: { curatedBy: l.fullName, section: e.section, enriched: false },
              evidence: [
                {
                  id: `${l.id}#entry`,
                  status: "inferred",
                  source: this.id,
                  url: l.canonicalUrl,
                  detail: `Listed in curated list ${l.fullName} (${e.section}); stars/licence not verified`,
                },
              ],
            },
            l.canonicalUrl,
          ),
        );
      }
    }
    return out.slice(0, lim(q, 30, 100));
  }
}

// ---------------------------------------------------------------- Web discovery
export class WebProvider extends Base implements Provider {
  readonly id = "web";
  readonly defaultSearch = true;
  readonly name = "Web search (Brave API / SearXNG)";
  readonly description =
    "Official docs, project sites and technical resources via a configured search API. No HTML scraping.";
  readonly resourceTypes = ["documentation" as const, "website" as const];
  readonly auth = "required" as const;
  readonly credentialEnv = ["BRAVE_API_KEY", "SEARXNG_URL"];
  readonly docsUrl = "https://api-dashboard.search.brave.com/app/documentation";
  readonly limitations = [
    "Requires BRAVE_API_KEY or SEARXNG_URL; otherwise reported unavailable (no scraping fallback by design).",
  ];
  override availability() {
    if (this.ctx.config.offline) return { ok: false, reason: "offline mode" };
    const c = this.ctx.config.credentials;
    return c.braveApiKey || c.searxngUrl
      ? { ok: true }
      : { ok: false, reason: "no search API configured (set BRAVE_API_KEY or SEARXNG_URL)" };
  }
  classify(url: string, title: string): "documentation" | "website" {
    return /(^|\.)docs?\.|\/docs?(\/|$)|readthedocs|\/documentation|\/guide|\/reference|developer\./i.test(
      url,
    ) || /documentation|docs/i.test(title)
      ? "documentation"
      : "website";
  }
  async search(q: ProviderQuery): Promise<Resource[]> {
    const c = this.ctx.config.credentials;
    let results: Array<{ title: string; url: string; description: string }> = [];
    if (c.searxngUrl) {
      const base = c.searxngUrl.replace(/\/$/, "");
      const loop = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
      const d = await this.ctx.http.json<{ results: any[] }>(`${base}/search?q=${enc(q.text)}&format=json`, {
        provider: this.id,
        policy: { allowLoopback: loop, allowHttp: loop },
        timeoutMs: this.timeout(this.id),
      });
      results = (d.results ?? []).map((r) => ({ title: r.title, url: r.url, description: r.content ?? "" }));
    } else if (c.braveApiKey) {
      const d = await this.ctx.http.json<{ web?: { results: any[] } }>(
        `https://api.search.brave.com/res/v1/web/search?q=${enc(q.text)}&count=${lim(q, 10, 20)}`,
        {
          provider: this.id,
          headers: { "x-subscription-token": c.braveApiKey, accept: "application/json" },
          timeoutMs: this.timeout(this.id),
        },
      );
      results = (d.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description ?? "",
      }));
    } else throw new ScoutError("PROVIDER_UNAVAILABLE", "No web search API configured.");
    return results.slice(0, lim(q)).map((r) => {
      const type = this.classify(r.url, r.title);
      return makeResource(this.ctx, {
        id: `web:${type}:${canonicalizeUrl(r.url)}`,
        type,
        provider: this.id,
        name: sanitizeText(r.title, 200),
        canonicalUrl: r.url,
        description: sanitizeText(r.description.replace(/<[^>]+>/g, ""), 400),
      });
    });
  }
}

/** robots.txt aware polite page fetch (used only for explicit documentation lookups). */
export class RobotsChecker {
  private cache = new Map<string, string[]>();
  constructor(
    private ctx: ProviderContext,
    private ua = "repo-scout",
  ) {}
  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    let dis = this.cache.get(u.origin);
    if (!dis) {
      dis = [];
      try {
        const txt = await this.ctx.http.text(`${u.origin}/robots.txt`, {
          provider: "robots",
          timeoutMs: 5000,
          maxBytes: 200_000,
        });
        let applies = false;
        for (const raw of txt.split(/\r?\n/)) {
          const line = raw.replace(/#.*/, "").trim();
          const idx = line.indexOf(":");
          if (idx < 0) continue;
          const k = line.slice(0, idx).trim().toLowerCase();
          const v = line.slice(idx + 1).trim();
          if (k === "user-agent") applies = v === "*" || v.toLowerCase() === this.ua;
          else if (applies && k === "disallow" && v) dis.push(v);
        }
      } catch {
        /* no robots => allowed */
      }
      this.cache.set(u.origin, dis);
    }
    return !dis.some((d) => u.pathname.startsWith(d));
  }
}

export function normalizeRepoUrl(u: string): string {
  const s = u
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "");
  return s.replace(/^http:\/\//, "https://");
}
function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
