# Score definitions

Scores are 0–100 with a `confidence` (0–1). **Confidence = share of factor weight backed by verified (1.0) or inferred (0.6) evidence** (assumption 0.25, missing 0). Factors with status `missing` are excluded from the value rather than guessed; if everything is missing the value is a neutral 50 with confidence 0 (UI shows "unverified").

| Score           | Meaning                                      | Main inputs (status)                                                                                                                                                                                            |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relevance`     | Match with the request                       | hybrid retrieval: BM25 + metadata affinity (+ local embeddings) (inferred); component keyword hits (inferred)                                                                                                   |
| `maintenance`   | Alive and cared for                          | days since push (verified), release recency (verified), commits last ~90 d (verified when stats available), archived (verified)                                                                                 |
| `quality`       | Engineering indicators — _not a code review_ | tests, CI, Dockerfile, static typing, structure, contributors — **missing until Level 3 tree inspection**                                                                                                       |
| `documentation` | Explains itself                              | description, homepage, topics (verified); README size (verified) and sections (inferred); docs/ dir (verified at L3)                                                                                            |
| `compatibility` | Fit with languages/frameworks/OS             | language vs explicit (verified) / assumed (inferred) preferences; framework & OS mentions (inferred); runtime **not tested**                                                                                    |
| `security`      | Security _indicators_ — never an audit       | OSV advisories for declared dependency versions (verified when performed; coverage reported), SECURITY policy, lockfile, install scripts, archive state, injection-like README text — **missing until Level 3** |
| `community`     | Adoption, log-scaled, low weight             | stars, forks, downloads, contributors, registry popularity                                                                                                                                                      |
| `license`       | Suitability for the task's constraints       | SPDX classification; allowed/forbidden lists; commercial use; project-licence conflict                                                                                                                          |
| `integration`   | How easily it can be embedded                | package/manifest presence, API/SDK/CLI/MCP signals, container support, licence friendliness                                                                                                                     |
| `overall`       | Weighted mean with adaptive weights          | see below                                                                                                                                                                                                       |

## Adaptive weights

Base: relevance .25 · maintenance .15 · quality .10 · documentation .10 · compatibility .12 · security .08 · community .05 · licence .07 · integration .08. Deltas by detected domain (then renormalised to 1):

| Domain                                                             | Emphasis                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| authentication                                                     | security +.14, maintenance +.08                        |
| computer-vision                                                    | compatibility +.08, quality +.04                       |
| real-time                                                          | quality +.10, compatibility +.05                       |
| education                                                          | documentation +.15                                     |
| ai-agents                                                          | maintenance +.05, integration +.04                     |
| embedded / robotics                                                | compatibility +.10 / +.08                              |
| security-tooling                                                   | security +.10, maintenance +.07                        |
| web-development, data-engineering, developer-tooling, speech-audio | smaller documentation/integration/compatibility shifts |

Explicit requirements add weight: security (+.05), licence constraints (+.05), performance (quality/compat), explicit language/OS (compat +.03). Each adjustment is recorded in `overall.explanation`.

## Gates (never silent)

- **Relevance gate:** `overall *= 0.35 + 0.65·min(1, relevance/60)`.
- Archived repository ⇒ overall ≤ 40, maintenance ≤ 10. Licence forbidden by the task ⇒ overall ≤ 20.

## Level-1 fast filter

`score = 100·(0.45·relevance + 0.15·recency + 0.10·licence + 0.10·popularity + 0.10·docs + 0.10·language)`; keep if ≥ 20 (archived only if relevance > .5).

## Composition scores

- `compatibilityScore = 100 − Σ penalties` (conflict 25, warning 8, info 1.5; issues whose evidence is _missing_ count 30%).
- `coherenceScore` = objective-weighted mix of mean component score, compatibility, required-component coverage, language unity, licence score, maintenance. Three objective profiles produce distinct options.
- `integrationComplexity` = components·4 + cross-language boundaries·9 + conflicts·18 + missing·10 (+10 if >2 languages, +5 if unverified) → low <25 · medium <50 · high <75 · very-high.
