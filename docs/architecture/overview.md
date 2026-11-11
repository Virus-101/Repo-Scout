# Architecture

```text
packages/
  schemas       Zod schemas + types: Resource, EvidenceRef, TaskSpec, Score, Evaluation, Composition, ImplementationPlan, ToolEnvelope
  core          config, errors, redaction, logging, SafeHttp (SSRF, limits, rate limiter), path/URL/prompt-injection helpers, safeExec
  cache         SQLite store (node:sqlite): migrations, TTL cache, resources, snapshots, relations, scores, provider health
  providers     Provider interface, 11 adapters, registry
  intelligence  rule-based task understanding (no model API): requirements, components, domains, licence constraints, queries
  scoring       licence classification, hybrid retrieval (BM25 + metadata + optional local embeddings), adaptive weights, Level 1/2/3 evaluation
  analysis      static manifest parsing, tree classification, architecture hints, OSV lookup, injection scan, Level-3 inspection
  composer      pairwise/set compatibility, beam-search solution composer, implementation plans with approval gates
  trending      snapshots → observed vs estimated growth, hidden gems, declining projects
  discovery     Engine: wires everything; caching, dedupe, circuit breaker, pipelines
  report        JSON recommendation records, Markdown and terminal renderers, score legend
  mcp           tool definitions (one source of truth), executeTool envelope, MCP server (official SDK, stdio)
  cli           commander program, integration snippets; bundled by esbuild into the published `repo-scout` package
```

Dependency direction is strictly downward (`schemas` ← `core` ← `cache`/`providers` ← `scoring` ← `analysis` ← `composer`/`trending` ← `discovery` ← `mcp` ← `cli`). Nothing depends on a model, an agent or a UI. The CLI and MCP server call the _same_ tool handlers (`executeTool`), so behaviour is identical and tested once.

## Pipeline

1. **Understand** (`intelligence`): clauses → functional / non-functional / performance / security requirements; languages, frameworks, OS, runtimes, infra, integrations; licence constraints; domain; component needs (explicit triggers + archetype-implied _assumed_ components); 15–40 queries of kinds `exact · technology · feature · semantic · alternative · related · package`. Every inferred item is tagged `assumed`.
2. **Gather** (`discovery`): route queries to providers (registries only see package queries by default), cache results in SQLite, dedupe by canonical id, merge duplicate discoveries (API data beats curated-list stubs).
3. **Level 1 – fast filter**: relevance (hybrid retrieval), recency, licence presence, log-scaled popularity (low weight), documentation hints, language fit.
4. **Level 2 – adaptive scoring**: nine scores with factor-level evidence; weights derived from the task (`weights.ts`); _missing_ factors are excluded and lower confidence; relevance gate; hard caps (archived, forbidden licence).
5. **Level 3 – deep inspection** (top N GitHub repos): tree, manifests, README, releases, contributors, commit activity, OSV advisories, npm deprecation, install-script detection, architecture patterns, prompt-injection flags. **Static only.**
6. **Compose** (`composer`): per-component candidate pools → beam search over combinations under three objectives (balanced, fewest language boundaries, lowest licence/maintenance risk) → compatibility issues, licence-set analysis, missing components, complexity, sequence.
7. **Plan**: reuse list, must-build list, steps and five approval gates for the agent.

## Storage

SQLite via `node:sqlite` (WAL, `busy_timeout=8000`, `BEGIN IMMEDIATE` writers, `0600` file mode where supported). Tables: `resources, kv_cache(namespace,key), snapshots, relations, scores, providers, meta, schema_migrations`. Forward-only migrations in `packages/cache/src/migrations.ts`; the migrator re-checks the version inside the write lock so concurrent first starts are safe. TTLs: resources 6 h, searches 1 h, analyses 24 h (configurable); stale entries are served only when a provider fails (and are labelled `stale`). Snapshots are never expired automatically.

## Design decisions

- **`node:sqlite` over `better-sqlite3`:** zero native build, trivial `npx` install on all OSes. Cost: requires Node ≥ 22.13 and the module is still flagged experimental by Node (its warning is suppressed in the CLI entry points).
- **Rule-based understanding:** deterministic, offline, auditable; the cost is limited vocabulary (see `lexicon.ts`). Embeddings are optional and local.
- **Single bundle:** esbuild bundles the workspace packages into `packages/cli/dist`; only `commander`, `zod` and `@modelcontextprotocol/sdk` are runtime dependencies.
- **Honest scoring:** unknowns are excluded and reported, never imputed.
