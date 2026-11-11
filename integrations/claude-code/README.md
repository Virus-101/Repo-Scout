# Claude Code

```bash
# 1. MCP server (user scope; add `--scope project` to write .mcp.json for your team)
claude mcp add --transport stdio --scope user repo-scout -- npx -y repo-scout mcp

# 2. Agent skill (personal)
mkdir -p ~/.claude/skills && cp -r "$(npx -y repo-scout skill | head -1)" ~/.claude/skills/repo-scout

# verify
claude mcp list        # or `/mcp` inside Claude Code
```

Project-scoped `.mcp.json` equivalent (see `mcp.json` in this folder). Claude Code asks you to approve project-scoped servers the first time.
