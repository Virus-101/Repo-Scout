# Gemini CLI

Source: <https://geminicli.com/docs/tools/mcp-server/> (checked 2026-11-11).

```bash
gemini mcp add repo-scout npx -y repo-scout mcp          # --scope user|project, -e KEY=value for env
```

or `~/.gemini/settings.json` (user) / `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "repo-scout": { "command": "npx", "args": ["-y", "repo-scout", "mcp"], "timeout": 120000, "trust": false }
  }
}
```

Keep `trust: false` so Gemini CLI asks before each tool call. Avoid underscores in the _server name_ (the docs warn about tool-name parsing); `repo-scout` is fine. Add `integrations/gemini-cli/GEMINI.md` to your project's `GEMINI.md` for guidance. (The docs note Gemini CLI availability changes for some account tiers — check your plan.)
