import { describe, expect, it } from "vitest";
import { Store } from "@repo-scout/cache";
import { TrendRadar, computeTrend, hiddenGemScore, maintenanceStatus } from "@repo-scout/trending";
import { GithubProvider } from "@repo-scout/providers";
import { SafeHttp } from "@repo-scout/core";
import { ghRepo, mockFetch, res, testConfig } from "../helpers.js";

const DAY = 86400000;
const daysAgo = (n: number, now = Date.now()) => new Date(now - n * DAY).toISOString();

describe("trend computation never fabricates history", () => {
  const r = res({ name: "a/b", fullName: "a/b", stars: 1000, createdAt: daysAgo(100) });
  it("insufficient snapshots -> clearly labelled ESTIMATE", () => {
    const t = computeTrend(r, [{ resourceId: "x", observedAt: 1, stars: 1000 }]);
    expect(t.label).toBe("estimated");
    expect(t.starsPerDay).toBeCloseTo(10, 0);
    expect(t.note).toMatch(/ESTIMATE/);
  });
  it("two snapshots on the same day are not enough for observed growth", () => {
    expect(
      computeTrend(r, [
        { resourceId: "x", observedAt: 0, stars: 10 },
        { resourceId: "x", observedAt: 3600_000, stars: 12 },
      ]).label,
    ).toBe("estimated");
  });
  it("observed growth from >=2 snapshots spanning >=1 day", () => {
    const t = computeTrend(r, [
      { resourceId: "x", observedAt: 0, stars: 100 },
      { resourceId: "x", observedAt: 4 * DAY, stars: 140 },
    ]);
    expect(t).toMatchObject({
      label: "observed",
      starsPerDay: 10,
      starGrowthPct: 40,
      observations: 2,
      windowDays: 4,
    });
  });
  it("negative growth is reported only when observed", () => {
    expect(
      computeTrend(r, [
        { resourceId: "x", observedAt: 0, stars: 100 },
        { resourceId: "x", observedAt: 2 * DAY, stars: 90 },
      ]).starsPerDay,
    ).toBeLessThan(0);
  });
  it("no age and no snapshots -> insufficient-data", () => {
    expect(computeTrend(res({ name: "a/c", fullName: "a/c", createdAt: undefined }), []).label).toBe(
      "insufficient-data",
    );
  });
  it("maintenance status", () => {
    expect(maintenanceStatus(res({ name: "a/b", pushedAt: daysAgo(10) }))).toBe("active");
    expect(maintenanceStatus(res({ name: "a/b", pushedAt: daysAgo(100) }))).toBe("slowing");
    expect(maintenanceStatus(res({ name: "a/b", pushedAt: daysAgo(300) }))).toBe("stale");
    expect(maintenanceStatus(res({ name: "a/b", pushedAt: daysAgo(900) }))).toBe("abandoned");
    expect(maintenanceStatus(res({ name: "a/b", archived: true }))).toBe("archived");
  });
});

describe("hidden gems", () => {
  it("does not exclude small repositories and prefers healthy documented ones", () => {
    const gem = hiddenGemScore(
      res({
        name: "a/gem",
        stars: 12,
        description: "A well documented tool that does one thing well",
        topics: ["x", "y"],
        homepage: "https://x.dev",
        pushedAt: daysAgo(3),
      }),
    );
    const dead = hiddenGemScore(res({ name: "a/dead", stars: 12, description: "", pushedAt: daysAgo(900) }));
    const famous = hiddenGemScore(
      res({
        name: "a/famous",
        stars: 90000,
        description: "A well documented tool that does one thing well",
        topics: ["x", "y"],
        pushedAt: daysAgo(3),
      }),
    );
    expect(gem.score).toBeGreaterThan(40);
    expect(gem.score).toBeGreaterThan(dead.score);
    expect(gem.score).toBeGreaterThan(famous.score * 3);
    expect(hiddenGemScore(res({ name: "a/arch", archived: true })).score).toBe(0);
  });
});

describe("TrendRadar", () => {
  const mk = (items: any[], now: () => number) => {
    const f = mockFetch([{ match: "/search/repositories", json: { items } }]);
    const gh = new GithubProvider({ http: new SafeHttp({ fetchImpl: f }), config: testConfig() });
    const store = new Store(":memory:", now);
    return { radar: new TrendRadar(gh, store, now), store, f };
  };
  it("builds local snapshots and flips from ESTIMATED to OBSERVED across runs", async () => {
    let t = Date.parse("2026-11-01T00:00:00Z");
    const now = () => t;
    const items = [
      ghRepo("n/hot", { stargazers_count: 300, created_at: daysAgo(30, t), pushed_at: daysAgo(1, t) }),
    ];
    const { radar, store, f } = mk(items, now);
    const first = await radar.trending({ language: "TypeScript" });
    expect(first.entries[0]!.trend.label).toBe("estimated");
    expect(first.notes.join()).toMatch(/ESTIMATES/);
    t += 5 * DAY;
    items[0]!.stargazers_count = 400;
    const second = await radar.trending({ language: "TypeScript" });
    expect(second.entries[0]!.trend).toMatchObject({ label: "observed", starsPerDay: 20 });
    expect(store.getSnapshots("github:repository:n/hot")).toHaveLength(2);
    expect(decodeURIComponent(f.calls[0]!)).toMatch(/created:>=2026-08-03/);
    expect(decodeURIComponent(f.calls[0]!)).toContain("language:TypeScript");
  });
  it("ranks observed growth above estimates", async () => {
    const t = Date.parse("2026-11-01T00:00:00Z");
    const now = () => t;
    const items = [
      ghRepo("n/slow", { stargazers_count: 100, created_at: daysAgo(10, t) }),
      ghRepo("n/fast", { stargazers_count: 1000, created_at: daysAgo(10, t) }),
    ];
    const { radar, store } = mk(items, now);
    store.addSnapshot({ resourceId: "github:repository:n/slow", observedAt: t - 2 * DAY, stars: 50 });
    const r = await radar.trending();
    expect(r.entries[0]!.resource.fullName).toBe("n/slow");
    expect(r.entries[0]!.trend.label).toBe("observed");
  });
  it("hidden gems and declining projects", async () => {
    const t = Date.parse("2026-11-01T00:00:00Z");
    const now = () => t;
    const items = [
      ghRepo("g/small", {
        stargazers_count: 8,
        description: "A carefully documented little library",
        pushed_at: daysAgo(4, t),
      }),
      ghRepo("g/old", { stargazers_count: 5000, pushed_at: daysAgo(900, t) }),
    ];
    const { radar } = mk(items, now);
    const gems = await radar.hiddenGems();
    expect(gems.entries[0]!.resource.fullName).toBe("g/small");
    expect(gems.entries[0]!.hiddenGemScore).toBeGreaterThan(30);
    const dec = await radar.declining();
    expect(dec.entries.map((e) => e.resource.fullName)).toEqual(["g/old"]);
    expect(dec.entries[0]!.maintenance).toBe("abandoned");
  });
});
