import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, MIGRATIONS } from "@repo-scout/cache";
import { res } from "../helpers.js";

describe("Store", () => {
  it("applies migrations once and records the version", () => {
    const s = new Store(":memory:");
    expect(s.schemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(s.integrityCheck()).toBe("ok");
  });
  it("is idempotent across reopen of a file database", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-db-")), "a.sqlite");
    const a = new Store(f);
    a.setCache("n", "k", { x: 1 }, 60);
    a.close();
    const b = new Store(f);
    expect(b.getCache("n", "k")?.value).toEqual({ x: 1 });
    expect(b.schemaVersion()).toBe(1);
    b.close();
  });
  it("expires entries by TTL and can serve stale on request", () => {
    let t = 1_000_000;
    const s = new Store(":memory:", () => t);
    s.setCache("search", "q", [1, 2], 10);
    expect(s.getCache("search", "q")).toBeDefined();
    t += 11_000;
    expect(s.getCache("search", "q")).toBeUndefined();
    expect(s.getCache("search", "q", { allowStale: true })).toMatchObject({ stale: true, value: [1, 2] });
  });
  it("deduplicates resources by id and keeps the newest", () => {
    const s = new Store(":memory:");
    s.upsertResources([res({ name: "a/b", fullName: "a/b", stars: 1 })], 60);
    s.upsertResources([res({ name: "a/b", fullName: "a/b", stars: 5 })], 60);
    expect(s.status().resources).toBe(1);
    expect(s.getResource("github:repository:a/b")?.stars).toBe(5);
    expect(s.findResourceByFullName("A/B")?.stars).toBe(5);
  });
  it("stores snapshots persistently and rate-limits duplicates", () => {
    const s = new Store(":memory:");
    expect(s.addSnapshot({ resourceId: "r", observedAt: 1_000_000, stars: 10 })).toBe(true);
    expect(s.addSnapshot({ resourceId: "r", observedAt: 1_000_010, stars: 11 })).toBe(false);
    expect(s.addSnapshot({ resourceId: "r", observedAt: 2_000_000, stars: 20 })).toBe(true);
    expect(s.getSnapshots("r").map((x) => x.stars)).toEqual([10, 20]);
  });
  it("invalidates by namespace/prefix and clears by scope", () => {
    const s = new Store(":memory:");
    s.setCache("search", "abc1", 1, 60);
    s.setCache("search", "abc2", 1, 60);
    s.setCache("analysis", "x", 1, 60);
    s.addSnapshot({ resourceId: "r", observedAt: 1, stars: 1 });
    expect(s.invalidate("search", "abc")).toBe(2);
    expect(s.clear("analysis")).toBeDefined();
    expect(s.status().analysisEntries).toBe(0);
    expect(s.status().snapshots).toBe(1); // history survives cache clearing
    s.clear("snapshots");
    expect(s.status().snapshots).toBe(0);
    s.setCache("a", "b", 1, 60);
    s.clear("all");
    expect(s.status().cacheEntries).toBe(0);
  });
  it("clear('expired') only removes expired rows", () => {
    let t = 0;
    const s = new Store(":memory:", () => t);
    s.setCache("a", "old", 1, 1);
    s.setCache("a", "new", 1, 1000);
    t = 5000;
    s.clear("expired");
    expect(s.getCache("a", "new")).toBeDefined();
    expect(s.status().cacheEntries).toBe(1);
  });
  it("supports concurrent writers on one file (WAL + busy_timeout)", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-conc-")), "c.sqlite");
    const stores = [new Store(f), new Store(f), new Store(f)];
    await Promise.all(
      stores.map(async (s, i) => {
        for (let k = 0; k < 50; k++) {
          s.setCache("n", `k${i}-${k}`, { i, k }, 60);
          s.addSnapshot({ resourceId: `r${i}`, observedAt: k * 100_000, stars: k });
          await new Promise((r) => setImmediate(r));
        }
      }),
    );
    expect(stores[0]!.status().cacheEntries).toBe(150);
    expect(stores[1]!.integrityCheck()).toBe("ok");
    stores.forEach((s) => s.close());
  });
  it("tracks relations, scores, provider health and meta", () => {
    const s = new Store(":memory:");
    s.addRelation("a", "b", "related");
    expect(s.getRelations("b")[0]).toMatchObject({ from: "a", to: "b" });
    s.saveScore("a", "ctx", { overall: 5 });
    expect(s.getScore("a", "ctx")).toEqual({ overall: 5 });
    s.recordProvider("github", true);
    s.recordProvider("github", false, "boom");
    expect(s.providerStats()[0]).toMatchObject({ id: "github", requests: 2, failures: 1, lastError: "boom" });
    s.setMeta("k", "v");
    expect(s.getMeta("k")).toBe("v");
  });
});
