# Contributing

Thanks for helping! Repo Scout aims to be correct, secure and honest about uncertainty. Please read this before opening a PR.

## Setup

```bash
corepack enable && pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Node ≥ 22.13. Tests are deterministic (mocked providers). Live tests are opt-in: `REPO_SCOUT_LIVE=1 pnpm test:live`.

## Principles

1. **Never fabricate.** No hard-coded demo results, simulated provider data in product code, invented history, or claims of verification/audit. Missing data is reported as missing.
2. **Evidence status on every datum** (`verified | inferred | missing | assumption`). New score factors must declare it.
3. **Untrusted content stays data.** Anything from providers goes through `sanitizeText`/`mdEscape` before output; never interpolate it into instructions.
4. **No execution, no cloning, no writes** from the engine. Side-effect boundaries are the agent's, via approval gates.
5. **Respect providers:** HTTPS via `SafeHttp`, rate limits, timeouts, no HTML scraping, documented limitations.
6. **Small dependency surface.** Justify any new runtime dependency in the PR.

## Adding things

- _Provider:_ see [docs/providers.md](docs/providers.md#adding-a-provider). Add fixtures + unit tests; add a live test that skips (not passes) when blocked.
- _Tool:_ add it in `packages/mcp/src/tools.ts` (Zod input, handler returning `{summary,data,markdown}`), run `pnpm docs:gen`, update the skill (`tests/integration/packaging.test.ts` enforces tool/skill parity).
- _Score/weights:_ update `docs/architecture/scoring.md` and tests in `tests/unit/scoring.test.ts`.
- _Agent integration:_ verify against the vendor's current docs and cite the date in `docs/integrations/`.

## Pull requests

Small, focused, with tests. Run `pnpm format` (Prettier), `pnpm lint`, `pnpm typecheck`, `pnpm test`. Update `CHANGELOG.md` under _Unreleased_. By contributing you agree your work is licensed under the MIT license.
