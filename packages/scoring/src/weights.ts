import type { Domain, ScoreName, TaskSpec } from "@repo-scout/schemas";

export type WeightMap = Record<Exclude<ScoreName, "overall">, number>;
const BASE: WeightMap = {
  relevance: 0.25,
  maintenance: 0.15,
  quality: 0.1,
  documentation: 0.1,
  compatibility: 0.12,
  security: 0.08,
  community: 0.05,
  license: 0.07,
  integration: 0.08,
};

const PROFILES: Record<Domain, { label: string; delta: Partial<WeightMap>; why: string }> = {
  authentication: {
    label: "authentication",
    delta: { security: 0.14, maintenance: 0.08, community: 0.02, relevance: -0.04, documentation: -0.01 },
    why: "authentication code is security-critical and must be actively patched",
  },
  "computer-vision": {
    label: "computer-vision",
    delta: { compatibility: 0.08, quality: 0.04, integration: 0.02, community: -0.01, maintenance: -0.03 },
    why: "framework/runtime (CUDA, ONNX, OpenCV, PyTorch) compatibility and performance characteristics dominate",
  },
  "real-time": {
    label: "real-time",
    delta: { quality: 0.1, compatibility: 0.05, documentation: -0.03, community: -0.03 },
    why: "latency depends on implementation characteristics (language, architecture, tests)",
  },
  education: {
    label: "education",
    delta: { documentation: 0.15, quality: 0.03, security: -0.04, compatibility: -0.02, integration: -0.03 },
    why: "clarity and documentation matter more than production hardening",
  },
  "ai-agents": {
    label: "ai-agents",
    delta: { maintenance: 0.05, integration: 0.04, compatibility: 0.02, community: -0.01 },
    why: "fast-moving ecosystem: freshness and integrability matter",
  },
  "web-development": {
    label: "web-development",
    delta: { documentation: 0.03, community: 0.03, integration: 0.02 },
    why: "mature ecosystems reward documentation and adoption",
  },
  embedded: {
    label: "embedded",
    delta: { compatibility: 0.1, quality: 0.04, community: -0.03, integration: -0.02 },
    why: "target/toolchain compatibility and footprint dominate",
  },
  "data-engineering": {
    label: "data-engineering",
    delta: { compatibility: 0.04, maintenance: 0.03, integration: 0.03 },
    why: "connectors and compatibility with existing stores matter",
  },
  "developer-tooling": {
    label: "developer-tooling",
    delta: { documentation: 0.03, integration: 0.04, quality: 0.02 },
    why: "tools succeed on ergonomics and integrability",
  },
  robotics: {
    label: "robotics",
    delta: { compatibility: 0.08, quality: 0.04, maintenance: 0.01 },
    why: "ROS/hardware compatibility and code quality matter",
  },
  "security-tooling": {
    label: "security-tooling",
    delta: { security: 0.1, maintenance: 0.07, quality: 0.02 },
    why: "security tools must themselves be trustworthy and current",
  },
  "speech-audio": {
    label: "speech-audio",
    delta: { compatibility: 0.06, quality: 0.04, maintenance: 0.01 },
    why: "model/runtime compatibility and performance dominate",
  },
  general: { label: "general", delta: {}, why: "no strong domain signal: balanced default weights" },
};

export interface WeightProfile {
  name: string;
  weights: WeightMap;
  adjustments: string[];
}
/** Derive task-dependent weights. Weights are re-normalised to sum to 1. */
export function deriveWeights(
  spec?: Pick<
    TaskSpec,
    | "domain"
    | "security"
    | "licenseConstraints"
    | "performance"
    | "operatingSystems"
    | "languages"
    | "nonFunctional"
  >,
): WeightProfile {
  const w: WeightMap = { ...BASE };
  const adjustments: string[] = [];
  const dom = spec?.domain ?? "general";
  const p = PROFILES[dom];
  for (const [k, v] of Object.entries(p.delta)) w[k as keyof WeightMap] += v as number;
  adjustments.push(`domain "${p.label}": ${p.why}`);
  if (spec) {
    if (
      spec.security.some((s) => s.origin === "explicit") &&
      dom !== "authentication" &&
      dom !== "security-tooling"
    ) {
      w.security += 0.05;
      adjustments.push("explicit security requirement: security +0.05");
    }
    if (
      spec.licenseConstraints.origin === "explicit" &&
      (spec.licenseConstraints.allowed.length || spec.licenseConstraints.forbidden.length)
    ) {
      w.license += 0.05;
      adjustments.push("explicit licence constraints: licence +0.05");
    }
    if (spec.performance.some((s) => s.origin === "explicit") && dom !== "real-time") {
      w.quality += 0.03;
      w.compatibility += 0.02;
      adjustments.push("explicit performance constraint: quality/compatibility up");
    }
    if (
      spec.languages.some((l) => l.origin === "explicit") ||
      spec.operatingSystems.some((o) => o.origin === "explicit")
    ) {
      w.compatibility += 0.03;
      adjustments.push("explicit language/OS preference: compatibility +0.03");
    }
  }
  for (const k of Object.keys(w) as Array<keyof WeightMap>) w[k] = Math.max(0.01, w[k]);
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(w) as Array<keyof WeightMap>) w[k] = Math.round((w[k] / sum) * 1000) / 1000;
  return { name: p.label, weights: w, adjustments };
}
