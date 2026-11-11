# Privacy (local tool)

Repo Scout is **local-first**. It has **no telemetry, no analytics, no accounts and no remote service of its own.**

## What leaves your machine

Only the HTTP requests needed for the providers you use, sent directly from your machine to those providers:

- GitHub/GitLab/Codeberg/npm/PyPI/crates.io/Maven/arXiv/Papers with Code/OSV.dev and (if configured) Brave Search or your SearXNG: **search terms derived from your request**, package names and versions (OSV), repository names. These providers can see your IP address, the queries and your token (for that provider only). Do not put confidential product details in task descriptions unless you accept that they become search queries.
- Optional embeddings run against a **local** server (loopback) — nothing is sent to a cloud model by Repo Scout.
- The AI agent that calls Repo Scout is a separate party: whatever Repo Scout returns is seen by that agent and its vendor, per that agent's privacy terms.

## What is stored locally

A SQLite file (default `~/.local/share/repo-scout/scout.sqlite`, `~/Library/Application Support/repo-scout/` on macOS, `%LOCALAPPDATA%\repo-scout\` on Windows; override with `REPO_SCOUT_HOME`/`REPO_SCOUT_DB`): cached provider responses (public metadata), your search strings (as cache keys hashed + stored results), analysis results, star/fork snapshots, relations, scores and provider health. **Credentials are never written to the database or config by Repo Scout.** The file is created with `0600` permissions (best effort on Windows). Multiple agents on the same account share it.

## Control

`repo-scout cache status` shows contents; `repo-scout cache clear --scope all -y` deletes everything (including historical snapshots); deleting the data directory removes all state. `--offline` / `REPO_SCOUT_OFFLINE=1` prevents all network access.
