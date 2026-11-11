import type {
  Composition,
  DiscoveryQuery,
  Evaluation,
  ImplementationPlan,
  Resource,
  ResourceType,
  TaskSpec,
  TrendEntry,
} from "@repo-scout/schemas";
import {
  RateLimiter,
  ScoutError,
  SafeHttp,
  createLogger,
  loadConfig,
  parseRepoRef,
  pLimit,
  sha,
  type Config,
  type Logger,
  type FetchFn,
} from "@repo-scout/core";
import { Store, type CacheScope } from "@repo-scout/cache";
import { ProviderRegistry, type Provider, type ProviderQuery } from "@repo-scout/providers";
import { alternativeQueries, understandTask } from "@repo-scout/intelligence";
import {
  OllamaEmbeddings,
  analyzeLicenseSet,
  classifyLicense,
  evaluate,
  fastFilter,
  hybridRank,
  type EmbeddingProvider,
} from "@repo-scout/scoring";
import { checkVulnerabilities, enrichResource, inspectRepository, parseManifest } from "@repo-scout/analysis";
import { composeSolutions, planFromComposition, planFromEvaluations } from "@repo-scout/composer";
import { TrendRadar, type RadarQuery } from "@repo-scout/trending";

export interface EngineOptions {
  /** Override the local rate limiter (tests / embedding applications). */
  limiter?: RateLimiter;
  config?: Config;
  fetchImpl?: FetchFn;
  logger?: Logger;
  store?: Store;
  now?: () => number;
  embedder?: EmbeddingProvider;
}

export interface DiscoveryCounts {
  candidatesDiscovered: number;
  shortlisted: number;
  deeplyInspected: number;
  recommendedCombinations: number;
}
export interface DiscoveryOptions {
  includePackages?: boolean;
  limit?: number;
  providers?: string[];
  types?: string[];
  language?: string;
  deep?: number;
  noCache?: boolean;
  sort?: "score" | "stars" | "updated";
  minScore?: number;
  page?: number;
  pageSize?: number;
}
export interface DiscoveryResult {
  spec: TaskSpec;
  counts: DiscoveryCounts;
  results: Evaluation[];
  warnings: string[];
  providersUsed: string[];
  providersFailed: Array<{ provider: string; error: string }>;
  queriesRun: number;
  retrievalMode: "lexical+metadata" | "lexical+metadata+embeddings";
  timings: { totalMs: number };
}

const PKG_PROVIDERS = new Set(["npm", "pypi", "crates", "maven"]);

export class Engine {
  readonly config: Config;
  readonly store: Store;
  readonly http: SafeHttp;
  readonly registry: ProviderRegistry;
  readonly logger: Logger;
  readonly radar: TrendRadar;
  private embedder?: EmbeddingProvider;
  private now: () => number;
  private ownsStore: boolean;
  constructor(o: EngineOptions = {}) {
    this.config = o.config ?? loadConfig();
    this.logger = o.logger ?? createLogger(this.config.logLevel);
    this.now = o.now ?? Date.now;
    this.ownsStore = !o.store;
    this.store = o.store ?? Store.open(this.config);
    // GitHub's search API allows 30 req/min with a token and 10/min anonymously: stay just under.
    const limiter =
      o.limiter ??
      new RateLimiter(30, 60_000)
        .setLimit("github-search", this.config.credentials.githubToken ? 25 : 8)
        .setLimit("arxiv", 10);
    this.http = new SafeHttp({ fetchImpl: o.fetchImpl, logger: this.logger, limiter });
    this.registry = ProviderRegistry.create(this.config, this.http);
    this.embedder =
      o.embedder ??
      (this.config.embeddings.provider === "ollama"
        ? new OllamaEmbeddings(this.http, this.config.embeddings.url, this.config.embeddings.model)
        : undefined);
    this.radar = new TrendRadar(this.registry.github, this.store, this.now);
  }
  close() {
    if (this.ownsStore) this.store.close();
  }

  // ------------------------------------------------------------ understanding
  understand(text: string, opts: { language?: string; projectLicense?: string } = {}): TaskSpec {
    if (!text || text.trim().length < 3)
      throw new ScoutError("INVALID_INPUT", "Describe the task in at least a few words.");
    if (text.length > 8000)
      throw new ScoutError("INVALID_INPUT", "Task description too long (max 8000 characters).");
    return understandTask(text, opts);
  }

  // ------------------------------------------------------------ provider access with cache + health tracking
  private async runProvider(
    p: Provider,
    q: ProviderQuery,
    noCache = false,
  ): Promise<{ resources: Resource[]; cached: boolean }> {
    const key = sha(`${p.id}|${JSON.stringify(q)}`);
    if (!noCache) {
      const hit = this.store.getCache<Resource[]>("search", key);
      if (hit)
        return {
          resources: hit.value.map((r) => ({
            ...r,
            freshness: {
              ...r.freshness,
              fromCache: true,
              ageSeconds: Math.round((this.now() - hit.createdAt) / 1000),
            },
          })),
          cached: true,
        };
    }
    try {
      const resources = await p.search(q);
      this.store.recordProvider(p.id, true);
      this.store.setCache("search", key, resources, this.config.searchTtlSeconds);
      this.store.upsertResources(resources, this.config.cacheTtlSeconds);
      return { resources, cached: false };
    } catch (e) {
      this.store.recordProvider(p.id, false, (e as Error).message);
      const stale = this.store.getCache<Resource[]>("search", key, { allowStale: true });
      if (stale)
        return {
          resources: stale.value.map((r) => ({
            ...r,
            freshness: { ...r.freshness, fromCache: true, stale: true },
          })),
          cached: true,
        };
      throw e;
    }
  }

  private selectProviders(opts: DiscoveryOptions, kinds?: ResourceType[]): Provider[] {
    let list = this.registry.active({ includeOptIn: !!opts.providers?.length });
    if (opts.providers?.length) list = list.filter((p) => opts.providers!.includes(p.id));
    if (kinds) list = list.filter((p) => p.resourceTypes.some((t) => kinds.includes(t)));
    return list;
  }

  /** Run queries across providers; merge + dedupe. */
  async gather(queries: DiscoveryQuery[], providers: Provider[], opts: DiscoveryOptions = {}) {
    const failed: Array<{ provider: string; error: string }> = [];
    const used = new Set<string>();
    const found = new Map<string, { resource: Resource; queryIds: Set<number>; componentIds: Set<string> }>();
    const limit = pLimit(4);
    const dead = new Set<string>(); // circuit breaker: skip providers that already failed hard in this run
    let run = 0;
    const jobs: Array<Promise<void>> = [];
    queries.forEach((q, qi) => {
      for (const p of providers) {
        // package queries -> registries; other kinds -> repositories/papers/collections; skip pointless pairings
        const explicit = !!opts.providers?.length;
        // routing: package queries -> registries; component/feature queries -> source hosts; registries see only package-kind or bare queries
        if (q.kind === "package" && !PKG_PROVIDERS.has(p.id)) continue;
        if (
          !explicit &&
          q.kind !== "package" &&
          PKG_PROVIDERS.has(p.id) &&
          (q.componentId || q.kind !== "exact")
        )
          continue;
        if (!explicit && p.id === "gitlab" && q.kind !== "exact") continue;
        if (p.id === "arxiv" || p.id === "paperswithcode") {
          if (q.kind !== "semantic" && q.kind !== "exact") continue;
          if (q.componentId) continue;
        }
        if (p.id === "awesome" && q.kind !== "related") continue;
        run++;
        jobs.push(
          limit(async () => {
            if (dead.has(p.id)) return;
            try {
              const { resources } = await this.runProvider(
                p,
                { text: q.text, limit: 15, language: q.language ?? opts.language, sort: "stars" },
                opts.noCache,
              );
              used.add(p.id);
              for (const r of resources) {
                const key = dedupeKey(r);
                const e = found.get(key) ?? {
                  resource: r,
                  queryIds: new Set<number>(),
                  componentIds: new Set<string>(),
                };
                if (found.has(key)) e.resource = mergeResources(e.resource, r);
                e.queryIds.add(qi);
                if (q.componentId) e.componentIds.add(q.componentId);
                found.set(key, e);
              }
            } catch (err) {
              failed.push({ provider: p.id, error: (err as Error).message });
              if (
                err instanceof ScoutError &&
                ["NETWORK", "TIMEOUT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "SECURITY_BLOCKED"].includes(
                  err.code,
                )
              )
                dead.add(p.id);
            }
          }),
        );
      }
    });
    await Promise.all(jobs);
    const uniqueFailed = [...new Map(failed.map((f) => [f.provider + f.error, f])).values()];
    return { found: [...found.values()], failed: uniqueFailed, used: [...used], queriesRun: run };
  }

  // ------------------------------------------------------------ main discovery pipeline
  async discover(request: string | TaskSpec, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const t0 = this.now();
    const spec =
      typeof request === "string" ? this.understand(request, { language: opts.language }) : request;
    const providers = this.selectProviders(opts);
    if (!providers.length)
      throw new ScoutError(
        "PROVIDER_UNAVAILABLE",
        "No providers available (offline mode or all disabled).",
        "Run `repo-scout providers` to see why.",
      );
    const { found, failed, used, queriesRun } = await this.gather(
      pickQueries(spec.queries, 14),
      providers,
      opts,
    );
    if (!found.length && failed.length === used.length + failed.length && failed.length)
      throw new ScoutError(
        "PROVIDER_ERROR",
        `All providers failed: ${failed.map((f) => `${f.provider}: ${f.error}`).join("; ")}`,
        "Check connectivity or set GITHUB_TOKEN to avoid rate limits.",
      );
    const warnings = failed.map((f) => `provider ${f.provider} failed: ${f.error}`);
    let candidates = found.map((f) => f.resource);
    if (opts.types?.length) candidates = candidates.filter((r) => opts.types!.includes(r.type));
    const maxC = this.config.limits.maxCandidates;
    // ---- Level 1
    const queryText = [
      spec.objective,
      ...spec.components.filter((c) => c.origin === "explicit").flatMap((c) => c.keywords),
    ].join(" ");
    const ranked = await hybridRank(candidates, queryText, {
      embedder: this.embedder,
      topicBoost: spec.frameworks.map((f) => f.value),
    });
    const fast = ranked
      .map((r) => ({ ...r, fast: fastFilter(r.resource, { spec, relevance: r.score.combined }) }))
      .sort((a, b) => b.fast.score - a.fast.score)
      .slice(0, maxC);
    const kept = fast.filter((f) => f.fast.keep);
    const shortlist = kept.slice(
      0,
      opts.limit ? Math.max(opts.limit, this.config.limits.maxShortlist) : this.config.limits.maxShortlist,
    );
    // ---- Level 2 (+ README enrichment for shortlisted repos at level 2.5 is skipped: done in level 3)
    const evaluations = shortlist.map((s) => evaluate(s.resource, { spec, relevance: s.score.combined }));
    evaluations.sort((a, b) => b.overall - a.overall);
    // ---- Level 3 for top-N repositories
    const deepN = opts.deep ?? this.config.limits.maxDeepInspect;
    let deep = 0;
    if (deepN > 0 && !this.config.offline) {
      const tops = evaluations
        .filter((e) => e.resource.type === "repository" && /^github:/.test(e.resource.id))
        .slice(0, deepN);
      await Promise.all(
        tops.map(async (e) => {
          try {
            const d = await this.analyzeResource(e.resource, spec, {
              relevance: shortlist.find((s) => s.resource.id === e.resource.id)?.score.combined,
            });
            const i = evaluations.findIndex((x) => x.resource.id === e.resource.id);
            if (i >= 0) {
              evaluations[i] = d;
              deep++;
            }
          } catch (err) {
            warnings.push(`deep inspection of ${e.resource.fullName} failed: ${(err as Error).message}`);
          }
        }),
      );
      evaluations.sort((a, b) => b.overall - a.overall);
    }
    for (const e of evaluations)
      e.alternatives = evaluations
        .filter((o) => o !== e && o.resource.type === e.resource.type)
        .slice(0, 3)
        .map((o) => o.resource.fullName ?? o.resource.name);
    let out = evaluations;
    if (opts.minScore) out = out.filter((e) => e.overall >= opts.minScore!);
    if (opts.sort === "stars")
      out = [...out].sort((a, b) => (b.resource.stars ?? 0) - (a.resource.stars ?? 0));
    if (opts.sort === "updated")
      out = [...out].sort((a, b) =>
        (b.resource.pushedAt ?? b.resource.updatedAt ?? "").localeCompare(
          a.resource.pushedAt ?? a.resource.updatedAt ?? "",
        ),
      );
    for (const e of out.slice(0, 50))
      this.store.saveScore(e.resource.id, sha(spec.raw), { overall: e.overall, level: e.level });
    return {
      spec,
      counts: {
        candidatesDiscovered: candidates.length,
        shortlisted: shortlist.length,
        deeplyInspected: deep,
        recommendedCombinations: 0,
      },
      results: out,
      warnings,
      providersUsed: used,
      providersFailed: failed,
      queriesRun,
      retrievalMode: this.embedder ? "lexical+metadata+embeddings" : "lexical+metadata",
      timings: { totalMs: this.now() - t0 },
    };
  }

  /** Simple search: provider results ranked with hybrid retrieval + level 2 scoring, no deep inspection unless asked. */
  async search(query: string, opts: DiscoveryOptions & { kinds?: ResourceType[] } = {}) {
    const t0 = this.now();
    const providers = this.selectProviders(opts, opts.kinds);
    const spec = this.understand(query, { language: opts.language });
    const qs: DiscoveryQuery[] = [
      { text: query, kind: "exact", language: opts.language, weight: 1 },
      { text: query, kind: "package" as const, weight: 0.8 },
    ];
    const { found, failed, used, queriesRun } = await this.gather(qs, providers, opts);
    if (!found.length && failed.length)
      throw new ScoutError(
        "PROVIDER_ERROR",
        `Search failed: ${failed.map((f) => `${f.provider}: ${f.error}`).join("; ")}`,
        "Check connectivity; set GITHUB_TOKEN to avoid rate limits.",
      );
    let cands = found.map((f) => f.resource);
    if (opts.types?.length) cands = cands.filter((r) => opts.types!.includes(r.type));
    const ranked = await hybridRank(cands, query, { embedder: this.embedder });
    const evals = ranked
      .map((r) => evaluate(r.resource, { spec, relevance: r.score.combined }))
      .sort((a, b) => b.overall - a.overall);
    const deepN = opts.deep ?? 0;
    const warnings = failed.map((f) => `provider ${f.provider} failed: ${f.error}`);
    let deep = 0;
    for (const e of evals
      .filter((x) => x.resource.type === "repository" && x.resource.id.startsWith("github:"))
      .slice(0, deepN)) {
      try {
        const d = await this.analyzeResource(e.resource, spec, {
          relevance: ranked.find((r) => r.resource.id === e.resource.id)?.score.combined,
        });
        evals[evals.indexOf(e)] = d;
        deep++;
      } catch (err) {
        warnings.push(`${e.resource.fullName}: ${(err as Error).message}`);
      }
    }
    evals.sort((a, b) => b.overall - a.overall);
    return {
      spec,
      evaluations: evals,
      counts: {
        candidatesDiscovered: cands.length,
        shortlisted: Math.min(evals.length, opts.limit ?? 20),
        deeplyInspected: deep,
        recommendedCombinations: 0,
      },
      warnings,
      providersUsed: used,
      providersFailed: failed,
      queriesRun,
      durationMs: this.now() - t0,
    };
  }

  // ------------------------------------------------------------ single repository analysis
  async getRepository(ref: string, opts: { noCache?: boolean } = {}): Promise<Resource> {
    const { owner, repo, host } = parseRepoRef(ref);
    if (host !== "github.com") {
      const p =
        host === "gitlab.com"
          ? this.registry.get("gitlab")
          : host === "codeberg.org"
            ? this.registry.get("codeberg")
            : undefined;
      if (!p?.get)
        throw new ScoutError(
          "INVALID_INPUT",
          `Unsupported host ${host} for single-repository lookup.`,
          "Supported: github.com, gitlab.com.",
        );
      const r = await p.get(`${owner}/${repo}`);
      if (!r) throw new ScoutError("NOT_FOUND", `${ref} not found`);
      return r;
    }
    const id = `github:repository:${`${owner}/${repo}`.toLowerCase()}`;
    if (!opts.noCache) {
      const hit = this.store.getResource(id);
      if (hit) return { ...hit, freshness: { ...hit.freshness, fromCache: true } };
    }
    if (this.config.offline) {
      const stale = this.store.getResource(id, { allowStale: true });
      if (stale) return { ...stale, freshness: { ...stale.freshness, fromCache: true, stale: true } };
      throw new ScoutError("PROVIDER_UNAVAILABLE", "Offline mode and repository not cached.");
    }
    try {
      const r = await this.registry.github.get(`${owner}/${repo}`);
      if (!r) throw new ScoutError("NOT_FOUND", `Repository ${owner}/${repo} not found (or private).`);
      this.store.recordProvider("github", true);
      this.store.upsertResources([r], this.config.cacheTtlSeconds);
      this.store.addSnapshot({
        resourceId: r.id,
        observedAt: this.now(),
        stars: r.stars,
        forks: r.forks,
        openIssues: r.openIssues,
        pushedAt: r.pushedAt,
      });
      return r;
    } catch (e) {
      if (!(e instanceof ScoutError && e.code === "NOT_FOUND"))
        this.store.recordProvider("github", false, (e as Error).message);
      throw e;
    }
  }

  /** Level 3: README + tree + manifests + OSV. Cached under `analysis`. */
  async analyzeResource(
    resource: Resource,
    spec?: TaskSpec,
    ctx: { relevance?: number; componentKeywords?: string[]; noCache?: boolean } = {},
  ): Promise<Evaluation> {
    const key = sha(
      `${resource.id}|${spec ? spec.raw : ""}|${ctx.relevance?.toFixed(2)}|${(ctx.componentKeywords ?? []).join(",")}`,
    );
    if (!ctx.noCache) {
      const hit = this.store.getCache<Evaluation>("analysis", key);
      if (hit) return hit.value;
    }
    if (resource.type !== "repository" || !resource.id.startsWith("github:"))
      return evaluate(resource, { spec, relevance: ctx.relevance, componentKeywords: ctx.componentKeywords });
    const r = await inspectRepository(
      resource,
      { github: this.registry.github, http: this.http, now: this.now },
      {},
    );
    const { extras } = await this.registry.github
      .getExtras(resource.fullName!, { tree: false })
      .catch(() => ({ extras: { releases: [] as any[] } as any }));
    const enriched = enrichResource(resource, {
      readme: extras.readme,
      languages: extras.languages,
      releases: extras.releases,
      contributors: extras.contributors,
    });
    const e = evaluate(enriched, {
      spec,
      relevance: ctx.relevance,
      componentKeywords: ctx.componentKeywords,
      inspection: r.inspection,
      now: this.now(),
    });
    e.limitations.push(...r.inspection.limitations.filter((l) => !e.limitations.includes(l)));
    if (r.errors.length) e.limitations.push(`partial data: ${r.errors.slice(0, 3).join("; ")}`);
    this.store.setCache("analysis", key, e, this.config.analysisTtlSeconds);
    this.store.upsertResources([enriched], this.config.cacheTtlSeconds);
    return e;
  }
  async analyze(ref: string, taskText?: string, opts: { noCache?: boolean } = {}): Promise<Evaluation> {
    const r = await this.getRepository(ref, opts);
    const spec = taskText ? this.understand(taskText) : undefined;
    return this.analyzeResource(r, spec, { relevance: undefined, noCache: opts.noCache });
  }
  async compare(refs: string[], taskText?: string) {
    if (refs.length < 2 || refs.length > 6)
      throw new ScoutError("INVALID_INPUT", "Provide between 2 and 6 repositories to compare.");
    const spec = taskText ? this.understand(taskText) : undefined;
    const evals = await Promise.all(
      refs.map(async (ref) => this.analyzeResource(await this.getRepository(ref), spec, {})),
    );
    evals.sort((a, b) => b.overall - a.overall);
    const names = evals.map((e) => e.resource.fullName ?? e.resource.name);
    const dims = Object.keys(evals[0]!.scores);
    const winners = Object.fromEntries(
      dims.map((d) => [
        d,
        names[
          evals.map((e) => e.scores[d]!.value).indexOf(Math.max(...evals.map((e) => e.scores[d]!.value)))
        ],
      ]),
    );
    return {
      evaluations: evals,
      ranking: evals.map((e, i) => ({
        rank: i + 1,
        repository: names[i]!,
        overall: e.overall,
        confidence: e.confidence,
      })),
      winnersByDimension: winners,
      licenseSet: analyzeLicenseSet(
        evals.map((e) => ({ name: e.resource.fullName ?? e.resource.name, license: e.resource.license })),
        spec?.licenseConstraints.projectLicense,
      ),
      caveat:
        "Scores are comparable only within this comparison and task context; check `confidence` and `limitations` before deciding.",
    };
  }

  async inspectDependencies(ref: string, opts: { vulnerabilities?: boolean } = {}) {
    const r = await this.getRepository(ref);
    const e = await inspectRepository(
      r,
      { github: this.registry.github, http: this.http },
      { vulnerabilityCheck: opts.vulnerabilities !== false },
    );
    return {
      repository: r.fullName,
      manifests: e.inspection.manifests,
      dependencies: e.inspection.dependencies,
      frameworks: e.inspection.frameworks,
      runtime: e.inspection.runtime,
      installScripts: e.inspection.security?.installScripts ?? [],
      vulnerabilityCheck: e.inspection.security?.vulnerabilityCheck,
      vulnerabilities: e.inspection.security?.vulnerabilities ?? [],
      dependencyHealth: e.depHealth,
      disclaimers: e.inspection.security?.disclaimers ?? [],
      limitations: e.inspection.limitations,
      errors: e.errors,
    };
  }
  /** Dependency analysis of manifest TEXT supplied by the caller (e.g. the agent's own project). */
  async inspectManifestText(path: string, content: string, opts: { vulnerabilities?: boolean } = {}) {
    const info = parseManifest(path, content.slice(0, 500_000));
    const vuln =
      opts.vulnerabilities !== false && !this.config.offline
        ? await checkVulnerabilities(this.http, info.dependencies).catch((e) => ({
            performed: "not_performed" as const,
            vulnerabilities: [],
            checked: 0,
            skipped: 0,
            note: `OSV lookup failed: ${(e as Error).message}`,
          }))
        : {
            performed: "not_performed" as const,
            vulnerabilities: [],
            checked: 0,
            skipped: 0,
            note: "Vulnerability lookup disabled or offline.",
          };
    return {
      manifest: path,
      dependencies: info.dependencies,
      installScripts: info.installScripts,
      runtime: info.runtime,
      vulnerabilityCheck: vuln.performed,
      vulnerabilities: vuln.vulnerabilities,
      note: vuln.note,
    };
  }
  async checkLicense(ref: string, taskText?: string, projectLicense?: string) {
    const r = await this.getRepository(ref);
    const spec = taskText ? this.understand(taskText, { projectLicense }) : undefined;
    const info = classifyLicense(r.license);
    const set = analyzeLicenseSet(
      [{ name: r.fullName ?? r.name, license: r.license }],
      projectLicense ?? spec?.licenseConstraints.projectLicense,
    );
    return {
      repository: r.fullName,
      declaredLicense: r.license ?? null,
      info,
      issues: set.issues,
      evidence: r.evidence[0],
      caveat:
        "Based on the hosting platform's licence detection. Not legal advice: read the LICENSE file and any NOTICE/third-party files.",
    };
  }
  async checkSecurity(ref: string) {
    const r = await this.getRepository(ref);
    const e = await this.analyzeResource(r, undefined, {});
    return {
      repository: r.fullName,
      security: e.scores.security,
      signals: e.inspection?.security,
      archived: r.archived ?? false,
      verified: e.verified.filter((v) => v.startsWith("security/")),
      missing: e.missing.filter((v) => v.startsWith("security/")),
      disclaimer: "Security INDICATORS only. This is not a security audit; no code was executed.",
    };
  }

  // ------------------------------------------------------------ alternatives & related
  async findAlternatives(nameOrRef: string, opts: DiscoveryOptions = {}) {
    let desc = "",
      topics: string[] = [],
      name = nameOrRef,
      self: Resource | undefined,
      lang = opts.language;
    if (/^[\w.-]+\/[\w.-]+$/.test(nameOrRef) || /^https:\/\/(github|gitlab)\.com\//.test(nameOrRef)) {
      try {
        self = await this.getRepository(nameOrRef);
        desc = self.description;
        topics = self.topics;
        name = self.name;
        lang = lang ?? self.language;
      } catch {
        /* treat as plain name */
      }
    }
    const qs = alternativeQueries(name, desc, topics);
    const providers = this.selectProviders(opts, ["repository", "package"]);
    const { found, failed, used } = await this.gather(
      qs.map((q) => ({ ...q, language: lang })),
      providers,
      opts,
    );
    const cands = found
      .map((f) => f.resource)
      .filter((r) => r.id !== self?.id && r.name.toLowerCase() !== name.toLowerCase());
    const spec = this.understand(`alternatives to ${name}: ${desc}`.slice(0, 500), { language: lang });
    const ranked = await hybridRank(cands, `${name} ${desc} ${topics.join(" ")}`, {
      embedder: this.embedder,
      topicBoost: topics,
    });
    const evals = ranked
      .map((r) => evaluate(r.resource, { spec, relevance: r.score.combined }))
      .sort((a, b) => b.overall - a.overall)
      .slice(0, opts.limit ?? 15);
    return {
      subject: self ?? { name },
      evaluations: evals,
      warnings: failed.map((f) => `provider ${f.provider} failed: ${f.error}`),
      providersUsed: used,
    };
  }
  async findRelated(ref: string, opts: DiscoveryOptions = {}) {
    const self = await this.getRepository(ref);
    const qs: DiscoveryQuery[] = [];
    if (self.topics.length)
      qs.push({
        text: self.topics.slice(0, 3).join(" "),
        kind: "related",
        weight: 1,
        language: self.language,
      });
    qs.push({ text: `awesome ${self.topics[0] ?? self.name}`, kind: "related", weight: 0.6 });
    qs.push({ text: self.description.split(/\s+/).slice(0, 6).join(" "), kind: "semantic", weight: 0.7 });
    const providers = this.selectProviders(opts, ["repository", "collection"]);
    const { found, failed } = await this.gather(qs, providers, opts);
    const cands = found.map((f) => f.resource).filter((r) => r.id !== self.id);
    const ranked = await hybridRank(cands, `${self.name} ${self.description} ${self.topics.join(" ")}`, {
      embedder: this.embedder,
      topicBoost: self.topics,
    });
    for (const r of ranked.slice(0, 20)) this.store.addRelation(self.id, r.resource.id, "related");
    return {
      subject: self,
      related: ranked.slice(0, opts.limit ?? 15).map((r) => ({
        resource: r.resource,
        similarity: Math.round(r.score.combined * 100) / 100,
        shared: {
          topics: r.resource.topics.filter((t) => self.topics.includes(t)),
          language: r.resource.language === self.language,
        },
      })),
      warnings: failed.map((f) => `provider ${f.provider} failed: ${f.error}`),
    };
  }

  // ------------------------------------------------------------ composition & planning
  async compose(
    request: string | TaskSpec,
    opts: DiscoveryOptions & { maxSolutions?: number; deepPerComponent?: number } = {},
  ) {
    const t0 = this.now();
    const spec =
      typeof request === "string" ? this.understand(request, { language: opts.language }) : request;
    const providers = this.selectProviders(
      opts,
      opts.includePackages ? ["repository", "package"] : ["repository"],
    );
    if (!providers.length) throw new ScoutError("PROVIDER_UNAVAILABLE", "No providers available.");
    const warnings: string[] = [];
    const byComponent: Record<string, Evaluation[]> = {};
    let total = 0,
      shortlisted = 0,
      deep = 0;
    const failedAll: Array<{ provider: string; error: string }> = [];
    const limit = pLimit(2);
    await Promise.all(
      spec.components.map((c) =>
        limit(async () => {
          const qs = spec.queries.filter(
            (q) =>
              q.componentId === c.id &&
              q.kind !== "alternative" &&
              (opts.includePackages || q.kind !== "package"),
          );
          if (!qs.length) return;
          const { found, failed } = await this.gather(qs.slice(0, c.required ? 2 : 1), providers, opts);
          failedAll.push(...failed);
          const cands = found
            .map((f) => f.resource)
            .filter(
              (r) =>
                r.type === "repository" ||
                (opts.includePackages && r.type === "package" && !!r.repositoryUrl),
            );
          total += cands.length;
          const ranked = await hybridRank(cands, c.keywords.join(" ") + " " + c.label, {
            embedder: this.embedder,
          });
          const kept = ranked
            .map((r) => ({ ...r, fast: fastFilter(r.resource, { spec, relevance: r.score.combined }) }))
            .filter((r) => r.fast.keep)
            .sort((a, b) => b.fast.score - a.fast.score)
            .slice(0, 6);
          shortlisted += kept.length;
          const evals = kept.map((k) =>
            evaluate(k.resource, { spec, relevance: k.score.combined, componentKeywords: c.keywords }),
          );
          const dn = opts.deepPerComponent ?? 2;
          evals.sort((a, b) => b.overall - a.overall);
          await Promise.all(
            evals.slice(0, dn).map(async (e) => {
              if (!e.resource.id.startsWith("github:") || e.resource.type !== "repository") return;
              try {
                const d = await this.analyzeResource(e.resource, spec, {
                  relevance: kept.find((k) => k.resource.id === e.resource.id)?.score.combined,
                  componentKeywords: c.keywords,
                });
                evals[evals.indexOf(e)] = d;
                deep++;
              } catch (err) {
                warnings.push(`inspection of ${e.resource.fullName} failed: ${(err as Error).message}`);
              }
            }),
          );
          byComponent[c.id] = evals.sort((a, b) => b.overall - a.overall);
        }),
      ),
    );
    warnings.push(
      ...[...new Map(failedAll.map((f) => [f.provider + f.error, f])).values()].map(
        (f) => `provider ${f.provider} failed: ${f.error}`,
      ),
    );
    const compositions = composeSolutions(spec, byComponent, { maxSolutions: opts.maxSolutions ?? 3 });
    return {
      spec,
      compositions,
      candidatesByComponent: byComponent,
      counts: {
        candidatesDiscovered: total,
        shortlisted,
        deeplyInspected: deep,
        recommendedCombinations: compositions.length,
      },
      warnings,
      durationMs: this.now() - t0,
    };
  }

  async plan(
    request: string | TaskSpec,
    opts: DiscoveryOptions & { composition?: Composition } = {},
  ): Promise<{
    spec: TaskSpec;
    plan: ImplementationPlan;
    compositions: Composition[];
    counts: DiscoveryCounts;
    warnings: string[];
  }> {
    const spec =
      typeof request === "string" ? this.understand(request, { language: opts.language }) : request;
    if (opts.composition)
      return {
        spec,
        plan: planFromComposition(spec, opts.composition),
        compositions: [opts.composition],
        counts: { candidatesDiscovered: 0, shortlisted: 0, deeplyInspected: 0, recommendedCombinations: 1 },
        warnings: [],
      };
    const c = await this.compose(spec, opts);
    if (c.compositions[0])
      return {
        spec,
        plan: planFromComposition(spec, c.compositions[0]),
        compositions: c.compositions,
        counts: c.counts,
        warnings: c.warnings,
      };
    const d = await this.discover(spec, opts);
    return {
      spec,
      plan: planFromEvaluations(spec, d.results.slice(0, 3)),
      compositions: [],
      counts: d.counts,
      warnings: [
        ...c.warnings,
        ...d.warnings,
        "No multi-component composition was possible; plan is based on top individual results.",
      ],
    };
  }

  // ------------------------------------------------------------ cache
  cacheStatus() {
    return {
      ...this.store.status(),
      providers: this.store.providerStats(),
      ttl: {
        resourcesSeconds: this.config.cacheTtlSeconds,
        searchSeconds: this.config.searchTtlSeconds,
        analysisSeconds: this.config.analysisTtlSeconds,
      },
    };
  }
  clearCache(scope: CacheScope = "expired") {
    return this.store.clear(scope);
  }
}

function dedupeKey(r: Resource): string {
  if (r.type === "repository")
    return `repo:${(r.fullName ?? r.name).toLowerCase()}:${r.canonicalUrl.includes("github.com") ? "gh" : r.provider}`;
  if (r.type === "package") return `pkg:${r.ecosystem}:${(r.fullName ?? r.name).toLowerCase()}`;
  return `${r.type}:${r.canonicalUrl.toLowerCase().replace(/\/$/, "")}`;
}
/** Merge duplicate discoveries: keep verified API-sourced data over curated-list stubs; union topics/evidence. */
function mergeResources(a: Resource, b: Resource): Resource {
  const [base, other] =
    (a.metadata.enriched === false && b.metadata.enriched !== false) ||
    (a.stars === undefined && b.stars !== undefined)
      ? [b, a]
      : [a, b];
  return {
    ...base,
    topics: [...new Set([...base.topics, ...other.topics])],
    evidence: [
      ...base.evidence,
      ...other.evidence.filter((e) => !base.evidence.some((x) => x.id === e.id)),
    ].slice(0, 8),
    description: base.description || other.description,
    license: base.license ?? other.license,
  };
}

export type { RadarQuery, TrendEntry };

/** Keep the heaviest queries but guarantee diversity across kinds and components. */
function pickQueries(qs: DiscoveryQuery[], max: number): DiscoveryQuery[] {
  const out: DiscoveryQuery[] = [];
  const seenKinds = new Map<string, number>();
  for (const q of qs) {
    const k = `${q.kind}:${q.componentId ?? ""}`;
    if ((seenKinds.get(k) ?? 0) >= 2) continue;
    seenKinds.set(k, (seenKinds.get(k) ?? 0) + 1);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}
