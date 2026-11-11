# Provider fixtures

Hand-written, minimal payloads that follow the documented response shapes of each provider API. They exist to make
unit/integration tests deterministic. They are **not** recordings of live traffic; live behaviour is covered separately by
`tests/integration/live/` (opt-in with `REPO_SCOUT_LIVE=1`).
