# Claude Code

Source: <https://code.claude.com/docs/en/mcp> and <https://code.claude.com/docs/en/skills> (checked 2026-11-11).

```bash
# user scope (all projects); use --scope project to write .mcp.json for your team, --scope local for this project only
claude mcp add --transport stdio --scope user repo-scout -- npx -y repo-scout mcp
claude mcp list          # verify; inside Claude Code run /mcp
```

Optional token (value is stored in your Claude config, not in this repo): `claude mcp add --transport stdio --env GITHUB_TOKEN=… repo-scout -- npx -y repo-scout mcp` (put another option between `--env` and the server name, as the docs note).

Project-scoped `.mcp.json` (commit-safe; contains no secrets):

```json
{
  "mcpServers": {
    "repo-scout": { "type": "stdio", "command": "npx", "args": ["-y", "repo-scout", "mcp"], "env": {} }
  }
}
```

Claude Code asks for approval before using project-scoped servers.

**Skill:** copy `skills/repo-scout/` to `~/.claude/skills/repo-scout/` (personal) or `.claude/skills/repo-scout/` (project). The skill uses only portable frontmatter fields (`name`, `description`, `license`, `compatibility`).
