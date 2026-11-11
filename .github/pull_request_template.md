## What & why

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` pass
- [ ] Tests added/updated (mocked); live behaviour claimed only if `pnpm test:live` was run
- [ ] No fabricated data; unknowns reported as missing; evidence status set on new factors
- [ ] Provider text treated as untrusted (sanitised/escaped); no new execution/clone/write paths
- [ ] Docs updated (`pnpm docs:gen` if tools changed; skill parity; CHANGELOG)
- [ ] New runtime dependency? justified here:
