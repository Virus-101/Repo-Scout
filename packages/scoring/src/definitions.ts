/** Documented score definitions (also rendered into docs/architecture/scoring.md and reports). */
export const SCORE_DEFINITIONS: Record<string, { summary: string; inputs: string[] }> = {
  relevance: {
    summary: "How well the resource matches the requested functionality (0-100).",
    inputs: [
      "hybrid retrieval score (BM25 + metadata affinity + optional local embeddings)",
      "component keyword hits in name/description/topics",
    ],
  },
  maintenance: {
    summary: "Evidence that the project is alive and cared for.",
    inputs: [
      "days since last push (verified)",
      "latest release age (verified)",
      "commits in last 90 days (verified if statistics available)",
      "archived flag (verified)",
    ],
  },
  quality: {
    summary: "Engineering-quality indicators. NOT a code review.",
    inputs: [
      "tests present (static tree)",
      "CI configuration present",
      "type/lint configuration present",
      "repository structure",
      "-- all missing at Level 1/2 unless the tree was inspected",
    ],
  },
  documentation: {
    summary: "How well the project explains itself.",
    inputs: [
      "README length & sections (install/usage/examples)",
      "docs directory / homepage",
      "description and topics",
    ],
  },
  compatibility: {
    summary: "Fit with the requested languages, frameworks, OS and runtimes.",
    inputs: [
      "primary language vs. requested languages",
      "framework/dependency overlap",
      "OS/runtime hints in topics and manifests",
    ],
  },
  security: {
    summary: "Security INDICATORS (never an audit).",
    inputs: [
      "OSV vulnerability lookup for declared dependencies (verified when performed)",
      "SECURITY policy file",
      "lockfile present",
      "install scripts present (risk)",
      "archived (no patches)",
    ],
  },
  community: {
    summary:
      "Adoption and community, log-scaled and deliberately low-weighted. Stars are never the primary quality measure.",
    inputs: ["stars", "forks", "contributors", "package downloads"],
  },
  license: {
    summary: "Suitability of the licence for the task's constraints.",
    inputs: [
      "SPDX classification",
      "allowed / forbidden licence lists",
      "commercial-use flag",
      "project licence compatibility",
    ],
  },
  integration: {
    summary: "How easy the resource is to embed or call from another system.",
    inputs: [
      "published package / manifest",
      "API/SDK/CLI/MCP topics",
      "container support",
      "permissive licence",
    ],
  },
  overall: {
    summary:
      "Weighted mean of the scores above using task-adaptive weights; unverifiable factors are excluded and lower the confidence value rather than being guessed.",
    inputs: ["adaptive weight profile (see weights.ts)"],
  },
};
export const CONFIDENCE_DEFINITION =
  "confidence = share of factor weight backed by verified (1.0) or inferred (0.6) evidence; 'missing' factors contribute 0.";
