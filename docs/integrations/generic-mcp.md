# Generic MCP client (stdio)

- Transport: **stdio** only. No port is opened; no remote access.
- Command: `npx -y repo-scout mcp` or `repo-scout-mcp`.
- stdout carries only protocol frames; diagnostics go to stderr (secrets redacted).
- Tools: 19 (`scout_*`), all returning one envelope in `structuredContent`; see [../mcp-tools.md](../mcp-tools.md).

```json
{
  "mcpServers": {
    "repo-scout": {
      "command": "npx",
      "args": ["-y", "repo-scout", "mcp"],
      "env": { "REPO_SCOUT_HOME": "/path/to/shared/data" }
    }
  }
}
```

Programmatic client (official SDK):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "demo", version: "1" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "repo-scout", "mcp"] }));
const r = await client.callTool({
  name: "scout_understand_task",
  arguments: { task: "real-time object detection" },
});
```
