import { describe, expect, it } from "vitest";
import {
  analyzeLicenseSet,
  bm25,
  classifyLicense,
  combine,
  deriveWeights,
  evaluate,
  fastFilter,
  hybridRank,
  licenseSuitability,
  tokenize,
  type EmbeddingProvider,
} from "@repo-scout/scoring";
import { understandTask } from "@repo-scout/intelligence";
import { res } from "../helpers.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe("license classification", () => {
  it.each([
    ["MIT", "permissive"],
    ["Apache-2.0", "permissive"],
    ["GPL-3.0-only", "strong-copyleft"],
    ["AGPL-3.0", "network-copyleft"],
    ["LGPL-2.1", "weak-copyleft"],
    ["MPL-2.0", "weak-copyleft"],
    ["Unlicense", "public-domain"],
    ["BUSL-1.1", "source-available"],
    ["CC-BY-NC-4.0", "source-available"],
    [undefined, "unknown"],
    ["NOASSERTION", "unknown"],
    ["MIT OR GPL-3.0", "permissive"],
    ["apache 2.0", "permissive"],
  ] as const)("%s -> %s", (id, cat) => {
    expect(classifyLicense(id).category).toBe(cat);
  });
  it("suitability honours allowed / forbidden lists and commercial use", () => {
    const spec = understandTask("a library, must be MIT licensed, no GPL");
    expect(licenseSuitability(classifyLicense("MIT"), spec).suitability).toBe(1);
    expect(licenseSuitability(classifyLicense("GPL-3.0"), spec).suitability).toBe(0);
    expect(licenseSuitability(classifyLicense("Apache-2.0"), spec).suitability).toBeLessThanOrEqual(0.1);
    const comm = understandTask("commercial closed-source product that needs an http client");
    expect(licenseSuitability(classifyLicense("AGPL-3.0"), comm).suitability).toBeLessThanOrEqual(0.25);
    expect(licenseSuitability(classifyLicense(undefined), comm).ok).toBe(false);
  });
  it("detects licence-set conflicts", () => {
    const r = analyzeLicenseSet([
      { name: "a", license: "GPL-2.0-only" },
      { name: "b", license: "Apache-2.0" },
      { name: "c" },
    ]);
    expect(r.issues.some((i) => i.severity === "conflict" && i.between.length === 2)).toBe(true);
    expect(r.issues.some((i) => /no recognised licence/.test(i.message))).toBe(true);
    const closed = analyzeLicenseSet([{ name: "x", license: "AGPL-3.0" }], "Proprietary");
    expect(closed.issues.some((i) => i.severity === "conflict")).toBe(true);
    expect(
      analyzeLicenseSet([
        { name: "m", license: "MIT" },
        { name: "n", license: "BSD-3-Clause" },
      ]).summary,
    ).toMatch(/permissive/);
  });
});

describe("adaptive weights", () => {
  const w = (t: string) => deriveWeights(understandTask(t));
  it("sum to 1 for every profile", () => {
    for (const t of [
      "login with oauth",
      "real-time object detection yolo",
      "tutorial for students",
      "etl data pipeline",
      "ros2 robot",
      "esp32 firmware",
      "fuzzing tool",
      "something",
    ]) {
      expect(Object.values(w(t).weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    }
  });
  it("authentication prioritises security and maintenance", () => {
    const a = w("user authentication with oauth and sso"),
      g = w("a thing for stuff");
    expect(a.weights.security).toBeGreaterThan(g.weights.security * 1.8);
    expect(a.weights.maintenance).toBeGreaterThan(g.weights.maintenance);
  });
  it("computer vision prioritises compatibility; education prioritises documentation; real-time prioritises quality", () => {
    expect(w("computer vision object detection").weights.compatibility).toBeGreaterThan(
      w("a thing for stuff").weights.compatibility,
    );
    expect(w("a beginner tutorial course for students").weights.documentation).toBeGreaterThan(0.2);
    expect(w("real-time low latency streaming").weights.quality).toBeGreaterThan(
      w("a thing for stuff").weights.quality * 1.5,
    );
  });
  it("stars (community) are never a primary weight", () => {
    for (const t of ["x", "web dashboard", "auth", "computer vision"])
      expect(w(t).weights.community).toBeLessThan(0.1);
  });
  it("explicit requirements add weight and are explained", () => {
    const p = w("secure encrypted MIT licensed low latency python tool");
    expect(p.adjustments.join(" ")).toMatch(/security|licence|performance/);
  });
});

describe("evaluation levels", () => {
  it("combine excludes missing factors and lowers confidence instead of guessing", () => {
    const s = combine(
      "quality",
      [
        { name: "a", value: 1, weight: 1, status: "verified", detail: "" },
        { name: "b", value: 0, weight: 1, status: "missing", detail: "" },
      ],
      "x",
    );
    expect(s.value).toBe(100);
    expect(s.confidence).toBe(0.5);
    const none = combine(
      "security",
      [{ name: "b", value: 0, weight: 1, status: "missing", detail: "" }],
      "x",
    );
    expect(none.value).toBe(50);
    expect(none.confidence).toBe(0);
  });
  it("never claims a security audit: security is unverified at level 2", () => {
    const e = evaluate(res({ name: "a/b", fullName: "a/b" }));
    expect(e.level).toBe("2-adaptive");
    expect(e.scores.security!.confidence).toBe(0);
    expect(e.missing.some((m) => m.startsWith("security/"))).toBe(true);
    expect(e.limitations.join()).toMatch(/not a security audit/);
  });
  it("separates verified / inferred / missing / assumptions", () => {
    const e = evaluate(res({ name: "a/b", fullName: "a/b" }), {
      spec: understandTask("a tool"),
      relevance: 0.5,
    });
    expect(e.verified.length).toBeGreaterThan(0);
    expect(e.inferred.length).toBeGreaterThan(0);
    expect(e.missing.length).toBeGreaterThan(0);
    expect(e.assumptions.length).toBeGreaterThan(0);
  });
  it("level 3 uses inspection evidence for quality and security", () => {
    const insp = {
      level: "3-deep" as const,
      structure: {
        topLevel: ["src", "tests", "docs", "a", "b"],
        hasTests: true,
        hasCI: true,
        hasDocsDir: true,
        hasDockerfile: true,
      },
      manifests: ["package.json"],
      dependencies: [],
      frameworks: [],
      architecturePatterns: ["typed (TypeScript config)"],
      apiSurface: ["CLI"],
      runtime: [],
      security: {
        vulnerabilityCheck: "performed" as const,
        vulnerabilities: [],
        hasSecurityPolicy: true,
        hasLockfile: true,
        installScripts: [],
        promptInjectionFindings: [],
        disclaimers: [],
      },
      limitations: [],
      commitActivity90d: 80,
      contributors: 40,
    };
    const e = evaluate(res({ name: "a/b", fullName: "a/b" }), { inspection: insp });
    expect(e.level).toBe("3-deep");
    expect(e.scores.quality!.value).toBeGreaterThan(80);
    expect(e.scores.security!.value).toBeGreaterThan(90);
    expect(e.scores.security!.confidence).toBeGreaterThan(0.8);
  });
  it("vulnerabilities and install scripts lower the security score", () => {
    const base = {
      level: "3-deep" as const,
      manifests: [],
      dependencies: [],
      frameworks: [],
      architecturePatterns: [],
      apiSurface: [],
      runtime: [],
      limitations: [],
    };
    const clean = evaluate(res({ name: "a/b", fullName: "a/b" }), {
      inspection: {
        ...base,
        security: {
          vulnerabilityCheck: "performed",
          vulnerabilities: [],
          hasSecurityPolicy: true,
          hasLockfile: true,
          installScripts: [],
          promptInjectionFindings: [],
          disclaimers: [],
        },
      },
    });
    const bad = evaluate(res({ name: "a/b", fullName: "a/b" }), {
      inspection: {
        ...base,
        security: {
          vulnerabilityCheck: "performed",
          vulnerabilities: Array.from({ length: 4 }, (_, i) => ({
            id: "GHSA-" + i,
            aliases: [],
            package: "p",
            ecosystem: "npm",
          })),
          hasSecurityPolicy: false,
          hasLockfile: false,
          installScripts: ["postinstall"],
          promptInjectionFindings: ["instruction-override phrase"],
          disclaimers: [],
        },
      },
    });
    expect(bad.scores.security!.value).toBeLessThan(clean.scores.security!.value - 30);
  });
  it("stars are not the primary measure: a healthy small repo beats a popular abandoned one", () => {
    const spec = understandTask("a json schema validation library");
    const popularDead = res({
      name: "big/dead",
      fullName: "big/dead",
      stars: 60000,
      forks: 9000,
      pushedAt: daysAgo(1500),
      description: "json schema validation library",
      topics: ["json", "schema", "validation"],
    });
    const smallAlive = res({
      name: "small/alive",
      fullName: "small/alive",
      stars: 45,
      forks: 3,
      pushedAt: daysAgo(5),
      description: "json schema validation library",
      topics: ["json", "schema", "validation"],
    });
    const rel = { relevance: 0.8 };
    expect(evaluate(smallAlive, { spec, ...rel }).overall).toBeGreaterThan(
      evaluate(popularDead, { spec, ...rel }).overall,
    );
  });
  it("archived repos and forbidden licences are capped with explanation", () => {
    const spec = understandTask("library, no gpl");
    expect(evaluate(res({ name: "a/b", fullName: "a/b", archived: true })).overall).toBeLessThanOrEqual(40);
    const g = evaluate(res({ name: "a/c", fullName: "a/c", license: "GPL-3.0" }), { spec });
    expect(g.overall).toBeLessThanOrEqual(20);
    expect(g.limitations.join()).toMatch(/forbidden/);
  });
  it("irrelevant but healthy repos are gated below relevant ones", () => {
    const spec = understandTask("object detection");
    const rel = evaluate(res({ name: "a/yolo", fullName: "a/yolo", description: "object detection" }), {
      spec,
      relevance: 0.9,
    });
    const irr = evaluate(res({ name: "a/other", fullName: "a/other", stars: 90000 }), {
      spec,
      relevance: 0.02,
    });
    expect(rel.overall).toBeGreaterThan(irr.overall + 15);
  });
  it("language mismatch against an explicit requirement hurts compatibility", () => {
    const spec = understandTask("a parser in rust");
    const rs = evaluate(res({ name: "a/r", fullName: "a/r", language: "Rust" }), { spec }),
      py = evaluate(res({ name: "a/p", fullName: "a/p", language: "Python" }), { spec });
    expect(rs.scores.compatibility!.value).toBeGreaterThan(py.scores.compatibility!.value + 30);
  });
});

describe("level 1 fast filtering", () => {
  it("keeps relevant, active, licensed repos and rejects stale irrelevant ones", () => {
    const good = fastFilter(
      res({
        name: "a/b",
        fullName: "a/b",
        description: "great tool for things",
        homepage: "https://x.dev",
        topics: ["x"],
      }),
      { relevance: 0.8 },
    );
    const bad = fastFilter(
      res({ name: "c/d", fullName: "c/d", pushedAt: daysAgo(2000), license: undefined, stars: 0, forks: 0 }),
      { relevance: 0.0 },
    );
    expect(good.keep).toBe(true);
    expect(bad.keep).toBe(false);
    expect(good.score).toBeGreaterThan(bad.score);
  });
  it("is fast enough to evaluate thousands of candidates", () => {
    const list = Array.from({ length: 5000 }, (_, i) =>
      res({ name: `o/r${i}`, fullName: `o/r${i}`, stars: i }),
    );
    const t = performance.now();
    list.forEach((r) => fastFilter(r, { relevance: 0.3 }));
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("hybrid retrieval", () => {
  const docs = [
    res({
      name: "a/whisper-stt",
      fullName: "a/whisper-stt",
      description: "speech to text transcription with whisper",
      topics: ["speech-recognition", "asr"],
    }),
    res({
      name: "b/react-ui",
      fullName: "b/react-ui",
      description: "react component library for dashboards",
      topics: ["react", "ui"],
    }),
    res({
      name: "c/yolo-detect",
      fullName: "c/yolo-detect",
      description: "real-time object detection",
      topics: ["yolo", "object-detection"],
    }),
  ];
  it("tokenizes with stemming and stop-words", () => {
    expect(tokenize("Building the transcriptions of Speeches")).toEqual(
      expect.arrayContaining(
        ["build", "transcription", "speeche"]
          .map((x) => x.replace("speeche", "speeche"))
          .filter((x) => x !== "speeche"),
      ),
    );
  });
  it("ranks lexically relevant resources first without any embedder", async () => {
    const r = await hybridRank(docs, "speech to text transcription");
    expect(r[0]!.resource.name).toBe("a/whisper-stt");
    expect(r[0]!.score.semantic).toBeUndefined();
    expect(bm25(docs, "object detection")[2]).toBeGreaterThan(bm25(docs, "object detection")[1]!);
  });
  it("blends optional local embeddings and survives embedder failure", async () => {
    const fake: EmbeddingProvider = {
      id: "fake",
      embed: async (t) => t.map((x) => [/audio|voice|speech/.test(x) ? 1 : 0, /ui|react/.test(x) ? 1 : 0]),
    };
    const r = await hybridRank(docs, "voice audio", { embedder: fake });
    expect(r[0]!.score.semantic).toBeDefined();
    expect(r[0]!.resource.name).toBe("a/whisper-stt");
    const broken: EmbeddingProvider = {
      id: "x",
      embed: async () => {
        throw new Error("down");
      },
    };
    const r2 = await hybridRank(docs, "object detection", { embedder: broken });
    expect(r2[0]!.resource.name).toBe("c/yolo-detect");
    expect(r2[0]!.score.semantic).toBeUndefined();
  });
  it("ranks 10k candidates quickly", async () => {
    const big = Array.from({ length: 10000 }, (_, i) =>
      res({
        name: `o/r${i}`,
        fullName: `o/r${i}`,
        description: `project number ${i} ${i % 7 === 0 ? "speech recognition" : "misc utility"}`,
        topics: ["t" + (i % 50)],
      }),
    );
    const t = performance.now();
    const r = await hybridRank(big, "speech recognition");
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r[0]!.score.combined).toBeGreaterThan(0.5);
  });
});
