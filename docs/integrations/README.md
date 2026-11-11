# Agent integrations

Repo Scout speaks **MCP over stdio**: command `npx -y repo-scout mcp` (or the `repo-scout-mcp` binary of a global install). Formats below were checked against each vendor's current documentation on **2026-11-11**; agents change quickly, so if a path or key no longer works, consult the vendor docs linked in each guide and the generic stdio recipe.

| Agent             | Guide                            | Config artefact in this repo                             |
| ----------------- | -------------------------------- | -------------------------------------------------------- |
| Claude Code       | [claude-code.md](claude-code.md) | `integrations/claude-code/mcp.json`                      |
| Cursor            | [cursor.md](cursor.md)           | `integrations/cursor/mcp.json`, `repo-scout.mdc`         |
| OpenAI Codex CLI  | [codex.md](codex.md)             | `integrations/codex/config.toml`, `AGENTS.md`            |
| Windsurf          | [windsurf.md](windsurf.md)       | `integrations/windsurf/mcp_config.json`, `repo-scout.md` |
| Gemini CLI        | [gemini-cli.md](gemini-cli.md)   | `integrations/gemini-cli/settings.json`, `GEMINI.md`     |
| Any MCP client    | [generic-mcp.md](generic-mcp.md) | `integrations/generic-mcp/README.md`                     |
| Agent skill (all) | [skill.md](skill.md)             | `skills/repo-scout/SKILL.md`                             |

`repo-scout integrate <agent>` prints the same snippets. Not all agents use the same format: JSON `mcpServers` (Claude Code, Cursor, Windsurf, Gemini CLI) vs TOML `[mcp_servers.*]` (Codex).

**Important:** these guides configure the _connection_. They do not validate that every agent product loads the server — only Claude-independent protocol conformance is tested (official SDK client ⇄ server over in-memory and stdio transports). See the validation status document.
