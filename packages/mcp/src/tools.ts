import { z } from "zod";
import type { Engine } from "@repo-scout/discovery";
import { ScoutError, redactDeep, sanitizeText } from "@repo-scout/core";
import { UNTRUSTED_NOTICE, VERSION, type ResourceType, type ToolEnvelope } from "@repo-scout/schemas";
import {
  renderCompareMd,
  renderCompositionMd,
  renderDiscoveryMd,
  renderEvaluationMd,
  renderPlanMd,
  renderScoreLegend,
  renderSpecMd,
  renderTrendMd,
  toRecommendation,
  renderCountsTerminal,
  renderEvaluationTerminal,
} from "@repo-scout/report";

export interface ToolResult {
  summary: string;
  data: unknown;
  markdown?: string;
  terminal?: string;
  warnings?: string[];
}
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  destructive?: boolean;
  handler: (engine: Engine, args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}
const def = <S extends z.ZodRawShape>(d: ToolDef<S>) => d;

const limit = z.number().int().min(1).max(50).optional().describe("Max results to return (default 10)");
const offset = z.number().int().min(0).optional().describe("Pagination offset");
const language = z
  .string()
  .max(40)
  .optional()
  .describe("Preferred primary programming language, e.g. TypeScript");
const repoRef = z.string().min(3).max(200).describe("GitHub repository as owner/name or https URL");
const task = z
  .string()
  .min(3)
  .max(8000)
  .describe("Natural-language description of the idea, problem or requirement");
const providersArg = z
  .array(z.string().max(30))
  .max(12)
  .optional()
  .describe("Restrict to these provider ids (see scout_list_providers)");
const kindsArg = z
  .array(z.enum(["repository", "package", "paper", "documentation", "collection", "website"]))
  .optional();
const page = <T>(a: T[], o = 0, l = 10) => ({
  items: a.slice(o, o + l),
  total: a.length,
  offset: o,
  limit: l,
  hasMore: o + l < a.length,
});

export const TOOLS = [
  def({
    name: "scout_understand_task",
    title: "Understand a task",
    readOnly: true,
    description:
      "Parse a natural-language idea into structured requirements (explicit vs assumed), component needs and discovery queries. Local only: no network access, no model API.",
    input: {
      task,
      language,
      projectLicense: z
        .string()
        .max(40)
        .optional()
        .describe("SPDX id of the developer's project licence, if known"),
    },
    async handler(e, a) {
      const spec = e.understand(a.task, { language: a.language, projectLicense: a.projectLicense });
      return {
        summary: `Domain ${spec.domain}; ${spec.components.length} component need(s); ${spec.queries.length} queries; ${spec.assumptions.length} assumption(s).`,
        data: spec,
        markdown: renderSpecMd(spec),
      };
    },
  }),
  def({
    name: "scout_search",
    title: "Search across providers",
    readOnly: true,
    description:
      "Search GitHub, package registries, curated lists, research and other enabled providers for a free-text query. Results are normalised, deduplicated and ranked (hybrid lexical+metadata retrieval) with Level-2 scores.",
    input: {
      query: z.string().min(2).max(300),
      kinds: kindsArg,
      providers: providersArg,
      language,
      limit,
      offset,
      deep: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("Deeply inspect the top N GitHub repositories (extra API calls)"),
      sort: z.enum(["score", "stars", "updated"]).optional(),
    },
    async handler(e, a) {
      const r = await e.search(a.query, {
        kinds: a.kinds as ResourceType[] | undefined,
        providers: a.providers,
        language: a.language,
        deep: a.deep,
        sort: a.sort,
      });
      let ev = r.evaluations;
      if (a.sort === "stars") ev = [...ev].sort((x, y) => (y.resource.stars ?? 0) - (x.resource.stars ?? 0));
      if (a.sort === "updated")
        ev = [...ev].sort((x, y) =>
          (y.resource.pushedAt ?? y.resource.updatedAt ?? "").localeCompare(
            x.resource.pushedAt ?? x.resource.updatedAt ?? "",
          ),
        );
      const p = page(ev, a.offset, a.limit ?? 10);
      return {
        summary: `${r.counts.candidatesDiscovered} candidates from ${r.providersUsed.join(", ") || "no provider"}; showing ${p.items.length} of ${p.total}.`,
        data: {
          counts: r.counts,
          results: p.items.map(toRecommendation),
          page: { total: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore },
          providersUsed: r.providersUsed,
          providersFailed: r.providersFailed,
        },
        markdown: renderDiscoveryMd(`Search: ${a.query}`, p.items, r.counts, {
          warnings: r.warnings,
          limit: p.limit,
        }),
        warnings: r.warnings,
        terminal: terminalList(p.items, r.counts),
      };
    },
  }),
  def({
    name: "scout_find_repositories",
    title: "Find repositories for a task",
    readOnly: true,
    description:
      "Full discovery pipeline for a described task: understand → generate queries → search providers → Level-1 filter → Level-2 adaptive scoring → Level-3 deep inspection of the top candidates. Returns counts (discovered / shortlisted / inspected) and evidence-backed scores.",
    input: {
      task,
      language,
      providers: providersArg,
      limit,
      offset,
      deep: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("How many top GitHub repos to inspect deeply (default 5)"),
      minScore: z.number().min(0).max(100).optional(),
    },
    async handler(e, a) {
      const r = await e.discover(a.task, {
        language: a.language,
        providers: a.providers,
        deep: a.deep,
        minScore: a.minScore,
        types: ["repository", "package"],
      });
      const p = page(r.results, a.offset, a.limit ?? 10);
      return {
        summary: `Discovered ${r.counts.candidatesDiscovered}, shortlisted ${r.counts.shortlisted}, deeply inspected ${r.counts.deeplyInspected}. Retrieval: ${r.retrievalMode}.`,
        data: {
          spec: r.spec,
          counts: r.counts,
          results: p.items.map(toRecommendation),
          page: { total: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore },
          providersUsed: r.providersUsed,
          providersFailed: r.providersFailed,
          queriesRun: r.queriesRun,
          retrievalMode: r.retrievalMode,
        },
        markdown: renderDiscoveryMd("Repositories for your task", p.items, r.counts, {
          spec: r.spec,
          warnings: r.warnings,
          limit: p.limit,
        }),
        warnings: r.warnings,
        terminal: terminalList(p.items, r.counts),
      };
    },
  }),
  def({
    name: "scout_find_packages",
    title: "Find packages",
    readOnly: true,
    description: "Search npm, PyPI, crates.io and Maven Central for packages matching a query.",
    input: {
      query: z.string().min(2).max(300),
      ecosystems: z.array(z.enum(["npm", "pypi", "crates", "maven"])).optional(),
      limit,
      offset,
      language,
    },
    async handler(e, a) {
      const r = await e.search(a.query, {
        kinds: ["package"],
        providers: a.ecosystems ?? ["npm", "pypi", "crates", "maven"],
        language: a.language,
      });
      const p = page(
        r.evaluations.filter((x) => x.resource.type === "package"),
        a.offset,
        a.limit ?? 10,
      );
      return {
        summary: `${p.total} package candidates from ${r.providersUsed.join(", ") || "none"}.`,
        data: {
          results: p.items.map(toRecommendation),
          page: { total: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore },
          providersFailed: r.providersFailed,
        },
        markdown: renderDiscoveryMd(`Packages: ${a.query}`, p.items, r.counts, { warnings: r.warnings }),
        warnings: r.warnings,
        terminal: terminalList(p.items, r.counts),
      };
    },
  }),
  def({
    name: "scout_find_alternatives",
    title: "Find alternatives",
    readOnly: true,
    description:
      "Find alternatives to a named library/project (owner/repo or plain name), ranked by similarity and fit.",
    input: { name: z.string().min(2).max(200), language, limit, providers: providersArg },
    async handler(e, a) {
      const r = await e.findAlternatives(a.name, {
        language: a.language,
        providers: a.providers,
        limit: a.limit ?? 10,
      });
      return {
        summary: `${r.evaluations.length} alternative(s) to ${a.name}.`,
        data: {
          subject: (r.subject as any).fullName ?? (r.subject as any).name,
          results: r.evaluations.map(toRecommendation),
          providersUsed: r.providersUsed,
        },
        markdown: renderDiscoveryMd(
          `Alternatives to ${a.name}`,
          r.evaluations,
          {
            candidatesDiscovered: r.evaluations.length,
            shortlisted: r.evaluations.length,
            deeplyInspected: 0,
            recommendedCombinations: 0,
          },
          { warnings: r.warnings },
        ),
        warnings: r.warnings,
        terminal: terminalList(r.evaluations),
      };
    },
  }),
  def({
    name: "scout_analyze_repository",
    title: "Analyze a repository",
    readOnly: true,
    description:
      "Level-3 static inspection of one repository: structure, manifests, dependencies, architecture patterns, README, tests/CI, OSV vulnerability lookup. Never clones or executes code. Every score lists verified / inferred / missing evidence.",
    input: {
      repository: repoRef,
      task: z.string().max(8000).optional().describe("Optional task context so scores adapt to your needs"),
      refresh: z.boolean().optional(),
    },
    async handler(e, a) {
      const ev = await e.analyze(a.repository, a.task, { noCache: a.refresh });
      return {
        summary: `${ev.resource.fullName}: ${ev.overall}/100 (confidence ${Math.round(ev.confidence * 100)}%, ${ev.level}).`,
        data: { recommendation: toRecommendation(ev), evaluation: ev },
        markdown: renderEvaluationMd(ev, { heading: 2 }) + "\n\n" + renderScoreLegend(),
        terminal: renderEvaluationTerminal(ev, 1),
      };
    },
  }),
  def({
    name: "scout_compare_repositories",
    title: "Compare repositories",
    readOnly: true,
    description: "Compare 2-6 repositories side by side on all scored dimensions, with licence-set analysis.",
    input: { repositories: z.array(repoRef).min(2).max(6), task: z.string().max(8000).optional() },
    async handler(e, a) {
      const c = await e.compare(a.repositories, a.task);
      return {
        summary: `Ranking: ${c.ranking.map((r) => `${r.repository} (${r.overall})`).join(" > ")}`,
        data: {
          ranking: c.ranking,
          winnersByDimension: c.winnersByDimension,
          licenseSet: c.licenseSet,
          results: c.evaluations.map(toRecommendation),
          caveat: c.caveat,
        },
        markdown: renderCompareMd(c),
        terminal: terminalList(c.evaluations),
      };
    },
  }),
  def({
    name: "scout_inspect_dependencies",
    title: "Inspect dependencies",
    readOnly: true,
    description:
      "List and check a repository's declared dependencies (static manifest parsing + OSV.dev lookup + npm deprecation). Alternatively pass manifestPath and manifestContent from the user's own project (content is parsed locally, never executed).",
    input: {
      repository: repoRef.optional(),
      manifestPath: z.string().max(200).optional().describe("e.g. package.json, requirements.txt"),
      manifestContent: z.string().max(500_000).optional(),
      vulnerabilities: z.boolean().optional(),
    },
    async handler(e, a) {
      if (a.manifestContent && a.manifestPath) {
        const r = await e.inspectManifestText(a.manifestPath, a.manifestContent, {
          vulnerabilities: a.vulnerabilities,
        });
        return {
          summary: `${r.dependencies.length} dependencies; vulnerability check ${r.vulnerabilityCheck}; ${r.vulnerabilities.length} advisories.`,
          data: r,
          markdown: depMd(a.manifestPath, r),
        };
      }
      if (!a.repository)
        throw new ScoutError(
          "INVALID_INPUT",
          "Provide `repository`, or both `manifestPath` and `manifestContent`.",
        );
      const r = await e.inspectDependencies(a.repository, { vulnerabilities: a.vulnerabilities });
      return {
        summary: `${r.dependencies.length} dependencies in ${r.manifests.length} manifest(s); vulnerability check ${r.vulnerabilityCheck ?? "not_performed"}; ${r.vulnerabilities.length} advisories.`,
        data: r,
        markdown: depMd(r.repository ?? "", r),
        warnings: r.errors,
      };
    },
  }),
  def({
    name: "scout_check_license",
    title: "Check licence",
    readOnly: true,
    description:
      "Classify a repository's licence and check suitability against task constraints or a project licence. Not legal advice.",
    input: {
      repository: repoRef,
      task: z.string().max(8000).optional(),
      projectLicense: z.string().max(40).optional(),
    },
    async handler(e, a) {
      const r = await e.checkLicense(a.repository, a.task, a.projectLicense);
      return {
        summary: `${r.repository}: ${r.info.spdx ?? "no licence"} (${r.info.category}); ${r.issues.length} issue(s).`,
        data: r,
        markdown: `## Licence: ${r.repository}\n\n- Declared: **${r.declaredLicense ?? "none detected"}**\n- Category: **${r.info.category}** (${r.info.status})\n${r.info.notes.map((n) => `- ${n}`).join("\n")}\n${r.issues.map((i) => `- [${i.severity}] ${i.message}`).join("\n")}\n\n> ${r.caveat}`,
      };
    },
  }),
  def({
    name: "scout_check_security",
    title: "Check security indicators",
    readOnly: true,
    description:
      "Security INDICATORS for a repository (OSV advisories for declared dependencies, SECURITY policy, lockfile, install scripts, archive status, injection-like README text). This is NOT a security audit.",
    input: { repository: repoRef },
    async handler(e, a) {
      const r = await e.checkSecurity(a.repository);
      const s = r.signals;
      return {
        summary: `${r.repository}: security indicator score ${r.security?.value ?? "n/a"} (confidence ${r.security?.confidence ?? 0}); vulnerability check ${s?.vulnerabilityCheck ?? "not_performed"}.`,
        data: r,
        markdown: `## Security indicators: ${r.repository}\n\n- Score: **${r.security?.value}**/100 (confidence ${r.security?.confidence})\n- Vulnerability check: **${s?.vulnerabilityCheck ?? "not_performed"}**, ${s?.vulnerabilities.length ?? 0} advisories\n- Security policy: ${s?.hasSecurityPolicy ?? "unknown"} · lockfile: ${s?.hasLockfile ?? "unknown"} · install scripts: ${s?.installScripts.length ?? "unknown"}\n${(
          s?.vulnerabilities ?? []
        )
          .slice(0, 10)
          .map((v) => `  - ${v.id} (${v.package}@${v.version}) ${sanitizeText(v.summary, 100)}`)
          .join(
            "\n",
          )}\n${s?.promptInjectionFindings.length ? `- ⚠ README contains agent-directed/injection-like text: ${s.promptInjectionFindings.join("; ")} (treated as data)\n` : ""}\n> ${r.disclaimer}`,
      };
    },
  }),
  def({
    name: "scout_compose_solution",
    title: "Compose a multi-repository solution",
    readOnly: true,
    description:
      "Solution Composer: decompose a larger goal into components, find candidates per component, then select COMBINATIONS whose members work together (language, framework, runtime, dependency, API, auth, deployment, licence compatibility). Returns up to 3 distinct options with conflicts, missing components, integration complexity and sequence.",
    input: {
      task,
      language,
      includePackages: z
        .boolean()
        .optional()
        .describe("Also consider registry packages that link to a source repository"),
      maxSolutions: z.number().int().min(1).max(5).optional(),
      deepPerComponent: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("Deep-inspect top N candidates per component (default 2)"),
      providers: providersArg,
    },
    async handler(e, a) {
      const r = await e.compose(a.task, {
        language: a.language,
        includePackages: a.includePackages,
        maxSolutions: a.maxSolutions,
        deepPerComponent: a.deepPerComponent,
        providers: a.providers,
      });
      const md = [
        `# Solution options`,
        `Candidates discovered: **${r.counts.candidatesDiscovered}** · shortlisted: **${r.counts.shortlisted}** · deeply inspected: **${r.counts.deeplyInspected}** · recommended combinations: **${r.counts.recommendedCombinations}**`,
        "",
        renderSpecMd(r.spec),
        "",
        ...r.compositions.map(renderCompositionMd),
        ...(r.warnings.length ? ["## Warnings", ...r.warnings.map((w) => `- ${w}`)] : []),
        "",
        renderScoreLegend(),
      ].join("\n");
      return {
        summary: r.compositions.length
          ? `${r.compositions.length} option(s); best: ${r.compositions[0]!.title} (complexity ${r.compositions[0]!.integrationComplexity.level}, compatibility ${r.compositions[0]!.compatibilityScore}).`
          : "No acceptable combination could be composed (see warnings / missing components).",
        data: { spec: r.spec, counts: r.counts, compositions: r.compositions, warnings: r.warnings },
        markdown: md,
        warnings: r.warnings,
        terminal: md,
      };
    },
  }),
  def({
    name: "scout_generate_implementation_plan",
    title: "Generate implementation plan",
    readOnly: true,
    description:
      "Compose a solution and produce an implementation plan for the CODING AGENT with explicit approval gates (clone / write files / modify project / install / execute). Repo Scout never performs these actions; the agent must obtain developer approval first.",
    input: {
      task,
      language,
      solutionIndex: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("Which composed option to plan (default 0)"),
    },
    async handler(e, a) {
      const c = await e.compose(a.task, { language: a.language });
      const r = await e.plan(c.spec, {
        composition: c.compositions[a.solutionIndex ?? 0] ?? undefined,
        language: a.language,
      });
      const plan = (c.compositions.length ? r : await e.plan(c.spec, { language: a.language })).plan;
      return {
        summary: `Plan with ${plan.steps.length} steps, ${plan.approvalGates.length} approval gates, ${plan.reuse.length} reusable component(s).`,
        data: {
          spec: c.spec,
          plan,
          compositions: c.compositions.map((x) => ({
            id: x.id,
            title: x.title,
            complexity: x.integrationComplexity.level,
            compatibilityScore: x.compatibilityScore,
          })),
          untrustedContentNotice: UNTRUSTED_NOTICE,
        },
        markdown: renderPlanMd(plan),
        warnings: c.warnings,
      };
    },
  }),
  def({
    name: "scout_find_trending",
    title: "Trending radar",
    readOnly: true,
    description:
      "Fast-growing / emerging repositories. Growth is labelled OBSERVED (from local snapshots over time) or ESTIMATED (lifetime average); never fabricated.",
    input: {
      language,
      topic: z.string().max(60).optional(),
      text: z.string().max(200).optional(),
      createdWithinDays: z.number().int().min(1).max(3650).optional(),
      minStars: z.number().int().min(0).optional(),
      minActivityDays: z.number().int().min(1).optional().describe("Require a push within N days"),
      minAgeDays: z.number().int().min(0).optional(),
      maxAgeDays: z.number().int().min(1).optional(),
      mode: z.enum(["trending", "declining"]).optional(),
      limit,
    },
    async handler(e, a) {
      const q = {
        language: a.language,
        topic: a.topic,
        text: a.text,
        createdWithinDays: a.createdWithinDays,
        minStars: a.minStars,
        minActivityDays: a.minActivityDays,
        minAgeDays: a.minAgeDays,
        maxAgeDays: a.maxAgeDays,
        limit: a.limit ?? 15,
      };
      const r = a.mode === "declining" ? await e.radar.declining(q) : await e.radar.trending(q);
      return {
        summary: `${r.entries.length} repositories; ${r.entries.filter((x) => x.trend.label === "observed").length} with observed growth.`,
        data: { entries: r.entries, notes: r.notes },
        markdown: renderTrendMd(
          a.mode === "declining" ? "Declining / abandoned projects" : "Trending repositories",
          r.entries,
          r.notes,
        ),
      };
    },
  }),
  def({
    name: "scout_find_hidden_gems",
    title: "Hidden gems",
    readOnly: true,
    description:
      "Healthy, well-documented, smaller repositories that popularity-sorted search buries. Small size is never an exclusion criterion.",
    input: {
      language,
      topic: z.string().max(60).optional(),
      text: z.string().max(200).optional(),
      maxStars: z.number().int().min(1).optional(),
      pushedWithinDays: z.number().int().min(1).optional(),
      limit,
    },
    async handler(e, a) {
      const r = await e.radar.hiddenGems({
        language: a.language,
        topic: a.topic,
        text: a.text,
        maxStars: a.maxStars,
        pushedWithinDays: a.pushedWithinDays,
        limit: a.limit ?? 15,
      });
      return {
        summary: `${r.entries.length} hidden-gem candidates.`,
        data: r,
        markdown: renderTrendMd("Hidden gems", r.entries, r.notes),
      };
    },
  }),
  def({
    name: "scout_find_related_projects",
    title: "Related projects",
    readOnly: true,
    description:
      "Projects related to a given repository (shared topics, language, description similarity, curated lists).",
    input: { repository: repoRef, limit, providers: providersArg },
    async handler(e, a) {
      const r = await e.findRelated(a.repository, { limit: a.limit ?? 10, providers: a.providers });
      return {
        summary: `${r.related.length} related project(s) for ${r.subject.fullName}.`,
        data: {
          subject: r.subject.fullName,
          related: r.related.map((x) => ({
            name: x.resource.fullName ?? x.resource.name,
            url: x.resource.canonicalUrl,
            type: x.resource.type,
            description: sanitizeText(x.resource.description, 200),
            language: x.resource.language,
            stars: x.resource.stars,
            license: x.resource.license,
            similarity: x.similarity,
            shared: x.shared,
          })),
        },
        markdown: `## Related to ${r.subject.fullName}\n\n${r.related.map((x) => `- [${x.resource.fullName ?? x.resource.name}](${x.resource.canonicalUrl}) — similarity ${x.similarity}, ★${x.resource.stars ?? "n/a"}, ${x.resource.language ?? "?"}`).join("\n")}`,
        warnings: r.warnings,
      };
    },
  }),
  def({
    name: "scout_get_repository_details",
    title: "Repository details",
    readOnly: true,
    description:
      "Raw normalised metadata for one repository (no scoring): description, topics, languages, contributors, releases, README excerpt (sanitised, untrusted), optional file tree.",
    input: {
      repository: repoRef,
      includeReadme: z.boolean().optional(),
      includeTree: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async handler(e, a) {
      const r = await e.getRepository(a.repository, { noCache: a.refresh });
      const { extras, errors } = await e.registry.github
        .getExtras(r.fullName!, { tree: a.includeTree })
        .catch((err) => ({ extras: null, errors: [(err as Error).message] }));
      const data = {
        resource: r,
        languages: extras?.languages,
        contributors: extras?.contributors,
        releases: extras?.releases,
        openPulls: extras?.openPulls,
        commitActivity90d: extras?.commitActivity90d,
        readmeExcerpt: a.includeReadme && extras?.readme ? sanitizeText(extras.readme, 4000) : undefined,
        tree: extras?.tree
          ? { truncated: extras.tree.truncated, paths: extras.tree.entries.slice(0, 300).map((x) => x.path) }
          : undefined,
        missing: errors,
      };
      return {
        summary: `${r.fullName}: ★${r.stars} · ${r.language ?? "?"} · ${r.license ?? "no licence"} · pushed ${r.pushedAt?.slice(0, 10)}.`,
        data,
        markdown: `## ${r.fullName}\n\n${sanitizeText(r.description, 400)}\n\n- URL: ${r.canonicalUrl}\n- ★ ${r.stars} · forks ${r.forks} · open issues ${r.openIssues} · contributors ${extras?.contributors ?? "n/a"}\n- Language: ${r.language ?? "n/a"} · licence: ${r.license ?? "none"}\n- Created ${r.createdAt?.slice(0, 10)} · last push ${r.pushedAt?.slice(0, 10)} · archived: ${r.archived}\n- Topics: ${r.topics.join(", ") || "—"}\n- Latest release: ${extras?.releases?.[0]?.tag ?? "n/a"}\n${errors.length ? `\nMissing: ${errors.join("; ")}\n` : ""}\n> ${UNTRUSTED_NOTICE}`,
        warnings: errors,
      };
    },
  }),
  def({
    name: "scout_list_providers",
    title: "List providers",
    readOnly: true,
    description:
      "Show every discovery provider, whether it is available (credentials/network policy) and its documented limitations.",
    input: {},
    async handler(e) {
      const p = e.registry.describe();
      return {
        summary: `${p.filter((x) => x.available).length}/${p.length} providers available.`,
        data: { providers: p, stats: e.store.providerStats() },
        markdown: `| Provider | Types | Available | Auth | Notes |\n|---|---|---|---|---|\n${p.map((x) => `| ${x.id} | ${x.resourceTypes.join(", ")} | ${x.available ? "yes" : "no: " + x.unavailableReason} | ${x.auth}${x.credentialEnv.length ? " (" + x.credentialEnv.join("/") + ")" : ""} | ${x.limitations[0] ?? ""} |`).join("\n")}`,
      };
    },
  }),
  def({
    name: "scout_cache_status",
    title: "Cache status",
    readOnly: true,
    description:
      "Local SQLite database status: size, entry counts, snapshots, provider health. Everything stays on this machine.",
    input: {},
    async handler(e) {
      const s = e.cacheStatus();
      return {
        summary: `${s.resources} resources, ${s.cacheEntries} cache entries, ${s.snapshots} snapshots, ${(s.sizeBytes / 1024).toFixed(0)} KiB at ${s.dbPath}.`,
        data: s,
        markdown: "```json\n" + JSON.stringify(s, null, 2) + "\n```",
      };
    },
  }),
  def({
    name: "scout_clear_cache",
    title: "Clear cache",
    readOnly: false,
    destructive: true,
    description:
      "Delete locally cached data. DESTRUCTIVE to local history when scope is 'snapshots' or 'all'. The coding agent must obtain developer approval and then pass confirm=true.",
    input: {
      scope: z.enum(["expired", "search", "analysis", "resources", "scores", "snapshots", "all"]),
      confirm: z.boolean().describe("Must be true; set only after the developer approved"),
    },
    async handler(e, a) {
      if (!a.confirm)
        throw new ScoutError(
          "INVALID_INPUT",
          "Refusing to clear cache without confirm=true.",
          "Ask the developer for approval, then retry with confirm=true.",
        );
      const r = e.clearCache(a.scope);
      return { summary: `Cleared '${a.scope}': ${JSON.stringify(r)}.`, data: { scope: a.scope, deleted: r } };
    },
  }),
] as const;

function depMd(title: string, r: any): string {
  const deps = r.dependencies as Array<{ name: string; spec: string; ecosystem: string; dev: boolean }>;
  return `## Dependencies: ${title}\n\n${deps
    .slice(0, 60)
    .map((d) => `- ${d.name} \`${d.spec}\` (${d.ecosystem}${d.dev ? ", dev" : ""})`)
    .join(
      "\n",
    )}${deps.length > 60 ? `\n- … ${deps.length - 60} more` : ""}\n\n**Vulnerability check:** ${r.vulnerabilityCheck ?? "not_performed"} — ${r.vulnerabilities.length} advisories\n${(
    r.vulnerabilities as any[]
  )
    .slice(0, 15)
    .map((v) => `- ${v.id}: ${v.package}@${v.version} ${sanitizeText(v.summary, 100)}`)
    .join(
      "\n",
    )}\n${r.installScripts?.length ? `\n**Install scripts (never executed):**\n${r.installScripts.map((s: string) => `- ${sanitizeText(s, 160)}`).join("\n")}\n` : ""}\n> ${(r.disclaimers ?? [r.note]).filter(Boolean).join(" ")}`;
}
function terminalList(
  evals: Parameters<typeof renderEvaluationTerminal>[0][],
  counts?: Parameters<typeof renderCountsTerminal>[0],
): string {
  return [
    counts ? renderCountsTerminal(counts) + "\n" : "",
    ...evals.map((e, i) => renderEvaluationTerminal(e, i + 1)).map((s) => s + "\n"),
  ].join("\n");
}

/** Run a tool by name with validation, redaction and the standard envelope. Used by the MCP server and the CLI. */
export async function executeTool(
  engine: Engine,
  name: string,
  rawArgs: unknown,
  now: () => number = Date.now,
): Promise<{ envelope: ToolEnvelope; markdown?: string; terminal?: string }> {
  const t0 = now();
  const meta = (): any => ({
    generatedAt: new Date().toISOString(),
    durationMs: now() - t0,
    version: VERSION,
    untrustedContentNotice: UNTRUSTED_NOTICE,
  });
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool)
    return {
      envelope: {
        ok: false,
        tool: name,
        summary: `Unknown tool ${name}`,
        warnings: [],
        error: { code: "NOT_FOUND", message: `Unknown tool ${name}` },
        meta: meta(),
      },
      markdown: undefined as string | undefined,
      terminal: undefined as string | undefined,
    };
  const parsed = z.object(tool.input as z.ZodRawShape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      envelope: {
        ok: false,
        tool: name,
        summary: `Invalid input: ${msg}`,
        warnings: [],
        error: { code: "INVALID_INPUT", message: msg, hint: "Check the tool's input schema." },
        meta: meta(),
      },
      markdown: undefined,
      terminal: undefined,
    };
  }
  try {
    const r = (await (tool.handler as any)(engine, parsed.data)) as ToolResult;
    const env = {
      ok: true,
      tool: name,
      summary: r.summary,
      data: redactDeep(r.data),
      warnings: r.warnings ?? [],
      meta: meta(),
    };
    return { envelope: env, markdown: r.markdown, terminal: r.terminal };
  } catch (err) {
    const se = err instanceof ScoutError ? err : new ScoutError("INTERNAL", (err as Error).message);
    return {
      envelope: {
        ok: false,
        tool: name,
        summary: se.message,
        warnings: [],
        error: { code: se.code, message: se.message, hint: se.hint },
        meta: meta(),
      },
      markdown: undefined,
      terminal: undefined,
    };
  }
}
