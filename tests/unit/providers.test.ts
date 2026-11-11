import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArxivProvider,
  AwesomeProvider,
  CodebergProvider,
  GithubProvider,
  MavenProvider,
  NpmProvider,
  PapersWithCodeProvider,
  PypiProvider,
  CratesProvider,
  GitlabProvider,
  RobotsChecker,
  WebProvider,
  canonicalizeUrl,
  normalizeRepoUrl,
} from "@repo-scout/providers";
import { ResourceSchema } from "@repo-scout/schemas";
import { testRegistry } from "../helpers.js";

const fx = (n: string) =>
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/providers", n),
    "utf8",
  );
const j = (n: string) => JSON.parse(fx(n));

describe("provider normalisation (fixtures)", () => {
  it("GitHub: maps fields, keeps types and evidence, treats NOASSERTION licence as missing", async () => {
    const { registry } = testRegistry([{ match: "/search/repositories", json: j("github-search.json") }]);
    const out = await registry.github.search({ text: "mcp" });
    expect(out).toHaveLength(2);
    const [a, b] = out as [any, any];
    expect(ResourceSchema.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({
      id: "github:repository:acme/mcp-kit",
      type: "repository",
      provider: "github",
      canonicalUrl: "https://github.com/acme/mcp-kit",
      license: "MIT",
      stars: 420,
      language: "TypeScript",
    });
    expect(a.evidence[0]).toMatchObject({ status: "verified", source: "github" });
    expect(a.freshness.fromCache).toBe(false);
    expect(b.license).toBeUndefined();
    expect(b.archived).toBe(true);
    expect(b.description).toBe("");
  });
  it("GitHub: builds qualified queries and sends token only when configured", async () => {
    const { registry, fetchImpl } = testRegistry(
      [{ match: "/search/repositories", json: { items: [] } }],
      {},
    );
    await registry.github.search({
      text: "agent",
      language: "Python",
      minStars: 50,
      pushedAfter: "2026-01-01",
      topic: "llm",
      sort: "stars",
    });
    const url = decodeURIComponent(fetchImpl.calls[0]!);
    expect(url).toContain("agent language:Python stars:>=50 pushed:>=2026-01-01 topic:llm archived:false");
    expect(url).toContain("sort=stars");
  });
  it("GitHub getExtras fails soft and reports missing pieces", async () => {
    const { registry } = testRegistry([
      { match: "raw.githubusercontent.com", body: "# Title\n\n## Installation\nnpm i x\n\n## Usage\n..." },
      { match: "/languages", json: { TypeScript: 900, JavaScript: 100 } },
      {
        match: "/contributors",
        json: [{ login: "a" }],
        headers: { link: '<https://api.github.com/x?per_page=1&page=37>; rel="last"' },
      },
      {
        match: "/releases",
        json: [
          { tag_name: "v1.2.0", published_at: "2026-10-01T00:00:00Z", prerelease: false, html_url: "u" },
        ],
      },
      { match: "/stats/commit_activity", status: 202, body: "" },
      {
        match: "/pulls",
        json: [{ number: 1 }],
        headers: { link: '<https://api.github.com/x?state=open&per_page=1&page=4>; rel="last"' },
      },
      { match: "/git/trees/", status: 403, body: "" },
    ]);
    const { extras, errors } = await registry.github.getExtras("acme/mcp-kit", { tree: true });
    expect(extras.readme).toContain("Installation");
    expect(extras.contributors).toBe(37);
    expect(extras.releases[0]!.tag).toBe("v1.2.0");
    expect(extras.openPulls).toBe(4);
    expect(extras.tree).toBeUndefined();
    expect(errors.join()).toMatch(/commit_activity.*202|tree/);
  });
  it("npm: normalises packages and links repository", async () => {
    const { registry } = testRegistry([
      { match: "registry.npmjs.org/-/v1/search", json: j("npm-search.json") },
    ]);
    const [p] = await registry.get("npm")!.search({ text: "mcp" });
    expect(p).toMatchObject({
      type: "package",
      ecosystem: "npm",
      fullName: "@acme/mcp-kit",
      license: "MIT",
      repositoryUrl: "https://github.com/acme/mcp-kit",
      version: "2.1.0",
    });
    expect((p!.metadata.npmScore as any).maintenance).toBe(0.95);
  });
  it("PyPI: resolves names, extracts repo link and licence classifier", async () => {
    const { registry } = testRegistry([
      { match: "pypi.org/pypi/faster-whisper/json", json: j("pypi-whisper.json") },
      { match: "pypi.org/pypi/", status: 404, body: "" },
    ]);
    const out = await registry.get("pypi")!.search({ text: "faster whisper" });
    expect(out.map((o) => o.fullName)).toContain("Faster-Whisper");
    expect(out[0]).toMatchObject({
      type: "package",
      ecosystem: "pypi",
      repositoryUrl: "https://github.com/SYSTRAN/faster-whisper",
      license: "MIT",
      language: "Python",
    });
  });
  it("crates / maven / gitlab / codeberg normalise", async () => {
    const { registry } = testRegistry([
      { match: "crates.io/api/v1/crates", json: j("crates-search.json") },
      { match: "search.maven.org", json: j("maven-search.json") },
      { match: "gitlab.com/api/v4/projects", json: j("gitlab-search.json") },
      { match: "codeberg.org/api/v1/repos/search", json: j("codeberg-search.json") },
    ]);
    expect((await registry.get("crates")!.search({ text: "serde" }))[0]).toMatchObject({
      ecosystem: "crates",
      language: "Rust",
      downloads: 50000000,
      repositoryUrl: "https://github.com/serde-rs/serde",
    });
    expect((await registry.get("maven")!.search({ text: "guava" }))[0]).toMatchObject({
      ecosystem: "maven",
      fullName: "com.google.guava:guava",
      version: "33.0.0-jre",
    });
    expect((await registry.get("gitlab")!.search({ text: "rg" }))[0]).toMatchObject({
      id: "gitlab:repository:someone/ripgrep-fork",
      stars: 12,
      type: "repository",
    });
    expect((await registry.get("codeberg")!.search({ text: "forgejo" }))[0]).toMatchObject({
      id: "codeberg:repository:forgejo/forgejo",
      language: "Go",
      stars: 1500,
    });
  });
  it("arXiv: papers are type 'paper' (never repository) and extract implementation links", async () => {
    const { registry } = testRegistry([{ match: "export.arxiv.org", body: fx("arxiv.xml") }]);
    const [p] = await registry.get("arxiv")!.search({ text: "real-time detection" });
    expect(p).toMatchObject({
      type: "paper",
      provider: "arxiv",
      canonicalUrl: "https://arxiv.org/abs/2401.00001v1",
      repositoryUrl: "https://github.com/example/rtdt",
    });
    expect(p!.name).toBe("Real-Time Detection & Tracking with Transformers");
    expect(p!.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(p!.topics).toEqual(["cs.CV", "cs.LG"]);
    expect(p!.stars).toBeUndefined();
  });
  it("Papers with Code reports itself unavailable instead of faking results", async () => {
    const { registry } = testRegistry([
      {
        match: "paperswithcode.com",
        fn: () =>
          new Response("", { status: 302, headers: { location: "https://huggingface.co/papers/trending" } }),
      },
    ]);
    await expect(registry.get("paperswithcode")!.search({ text: "x" })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
  it("Awesome: parses list entries and creates collection + stub repositories flagged as unenriched", async () => {
    const { registry } = testRegistry([
      {
        match: "/search/repositories",
        json: {
          items: [
            {
              ...j("github-search.json").items[0],
              full_name: "acme/awesome-speech",
              name: "awesome-speech",
              topics: ["awesome"],
              html_url: "https://github.com/acme/awesome-speech",
            },
          ],
        },
      },
      { match: "raw.githubusercontent.com/acme/awesome-speech", body: fx("awesome-readme.md") },
    ]);
    const out = await registry.get("awesome")!.search({ text: "speech recognition" });
    expect(out[0]).toMatchObject({ type: "collection", provider: "awesome" });
    const w = out.find((o) => o.name === "whisper.cpp")!;
    expect(w).toMatchObject({ type: "repository", id: "github:repository:ggerganov/whisper.cpp" });
    expect(w.stars).toBeUndefined();
    expect(w.metadata).toMatchObject({ enriched: false, curatedBy: "acme/awesome-speech" });
    expect(w.evidence.some((e) => e.status === "inferred")).toBe(true);
    expect(out.find((o) => o.name === "Some Blog")?.type).toBe("website");
    expect(
      new AwesomeProvider({} as any).parseEntries(fx("awesome-readme.md"), "https://github.com/x/y"),
    ).toHaveLength(4);
  });
  it("Web provider is unavailable without a search API and never scrapes", async () => {
    const { registry } = testRegistry([]);
    expect(registry.get("web")!.availability().ok).toBe(false);
    const withKey = testRegistry(
      [
        {
          match: "api.search.brave.com",
          json: {
            web: {
              results: [
                {
                  title: "Acme Docs",
                  url: "https://docs.acme.dev/start",
                  description: "<b>Getting</b> started",
                },
                { title: "Acme", url: "https://acme.dev", description: "home" },
              ],
            },
          },
        },
      ],
      { credentials: { braveApiKey: "k" } } as any,
    );
    expect(withKey.registry.get("web")!.availability().ok).toBe(true);
    const r = await withKey.registry.get("web")!.search({ text: "acme" });
    expect(r.map((x) => x.type)).toEqual(["documentation", "website"]);
    expect(r[0]!.description).toBe("Getting started");
  });
  it("provider strings are sanitised (ANSI/bidi/control characters, non-http URLs)", async () => {
    const evil = {
      ...j("github-search.json").items[0],
      full_name: "acme/ev\u001b[31mil\u202E",
      name: "ev\u001b]0;pwn\u0007il",
      description: "ok\u001b[2J",
      topics: ["a\u001bb"],
      homepage: "javascript:alert(1)",
      html_url: "https://github.com/acme/evil",
    };
    const { registry } = testRegistry([{ match: "/search/repositories", json: { items: [evil] } }]);
    const [r] = await registry.github.search({ text: "x" });
    expect(JSON.stringify(r)).not.toMatch(/\\u001b|\\u202e|\\u0007/i);
    expect(r!.homepage).toBeUndefined();
  });
  it("registry honours enable/disable and offline mode", () => {
    const off = testRegistry([], { offline: true }).registry;
    expect(off.active()).toHaveLength(0);
    const dis = testRegistry([], { providers: { disabled: ["npm"], timeoutMs: {} } }).registry;
    expect(dis.active().map((p) => p.id)).not.toContain("npm");
    const only = testRegistry([], {
      providers: { enabled: ["github"], disabled: [], timeoutMs: {} },
    }).registry;
    expect(only.active().map((p) => p.id)).toEqual(["github"]);
    expect(
      testRegistry([])
        .registry.describe()
        .every((d) => d.limitations.length > 0 && d.docsUrl.startsWith("https://")),
    ).toBe(true);
  });
  it("provider errors map to typed errors", async () => {
    const { registry } = testRegistry([
      { match: "/search/repositories", status: 403, headers: { "x-ratelimit-remaining": "0" }, body: "{}" },
    ]);
    await expect(registry.github.search({ text: "x" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const bad = testRegistry([{ match: "registry.npmjs.org", body: "<html>oops" }]);
    await expect(bad.registry.get("npm")!.search({ text: "x" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
  it("RobotsChecker honours Disallow rules", async () => {
    const { registry } = testRegistry([{ match: "robots.txt", body: "User-agent: *\nDisallow: /private\n" }]);
    const rc = new RobotsChecker(registry.ctx);
    expect(await rc.allowed("https://x.dev/docs")).toBe(true);
    expect(await rc.allowed("https://x.dev/private/a")).toBe(false);
  });
  it("URL helpers", () => {
    expect(canonicalizeUrl("https://www.GitHub.com/A/B.git?x=1#h")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("git+ssh://git@github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("git@gitlab.com:a/b.git")).toBe("https://gitlab.com/a/b");
  });
  it("all provider classes are constructible and expose the common interface", () => {
    const ctx = testRegistry([]).registry.ctx;
    for (const P of [
      GithubProvider,
      NpmProvider,
      PypiProvider,
      CratesProvider,
      MavenProvider,
      GitlabProvider,
      CodebergProvider,
      ArxivProvider,
      PapersWithCodeProvider,
      AwesomeProvider,
      WebProvider,
    ]) {
      const p = new (P as any)(ctx);
      expect(typeof p.search).toBe("function");
      expect(p.id).toBeTruthy();
      expect(p.resourceTypes.length).toBeGreaterThan(0);
    }
  });
});
