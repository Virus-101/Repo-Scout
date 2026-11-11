// Performance benchmarks. Everything here is measured on the current machine; nothing is hard-coded.
// Network is mocked (zero latency), so "search latency" below is LOCAL pipeline overhead, not provider latency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "@repo-scout/discovery";
import { Store } from "@repo-scout/cache";
import { RateLimiter, loadConfig } from "@repo-scout/core";
import { understandTask } from "@repo-scout/intelligence";
import { evaluate, fastFilter, hybridRank } from "@repo-scout/scoring";
import { renderDiscoveryMd, toRecommendation } from "@repo-scout/report";
import type { Resource } from "@repo-scout/schemas";

const dir = path.dirname(fileURLToPath(import.meta.url));
const results: Record<string, unknown>[] = [];
const mb = (n: number) => +(n / 1048576).toFixed(1);
async function time<T>(
  name: string,
  fn: () => Promise<T> | T,
  iterations = 1,
  extra: Record<string, unknown> = {},
) {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const row = {
    benchmark: name,
    runs: iterations,
    medianMs: +samples[Math.floor(samples.length / 2)]!.toFixed(2),
    p95Ms: +samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!.toFixed(2),
    ...extra,
  };
  results.push(row);
  return row;
}
const synth = (n: number): Resource[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `github:repository:o/r${i}`,
    type: "repository",
    provider: "github",
    name: `r${i}`,
    fullName: `o/r${i}`,
    canonicalUrl: `https://github.com/o/r${i}`,
    description: `project ${i} for ${["speech recognition", "object detection", "web dashboards", "robot navigation", "data pipelines"][i % 5]} with ${["python", "rust", "typescript"][i % 3]} bindings`,
    topics: [`topic${i % 40}`, ["asr", "yolo", "react", "ros2", "etl"][i % 5]!],
    language: ["Python", "Rust", "TypeScript"][i % 3],
    stars: (i * 37) % 50000,
    forks: (i * 13) % 4000,
    license: ["MIT", "Apache-2.0", "GPL-3.0"][i % 3],
    pushedAt: new Date(Date.now() - (i % 900) * 86400000).toISOString(),
    createdAt: "2022-01-01T00:00:00Z",
    metadata: {},
    evidence: [{ id: `e${i}`, status: "verified", source: "github", detail: "synthetic" }],
    freshness: { retrievedAt: new Date().toISOString(), ageSeconds: 0, fromCache: false, stale: false },
  }));

const spec = understandTask("a self-hosted meeting assistant with speech to text and an llm in python");
await time(
  "task understanding (local)",
  () =>
    understandTask(
      "I want to build an autonomous AI desktop assistant that controls Windows, understands screenshots, executes tasks, supports MCP, and remembers previous interactions.",
    ),
  200,
);

for (const n of [1_000, 10_000, 50_000]) {
  const list = synth(n);
  await time(
    `candidate filtering (Level 1) n=${n}`,
    () => list.forEach((r) => fastFilter(r, { spec, relevance: 0.4 })),
    5,
    { items: n, itemsPerSec: 0 },
  );
  const last = results[results.length - 1] as any;
  last.itemsPerSec = Math.round(n / (last.medianMs / 1000));
  await time(
    `hybrid ranking (BM25+metadata) n=${n}`,
    () => hybridRank(list, "speech recognition python"),
    3,
    { items: n },
  );
  const l2 = results[results.length - 1] as any;
  l2.itemsPerSec = Math.round(n / (l2.medianMs / 1000));
}
const l2set = synth(5_000);
await time(
  "adaptive scoring (Level 2) n=5000",
  () => l2set.forEach((r) => evaluate(r, { spec, relevance: 0.4 })),
  3,
  { items: 5000 },
);
(results[results.length - 1] as any).itemsPerSec = Math.round(
  5000 / ((results[results.length - 1] as any).medianMs / 1000),
);

// cache hit performance on a file-backed SQLite DB
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-bench-"));
const store = new Store(path.join(tmp, "bench.sqlite"));
const payload = synth(50);
for (let i = 0; i < 2000; i++) store.setCache("search", `k${i}`, payload, 3600);
await time(
  "cache hit (50-resource payload, file SQLite)",
  () => {
    for (let i = 0; i < 2000; i++) store.getCache("search", `k${i}`);
  },
  5,
  { operations: 2000 },
);
(results[results.length - 1] as any).opsPerSec = Math.round(
  2000 / ((results[results.length - 1] as any).medianMs / 1000),
);
await time(
  "cache write (50-resource payload)",
  () => {
    for (let i = 0; i < 500; i++) store.setCache("search", `w${i}`, payload, 3600);
  },
  5,
  { operations: 500 },
);
await time(
  "resource upsert batch (1000 resources, one transaction)",
  () => store.upsertResources(synth(1000), 3600),
  5,
  { items: 1000 },
);
store.close();

// end-to-end local pipeline with mocked providers (no network)
const fetchImpl = (async (url: string) => {
  const items = synth(30).map((r) => ({
    full_name: r.fullName,
    name: r.name,
    html_url: r.canonicalUrl,
    description: r.description,
    language: r.language,
    topics: r.topics,
    license: { spdx_id: r.license },
    stargazers_count: r.stars,
    forks_count: r.forks,
    open_issues_count: 1,
    created_at: r.createdAt,
    updated_at: r.pushedAt,
    pushed_at: r.pushedAt,
    archived: false,
    fork: false,
    default_branch: "main",
  }));
  return new Response(
    String(url).includes("api.github.com/search")
      ? JSON.stringify({ items })
      : JSON.stringify({ objects: [], crates: [], data: [], response: { docs: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as any;
const cfg = loadConfig({ REPO_SCOUT_CONFIG: "/nonexistent.json" } as any, { dbPath: ":memory:" });
const engine = new Engine({
  config: cfg,
  fetchImpl,
  store: new Store(":memory:"),
  limiter: new RateLimiter(1_000_000),
});
await time(
  "end-to-end discover, cold cache, mocked providers",
  () => engine.discover("speech to text meeting assistant in python", { deep: 0, noCache: true }),
  5,
);
await time(
  "end-to-end discover, warm SQLite cache, mocked providers",
  () => engine.discover("speech to text meeting assistant in python", { deep: 0 }),
  20,
);

// memory + large result sets
if (global.gc) global.gc();
const before = process.memoryUsage();
const big = synth(50_000);
const ranked = await hybridRank(big, "speech recognition python");
const evals = ranked.slice(0, 5_000).map((r) => evaluate(r.resource, { spec, relevance: r.score.combined }));
const md = renderDiscoveryMd(
  "big",
  evals,
  {
    candidatesDiscovered: big.length,
    shortlisted: evals.length,
    deeplyInspected: 0,
    recommendedCombinations: 0,
  },
  { limit: 5_000 },
);
const json = JSON.stringify(evals.map(toRecommendation));
const after = process.memoryUsage();
results.push({
  benchmark: "memory: 50k candidates ranked, 5k evaluated, markdown+JSON rendered",
  rssMB: mb(after.rss),
  heapUsedMB: mb(after.heapUsed),
  heapGrowthMB: mb(after.heapUsed - before.heapUsed),
  markdownKB: Math.round(md.length / 1024),
  jsonKB: Math.round(json.length / 1024),
});

const env = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  generatedAt: new Date().toISOString(),
  note: "Mocked providers (0 ms latency): numbers show local processing cost only.",
};
console.log(JSON.stringify(env, null, 2));
console.table(results);
fs.mkdirSync(path.join(dir, "results"), { recursive: true });
fs.writeFileSync(path.join(dir, "results/latest.json"), JSON.stringify({ env, results }, null, 2));
