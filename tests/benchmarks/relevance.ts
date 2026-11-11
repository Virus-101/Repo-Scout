// Offline relevance evaluation on a SYNTHETIC, hand-graded dataset (see datasets/relevance.json and docs/development/evaluation.md).
// Compares Repo Scout's ranking (task understanding + hybrid retrieval + Level-2 adaptive scoring) with a stars-only baseline and a lexical-only baseline.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { understandTask } from "@repo-scout/intelligence";
import { evaluate, hybridRank, fastFilter } from "@repo-scout/scoring";
import type { Resource } from "@repo-scout/schemas";

const dir = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(dir, "datasets/relevance.json"), "utf8"));
const DAY = 86400000,
  now = Date.now();
const mk = (c: any[]): Resource & { grade: number } => ({
  id: `github:repository:${c[0]}`,
  type: "repository",
  provider: "github",
  name: String(c[0]).split("/")[1]!,
  fullName: c[0],
  canonicalUrl: `https://github.com/${c[0]}`,
  description: c[1],
  topics: c[2],
  language: c[3],
  stars: c[4],
  forks: Math.round(c[4] / 10),
  pushedAt: new Date(now - c[5] * DAY).toISOString(),
  createdAt: new Date(now - 700 * DAY).toISOString(),
  license: c[6],
  metadata: {},
  evidence: [{ id: "e", status: "verified", source: "github", detail: "synthetic" }],
  freshness: { retrievedAt: new Date(now).toISOString(), ageSeconds: 0, fromCache: false, stale: false },
  grade: c[7],
});
const dcg = (grades: number[]) => grades.reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0);
const ndcg = (ranked: number[], k: number) => {
  const ideal = [...ranked].sort((a, b) => b - a);
  const d = dcg(ideal.slice(0, k));
  return d ? dcg(ranked.slice(0, k)) / d : 0;
};
const p3 = (ranked: number[]) =>
  ranked.slice(0, 3).filter((g) => g === 2).length / Math.min(3, ranked.filter((g) => g === 2).length || 1);
const mrr = (ranked: number[]) => {
  const i = ranked.findIndex((g) => g === 2);
  return i < 0 ? 0 : 1 / (i + 1);
};

type Row = { category: string; method: string; ndcg5: number; p3: number; mrr: number };
const rows: Row[] = [];
for (const q of data.queries) {
  const cands = q.candidates.map(mk);
  const spec = understandTask(q.query);
  const hr = await hybridRank(cands, q.query);
  const rel = new Map(hr.map((h) => [h.resource.id, h.score.combined]));
  const methods: Record<string, Array<Resource & { grade: number }>> = {
    "stars-only": [...cands].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)),
    "lexical-only": hr.map((h) => h.resource as any),
    "repo-scout": [...cands]
      .map((r) => ({
        r,
        e: evaluate(r, { spec, relevance: rel.get(r.id) }),
        f: fastFilter(r, { spec, relevance: rel.get(r.id) }),
      }))
      .sort((a, b) => b.e.overall - a.e.overall)
      .map((x) => x.r),
  };
  for (const [method, list] of Object.entries(methods)) {
    const g = list.map((r) => r.grade);
    rows.push({ category: q.category, method, ndcg5: ndcg(g, 5), p3: p3(g), mrr: mrr(g) });
  }
}
const agg = (m: string) => {
  const r = rows.filter((x) => x.method === m);
  const a = (k: keyof Row) => r.reduce((s, x) => s + (x[k] as number), 0) / r.length;
  return {
    method: m,
    "nDCG@5": +a("ndcg5").toFixed(3),
    "P@3(direct)": +a("p3").toFixed(3),
    MRR: +a("mrr").toFixed(3),
  };
};
const summary = ["stars-only", "lexical-only", "repo-scout"].map(agg);
console.log("Relevance evaluation (synthetic dataset, 8 categories, 8 candidates each)\n");
console.table(summary);
console.log("\nPer category nDCG@5:");
console.table(
  data.queries.map((q: any) => ({
    category: q.category,
    ...Object.fromEntries(
      ["stars-only", "lexical-only", "repo-scout"].map((m) => [
        m,
        +rows.find((r) => r.category === q.category && r.method === m)!.ndcg5.toFixed(3),
      ]),
    ),
  })),
);
fs.mkdirSync(path.join(dir, "results"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "results/relevance.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      dataset: "synthetic (see datasets/relevance.json)",
      summary,
      rows,
    },
    null,
    2,
  ),
);
