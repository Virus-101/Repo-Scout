# Windsurf

Source: Windsurf Cascade MCP docs (<https://docs.windsurf.com/plugins/cascade/mcp>; the vendor's docs now redirect to docs.devin.ai) — checked 2026-11-11.

**Caveat — documentation is mid-migration.** The long-standing, widely documented location is `~/.codeium/windsurf/mcp_config.json` (`%USERPROFILE%\.codeium\windsurf\mcp_config.json` on Windows). The newest vendor pages describe `.devin/mcp_config.json` (project), `.devin/mcp_config.local.json` and `~/.config/devin/mcp_config.json` (user) and a UI route (Customize → MCPs). Use the UI's "open config file" action to find the file your installed version reads.

```json
{ "mcpServers": { "repo-scout": { "command": "npx", "args": ["-y", "repo-scout", "mcp"] } } }
```

Restart/refresh the MCP list after editing. **Rules:** copy `integrations/windsurf/repo-scout.md` into `.windsurf/rules/` (or your version's rules location).
