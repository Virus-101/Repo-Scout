# Benchmarks

`pnpm bench` (`node --expose-gc --import tsx tests/benchmarks/run.ts`) measures on the **current machine** with **mocked, zero-latency providers**, so numbers are local processing costs, not real search latency (which is dominated by provider round trips: seconds).

Measured on 2026-11-11 (23:09 UTC) — Linux x64, Node v22.23.4, 4 × Intel Xeon @ 2.10 GHz (cloud VM). Source of truth: `tests/benchmarks/results/latest.json` (re-run to refresh).

| Benchmark                                                                           | Median                   | Throughput                  |
| ----------------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| Task understanding (flagship example)                                               | 0.70 ms                  | —                           |
| Level-1 candidate filtering, 1k / 10k / 50k                                         | 3.7 / 20.4 / 103 ms      | ~267k / 490k / 485k items/s |
| Hybrid ranking (BM25 + metadata), 1k / 10k / 50k                                    | 19 / 141 / 695 ms        | ~52k / 71k / 72k items/s    |
| Level-2 adaptive scoring, 5k                                                        | 91.9 ms                  | ~54k items/s                |
| Cache hit (50-resource payload, file SQLite)                                        | 0.12 ms/op               | ~8.1k ops/s                 |
| Cache write (50-resource payload)                                                   | 0.13 ms/op               | —                           |
| Batched resource upsert (1000 rows, one transaction)                                | 8.2 ms                   | —                           |
| End-to-end `discover`, cold / warm SQLite cache (mocked)                            | 19.9 / 7.1 ms            | —                           |
| Memory: 50k candidates ranked + 5k evaluated + MD (3.8 MB) & JSON (6.6 MB) rendered | RSS 296 MB, heap +140 MB | —                           |

Caveats: single machine, small number of runs (3–200), synthetic resources; no claim is made for other hardware.

Real-world end-to-end latency (manual `time`, same VM, egress proxy, `GITHUB_TOKEN` present, default providers, `--deep 0`, 2026-11-11): `repo-scout find "real-time object detection"` took **4.3 s cold** (empty database, live providers) and **2.1 s on a repeat run** (search results served from SQLite; providers that failed — e.g. GitLab 429 — are not cached and are retried). Runs with Level-3 inspection or `compose` are slower (seconds to a minute) because of GitHub quota/rate limits. These are single observations, not statistics.
