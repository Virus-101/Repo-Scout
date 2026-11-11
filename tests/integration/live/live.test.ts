// Opt-in live tests: REPO_SCOUT_LIVE=1 pnpm test:live   (set NODE_USE_ENV_PROXY=1 behind a proxy; GITHUB_TOKEN recommended)
// These hit REAL public provider APIs and are excluded from the default run. Each provider is tested independently; a
// provider that is blocked by your network or rate-limited is reported as skipped, never as passed.
import { describe, expect, it } from "vitest";
import { Engine } from "@repo-scout/discovery";
import { loadConfig, ScoutError } from "@repo-scout/core";
import { Store } from "@repo-scout/cache";

const engine = new Engine({
  config: loadConfig(process.env, { dbPath: ":memory:" }),
  store: new Store(":memory:"),
});
const reg = engine.registry;

async function live(id: string, q: string, check: (r: any[]) => void, ctx: { skip: (m?: string) => void }) {
  try {
    const r = await reg.get(id)!.search({ text: q, limit: 5 });
    check(r);
  } catch (e) {
    if (
      e instanceof ScoutError &&
      ["RATE_LIMITED", "NETWORK", "TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR"].includes(e.code)
    ) {
      console.warn(`[live] ${id} skipped: ${e.message}`);
      ctx.skip(e.message);
    } else throw e;
  }
}
describe.sequential("live provider smoke tests", () => {
  it("github", async (ctx) =>
    live(
      "github",
      "mcp server typescript",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].type).toBe("repository");
        expect(r[0].canonicalUrl).toMatch(/^https:\/\/github\.com\//);
      },
      ctx,
    ));
  it("npm", async (ctx) =>
    live(
      "npm",
      "express",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].ecosystem).toBe("npm");
      },
      ctx,
    ));
  it("pypi", async (ctx) =>
    live(
      "pypi",
      "requests",
      (r) => {
        expect(r.map((x: any) => x.name.toLowerCase())).toContain("requests");
      },
      ctx,
    ));
  it("crates", async (ctx) =>
    live(
      "crates",
      "serde",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
      },
      ctx,
    ));
  it("maven", async (ctx) =>
    live(
      "maven",
      "guava",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
      },
      ctx,
    ));
  it("gitlab", async (ctx) =>
    live(
      "gitlab",
      "ripgrep",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
      },
      ctx,
    ));
  it("codeberg", async (ctx) =>
    live(
      "codeberg",
      "forgejo",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
      },
      ctx,
    ));
  it("arxiv", async (ctx) =>
    live(
      "arxiv",
      "object detection",
      (r) => {
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].type).toBe("paper");
      },
      ctx,
    ));
  it("awesome lists (GitHub search + raw README parsing)", async (ctx) =>
    live(
      "awesome",
      "speech recognition",
      (r) => {
        expect(r.some((x: any) => x.type === "collection")).toBe(true);
      },
      ctx,
    ));
  it("github raw README fetch", async (ctx) => {
    try {
      const t = await reg.github.getReadme("sindresorhus/awesome");
      expect(t && t.length).toBeGreaterThan(500);
    } catch (e) {
      if (e instanceof ScoutError) ctx.skip(e.message);
      else throw e;
    }
  });
  it("paperswithcode (expected to be unavailable: legacy API redirects)", async (ctx) =>
    live("paperswithcode", "agent", () => {}, ctx));
  it("osv.dev querybatch", async (ctx) => {
    try {
      const { checkVulnerabilities } = await import("@repo-scout/analysis");
      const r = await checkVulnerabilities(engine.http, [
        { name: "lodash", spec: "4.17.20", ecosystem: "npm", dev: false, manifest: "p" },
      ]);
      expect(r.performed).toBe("performed");
      expect(r.vulnerabilities.length).toBeGreaterThan(0);
    } catch (e) {
      if (e instanceof ScoutError) ctx.skip(e.message);
      else throw e;
    }
  });
  it("end-to-end find", async (ctx) => {
    try {
      const r = await engine.discover("markdown parser in rust", { deep: 0 });
      expect(r.counts.candidatesDiscovered).toBeGreaterThan(5);
      expect(r.results[0]!.overall).toBeGreaterThan(0);
    } catch (e) {
      if (e instanceof ScoutError) ctx.skip(e.message);
      else throw e;
    }
  });
});
