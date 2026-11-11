# Relevance evaluation — method and limitations

`pnpm eval` runs `tests/benchmarks/relevance.ts` on `tests/benchmarks/datasets/relevance.json`: 8 categories (AI agents, computer vision, web development, embedded, data engineering, developer tooling, robotics, security tooling), one query each, 8 candidates per query, hand-graded 0/1/2. It compares three rankers on nDCG@5, P@3 (share of the top 3 that are grade 2) and MRR:

- **stars-only** — the naive baseline;
- **lexical-only** — BM25 + metadata affinity (Repo Scout's retrieval stage);
- **repo-scout** — task understanding + retrieval + Level-2 adaptive scoring.

Latest run (2026-11-11, `tests/benchmarks/results/relevance.json`):

| Ranker       | nDCG@5 | P@3   | MRR   |
| ------------ | ------ | ----- | ----- |
| stars-only   | 0.478  | 0.396 | 0.458 |
| lexical-only | 0.985  | 0.938 | 1.000 |
| repo-scout   | 0.979  | 1.000 | 1.000 |

## How to read this — limitations (important)

1. **The dataset is synthetic.** Records and grades were written by the maintainers of this repo, with relevant items sharing vocabulary with the query. It is an _easy_ set: it shows that popularity-only ranking fails on decoys and that retrieval + scoring ranks vocabulary-matching items first. It does **not** show that Repo Scout beats a good lexical ranker (it does not: 0.979 vs 0.985 nDCG@5), nor does it measure real-world recommendation quality.
2. Tiny sample (64 candidates, 8 queries): differences in the third decimal are noise.
3. Graded for _relevance_, not for suitability, security or integration — so it cannot show the value of maintenance/licence/compatibility weighting, which is the point of Level-2 scoring.
4. Provider recall (what GitHub etc. return) is outside this evaluation; live runs show weak component matches for some queries (see README example).

A meaningful evaluation needs real candidate pools captured from providers for real tasks, graded independently by several people (with inter-annotator agreement) and including "is this actually usable together" judgements. That is on the roadmap; until then, do not cite these numbers as product accuracy.
