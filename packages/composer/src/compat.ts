import type { CompatibilityIssue, Dependency, Evaluation } from "@repo-scout/schemas";
import { declaredVersion } from "@repo-scout/analysis";

const SERVICE_SURFACE = /HTTP API|gRPC|GraphQL|WebSocket|MCP server|CLI/;
const JS = new Set(["javascript", "typescript"]);
const sameRuntimeFamily = (a?: string, b?: string) =>
  !!a &&
  !!b &&
  (a.toLowerCase() === b.toLowerCase() ||
    (JS.has(a.toLowerCase()) && JS.has(b.toLowerCase())) ||
    (["c", "c++"].includes(a.toLowerCase()) && ["c", "c++"].includes(b.toLowerCase())) ||
    (["java", "kotlin"].includes(a.toLowerCase()) && ["java", "kotlin"].includes(b.toLowerCase())));
const name = (e: Evaluation) => e.resource.fullName ?? e.resource.name;
const text = (e: Evaluation) =>
  `${e.resource.description} ${e.resource.topics.join(" ")} ${e.inspection?.apiSurface.join(" ") ?? ""} ${e.inspection?.frameworks.join(" ") ?? ""}`.toLowerCase();
const UI_FW = ["React", "Vue", "Svelte", "Angular", "Next.js"];

export interface PairContext {
  componentA: string;
  componentB: string;
}

export function pairIssues(a: Evaluation, b: Evaluation, ctx: PairContext): CompatibilityIssue[] {
  const out: CompatibilityIssue[] = [];
  const la = a.resource.language,
    lb = b.resource.language;
  const between = [name(a), name(b)];
  const exposes = (e: Evaluation) =>
    (e.inspection?.apiSurface ?? []).some((s) => SERVICE_SURFACE.test(s)) ||
    /\b(api|server|sdk|rest|grpc|cli|mcp|openai-compatible)\b/.test(text(e));
  if (la && lb && !sameRuntimeFamily(la, lb)) {
    const bridged = exposes(a) || exposes(b);
    out.push({
      severity: bridged ? "info" : "warning",
      kind: "language",
      between,
      status: "inferred",
      message: bridged
        ? `${la} ↔ ${lb}: cross-language boundary; at least one side advertises an API/CLI/SDK so integration over a process/network boundary looks feasible (${ctx.componentA} ↔ ${ctx.componentB}).`
        : `${la} ↔ ${lb}: cross-language and neither side advertises an API/CLI/SDK; a custom bridge (FFI, subprocess or wrapper service) is likely required.`,
    });
  }
  // UI framework clash
  const fa = a.inspection?.frameworks.filter((f) => UI_FW.includes(f)) ?? [],
    fb = b.inspection?.frameworks.filter((f) => UI_FW.includes(f)) ?? [];
  if (fa.length && fb.length && !fa.some((f) => fb.includes(f)))
    out.push({
      severity: "conflict",
      kind: "framework",
      between,
      status: "verified",
      message: `Competing UI frameworks (${fa.join("/")} vs ${fb.join("/")}) cannot share one component tree.`,
    });
  // runtime
  const ra = a.inspection?.runtime ?? [],
    rb = b.inspection?.runtime ?? [];
  const gpu = (r: string[]) => r.some((x) => /gpu|cuda/.test(x));
  if (gpu(ra) !== gpu(rb) && (gpu(ra) || gpu(rb)))
    out.push({
      severity: "info",
      kind: "runtime",
      between,
      status: "inferred",
      message: `${gpu(ra) ? name(a) : name(b)} is GPU-oriented; make sure the deployment target offers a GPU (or a CPU fallback).`,
    });
  const nodeA = ra.find((x) => x.startsWith("node")),
    nodeB = rb.find((x) => x.startsWith("node"));
  if (nodeA && nodeB && nodeA !== nodeB)
    out.push({
      severity: "info",
      kind: "runtime",
      between,
      status: "verified",
      message: `Different Node engine requirements (${nodeA} vs ${nodeB}); pick a Node version satisfying both.`,
    });
  // dependency conflicts (same package, different major) - only when both inspected
  if (a.inspection && b.inspection) {
    const idx = (deps: Dependency[]) =>
      new Map(deps.filter((d) => !d.dev).map((d) => [`${d.ecosystem}:${d.name}`, declaredVersion(d.spec)]));
    const ma = idx(a.inspection.dependencies),
      mb = idx(b.inspection.dependencies);
    for (const [k, va] of ma) {
      const vb = mb.get(k);
      if (va && vb && va.split(".")[0] !== vb.split(".")[0] && k.startsWith("pypi:"))
        out.push({
          severity: "warning",
          kind: "dependency",
          between,
          status: "verified",
          message: `Both depend on ${k.split(":")[1]} with different major versions (${va} vs ${vb}); they likely cannot share one Python environment.`,
        });
      else if (va && vb && va.split(".")[0] !== vb.split(".")[0])
        out.push({
          severity: "info",
          kind: "dependency",
          between,
          status: "verified",
          message: `Both depend on ${k.split(":")[1]} with different major versions (${va} vs ${vb}); isolate via separate processes/packages.`,
        });
    }
  } else
    out.push({
      severity: "info",
      kind: "dependency",
      between,
      status: "missing",
      message:
        "Dependency manifests of one or both components were not inspected: version conflicts are unverified.",
    });
  // API compatibility hints
  const openaiA = /openai[- ]compatible|openai api/.test(text(a)),
    openaiB =
      /openai|chat completions/.test(text(b)) || (b.inspection?.frameworks.includes("OpenAI SDK") ?? false);
  if ((openaiA && openaiB) || (/openai[- ]compatible/.test(text(b)) && /openai/.test(text(a))))
    out.push({
      severity: "info",
      kind: "api",
      between,
      status: "inferred",
      message:
        "OpenAI-compatible API on one side and an OpenAI-style client on the other: a natural integration seam.",
    });
  if (/\bmcp\b|model context protocol/.test(text(a)) && /\bmcp\b|model context protocol/.test(text(b)))
    out.push({
      severity: "info",
      kind: "api",
      between,
      status: "inferred",
      message: "Both speak MCP: they can interoperate via the Model Context Protocol.",
    });
  return out;
}

export function setIssues(evals: Evaluation[], labels: string[]): CompatibilityIssue[] {
  const out: CompatibilityIssue[] = [];
  for (let i = 0; i < evals.length; i++)
    for (let j = i + 1; j < evals.length; j++)
      out.push(...pairIssues(evals[i]!, evals[j]!, { componentA: labels[i]!, componentB: labels[j]! }));
  // deployment uniformity
  const insp = evals.filter((e) => e.inspection?.structure);
  if (insp.length >= 2) {
    const withDocker = insp.filter((e) => e.inspection!.structure!.hasDockerfile);
    if (withDocker.length > 0 && withDocker.length < insp.length)
      out.push({
        severity: "info",
        kind: "deployment",
        between: insp.filter((e) => !e.inspection!.structure!.hasDockerfile).map(name),
        status: "verified",
        message: `Some components ship a Dockerfile (${withDocker.map(name).join(", ")}) and some do not; you will need to containerise the rest for a uniform deployment.`,
      });
  }
  // auth coupling
  const auth = evals.findIndex((_, i) => labels[i] === "Authentication");
  if (auth >= 0) {
    const t = `${evals[auth]!.resource.topics.join(" ")} ${evals[auth]!.resource.description}`.toLowerCase();
    if (!/oidc|oauth|openid|jwt|saml/.test(t))
      out.push({
        severity: "warning",
        kind: "auth",
        between: [name(evals[auth]!)],
        status: "inferred",
        message:
          "Authentication component does not advertise OIDC/OAuth2/JWT in its metadata; token hand-off to the backend is unverified.",
      });
    else
      out.push({
        severity: "info",
        kind: "auth",
        between: [name(evals[auth]!)],
        status: "inferred",
        message:
          "Advertises standard token protocols (OIDC/OAuth2/JWT): the backend can validate tokens without bespoke glue.",
      });
  }
  return out;
}
