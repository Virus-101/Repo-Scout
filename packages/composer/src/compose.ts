import type { Composition, CompatibilityIssue, Evaluation, TaskSpec } from "@repo-scout/schemas";
import { analyzeLicenseSet } from "@repo-scout/scoring";
import { sha } from "@repo-scout/core";
import { setIssues } from "./compat.js";

export type Candidates = Record<string, Evaluation[]>;
export interface ComposeOptions {
  perComponent?: number;
  beam?: number;
  maxSolutions?: number;
  minComponentScore?: number;
}

const LAYER_ORDER = [
  "database",
  "vector-storage",
  "agent-memory",
  "backend",
  "authentication",
  "audio-capture",
  "video-streaming",
  "speech-to-text",
  "speaker-identification",
  "inference-runtime",
  "llm-integration",
  "agent-framework",
  "mcp-support",
  "desktop-automation",
  "screenshot-understanding",
  "object-detection",
  "ocr",
  "summarization",
  "search",
  "text-to-speech",
  "etl-orchestration",
  "stream-processing",
  "data-quality",
  "frontend",
  "notifications",
  "deployment",
  "observability",
];
const orderOf = (id: string) => {
  const i = LAYER_ORDER.indexOf(id);
  return i < 0 ? 50 : i;
};

interface Profile {
  id: string;
  title: string;
  w: { quality: number; compat: number; coverage: number; langUnity: number; license: number; maint: number };
}
const PROFILES: Profile[] = [
  {
    id: "balanced",
    title: "Best overall fit",
    w: { quality: 0.35, compat: 0.35, coverage: 0.15, langUnity: 0.05, license: 0.05, maint: 0.05 },
  },
  {
    id: "single-language",
    title: "Fewest language boundaries",
    w: { quality: 0.2, compat: 0.25, coverage: 0.1, langUnity: 0.35, license: 0.05, maint: 0.05 },
  },
  {
    id: "low-risk",
    title: "Lowest licence & maintenance risk",
    w: { quality: 0.2, compat: 0.2, coverage: 0.1, langUnity: 0.05, license: 0.25, maint: 0.2 },
  },
];

const PENALTY = { conflict: 25, warning: 8, info: 1.5 };
export function compatibilityFromIssues(issues: CompatibilityIssue[]): number {
  return Math.max(
    0,
    Math.round(
      (100 - issues.reduce((a, i) => a + PENALTY[i.severity] * (i.status === "missing" ? 0.3 : 1), 0)) * 10,
    ) / 10,
  );
}
function langUnity(evals: Evaluation[]): number {
  const langs = evals.map((e) => e.resource.language).filter(Boolean) as string[];
  if (!langs.length) return 0.5;
  const norm = langs.map((l) => (["TypeScript", "JavaScript"].includes(l) ? "JS/TS" : l));
  const counts = new Map<string, number>();
  for (const l of norm) counts.set(l, (counts.get(l) ?? 0) + 1);
  return Math.max(...counts.values()) / norm.length;
}

interface Scored {
  picks: Array<{ componentId: string; label: string; evaluation: Evaluation }>;
  issues: CompatibilityIssue[];
  compat: number;
  objective: number;
  mean: number;
}

function scorePicks(
  picks: Scored["picks"],
  totalRequired: number,
  requiredCovered: number,
  p: Profile,
  projectLicense?: string,
): Scored {
  const evals = picks.map((x) => x.evaluation);
  const issues = setIssues(
    evals,
    picks.map((x) => x.label),
  );
  const lic = analyzeLicenseSet(
    evals.map((e) => ({ name: e.resource.fullName ?? e.resource.name, license: e.resource.license })),
    projectLicense,
  );
  for (const li of lic.issues)
    issues.push({
      severity: li.severity,
      kind: "license",
      between: li.between,
      message: li.message,
      status: "verified",
    });
  const compat = compatibilityFromIssues(issues);
  const mean = evals.reduce((a, e) => a + e.overall, 0) / Math.max(1, evals.length);
  const licScore = evals.reduce((a, e) => a + (e.scores.license?.value ?? 50), 0) / Math.max(1, evals.length);
  const maint =
    evals.reduce((a, e) => a + (e.scores.maintenance?.value ?? 50), 0) / Math.max(1, evals.length);
  const coverage = totalRequired ? (requiredCovered / totalRequired) * 100 : 100;
  const objective =
    p.w.quality * mean +
    p.w.compat * compat +
    p.w.coverage * coverage +
    p.w.langUnity * langUnity(evals) * 100 +
    p.w.license * licScore +
    p.w.maint * maint;
  return { picks, issues, compat, objective, mean };
}

/**
 * Solution Composer. Chooses ONE repository per component need such that the whole combination is coherent.
 * Individual popularity never decides: the objective weighs pairwise compatibility, licence set, language unity and coverage.
 */
export function composeSolutions(
  spec: TaskSpec,
  candidates: Candidates,
  opts: ComposeOptions = {},
): Composition[] {
  const K = opts.perComponent ?? 4,
    beam = opts.beam ?? 24,
    minScore = opts.minComponentScore ?? 35;
  const needs = spec.components.map((c) => ({
    c,
    cands: (candidates[c.id] ?? [])
      .filter((e) => e.resource.type === "repository" || e.resource.type === "package")
      .filter((e) => e.overall >= minScore)
      .sort((a, b) => b.overall - a.overall)
      .slice(0, K),
  }));
  const active = needs.filter((n) => n.cands.length).sort((a, b) => orderOf(a.c.id) - orderOf(b.c.id));
  const missing = needs.filter((n) => !n.cands.length);
  const requiredTotal = needs.filter((n) => n.c.required).length;
  if (!active.length) return [];
  const results: Scored[] = [];
  for (const p of PROFILES) {
    let frontier: Scored["picks"][] = [[]];
    for (const n of active) {
      const next: Array<{ picks: Scored["picks"]; obj: number }> = [];
      for (const f of frontier)
        for (const e of n.cands) {
          if (f.some((x) => x.evaluation.resource.id === e.resource.id)) continue;
          const picks = [...f, { componentId: n.c.id, label: n.c.label, evaluation: e }];
          const covered = picks.filter((x) => needs.find((m) => m.c.id === x.componentId)?.c.required).length;
          next.push({
            picks,
            obj: scorePicks(picks, requiredTotal, covered, p, spec.licenseConstraints.projectLicense)
              .objective,
          });
        }
      next.sort((a, b) => b.obj - a.obj);
      frontier = next.slice(0, beam).map((x) => x.picks);
      if (!frontier.length) frontier = [[]];
    }
    for (const picks of frontier.slice(0, 6)) {
      const covered = picks.filter((x) => needs.find((m) => m.c.id === x.componentId)?.c.required).length;
      const s = scorePicks(picks, requiredTotal, covered, p, spec.licenseConstraints.projectLicense);
      (s as any).profile = p;
      results.push(s);
    }
  }
  // choose distinct solutions: best per profile first, then fill
  const key = (s: Scored) =>
    s.picks
      .map((x) => x.evaluation.resource.id)
      .sort()
      .join("|");
  const chosen: Array<Scored & { profile?: Profile }> = [];
  const seen = new Set<string>();
  for (const p of PROFILES) {
    const mine = results
      .filter((r) => (r as any).profile.id === p.id)
      .sort((a, b) => b.objective - a.objective);
    const best = mine.find((r) => !seen.has(key(r)));
    if (best) {
      (best as any).own = best === mine[0];
      chosen.push(best as any);
      seen.add(key(best));
    }
  }
  for (const r of results.sort((a, b) => b.objective - a.objective)) {
    if (chosen.length >= (opts.maxSolutions ?? 3)) break;
    if (!seen.has(key(r))) {
      chosen.push(r as any);
      seen.add(key(r));
    }
  }
  const final = chosen.slice(0, opts.maxSolutions ?? 3);
  const first = final[0];
  return final.map((s, idx) => {
    let profile = (s as any).profile as Profile;
    if (!(s as any).own && first) {
      // fallback pick (the profile's own best was already used): describe what actually differs instead of reusing a misleading label
      const diff = s.picks
        .filter(
          (p) =>
            first.picks.find((q) => q.componentId === p.componentId)?.evaluation.resource.id !==
            p.evaluation.resource.id,
        )
        .map((p) => p.label);
      profile = {
        ...profile,
        title: `Alternative combination (differs in: ${diff.join(", ") || "selection"})`,
      };
    }
    return toComposition(
      spec,
      s,
      profile,
      active,
      missing.map((m) => m.c),
      candidates,
      idx,
    );
  });
}

function toComposition(
  spec: TaskSpec,
  s: Scored,
  profile: Profile,
  active: Array<{ c: TaskSpec["components"][number] }>,
  missing: TaskSpec["components"],
  candidates: Candidates,
  idx: number,
): Composition {
  const sorted = [...s.picks].sort((a, b) => orderOf(a.componentId) - orderOf(b.componentId));
  const evals = sorted.map((x) => x.evaluation);
  const langs = [...new Set(evals.map((e) => e.resource.language).filter(Boolean))] as string[];
  const crossEdges = s.issues.filter((i) => i.kind === "language").length;
  const conflicts = s.issues.filter((i) => i.severity === "conflict").length;
  const unverified = s.issues.filter((i) => i.status === "missing").length;
  const drivers: string[] = [];
  let score =
    evals.length * 4 +
    crossEdges * 9 +
    conflicts * 18 +
    missing.length * 10 +
    (langs.length > 2 ? 10 : 0) +
    (unverified ? 5 : 0);
  if (crossEdges)
    drivers.push(`${crossEdges} cross-language integration boundar${crossEdges > 1 ? "ies" : "y"}`);
  if (conflicts) drivers.push(`${conflicts} compatibility conflict(s)`);
  if (missing.length) drivers.push(`${missing.length} component(s) must be built or sourced elsewhere`);
  if (langs.length > 2) drivers.push(`${langs.length} languages in one solution`);
  drivers.push(`${evals.length} components to wire together`);
  if (unverified) drivers.push("dependency conflicts not verified (manifests not inspected)");
  score = Math.min(100, score);
  const level = score < 25 ? "low" : score < 50 ? "medium" : score < 75 ? "high" : "very-high";
  const lic = analyzeLicenseSet(
    evals.map((e) => ({ name: e.resource.fullName ?? e.resource.name, license: e.resource.license })),
    spec.licenseConstraints.projectLicense,
  );
  const inspected = evals.filter((e) => e.inspection).length;
  const confidence =
    Math.round(
      (evals.reduce((a, e) => a + e.confidence, 0) / Math.max(1, evals.length)) *
        (inspected === evals.length ? 1 : 0.85) *
        100,
    ) / 100;
  const flow = sorted
    .map((x) => `${x.label} → ${x.evaluation.resource.fullName ?? x.evaluation.resource.name}`)
    .join("\n");
  const overview = `${profile.title}. Layered stack (lower layers first):\n${flow}\nLanguages: ${langs.join(", ") || "unknown"}. ${missing.length ? `Not covered by any acceptable candidate: ${missing.map((m) => m.label).join(", ")}.` : "All identified components have a candidate."}`;
  const sequence: string[] = sorted.map(
    (x, i) =>
      `${i + 1}. Stand up ${x.label} using ${x.evaluation.resource.fullName ?? x.evaluation.resource.name} and verify it in isolation (read its docs; do not run unreviewed install scripts).`,
  );
  sequence.push(
    `${sequence.length + 1}. Write the glue/adapters between neighbouring components (resolve: ${
      s.issues
        .filter((i) => i.severity !== "info")
        .slice(0, 3)
        .map((i) => i.kind)
        .join(", ") || "no open compatibility warnings"
    }).`,
  );
  for (const m of missing)
    sequence.push(
      `${sequence.length + 1}. Build or source "${m.label}" (no suitable existing candidate found).`,
    );
  sequence.push(
    `${sequence.length + 1}. Add end-to-end tests of the complete flow, then deployment configuration.`,
  );
  const integrationDeps = [
    ...new Set(s.issues.filter((i) => i.severity !== "info").map((i) => i.message)),
  ].slice(0, 12);
  return {
    id: `sol-${sha(sorted.map((x) => x.evaluation.resource.id).join("|") + idx)}`,
    title: `Option ${idx + 1}: ${profile.title}`,
    architectureOverview: overview,
    components: sorted.map((x) => ({
      componentId: x.componentId,
      componentLabel: x.label,
      evaluation: x.evaluation,
      rationale: `${x.evaluation.resource.fullName ?? x.evaluation.resource.name} scored ${x.evaluation.overall}/100 (confidence ${x.evaluation.confidence}) for ${x.label}; chosen for fit with the other selections, not for popularity alone.${x.evaluation.reasons.length ? " Strengths: " + x.evaluation.reasons.join(", ") + "." : ""}`,
      alternatives: (candidates[x.componentId] ?? [])
        .filter((e) => e.resource.id !== x.evaluation.resource.id)
        .slice(0, 3)
        .map((e) => e.resource.fullName ?? e.resource.name),
    })),
    integrationDependencies: integrationDeps,
    issues: s.issues,
    missingComponents: missing.map((m) => ({
      componentId: m.id,
      label: m.label,
      reason:
        "No candidate reached the minimum evaluation score; likely needs custom development or a non-open-source option.",
    })),
    integrationComplexity: { level, score, drivers },
    compatibilityScore: s.compat,
    coherenceScore: Math.round(s.objective * 10) / 10,
    implementationSequence: sequence,
    confidence,
    evidence: evals.flatMap((e) =>
      e.resource.evidence
        .slice(0, 1)
        .map(
          (x) =>
            `${e.resource.fullName ?? e.resource.name}: ${x.detail} (${x.status}${x.url ? ", " + x.url : ""})`,
        ),
    ),
    licenseSummary: lic.summary,
  };
}
