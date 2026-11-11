# Cursor

Source: <https://cursor.com/docs/context/mcp>, <https://cursor.com/docs/context/rules> (checked 2026-11-11).

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{ "mcpServers": { "repo-scout": { "command": "npx", "args": ["-y", "repo-scout", "mcp"] } } }
```

Add an optional `"env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" }` only if your Cursor version supports env interpolation; otherwise export the variable in the shell that launches Cursor.

**Rule:** copy `integrations/cursor/repo-scout.mdc` to `.cursor/rules/`. Cursor rules must be `.mdc` with frontmatter (`description`, `globs`, `alwaysApply`); this one is an "Apply Intelligently" rule (`alwaysApply: false` + description).
