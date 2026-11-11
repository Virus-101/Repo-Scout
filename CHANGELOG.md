# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased (not yet published)

### Added

- Modular TypeScript monorepo (13 packages) bundled into one `repo-scout` package (CLI + MCP server).
- 11 provider adapters: GitHub, GitLab, Codeberg, npm, PyPI, crates.io, Maven Central, arXiv, Papers with Code (reports unavailable), awesome lists, web search APIs (Brave/SearXNG).
- Rule-based natural-language task understanding with explicit/assumed tagging and multi-kind query generation.
- Hybrid retrieval (BM25 + metadata, optional local embeddings), 3-level evaluation, task-adaptive weights, licence classification and cross-component licence analysis.
- Level-3 static inspection (tree, manifests, README, OSV advisories, install-script and prompt-injection flags).
- Solution Composer with compatibility analysis, three distinct options, missing-component reporting, complexity estimate, implementation sequence and approval-gated plans.
- Trend radar with local snapshots (observed vs estimated growth), hidden gems, decline detection.
- SQLite store (WAL, migrations, TTL cache, snapshots), SSRF/path/secret protections.
- MCP server (19 tools, official SDK, stdio), CLI (all commands from the spec plus `understand`, `details`, `license`, `security`, `deps`, `integrate`, `skill`), agent skill, integration kits for Claude Code, Cursor, Codex, Windsurf, Gemini CLI.
- 180+ automated tests, opt-in live tests, benchmarks, synthetic relevance evaluation, clean-install verifier, CI workflows.
