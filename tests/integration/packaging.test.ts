import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "@repo-scout/mcp";
import { INTEGRATIONS } from "../../packages/cli/src/integrations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("agent skill packaging", () => {
  const skill = read("skills/repo-scout/SKILL.md");
  const fm = skill.match(/^---\n([\s\S]*?)\n---\n/)!;
  it("has valid portable frontmatter (name matches directory, description present)", () => {
    expect(fm).toBeTruthy();
    const keys = fm[1]!
      .split("\n")
      .map((l) => l.match(/^([a-z-]+):/)?.[1])
      .filter(Boolean);
    expect(keys).toEqual(expect.arrayContaining(["name", "description"]));
    for (const k of keys)
      expect(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]).toContain(k);
    expect(fm[1]).toMatch(/^name: repo-scout$/m);
    expect(fm[1]!.match(/^description: (.*)$/m)![1]!.length).toBeLessThan(1024);
  });
  it("references only tools that exist, and mentions every tool", () => {
    const mentioned = new Set(skill.match(/scout_[a-z_]+/g));
    const real = new Set(TOOLS.map((t) => t.name));
    for (const m of mentioned) expect(real.has(m), m).toBe(true);
    for (const t of TOOLS) expect(mentioned.has(t.name), `${t.name} missing from skill`).toBe(true);
  });
  it("covers the required guidance topics", () => {
    for (const re of [
      /When to use/i,
      /Approval boundaries/i,
      /untrusted/i,
      /Compos/i,
      /confidence/i,
      /rebuild|reinvent/i,
      /implementation plan/i,
      /alternatives/i,
      /evidence|verified/i,
    ])
      expect(skill).toMatch(re);
  });
  it("does not duplicate the discovery engine (no code blocks implementing logic)", () => {
    expect(skill.match(/```/g)?.length ?? 0).toBe(0);
  });
});

describe("integration files", () => {
  it("every supported agent has config artefacts that parse", () => {
    for (const f of [
      "integrations/claude-code/mcp.json",
      "integrations/cursor/mcp.json",
      "integrations/windsurf/mcp_config.json",
      "integrations/gemini-cli/settings.json",
    ]) {
      const j = JSON.parse(read(f));
      expect(j.mcpServers["repo-scout"].args).toEqual(expect.arrayContaining(["repo-scout", "mcp"]));
    }
    expect(read("integrations/codex/config.toml")).toMatch(
      /\[mcp_servers\.repo-scout\][\s\S]*command = "npx"/,
    );
    expect(read("integrations/cursor/repo-scout.mdc")).toMatch(
      /^---\ndescription: [\s\S]*alwaysApply: false\n---/,
    );
    for (const f of [
      "integrations/codex/AGENTS.md",
      "integrations/gemini-cli/GEMINI.md",
      "integrations/windsurf/repo-scout.md",
      "integrations/generic-mcp/README.md",
      "integrations/claude-code/README.md",
    ])
      expect(read(f).length).toBeGreaterThan(100);
  });
  it("CLI integrate snippets cover claude-code, cursor, codex, windsurf, gemini-cli, generic", () => {
    expect(INTEGRATIONS.map((i) => i.id).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "generic",
      "windsurf",
    ]);
    for (const i of INTEGRATIONS)
      expect(i.snippet({ command: "npx", args: ["-y", "repo-scout", "mcp"] })).toContain("repo-scout");
  });
  it("publishable package metadata is coherent", () => {
    const pkg = JSON.parse(read("packages/cli/package.json"));
    expect(pkg.name).toBe("repo-scout");
    expect(pkg.bin).toMatchObject({ "repo-scout": "dist/cli.js", "repo-scout-mcp": "dist/mcp.js" });
    expect(pkg.engines.node).toBe(">=22.13");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "commander", "zod"]);
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "skills", "integrations"]));
  });
  it("repository hygiene: no committed secrets patterns, .env ignored", () => {
    expect(read(".gitignore")).toMatch(/^\.env$/m);
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) =>
          e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "scratch"
            ? []
            : e.isDirectory()
              ? walk(path.join(d, e.name))
              : [path.join(d, e.name)],
        );
    for (const f of walk(root).filter((f) => /\.(ts|json|md|mjs|yml|toml|mdc)$/.test(f)))
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(
        /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{40,}/,
      );
  });
});
