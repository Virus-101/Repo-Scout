# Installation & quick start

## Requirements

- **Node.js ≥ 22.13** (stable `node:sqlite`; Node 24 LTS also works). No native modules, no compiler needed.
- `git` is only needed by _your agent_ for approved clones; Repo Scout never clones.
- Optional: `GITHUB_TOKEN` (public read access is enough).

## Install

```bash
# global (after the package is published)
npm install -g repo-scout
repo-scout doctor

# zero-install (after publication)
npx -y repo-scout search "AI agent framework"
```

> The npm name `repo-scout` was **unclaimed (404) on 2026-11-11** when checked with `npm view`. Nothing has been published yet. Re-check before publishing: `npm view repo-scout name`.

### From source (works today)

```bash
git clone https://github.com/virus-101/repo-scout && cd repo-scout
corepack enable && pnpm install && pnpm build
node packages/cli/dist/cli.js doctor
pnpm --filter repo-scout pack        # produces repo-scout-0.1.0.tgz; npm i -g ./repo-scout-0.1.0.tgz
```

### Clean-room verification

`pnpm verify:install` builds, packs, installs the tarball into an empty project with an empty `HOME`, runs `--version`, `doctor`, `understand`, creates the database and performs a real MCP stdio handshake (lists tools, calls one).

## Quick start

```bash
repo-scout doctor                                   # check node, db, network, credentials
repo-scout understand "self-hosted AI meeting assistant"   # no network; shows explicit vs assumed
repo-scout find "real-time object detection" -n 5
repo-scout analyze owner/repo
repo-scout compose "self-hosted AI meeting assistant" --markdown -o report.md
repo-scout plan "self-hosted AI meeting assistant"
```

## Configuration

Precedence: defaults < `config.json` < environment < CLI flags.

| Environment variable                          | Meaning                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN` / `GH_TOKEN`                   | GitHub API token (raises limits; used for GitHub hosts only)                                                                   |
| `GITLAB_TOKEN`, `CODEBERG_TOKEN`              | Optional tokens for those hosts                                                                                                |
| `BRAVE_API_KEY` or `SEARXNG_URL`              | Enables the `web` provider (docs/site discovery)                                                                               |
| `REPO_SCOUT_HOME`                             | Data directory (default: `~/.local/share/repo-scout`, `~/Library/Application Support/repo-scout`, `%LOCALAPPDATA%\repo-scout`) |
| `REPO_SCOUT_DB`                               | Explicit SQLite path                                                                                                           |
| `REPO_SCOUT_CONFIG`                           | Config file path (default `<home>/config.json`)                                                                                |
| `REPO_SCOUT_CACHE_TTL`                        | Resource cache TTL in seconds (default 21600)                                                                                  |
| `REPO_SCOUT_OFFLINE=1`                        | Never touch the network                                                                                                        |
| `REPO_SCOUT_EMBEDDINGS=ollama`, `OLLAMA_HOST` | Optional local embeddings (see below)                                                                                          |
| `REPO_SCOUT_LOG_LEVEL`                        | `silent                                                                                                                        | error | warn | info | debug` (logs go to stderr; secrets are redacted) |
| `NODE_USE_ENV_PROXY=1`                        | Make Node's `fetch` honour `HTTP(S)_PROXY` (Node ≥ 22.21)                                                                      |

`config.json` (all keys optional; **do not put secrets in it** — use environment variables):

```json
{
  "cacheTtlSeconds": 21600,
  "searchTtlSeconds": 3600,
  "analysisTtlSeconds": 86400,
  "providers": {
    "enabled": ["github", "npm", "pypi", "arxiv"],
    "disabled": [],
    "timeoutMs": { "github": 20000 }
  },
  "limits": { "maxCandidates": 120, "maxShortlist": 15, "maxDeepInspect": 5 },
  "embeddings": { "provider": "ollama", "url": "http://127.0.0.1:11434", "model": "nomic-embed-text" }
}
```

### Optional local embeddings

With `embeddings.provider = "ollama"`, retrieval blends BM25 + metadata with cosine similarity from a **local** Ollama server (loopback only — no cloud API). If it is unreachable, Repo Scout silently falls back to lexical+metadata retrieval; discovery never depends on embeddings.

### Multiple agents, one database

All agents share the same SQLite file (WAL mode, 8 s busy timeout, immediate transactions). Run as many MCP servers/CLI processes concurrently as you like. Put `REPO_SCOUT_HOME` on a local disk (SQLite WAL does not work reliably on network filesystems).

## Platform notes

Linux, macOS and Windows are supported by design (path handling via `node:path`, no shell, `.cmd` shims handled in the install verifier). Local validation so far covers **Linux only**; the CI matrix covers all three — see [validation status](../development/validation-status.md).
