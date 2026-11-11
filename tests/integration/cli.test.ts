import { RateLimiter } from "@repo-scout/core";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram } from "../../packages/cli/src/program.js";
import { Engine } from "@repo-scout/discovery";
import { Store } from "@repo-scout/cache";
import { ghRepo, mockFetch, testConfig, type Route } from "../helpers.js";

const routes: Route[] = [
  {
    match: "api.github.com/search/repositories",
    json: { items: [ghRepo("acme/mcp-kit"), ghRepo("foo/agent-lib", { language: "Python" })] },
  },
  { match: "registry.npmjs.org/-/v1/search", json: { objects: [] } },
  { match: "pypi.org", status: 404, body: "" },
  { match: "crates.io", json: { crates: [] } },
  { match: "search.maven.org", json: { response: { docs: [] } } },
  { match: "arxiv.org", body: "<feed/>" },
  { match: "paperswithcode", status: 302, body: "" },
  { match: "gitlab.com", json: [] },
  { match: "codeberg.org", json: { data: [] } },
  { match: "raw.githubusercontent.com", status: 404, body: "" },
  { match: "api.github.com/repos/acme/mcp-kit", json: ghRepo("acme/mcp-kit") },
  { match: "api.github.com/repos", status: 404, body: "{}" },
  {
    match: "api.github.com/rate_limit",
    json: { resources: { core: { remaining: 59, limit: 60 }, search: { remaining: 9, limit: 10 } } },
  },
  { match: "osv.dev", status: 500, body: "" },
];
function harness(over: Record<string, unknown> = {}) {
  const out: string[] = [],
    err: string[] = [];
  const fetchImpl = mockFetch(routes);
  const { main } = buildProgram({
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: false,
      env: { REPO_SCOUT_CONFIG: "/nonexistent.json" },
    },
    createEngine: () =>
      new Engine({
        config: testConfig(over),
        fetchImpl,
        store: new Store(":memory:"),
        limiter: new RateLimiter(100000),
      }),
  });
  return {
    run: async (...a: string[]) => {
      const code = await main(a);
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
    out,
    err,
    fetchImpl,
  };
}

describe("CLI", () => {
  it("search: human output, exit 0", async () => {
    const r = await harness().run("search", "mcp", "server", "-p", "github", "-n", "3");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/acme\/mcp-kit/);
    expect(r.out).toMatch(/confidence/);
    expect(r.out).toMatch(/Candidates discovered/);
  });
  it("--json emits the shared envelope", async () => {
    const r = await harness().run("--json", "search", "mcp", "-p", "github");
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, tool: "scout_search" });
    expect(j.data.results[0]).toHaveProperty("scores");
  });
  it("--markdown emits a report and -o writes a file (refuses overwrite without --force)", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-cli-")), "r.md");
    const h = harness();
    expect((await h.run("--markdown", "-o", f, "search", "mcp", "-p", "github")).code).toBe(0);
    const txt = fs.readFileSync(f, "utf8");
    expect(txt).toMatch(/^# Search: mcp/);
    expect(txt).toMatch(/Score definitions/);
    const again = await harness().run("--markdown", "-o", f, "search", "mcp", "-p", "github");
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/--force/);
    expect(
      (await harness().run("--markdown", "-o", f, "--force", "search", "mcp", "-p", "github")).code,
    ).toBe(0);
  });
  it("sorting, pagination and limits", async () => {
    const h = harness();
    const a = JSON.parse((await h.run("--json", "search", "mcp", "-p", "github", "-n", "1")).out).data;
    const b = JSON.parse(
      (await harness().run("--json", "search", "mcp", "-p", "github", "-n", "1", "--offset", "1")).out,
    ).data;
    expect(a.results).toHaveLength(1);
    expect(a.results[0].name).not.toBe(b.results[0].name);
    const s = JSON.parse(
      (await harness().run("--json", "search", "mcp", "-p", "github", "--sort", "stars")).out,
    ).data.results;
    expect(s[0].stars).toBeGreaterThanOrEqual(s[1].stars);
  });
  it("understand works offline and prints assumptions", async () => {
    const h = harness({ offline: true });
    const r = await h.run("understand", "self-hosted", "meeting", "assistant");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/assumed/);
    expect(h.fetchImpl.calls).toHaveLength(0);
  });
  it("actionable errors and distinct exit codes", async () => {
    expect((await harness().run("analyze", "no/such")).code).toBe(3);
    const bad = await harness().run("analyze", "not a repo");
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/error \[INVALID_INPUT\]/);
    expect((await harness().run("bogus-command")).code).toBe(2);
    const off = await harness({ offline: true }).run("find", "something to build");
    expect(off.code).toBe(4);
    expect(off.err).toMatch(/hint:/);
    const j = JSON.parse((await harness().run("--json", "analyze", "no/such")).out);
    expect(j).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  it("cache status/clear (confirmation required)", async () => {
    const h = harness();
    expect((await h.run("cache", "status")).out).toMatch(/resources/);
    const no = await h.run("cache", "clear", "--scope", "all");
    expect(no.code).toBe(2);
    expect(no.err).toMatch(/confirm/);
    expect((await h.run("cache", "clear", "--scope", "expired", "-y")).code).toBe(0);
  });
  it("providers lists every provider", async () => {
    const r = await harness().run("--json", "providers");
    const p = JSON.parse(r.out).data.providers.map((x: any) => x.id);
    expect(p).toEqual(
      expect.arrayContaining([
        "github",
        "npm",
        "pypi",
        "crates",
        "maven",
        "gitlab",
        "codeberg",
        "arxiv",
        "paperswithcode",
        "awesome",
        "web",
      ]),
    );
  });
  it("doctor reports checks and passes on a healthy setup", async () => {
    const r = await harness().run("doctor");
    expect(r.out).toMatch(/node/);
    expect(r.out).toMatch(/database/);
    expect(r.out).toMatch(/schema v1/);
    expect(r.code).toBe(0);
    const j = JSON.parse((await harness().run("--json", "doctor")).out);
    expect(j.ok).toBe(true);
    expect(j.checks.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["node", "config", "database", "network (GitHub)", "providers"]),
    );
    expect(JSON.stringify(j)).not.toMatch(/ghp_/);
  });
  it("integrate prints per-agent formats", async () => {
    const all = (await harness().run("integrate")).out;
    expect(all).toMatch(/claude mcp add --transport stdio repo-scout/);
    expect(all).toMatch(/\[mcp_servers\.repo-scout\]/);
    expect(all).toMatch(/\.cursor\/mcp\.json/);
    expect(all).toMatch(/settings\.json/);
    expect(all).toMatch(/Windsurf/);
    expect((await harness().run("integrate", "nope")).code).toBe(2);
    expect(JSON.parse((await harness().run("--json", "integrate", "cursor")).out)[0].snippet).toContain(
      '"mcpServers"',
    );
  });
  it("deps --file parses a local manifest without executing it", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-mf-")), "package.json");
    fs.writeFileSync(
      f,
      JSON.stringify({
        dependencies: { express: "^4.18.0" },
        scripts: { postinstall: "echo pwned > /tmp/should-not-exist-rs" },
      }),
    );
    const r = await harness().run("--json", "deps", "--file", f, "--no-vuln");
    expect(JSON.parse(r.out).data.dependencies[0].name).toBe("express");
    expect(fs.existsSync("/tmp/should-not-exist-rs")).toBe(false);
  });
  it("version and help", async () => {
    const h = harness();
    expect((await h.run("--version")).code).toBe(0);
    const help = await h.run("--help");
    expect(help.out + help.err).toMatch(/Find the building blocks/);
  });
});
