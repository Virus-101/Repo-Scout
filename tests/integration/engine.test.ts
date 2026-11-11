import { describe, expect, it } from "vitest";
import { ghRepo, testEngine, type Route } from "../helpers.js";

const items = (names: string[], over: Record<string, unknown> = {}) =>
  names.map((n) =>
    ghRepo(n, {
      description: `${n} speech to text transcription engine`,
      topics: ["speech", "asr"],
      ...over,
    }),
  );
const base = (extra: Route[] = []): Route[] => [
  {
    match: "api.github.com/search/repositories",
    json: { items: items(["acme/whisper-lite", "foo/stt-core", "bar/old-asr"], { language: "Python" }) },
  },
  {
    match: "registry.npmjs.org/-/v1/search",
    json: {
      objects: [
        {
          package: {
            name: "whisper-node",
            version: "1.0.0",
            description: "speech to text transcription for node",
            keywords: ["asr"],
            date: new Date().toISOString(),
            links: {
              npm: "https://www.npmjs.com/package/whisper-node",
              repository: "git+https://github.com/acme/whisper-lite.git",
            },
            license: "MIT",
          },
          score: { detail: { popularity: 0.3, maintenance: 0.9, quality: 0.8 } },
        },
      ],
    },
  },
  { match: "pypi.org/pypi/", status: 404, body: "" },
  { match: "crates.io", json: { crates: [] } },
  { match: "search.maven.org", json: { response: { docs: [] } } },
  { match: "export.arxiv.org", body: "<feed></feed>" },
  { match: "paperswithcode.com", status: 302, body: "" },
  { match: "gitlab.com", json: [] },
  { match: "codeberg.org", json: { data: [] } },
  { match: "raw.githubusercontent.com", status: 404, body: "" },
  { match: "api.github.com/repos", status: 403, body: "{}" },
  { match: "osv.dev", status: 500, body: "" },
  ...extra,
];

describe("Engine.discover (mocked providers)", () => {
  it("runs the full pipeline: understand → search → dedupe → filter → score → report counts", async () => {
    const { engine } = testEngine(base());
    const r = await engine.discover("speech to text transcription engine in python", { deep: 0 });
    expect(r.counts.candidatesDiscovered).toBeGreaterThanOrEqual(3);
    expect(r.counts.shortlisted).toBeGreaterThan(0);
    expect(r.counts.shortlisted).toBeLessThanOrEqual(15);
    expect(r.results[0]!.overall).toBeGreaterThanOrEqual(r.results[r.results.length - 1]!.overall);
    expect(r.providersUsed).toEqual(expect.arrayContaining(["github", "npm"]));
    expect(r.retrievalMode).toBe("lexical+metadata");
    // dedupe: the same repo must not appear twice
    const ids = r.results.map((x) => x.resource.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.results.every((e) => e.alternatives.length >= 0 && e.verified.length > 0)).toBe(true);
  });
  it("tolerates provider failures: warns, keeps going, records provider health", async () => {
    const { engine } = testEngine(
      base([{ match: "registry.npmjs.org/-/v1/search", status: 500, body: "boom" }]).sort((a) =>
        String(a.match).includes("npmjs") ? -1 : 1,
      ),
    );
    const r = await engine.discover("speech to text transcription engine", { deep: 0 });
    expect(r.warnings.join()).toMatch(/provider npm failed/);
    expect(r.results.length).toBeGreaterThan(0);
    expect(engine.store.providerStats().find((p) => p.id === "npm")!.failures).toBeGreaterThan(0);
  });
  it("throws a typed error when every provider fails", async () => {
    const { engine } = testEngine([{ match: "", status: 500, body: "x" }]);
    await expect(engine.discover("speech to text engine", { deep: 0 })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
  it("circuit-breaks a provider that fails hard instead of retrying every query", async () => {
    const { engine, fetchImpl } = testEngine(
      base([{ match: "codeberg.org", status: 429, body: "" }]).sort((a) =>
        String(a.match).includes("codeberg") ? -1 : 1,
      ),
    );
    await engine.discover("speech to text transcription engine", {
      deep: 0,
      providers: ["github", "codeberg"],
    });
    expect(fetchImpl.calls.filter((c) => c.includes("codeberg.org")).length).toBeLessThanOrEqual(4); // in-flight at failure time (concurrency 4); the other ~10 queries are skipped
  });
  it("serves repeated searches from the SQLite cache (no extra network calls)", async () => {
    const { engine, fetchImpl } = testEngine(base());
    await engine.search("speech to text", { providers: ["github", "npm"] });
    const n = fetchImpl.calls.length;
    expect(n).toBeGreaterThan(0);
    const before = [...fetchImpl.calls];
    const again = await engine.search("speech to text", { providers: ["github", "npm"] });
    expect(fetchImpl.calls.slice(n), "new calls").toEqual([]);
    void before;
    expect(again.evaluations[0]!.resource.freshness.fromCache).toBe(true);
    await engine.search("speech to text", { providers: ["github", "npm"], noCache: true });
    expect(fetchImpl.calls.length).toBeGreaterThan(n);
    expect(engine.cacheStatus().searchEntries).toBeGreaterThan(0);
  });
  it("serves stale cache when a provider later fails", async () => {
    let t = 0;
    const now = () => t;
    const routes = base();
    const { engine } = testEngine(routes, { searchTtlSeconds: 1 }, now);
    await engine.search("speech to text", { providers: ["github"] });
    t += 10_000;
    routes.unshift({ match: "api.github.com/search", status: 500, body: "" });
    const r = await engine.search("speech to text", { providers: ["github"] });
    expect(r.evaluations.length).toBeGreaterThan(0);
    expect(r.evaluations[0]!.resource.freshness.stale).toBe(true);
  });
  it("search honours kinds/provider filters and offline mode", async () => {
    const { engine } = testEngine(base());
    const pk = await engine.search("whisper", { kinds: ["package"], providers: ["npm"] });
    expect(pk.evaluations.every((e) => e.resource.type === "package")).toBe(true);
    const off = testEngine(base(), { offline: true }).engine;
    await expect(off.discover("anything at all", {})).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("validates task input", () => {
    const { engine } = testEngine([]);
    expect(() => engine.understand("")).toThrow(/at least a few words/);
    expect(() => engine.understand("x".repeat(9000))).toThrow(/too long/);
  });
});

describe("Engine analysis (Level 3)", () => {
  const repoRoutes: Route[] = [
    { match: "api.github.com/repos/acme/whisper-lite/readme", status: 404, body: "" },
    {
      match: "raw.githubusercontent.com/acme/whisper-lite/HEAD/README.md",
      body: "# whisper-lite\n## Install\npip install\n## Usage\nexample api",
    },
    {
      match: "raw.githubusercontent.com/acme/whisper-lite/HEAD/requirements.txt",
      body: "numpy==1.26.0\nrequests>=2.0\n",
    },
    { match: "raw.githubusercontent.com", status: 404, body: "" },
    {
      match: "api.github.com/repos/acme/whisper-lite/git/trees",
      json: {
        truncated: false,
        tree: [
          "src",
          "tests",
          "docs",
          ".github/workflows/ci.yml",
          "requirements.txt",
          "SECURITY.md",
          "uv.lock",
        ].map((p) => ({ path: p, type: p.includes(".") ? "blob" : "tree" })),
      },
    },
    { match: "api.github.com/repos/acme/whisper-lite/languages", json: { Python: 100 } },
    { match: "api.github.com/repos/acme/whisper-lite/contributors", json: [{}, {}] },
    {
      match: "api.github.com/repos/acme/whisper-lite/releases",
      json: [{ tag_name: "v0.3.0", published_at: new Date().toISOString(), html_url: "u" }],
    },
    {
      match: "api.github.com/repos/acme/whisper-lite/stats",
      json: Array.from({ length: 52 }, () => ({ total: 4 })),
    },
    { match: "api.github.com/repos/acme/whisper-lite/pulls", json: [{}] },
    {
      match: "api.github.com/repos/acme/whisper-lite",
      json: ghRepo("acme/whisper-lite", { language: "Python", license: { spdx_id: "Apache-2.0" } }),
    },
    { match: "osv.dev/v1/querybatch", json: { results: [{ vulns: [{ id: "GHSA-aaaa" }] }, {}] } },
    { match: "osv.dev/v1/vulns/", json: { summary: "numpy bug", aliases: ["CVE-1"] } },
  ];
  it("analyze returns a Level-3 evaluation with evidence, caches it, and flags OSV findings", async () => {
    const { engine, fetchImpl } = testEngine(repoRoutes);
    const e = await engine.analyze("acme/whisper-lite", "speech to text in python");
    expect(e.level).toBe("3-deep");
    expect(e.inspection!.security!.vulnerabilityCheck).toMatch(/performed|partial/);
    expect(e.inspection!.security!.vulnerabilities).toHaveLength(1);
    expect(e.scores.quality!.confidence).toBeGreaterThan(0.5);
    expect(e.resource.latestRelease?.tag).toBe("v0.3.0");
    expect(e.inspection!.structure!.hasTests).toBe(true);
    expect(e.verified.some((v) => v.startsWith("security/known vulnerabilities"))).toBe(true);
    const n = fetchImpl.calls.length;
    await engine.analyze("acme/whisper-lite", "speech to text in python");
    expect(fetchImpl.calls.length).toBe(n);
  });
  it("compare ranks repositories and analyses the licence set", async () => {
    const other = ghRepo("zed/stt", {
      language: "Rust",
      license: { spdx_id: "GPL-3.0" },
      description: "stt",
    });
    const { engine } = testEngine([
      { match: /api\.github\.com\/repos\/zed\/stt$/, json: other },
      ...repoRoutes,
    ]);
    const c = await engine.compare(["acme/whisper-lite", "zed/stt"], "speech to text, no gpl");
    expect(c.ranking[0]!.repository).toBe("acme/whisper-lite");
    expect(c.licenseSet.issues.length).toBeGreaterThanOrEqual(0);
    expect(Object.keys(c.winnersByDimension)).toContain("overall");
    await expect(engine.compare(["only/one"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("checkLicense / checkSecurity / inspectDependencies / manifest text", async () => {
    const { engine } = testEngine(repoRoutes);
    const l = await engine.checkLicense("acme/whisper-lite", undefined, "Proprietary");
    expect(l.info.category).toBe("permissive");
    expect(l.caveat).toMatch(/Not legal advice/);
    const s = await engine.checkSecurity("acme/whisper-lite");
    expect(s.disclaimer).toMatch(/not a security audit/i);
    const d = await engine.inspectDependencies("acme/whisper-lite");
    expect(d.dependencies.map((x) => x.name)).toEqual(["numpy", "requests"]);
    const m = await engine.inspectManifestText(
      "package.json",
      JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
    );
    expect(m.dependencies).toHaveLength(1);
  });
  it("missing repository -> NOT_FOUND", async () => {
    const { engine } = testEngine([{ match: "api.github.com/repos/no/such", status: 404, body: "{}" }]);
    await expect(engine.getRepository("no/such")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(engine.getRepository("bad ref!")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("offline mode serves cached repositories and refuses uncached ones", async () => {
    const { engine } = testEngine(repoRoutes);
    await engine.getRepository("acme/whisper-lite");
    (engine.config as any).offline = true;
    expect((await engine.getRepository("acme/whisper-lite")).freshness.fromCache).toBe(true);
    await expect(engine.getRepository("other/repo")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Engine.compose / plan end-to-end (mocked)", () => {
  it("composes multi-repo solutions with per-component candidates and generates a gated plan", async () => {
    const byQuery = (url: string) => {
      const q = decodeURIComponent(url.split("q=")[1] ?? "").toLowerCase();
      const names = /whisper|speech|asr/.test(q)
        ? ["acme/whisper-lite", "foo/stt-core"]
        : /diariz|speaker|pyannote/.test(q)
          ? ["spk/diarize-py"]
          : /llm|ollama|inference/.test(q)
            ? ["llm/serve-py", "rs/llm-rs"]
            : /summar/.test(q)
              ? ["sum/meeting-summarizer"]
              : /audio|record|loopback/.test(q)
                ? ["aud/capture-py"]
                : [];
      return new Response(
        JSON.stringify({
          items: names.map((n) =>
            ghRepo(n, {
              language: n.endsWith("rs") ? "Rust" : "Python",
              description: `${n} ${q}`,
              topics: q.split(/\s+/),
            }),
          ),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const { engine } = testEngine(
      base([{ match: "api.github.com/search/repositories", fn: byQuery }]).sort((a) => (a.fn ? -1 : 1)),
    );
    const r = await engine.compose(
      "self-hosted meeting assistant: record audio, speech to text, speaker diarization, summarize with an llm",
      { deepPerComponent: 0, maxSolutions: 3 },
    );
    expect(r.compositions.length).toBeGreaterThan(0);
    const c = r.compositions[0]!;
    expect(c.components.map((x) => x.componentId)).toEqual(
      expect.arrayContaining(["speech-to-text", "llm-integration"]),
    );
    expect(r.counts.recommendedCombinations).toBe(r.compositions.length);
    expect(r.counts.candidatesDiscovered).toBeGreaterThan(3);
    expect(c.missingComponents.length).toBeGreaterThanOrEqual(0);
    expect(c.architectureOverview).toMatch(/→/);
    const plan = await engine.plan(r.spec, { composition: c });
    expect(plan.plan.approvalGates).toHaveLength(5);
    expect(plan.plan.reuse.length).toBe(c.components.length);
  });
});
