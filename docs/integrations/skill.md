# The Repo Scout agent skill

`skills/repo-scout/SKILL.md` follows the portable skill format (YAML frontmatter with `name`, `description`, `license`, `compatibility`; Markdown body). It covers: when to use Repo Scout, how to understand requests, searching, evidence evaluation, comparison, composition, implementation plans, approval boundaries, untrusted-content rules and avoiding rebuilding existing software.

It deliberately contains **no engine logic** — only guidance that drives the `scout_*` MCP tools (or the CLI). Tests (`tests/integration/packaging.test.ts`) enforce that every tool the skill mentions exists, that every tool is mentioned, and that the frontmatter uses only portable fields.

Install: copy the directory to your agent's skills folder (Claude Code: `~/.claude/skills/repo-scout/` or `.claude/skills/repo-scout/`). `repo-scout skill` prints the bundled path. For agents without skill support use the rule/instruction files in `integrations/` (Cursor `.mdc`, Codex `AGENTS.md`, Gemini `GEMINI.md`, Windsurf rule).
