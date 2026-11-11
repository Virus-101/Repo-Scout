# OpenAI Codex CLI

Source: Codex MCP documentation (<https://developers.openai.com/codex/mcp>, redirected to learn.chatgpt.com/docs/extend/mcp; checked 2026-11-11).

```bash
codex mcp add repo-scout -- npx -y repo-scout mcp
codex mcp list
```

or in `~/.codex/config.toml` (project-level `.codex/config.toml` works for trusted projects):

```toml
[mcp_servers.repo-scout]
command = "npx"
args = ["-y", "repo-scout", "mcp"]
startup_timeout_sec = 30      # first npx run may download the package
tool_timeout_sec = 120        # discovery can take a while on anonymous GitHub quotas

# optional: forward a token from your environment without storing it
# env_vars = ["GITHUB_TOKEN"]
```

Codex also supports per-tool approval modes (`default_tools_approval_mode`, `tools.<tool>.approval_mode`). A conservative setup is `default_tools_approval_mode = "prompt"`.

**Instructions:** append `integrations/codex/AGENTS.md` to your project's `AGENTS.md`. For skills, place `skills/repo-scout/` in the skills directory your Codex version documents.
