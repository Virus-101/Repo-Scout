import type { Resource } from "@repo-scout/schemas";
import type { SafeHttp } from "@repo-scout/core";

const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to with using use used want need build create make my our i we you your can should must will like via also any all more some such than then them these those their there about over under based".split(
    " ",
  ),
);
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}
export function resourceText(r: Resource): { name: string[]; body: string[]; topics: string[] } {
  return {
    name: tokenize(`${r.name} ${r.fullName ?? ""}`),
    body: tokenize(`${r.description} ${r.language ?? ""} ${(r.metadata.readmeHead as string) ?? ""}`),
    topics: r.topics.flatMap((t) => tokenize(t.replace(/-/g, " "))),
  };
}

export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}
export function cosine(a: number[], b: number[]): number {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
/** Optional LOCAL embeddings via an Ollama server (default http://127.0.0.1:11434). No cloud API involved. */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id = "ollama";
  constructor(
    private http: SafeHttp,
    private url: string,
    private model: string,
  ) {}
  async embed(texts: string[]): Promise<number[][]> {
    const u = this.url.replace(/\/$/, "");
    const loop = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
    const d = await this.http.json<{ embeddings: number[][] }>(`${u}/api/embed`, {
      provider: "ollama",
      method: "POST",
      body: JSON.stringify({ model: this.model, input: texts }),
      headers: { "content-type": "application/json" },
      policy: { allowLoopback: loop, allowHttp: loop },
      timeoutMs: 60_000,
    });
    return d.embeddings;
  }
}

export interface RetrievalScore {
  lexical: number;
  metadata: number;
  semantic?: number;
  combined: number;
}
export interface HybridOptions {
  embedder?: EmbeddingProvider;
  topicBoost?: string[];
  weights?: { lexical: number; metadata: number; semantic: number };
}

/** Okapi BM25 over the candidate set (corpus statistics from the candidates themselves). */
export function bm25(resources: Resource[], query: string, k1 = 1.4, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  const docs = resources.map((r) => {
    const t = resourceText(r);
    return [...t.name, ...t.name, ...t.name, ...t.topics, ...t.topics, ...t.body];
  });
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length) || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
}
/** Metadata affinity: topic overlap + name hit; independent of corpus. */
export function metadataAffinity(r: Resource, query: string, topicBoost: string[] = []): number {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const t = resourceText(r);
  const topicHits = [...q].filter((x) => t.topics.includes(x)).length / q.size;
  const nameHits = [...q].filter((x) => t.name.includes(x)).length / q.size;
  const boost = topicBoost.length
    ? topicBoost.filter((b) => r.topics.includes(b)).length / topicBoost.length
    : 0;
  return Math.min(1, 0.5 * topicHits + 0.4 * nameHits + 0.1 * boost);
}

/** Hybrid retrieval: BM25 (lexical) + metadata affinity + optional local embeddings. Works with no embedder. */
export async function hybridRank(
  resources: Resource[],
  query: string,
  opts: HybridOptions = {},
): Promise<Array<{ resource: Resource; score: RetrievalScore }>> {
  if (!resources.length) return [];
  const raw = bm25(resources, query);
  const max = Math.max(...raw, 1e-9);
  let sem: number[] | undefined;
  if (opts.embedder) {
    try {
      const vecs = await opts.embedder.embed([
        query,
        ...resources.map((r) => `${r.name}. ${r.description}. ${r.topics.join(", ")}`.slice(0, 600)),
      ]);
      const q = vecs[0]!;
      sem = vecs.slice(1).map((v) => Math.max(0, cosine(q, v)));
    } catch {
      sem = undefined; /* embeddings are optional: fall back to lexical */
    }
  }
  const w =
    opts.weights ??
    (sem ? { lexical: 0.45, metadata: 0.2, semantic: 0.35 } : { lexical: 0.7, metadata: 0.3, semantic: 0 });
  return resources
    .map((resource, i) => {
      const lexical = raw[i]! / max;
      const metadata = metadataAffinity(resource, query, opts.topicBoost);
      const semantic = sem?.[i];
      const combined =
        w.lexical * lexical + w.metadata * metadata + (semantic !== undefined ? w.semantic * semantic : 0);
      return { resource, score: { lexical, metadata, semantic, combined } };
    })
    .sort((a, b) => b.score.combined - a.score.combined);
}
