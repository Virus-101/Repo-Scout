// Clean-environment install test: packs the CLI package, installs the tarball into an empty temp project with an empty HOME,
// then exercises the installed binaries (version, doctor --offline, understand, and a real stdio MCP handshake).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const step = (m) => console.log(`\n== ${m}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "rs-install-"));
const home = path.join(work, "home");
fs.mkdirSync(home);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  REPO_SCOUT_HOME: path.join(home, "data"),
  REPO_SCOUT_OFFLINE: "1",
  NO_COLOR: "1",
};
delete env.GITHUB_TOKEN;
delete env.GH_TOKEN;

step("build");
sh("node", [path.join(root, "scripts/build.mjs")], { cwd: root });
step("pack");
const packDir = path.join(work, "pack");
fs.mkdirSync(packDir);
sh("pnpm", ["pack", "--pack-destination", packDir], { cwd: path.join(root, "packages/cli") });
const tgz = fs.readdirSync(packDir).find((f) => f.endsWith(".tgz"));
console.log("tarball:", tgz);
const listing = sh("tar", ["-tzf", path.join(packDir, tgz)]).split("\n");
for (const need of [
  "package/dist/cli.js",
  "package/dist/mcp.js",
  "package/skills/repo-scout/SKILL.md",
  "package/integrations/cursor/mcp.json",
  "package/LICENSE",
  "package/README.md",
])
  if (!listing.includes(need)) throw new Error(`tarball is missing ${need}`);
if (listing.some((f) => /\.(sqlite|env)$|node_modules|\.test\./.test(f)))
  throw new Error("tarball contains files that must not ship");
step("install into empty project");
const proj = path.join(work, "proj");
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, "package.json"), '{"name":"clean-room","private":true}');
sh("npm", ["install", "--no-audit", "--no-fund", path.join(packDir, tgz)], { cwd: proj, env });
const bin = (n) => path.join(proj, "node_modules", ".bin", process.platform === "win32" ? `${n}.cmd` : n);
const run = (n, args) => {
  const r = spawnSync(bin(n), args, {
    cwd: proj,
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return r;
};

step("repo-scout --version");
let r = run("repo-scout", ["--version"]);
if (r.status !== 0) throw new Error(r.stderr);
console.log(r.stdout.trim());
step("repo-scout doctor (offline)");
r = run("repo-scout", ["doctor"]);
console.log(r.stdout);
if (r.status !== 0) throw new Error("doctor failed: " + r.stderr);
step("repo-scout understand");
r = run("repo-scout", ["understand", "self-hosted", "AI", "meeting", "assistant"]);
if (r.status !== 0 || !/Components/.test(r.stdout)) throw new Error("understand failed: " + r.stderr);
console.log(r.stdout.split("\n").slice(0, 4).join("\n"));
step("repo-scout cache status --json");
r = run("repo-scout", ["--json", "cache", "status"]);
const j = JSON.parse(r.stdout);
if (!j.ok || !fs.existsSync(j.data.dbPath)) throw new Error("db not created");
console.log("db:", j.data.dbPath);
step("skill + integrate");
r = run("repo-scout", ["skill"]);
if (!/skills[\\/]repo-scout/.test(r.stdout)) throw new Error("skill path missing");
r = run("repo-scout", ["integrate", "codex"]);
if (!/mcp_servers/.test(r.stdout)) throw new Error("integrate failed");

step("MCP stdio handshake via the official SDK client");
const sdk = path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm");
const { Client } = await import(path.join(sdk, "client/index.js"));
const { StdioClientTransport } = await import(path.join(sdk, "client/stdio.js"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(proj, "node_modules/repo-scout/dist/mcp.js")],
  env: { ...env, PATH: process.env.PATH },
  stderr: "pipe",
});
const client = new Client({ name: "verify-install", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);
if (tools.length < 18) throw new Error("expected >= 18 tools");
const res = await client.callTool({
  name: "scout_understand_task",
  arguments: { task: "real-time object detection in python" },
});
if (res.isError || !res.structuredContent?.ok) throw new Error("tool call failed");
console.log("scout_understand_task ->", res.structuredContent.summary);
await client.close();
console.log("\nOK: clean install verified on", process.platform, process.arch, "node", process.version);
fs.rmSync(work, { recursive: true, force: true });
