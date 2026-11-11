<div align="center">

# 🔭 GitHub Repo Scout

**Find the building blocks. Build smarter.**

A local-first, agent-first repository intelligence engine: discover, evaluate, compare and _combine_ existing open-source software — from the CLI, from any MCP-capable AI coding agent, or through an installable agent skill.

[![CI](https://github.com/virus-101/repo-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/virus-101/repo-scout/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![Node >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)

</div>

> **Status: v0.1.0, not yet published to npm.** The package name `repo-scout` returned _404 Not Found_ on the npm registry when checked on 2026-11-11 (i.e. unclaimed at that time; names can be taken at any moment). Until it is published, install from source (see [Installation](#installation)). See [docs/development/validation-status.md](docs/development/validation-status.md) for exactly what has and has not been validated.

---

## 1. What is Repo Scout?

Repo Scout takes a natural-language idea — _"a self-hosted AI meeting assistant"_ — and answers the question every developer should ask first: **what already exists that I can reuse?**

It understands the task, extracts requirements (separating what you _said_ from what it _assumed_), searches many ecosystems, filters and scores candidates with task-adaptive weights, statically inspects the shortlist, and — its main differentiator — **composes combinations of repositories that work together**, then hands your AI agent an evidence-backed implementation plan with explicit approval gates.

It provides **evidence and recommendations**. Your AI agent does the implementation. Repo Scout never clones, writes, installs or executes anything.

## 2. Why do developers need it?

- Teams routinely rebuild things that exist as mature, maintained, permissively-licensed projects.
- Choosing between projects by stars is unreliable; fit, maintenance, licence and compatibility matter more.
- Real systems are _combinations_ (speech-to-text + diarization + LLM runtime + vector store + auth…). Picking the "best" part for each slot independently often yields parts that don't fit together.
- AI agents hallucinate libraries and miss new ones. Repo Scout gives them grounded, cited, current data with honest uncertainty.

## 3. How is it different from GitHub search?

|              | GitHub search      | Repo Scout                                                                                                                                                                             |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input        | keywords           | a described goal (decomposed into components + queries)                                                                                                                                |
| Sources      | GitHub repos       | GitHub, GitLab, Codeberg, npm, PyPI, crates.io, Maven Central, arXiv, Papers with Code, awesome lists, web docs (optional) — normalised, with _different object types never conflated_ |
| Ranking      | text + stars       | hybrid lexical/metadata (+ optional local embeddings), then **task-adaptive** multi-factor scores; stars are low-weight                                                                |
| Evidence     | none               | every score lists **verified / inferred / missing / assumed** factors and a confidence value                                                                                           |
| Depth        | README skim        | Level 1 filter → Level 2 adaptive scoring → Level 3 static inspection (tree, manifests, OSV advisories, licence)                                                                       |
| Systems      | one repo at a time | **Solution Composer**: whole-stack compatibility (language, framework, runtime, deps, API, auth, deploy, licence)                                                                      |
| Trends       | sort by stars      | observed-vs-estimated growth from local snapshots, hidden-gem detection, decline detection                                                                                             |
| Agent safety | n/a                | untrusted-content handling, injection flags, approval gates for clone/write/install/execute                                                                                            |

## 4. Installation

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; no native build step).

```bash
# once published to npm:
npm install -g repo-scout
repo-scout doctor
repo-scout search "AI agent framework"

# zero-install:
npx -y repo-scout search "AI agent framework"
```

From source (works today):

```bash
git clone https://github.com/virus-101/repo-scout && cd repo-scout
pnpm install && pnpm build
node packages/cli/dist/cli.js doctor        # or: pnpm link --global ./packages/cli
```

Optional but recommended: `export GITHUB_TOKEN=…` (read-only public access is enough) — anonymous GitHub limits are 60 core / 10 search requests per hour. Behind an HTTP(S) proxy set `NODE_USE_ENV_PROXY=1`. Details: [docs/installation](docs/installation/README.md).

## 5. Configure MCP (for AI agents)

Server command: `npx -y repo-scout mcp` (stdio). Verified formats (checked against current vendor docs on 2026-11-11):

| Agent              | Quick setup                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Claude Code**    | `claude mcp add --transport stdio repo-scout -- npx -y repo-scout mcp`                                      |
| **Cursor**         | `.cursor/mcp.json` → `{"mcpServers":{"repo-scout":{"command":"npx","args":["-y","repo-scout","mcp"]}}}`     |
| **OpenAI Codex**   | `codex mcp add repo-scout -- npx -y repo-scout mcp` or `[mcp_servers.repo-scout]` in `~/.codex/config.toml` |
| **Windsurf**       | `mcp_config.json` (`mcpServers`, same shape as Cursor) — see note on the new location in the guide          |
| **Gemini CLI**     | `gemini mcp add repo-scout npx -y repo-scout mcp` or `mcpServers` in `~/.gemini/settings.json`              |
| **Any MCP client** | stdio transport, command `npx -y repo-scout mcp`                                                            |

Print ready-to-paste snippets with `repo-scout integrate [agent]`. Full guides: [docs/integrations](docs/integrations/README.md).

## 6. Use the CLI

```text
repo-scout search "AI agent framework"          # free-text search across providers
repo-scout find "real-time object detection"    # full pipeline for a described task
repo-scout analyze owner/repository             # deep static analysis of one repo
repo-scout compare owner/repo1 owner/repo2      # side-by-side comparison
repo-scout compose "AI meeting assistant"       # multi-repo solution options
repo-scout plan "my project requirements"       # implementation plan with approval gates
repo-scout trending | hidden-gems | declining   # trend radar
repo-scout alternatives "popular-library"       # alternatives to a project
repo-scout providers | cache status | cache clear | doctor
```

Global flags: `--json` (same envelope as MCP), `--markdown`, `-o report.md`, `-n/--limit`, `--offset`, `--sort score|stars|updated`, `-l/--language`, `-p/--provider`, `-v/--verbose`, `--offline`. Exit codes: 0 ok · 1 error · 2 bad input · 3 not found · 4 provider/network · 5 rate-limited · 6 security-blocked · 7 config · 8 database. Reference: [docs/cli.md](docs/cli.md).

## 7. Use the agent skill

`skills/repo-scout/SKILL.md` teaches an agent _when_ to use Repo Scout, how to read evidence, how to compare and compose, how to respect approval gates and why repository text is untrusted. It does not duplicate the engine; it drives the MCP tools (or CLI).

```bash
# Claude Code (personal)
mkdir -p ~/.claude/skills && cp -r "$(repo-scout skill | head -1)" ~/.claude/skills/repo-scout
```

Guide: [docs/integrations/skill.md](docs/integrations/skill.md).

## 8. Practical examples

Real output from this repository's CLI on 2026-11-11 (live GitHub/npm/PyPI/crates/GitLab/arXiv providers, anonymous-equivalent quotas; scores and rankings change over time):

```text
$ repo-scout find "real-time object detection" -n 3 --deep 1
Discovered 276, shortlisted 15, deeply inspected 1. Retrieval: lexical+metadata.

1. lyuwenyu/RT-DETR  72.2/100  confidence 46% · 2-adaptive
   https://github.com/lyuwenyu/RT-DETR
   repository · Python · Apache-2.0 · ★5663 · active 2026-10-09 · release n/a
   relevance 57 · maintenance 89 · compat 90 · security unverified · docs 66
   ! Source not inspected: quality, security and integration scores rely on metadata only.
2. PaddlePaddle/PaddleDetection  72/100 …
3. iMoonLab/yolov13  71.6/100  … AGPL-3.0 … ! low license score (25/100)
```

Note the honesty: `security unverified` (no vulnerability data was fetched), `confidence 46%`, and AGPL flagged. A composed solution (abridged) from `repo-scout compose "Build a self-hosted AI meeting assistant"`:

```text
Speech-to-text → m-bain/whisperX            Speaker identification → pyannote/pyannote-metrics
Deployment → louislam/dockge                 LLM integration → jundot/omlx
Not covered by any acceptable candidate: Full-text search
Integration complexity: medium · Compatibility 57.8 · Confidence 39% (dependency conflicts unverified: manifests not inspected)
Licences: contains copyleft component (alyssaxuu/screenity: GPL-3.0)
```

The live results above also show current limits: component search quality depends on provider search, and several picks (e.g. a screen recorder for "audio capture") are weak — which is why every option lists conflicts, confidence and what is _unverified_, and why your agent is told to verify before relying on them.

From an agent (MCP), typical flow: `scout_understand_task` → `scout_find_repositories` → `scout_analyze_repository` → `scout_compare_repositories` → `scout_compose_solution` → `scout_generate_implementation_plan` → _ask the developer_ → clone/inspect/integrate.

## 9. Architecture

```text
 CLI (commander)  ─┐                    ┌─ providers: GitHub · GitLab · Codeberg · npm · PyPI · crates · Maven
 MCP server (stdio)├─► tools (zod) ───► │  arXiv · Papers with Code · awesome lists · web search API
 Agent skill ─────┘     │               └─ SafeHttp: https-only, SSRF checks, size/time caps, rate limits, redaction
                        ▼
   intelligence (task → spec, queries) → discovery engine → scoring (L1/L2, adaptive weights, licence, hybrid retrieval)
        analysis (L3: tree, manifests, OSV) → composer (compatibility, combos, plan) → trending (snapshots) → report (JSON/MD/text)
                        ▼
                 cache: SQLite (WAL) — resources, searches, analyses, snapshots, relations, scores, provider health
```

`packages/` = `schemas · core · cache · providers · intelligence · scoring · analysis · composer · trending · discovery · report · mcp · cli`. The engine has no dependency on any model or agent. See [docs/architecture](docs/architecture/overview.md) and [scoring definitions](docs/architecture/scoring.md).

## 10. Roadmap

- Publish to npm and add provenance-signed releases.
- GraphQL batching for GitHub (fewer round trips with a token).
- Maven POM parsing (descriptions/licences), crates.io sparse index, more registries (NuGet, Go proxy, RubyGems, Packagist).
- Lockfile-aware vulnerability checks (exact resolved versions instead of declared minimums).
- Optional local embedding presets and an evaluation set built from real, labelled recommendations.
- Windows/macOS CI results published (workflow exists; see status doc).

## 11. Security & limitations

- Everything from repositories, READMEs, packages and web pages is **untrusted data**; injection-like text is flagged, sanitised and never treated as instructions. See [SECURITY.md](SECURITY.md) and [docs/security](docs/security/README.md).
- No code is executed, built or installed; no cloning. Approval gates are returned to the agent in every plan.
- **Security output is indicators, not an audit.** Licence classification is not legal advice. Scores are heuristics, shown with confidence and evidence.
- Local-first and no telemetry; data stays in a local SQLite file ([PRIVACY.md](PRIVACY.md)).
- Known provider limits: GitHub rate limits; PyPI has no search API (names are resolved, not searched); Maven search returns coordinates only; Codeberg often rate-limits anonymous clients; the legacy Papers with Code API now redirects (reported as unavailable); web discovery needs `BRAVE_API_KEY` or `SEARXNG_URL`.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test       # 180+ tests, mocked providers, deterministic
pnpm test:live                                  # opt-in: real provider calls (REPO_SCOUT_LIVE=1)
pnpm bench && pnpm eval                         # performance + (synthetic) relevance benchmarks
pnpm verify:install                             # clean-room tarball install + MCP stdio handshake
```

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Changes: [CHANGELOG.md](CHANGELOG.md) · License: [MIT](LICENSE).
