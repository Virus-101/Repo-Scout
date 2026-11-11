# Testing

```bash
pnpm test                  # unit + integration, deterministic (mocked providers), ~2 s
pnpm test:live             # REPO_SCOUT_LIVE=1 — real provider calls; blocked providers are SKIPPED, never "passed"
pnpm bench                 # performance benchmarks -> tests/benchmarks/results/latest.json
pnpm eval                  # synthetic relevance evaluation -> tests/benchmarks/results/relevance.json
pnpm verify:install        # clean-room tarball install + CLI + MCP stdio handshake
```

| Area                                                                  | File                                  |
| --------------------------------------------------------------------- | ------------------------------------- |
| Query understanding, domains, licence parsing                         | `tests/unit/intelligence.test.ts`     |
| Provider normalisation (fixtures), failure mapping, robots            | `tests/unit/providers.test.ts`        |
| Ranking, adaptive weights, licence classification, evaluation honesty | `tests/unit/scoring.test.ts`          |
| Compatibility analysis, composer, plans/approval gates                | `tests/unit/composer.test.ts`         |
| Cache/DB: migrations, TTL, dedupe, snapshots, concurrency             | `tests/unit/cache.test.ts`            |
| Security validation                                                   | `tests/unit/security.test.ts`         |
| Manifests, OSV, Level-3 inspection                                    | `tests/unit/analysis.test.ts`         |
| Trend honesty, hidden gems, radar                                     | `tests/unit/trending.test.ts`         |
| Engine pipelines (provider failure, cache, stale, offline, compose)   | `tests/integration/engine.test.ts`    |
| MCP tools via the official SDK client                                 | `tests/integration/mcp.test.ts`       |
| CLI (formats, exit codes, doctor, integrate)                          | `tests/integration/cli.test.ts`       |
| Skill/integration packaging, repo hygiene                             | `tests/integration/packaging.test.ts` |
| Live provider smoke tests (opt-in)                                    | `tests/integration/live/live.test.ts` |

Fixtures in `tests/fixtures/providers` are **hand-written to match documented response shapes**, not recordings. A green default run therefore proves behaviour against those shapes, **not** that live APIs still return them — that is what the live tests are for.

Project categories exercised by understanding/evaluation tests: AI agents, computer vision, web development, embedded, data engineering, developer tooling, robotics, security tooling (plus speech/audio, authentication, education, real-time).
