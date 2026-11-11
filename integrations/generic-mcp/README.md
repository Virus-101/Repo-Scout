# Any MCP client (stdio)

Launch command: `npx -y repo-scout mcp` (or `repo-scout-mcp` after `npm i -g repo-scout`). Transport: **stdio**. No network port is opened.

```json
{ "mcpServers": { "repo-scout": { "command": "npx", "args": ["-y", "repo-scout", "mcp"] } } }
```

Optional environment (set in the client's `env` block or your shell): `GITHUB_TOKEN`, `REPO_SCOUT_HOME`, `REPO_SCOUT_OFFLINE=1`, `NODE_USE_ENV_PROXY=1` (when behind an HTTP(S) proxy).
