export interface Integration {
  id: string;
  name: string;
  configPath: string;
  format: "json" | "toml" | "command";
  snippet: (cmd: { command: string; args: string[] }) => string;
  notes: string[];
  skillDir?: string;
}

const json = (o: unknown) => JSON.stringify(o, null, 2);
const q = (s: string) => JSON.stringify(s);

export const INTEGRATIONS: Integration[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: ".mcp.json (project) or `claude mcp add` (user/local scope)",
    format: "json",
    snippet: (c) =>
      `# CLI (recommended):\nclaude mcp add --transport stdio repo-scout -- ${[c.command, ...c.args].join(" ")}\n\n# or project-scoped .mcp.json:\n${json({ mcpServers: { "repo-scout": { type: "stdio", command: c.command, args: c.args, env: {} } } })}`,
    notes: [
      "Skill: copy skills/repo-scout to ~/.claude/skills/repo-scout (personal) or .claude/skills/repo-scout (project).",
      "Project-scoped servers in .mcp.json require approval the first time Claude Code loads them.",
    ],
    skillDir: "~/.claude/skills/repo-scout",
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: ".cursor/mcp.json (project) or ~/.cursor/mcp.json (global)",
    format: "json",
    snippet: (c) => json({ mcpServers: { "repo-scout": { command: c.command, args: c.args } } }),
    notes: [
      "Rule file: copy integrations/cursor/repo-scout.mdc to .cursor/rules/ so the agent knows when to call Repo Scout.",
    ],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    configPath: "~/.codex/config.toml",
    format: "toml",
    snippet: (c) =>
      `[mcp_servers.repo-scout]\ncommand = ${q(c.command)}\nargs = [${c.args.map(q).join(", ")}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\n\n# or: codex mcp add repo-scout -- ${[c.command, ...c.args].join(" ")}`,
    notes: [
      "Instructions: add the contents of integrations/codex/AGENTS.md to your project's AGENTS.md.",
      "Codex also supports agent skills: copy skills/repo-scout to ~/.codex/skills/repo-scout (check `codex` docs for the current location).",
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configPath: "~/.codeium/windsurf/mcp_config.json",
    format: "json",
    snippet: (c) => json({ mcpServers: { "repo-scout": { command: c.command, args: c.args } } }),
    notes: [
      "Windsurf's docs have moved to docs.devin.ai and now also describe .devin/mcp_config.json (project) and ~/.config/devin/mcp_config.json (user); ~/.codeium/windsurf/mcp_config.json is the long-standing Windsurf location. Check which your version reads (Settings > Cascade > MCP Servers > raw config opens the right file).",
      "Restart/refresh the MCP list after editing.",
      "Rules: copy integrations/windsurf/repo-scout.md to .windsurf/rules/.",
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    configPath: "~/.gemini/settings.json (user) or .gemini/settings.json (project)",
    format: "json",
    snippet: (c) =>
      `${json({ mcpServers: { "repo-scout": { command: c.command, args: c.args, timeout: 120000, trust: false } } })}\n\n# or: gemini mcp add repo-scout ${c.command} ${c.args.join(" ")}`,
    notes: [
      "Keep trust=false so Gemini CLI keeps asking before each tool call.",
      "Context: add integrations/gemini-cli/GEMINI.md content to your GEMINI.md.",
    ],
  },
  {
    id: "generic",
    name: "Generic MCP client (stdio)",
    configPath: "your client's MCP server configuration",
    format: "json",
    snippet: (c) => json({ mcpServers: { "repo-scout": { command: c.command, args: c.args } } }),
    notes: [
      "Any client that can launch a stdio MCP server works. Transport: stdio. No network port is opened.",
    ],
  },
];
export function findIntegration(id: string) {
  return INTEGRATIONS.find((i) => i.id === id || (id === "generic-mcp" && i.id === "generic"));
}
