import { describe, expect, it } from "vitest";
import {
  composeSolutions,
  compatibilityFromIssues,
  pairIssues,
  planFromComposition,
  planFromEvaluations,
  buildApprovalGates,
  SECURITY_NOTICES,
} from "@repo-scout/composer";
import { evaluate } from "@repo-scout/scoring";
import { understandTask } from "@repo-scout/intelligence";
import { CompositionSchema, ImplementationPlanSchema, type Evaluation } from "@repo-scout/schemas";
import { res } from "../helpers.js";

const ev = (
  name: string,
  o: Record<string, unknown> = {},
  ctx: Record<string, unknown> = {},
  adjust?: (e: Evaluation) => void,
): Evaluation => {
  const e = evaluate(res({ name, fullName: name, description: "speech tool api sdk", ...o }), {
    relevance: 0.8,
    ...ctx,
  });
  adjust?.(e);
  return e;
};
const spec = understandTask(
  "A meeting assistant that records audio, transcribes speech to text, and summarizes with an llm, as a web ui frontend",
);
const keep = (...ids: string[]) => ({
  ...spec,
  components: spec.components.filter((c) => ids.includes(c.id)),
});

describe("compatibility analysis", () => {
  it("flags cross-language boundaries, softer when an API surface exists", () => {
    const py = ev("a/py", { language: "Python", description: "no hints" }),
      js = ev("b/js", { language: "TypeScript", description: "no hints" });
    const issues = pairIssues(py, js, { componentA: "A", componentB: "B" });
    expect(issues.find((i) => i.kind === "language")?.severity).toBe("warning");
    const api = ev("c/api", { language: "TypeScript", description: "http api server sdk" });
    expect(
      pairIssues(py, api, { componentA: "A", componentB: "B" }).find((i) => i.kind === "language")?.severity,
    ).toBe("info");
    expect(
      pairIssues(py, ev("d/py2", { language: "Python" }), { componentA: "A", componentB: "B" }).some(
        (i) => i.kind === "language",
      ),
    ).toBe(false);
    expect(
      pairIssues(ev("e/ts", { language: "TypeScript" }), ev("f/js", { language: "JavaScript" }), {
        componentA: "A",
        componentB: "B",
      }).some((i) => i.kind === "language"),
    ).toBe(false);
  });
  it("detects UI framework clashes and dependency major-version conflicts when inspected", () => {
    const base = {
      level: "3-deep" as const,
      manifests: [],
      frameworks: [],
      architecturePatterns: [],
      apiSurface: [],
      runtime: [],
      limitations: [],
    };
    const a = ev(
      "a/ui",
      {},
      {
        inspection: {
          ...base,
          frameworks: ["React"],
          dependencies: [{ name: "numpy", spec: "1.26.0", ecosystem: "pypi", dev: false, manifest: "r" }],
        },
      },
    );
    const b = ev(
      "b/ui",
      {},
      {
        inspection: {
          ...base,
          frameworks: ["Vue"],
          dependencies: [{ name: "numpy", spec: "2.0.0", ecosystem: "pypi", dev: false, manifest: "r" }],
        },
      },
    );
    const issues = pairIssues(a, b, { componentA: "A", componentB: "B" });
    expect(issues.some((i) => i.kind === "framework" && i.severity === "conflict")).toBe(true);
    expect(issues.some((i) => i.kind === "dependency" && i.severity === "warning")).toBe(true);
  });
  it("marks un-inspected dependency compatibility as unverified, not fine", () => {
    const issues = pairIssues(ev("a/x"), ev("b/y"), { componentA: "A", componentB: "B" });
    expect(issues.find((i) => i.kind === "dependency")).toMatchObject({ status: "missing" });
  });
  it("scores compatibility from issues", () => {
    expect(compatibilityFromIssues([])).toBe(100);
    expect(
      compatibilityFromIssues([
        { severity: "conflict", kind: "other", between: [], message: "", status: "verified" },
      ]),
    ).toBe(75);
    expect(
      compatibilityFromIssues([
        { severity: "warning", kind: "other", between: [], message: "", status: "verified" },
      ]),
    ).toBeGreaterThan(
      compatibilityFromIssues([
        { severity: "conflict", kind: "other", between: [], message: "", status: "verified" },
      ]),
    );
  });
});

describe("solution composer", () => {
  it("prefers a coherent combination over individually higher-scoring but clashing picks", () => {
    // stt: Rust option scores highest alone, Python option slightly lower; llm & summarizer are Python => coherent stack wins in single-language profile
    const s = keep("speech-to-text", "llm-integration", "summarization");
    const cands = {
      "speech-to-text": [
        ev(
          "rust/stt",
          { language: "Rust", description: "speech to text engine", stars: 90000, forks: 9000 },
          { relevance: 0.95 },
        ),
        ev(
          "py/stt",
          { language: "Python", description: "speech to text engine", stars: 3000 },
          { relevance: 0.85 },
        ),
      ],
      "llm-integration": [ev("py/llm", { language: "Python", description: "llm inference runtime" })],
      summarization: [ev("py/sum", { language: "Python", description: "meeting summarizer llm" })],
    };
    const out = composeSolutions(s, cands, { maxSolutions: 3 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const best = out[0]!,
      rust = out.find((o) => o.components.some((c) => c.evaluation.resource.fullName === "rust/stt"))!;
    expect(
      best.components.find((c) => c.componentId === "speech-to-text")!.evaluation.resource.fullName,
    ).toBe("py/stt"); // despite rust/stt scoring higher alone
    expect(best.compatibilityScore).toBeGreaterThan(rust.compatibilityScore);
    expect(best.coherenceScore).toBeGreaterThan(rust.coherenceScore);
    expect(rust.title).toMatch(/Alternative combination/);
    for (const o of out) expect(CompositionSchema.safeParse(o).success).toBe(true);
  });
  it("produces distinct options with alternatives, sequence, complexity and evidence", () => {
    const s = keep("speech-to-text", "llm-integration");
    const out = composeSolutions(s, {
      "speech-to-text": [ev("a/s1"), ev("a/s2", { language: "Go" })],
      "llm-integration": [ev("a/l1"), ev("a/l2", { language: "Rust" })],
    });
    const keys = out.map((o) =>
      o.components
        .map((c) => c.evaluation.resource.id)
        .sort()
        .join(),
    );
    expect(new Set(keys).size).toBe(out.length);
    const o = out[0]!;
    expect(o.components[0]!.alternatives.length).toBeGreaterThan(0);
    expect(o.implementationSequence.length).toBeGreaterThanOrEqual(o.components.length + 2);
    expect(["low", "medium", "high", "very-high"]).toContain(o.integrationComplexity.level);
    expect(o.evidence.length).toBeGreaterThan(0);
    expect(o.architectureOverview).toMatch(/→/);
  });
  it("reports missing components instead of fabricating candidates", () => {
    const s = keep("speech-to-text", "speaker-identification");
    const out = composeSolutions(s, { "speech-to-text": [ev("a/s")], "speaker-identification": [] });
    expect(out[0]!.missingComponents.map((m) => m.componentId)).toEqual(["speaker-identification"]);
    expect(out[0]!.implementationSequence.join()).toMatch(/Build or source/);
    expect(composeSolutions(s, {})).toEqual([]);
  });
  it("ignores candidates below the minimum score", () => {
    const weak = ev("a/weak", { archived: true });
    weak.overall = 10;
    expect(composeSolutions(keep("speech-to-text"), { "speech-to-text": [weak] })).toEqual([]);
  });
  it("surfaces licence conflicts across the combination and project licence", () => {
    const s = {
      ...keep("speech-to-text", "llm-integration"),
      licenseConstraints: {
        allowed: [],
        forbidden: [],
        projectLicense: "Proprietary",
        origin: "explicit" as const,
      },
    };
    const out = composeSolutions(s, {
      "speech-to-text": [ev("a/gpl", { license: "AGPL-3.0" })],
      "llm-integration": [ev("a/mit", { license: "MIT" })],
    });
    expect(out[0]!.issues.some((i) => i.kind === "license" && i.severity === "conflict")).toBe(true);
    expect(out[0]!.licenseSummary).toMatch(/copyleft/i);
    expect(out[0]!.compatibilityScore).toBeLessThan(100);
  });
  it("never reuses one repository for two components", () => {
    const same = ev("a/both");
    const out = composeSolutions(keep("speech-to-text", "llm-integration"), {
      "speech-to-text": [same],
      "llm-integration": [same],
    });
    expect(
      out.every(
        (o) => new Set(o.components.map((c) => c.evaluation.resource.id)).size === o.components.length,
      ),
    ).toBe(true);
  });
});

describe("implementation plan & approval boundaries", () => {
  const comp = composeSolutions(keep("speech-to-text", "llm-integration"), {
    "speech-to-text": [ev("a/s")],
    "llm-integration": [ev("a/l")],
  })[0]!;
  it("contains every approval gate and never performs actions itself", () => {
    const plan = planFromComposition(keep("speech-to-text"), comp);
    expect(ImplementationPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.approvalGates.map((g) => g.action).sort()).toEqual([
      "clone",
      "execute-commands",
      "install-dependencies",
      "modify-existing-project",
      "write-files",
    ]);
    expect(plan.approvalGates.every((g) => g.required === true)).toBe(true);
    for (const s of plan.steps.filter((s) => /clone|Install|Write adapters|Modify|Test end/i.test(s.title)))
      expect(s.approvalGate, s.title).toBeDefined();
    expect(plan.steps[0]!.title).toMatch(/Present this plan/);
    expect(plan.agentInstructions.join()).toMatch(/approval/i);
    expect(plan.securityNotices).toEqual(SECURITY_NOTICES);
  });
  it("clone commands are hardened (no hooks, shallow, no submodules, no symlinks)", () => {
    const cmd = buildApprovalGates([{ name: "x", url: "https://github.com/a/x" }])[0]!.commands[0]!;
    expect(cmd).toMatch(/core\.hooksPath=\/dev\/null/);
    expect(cmd).toMatch(/--depth 1/);
    expect(cmd).toMatch(/--no-recurse-submodules/);
    expect(cmd).toMatch(/core\.symlinks=false/);
    expect(cmd).toMatch(/<scratch>/);
  });
  it("falls back to a plan from plain evaluations", () => {
    const p = planFromEvaluations(understandTask("json diff"), [ev("a/diff")]);
    expect(p.reuse).toHaveLength(1);
    expect(p.approvalGates).toHaveLength(5);
  });
});
