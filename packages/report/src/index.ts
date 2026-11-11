import type { Composition, Evaluation, ImplementationPlan, TaskSpec, TrendEntry } from "@repo-scout/schemas";
import { mdEscape, sanitizeText, UNTRUSTED_NOTICE_TEXT } from "./util.js";
import { SCORE_DEFINITIONS, CONFIDENCE_DEFINITION } from "@repo-scout/scoring";

export { UNTRUSTED_NOTICE_TEXT } from "./util.js";

/** Machine-readable recommendation record with every field required by the product spec. */
export function toRecommendation(e: Evaluation) {
  const r = e.resource;
  return {
    name: r.fullName ?? r.name,
    canonicalUrl: r.canonicalUrl,
    resourceType: r.type,
    provider: r.provider,
    description: sanitizeText(r.description, 300),
    primaryLanguage: r.language ?? null,
    license: e.license.spdx ?? null,
    licenseCategory: e.license.category,
    stars: r.stars ?? null,
    downloads: r.downloads ?? null,
    lastActivity: r.pushedAt ?? r.updatedAt ?? null,
    release: r.latestRelease ?? (r.version ? { tag: r.version } : null),
    scores: {
      overall: e.overall,
      ...Object.fromEntries(
        [
          "relevance",
          "maintenance",
          "compatibility",
          "security",
          "documentation",
          "quality",
          "community",
          "license",
          "integration",
        ].map((k) => [k, e.scores[k] && e.scores[k]!.confidence > 0 ? e.scores[k]!.value : null]),
      ),
    },
    scoreConfidence: Object.fromEntries(Object.entries(e.scores).map(([k, v]) => [k, v.confidence])),
    securityIndicators: securityIndicators(e),
    confidence: e.confidence,
    evaluationLevel: e.level,
    evidence: r.evidence
      .slice(0, 3)
      .map((x) => ({ id: x.id, status: x.status, source: x.source, url: x.url, detail: x.detail })),
    reasons: e.reasons,
    limitations: e.limitations,
    alternatives: e.alternatives,
    freshness: r.freshness,
  };
}
function securityIndicators(e: Evaluation) {
  const s = e.inspection?.security;
  if (!s)
    return {
      vulnerabilityCheck: "not_performed",
      note: "No security data at this evaluation level. This is not an audit.",
    };
  return {
    vulnerabilityCheck: s.vulnerabilityCheck,
    knownVulnerabilities: s.vulnerabilities.length,
    securityPolicy: s.hasSecurityPolicy ?? null,
    lockfile: s.hasLockfile ?? null,
    installScripts: s.installScripts.length,
    agentDirectedTextInReadme: s.promptInjectionFindings.length > 0,
    note: "Indicators only. Not an audit.",
  };
}

const n = (v: number | undefined | null) => (v === undefined || v === null ? "n/a" : String(Math.round(v)));
const date = (s?: string | null) => (s ? s.slice(0, 10) : "n/a");

export function renderEvaluationMd(e: Evaluation, opts: { heading?: number } = {}): string {
  const h = "#".repeat(opts.heading ?? 3);
  const r = e.resource;
  const L: string[] = [];
  L.push(
    `${h} [${mdEscape(r.fullName ?? r.name)}](${r.canonicalUrl}) — ${e.overall}/100 (confidence ${Math.round(e.confidence * 100)}%)`,
  );
  L.push(
    `*${r.type}* via ${r.provider} · ${r.language ?? "language n/a"} · licence **${e.license.spdx ?? "none detected"}** (${e.license.category}) · ★ ${r.stars ?? "n/a"} · last activity ${date(r.pushedAt ?? r.updatedAt)} · release ${r.latestRelease?.tag ?? r.version ?? "n/a"} · level ${e.level}`,
  );
  if (r.description) L.push("", `> ${mdEscape(sanitizeText(r.description, 300))}`);
  L.push(
    "",
    `| overall | relevance | maintenance | compatibility | security | docs | quality | community | licence | integration |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    `| ${[e.overall, ...["relevance", "maintenance", "compatibility", "security", "documentation", "quality", "community", "license", "integration"].map((k) => scoreCell(e, k))].join(" | ")} |`,
  );
  if (e.reasons.length) L.push("", `**Why:** ${e.reasons.join("; ")}`);
  if (e.limitations.length) L.push("", `**Limitations:** ${e.limitations.map(mdEscape).join(" · ")}`);
  if (e.alternatives.length) L.push("", `**Alternatives:** ${e.alternatives.map(mdEscape).join(", ")}`);
  const ev = r.evidence[0];
  if (ev) L.push("", `**Evidence:** [${ev.status}] ${mdEscape(ev.detail)}${ev.url ? ` (${ev.url})` : ""}`);
  return L.join("\n");
}
function scoreCell(e: Evaluation, k: string) {
  const s = e.scores[k];
  return s ? `${n(s.value)}${s.confidence < 0.3 ? "†" : ""}` : "n/a";
}

export function renderScoreLegend(): string {
  return [
    "### Score definitions",
    "",
    ...Object.entries(SCORE_DEFINITIONS).map(([k, v]) => `- **${k}** — ${v.summary}`),
    "",
    `† = low-confidence score (little verified evidence). ${CONFIDENCE_DEFINITION}`,
  ].join("\n");
}

export function renderSpecMd(spec: TaskSpec): string {
  const tv = (a: Array<{ value: string; origin: string }>) =>
    a.length ? a.map((x) => `${x.value}${x.origin === "assumed" ? " *(assumed)*" : ""}`).join(", ") : "—";
  const L = [
    `## Task understanding`,
    `**Objective:** ${mdEscape(spec.objective)}`,
    `**Domain:** ${spec.domain} (confidence ${spec.domainConfidence})`,
    "",
    `- **Functional requirements:** ${spec.functional.map((f) => mdEscape(f.text)).join(" · ")}`,
    `- **Non-functional:** ${spec.nonFunctional.map((f) => mdEscape(f.text)).join(" · ") || "—"}`,
    `- **Performance:** ${spec.performance.map((f) => mdEscape(f.text)).join(" · ") || "—"}`,
    `- **Security:** ${spec.security.map((f) => mdEscape(f.text)).join(" · ") || "—"}`,
    `- **Languages:** ${tv(spec.languages)}`,
    `- **Frameworks:** ${tv(spec.frameworks)}`,
    `- **OS:** ${tv(spec.operatingSystems)}`,
    `- **Runtimes:** ${tv(spec.runtimes)}`,
    `- **Infrastructure:** ${tv(spec.infrastructure)}`,
    `- **Integrations:** ${tv(spec.integrations)}`,
    `- **Licence constraints (${spec.licenseConstraints.origin}):** allowed [${spec.licenseConstraints.allowed.join(", ")}] forbidden [${spec.licenseConstraints.forbidden.join(", ")}]${spec.licenseConstraints.commercialUse ? " commercial-use" : ""}`,
    "",
    "**Components:**",
    ...spec.components.map(
      (c) => `- ${c.label} — ${c.origin}${c.required ? "" : ", optional"} (${c.keywords.join(", ")})`,
    ),
  ];
  if (spec.assumptions.length)
    L.push("", "**Assumptions (not stated by you):**", ...spec.assumptions.map((a) => `- ${mdEscape(a)}`));
  return L.join("\n");
}

export function renderDiscoveryMd(
  title: string,
  evals: Evaluation[],
  counts: {
    candidatesDiscovered: number;
    shortlisted: number;
    deeplyInspected: number;
    recommendedCombinations: number;
  },
  extra: { spec?: TaskSpec; warnings?: string[]; limit?: number } = {},
): string {
  const L = [
    `# ${mdEscape(title)}`,
    "",
    `- Candidate resources discovered: **${counts.candidatesDiscovered}**`,
    `- Shortlisted: **${counts.shortlisted}**`,
    `- Deeply inspected: **${counts.deeplyInspected}**`,
    `- Recommended combinations: **${counts.recommendedCombinations}**`,
    "",
  ];
  if (extra.spec) L.push(renderSpecMd(extra.spec), "");
  L.push("## Results", "");
  for (const e of evals.slice(0, extra.limit ?? 10)) L.push(renderEvaluationMd(e), "");
  if (extra.warnings?.length) L.push("## Warnings", ...extra.warnings.map((w) => `- ${mdEscape(w)}`), "");
  L.push(renderScoreLegend(), "", `> ${UNTRUSTED_NOTICE_TEXT}`);
  return L.join("\n");
}

export function renderCompositionMd(c: Composition): string {
  const L = [
    `## ${mdEscape(c.title)}`,
    "",
    `**Integration complexity:** ${c.integrationComplexity.level} (${c.integrationComplexity.score}/100) — ${c.integrationComplexity.drivers.map(mdEscape).join("; ")}`,
    `**Compatibility:** ${c.compatibilityScore}/100 · **Coherence:** ${c.coherenceScore} · **Confidence:** ${Math.round(c.confidence * 100)}%`,
    `**Licences:** ${mdEscape(c.licenseSummary)}`,
    "",
    "### Architecture overview",
    "```text",
    c.architectureOverview,
    "```",
    "",
    "### Selected repositories",
    "",
    "| Component | Repository | Language | Licence | Score | Alternatives |",
    "|---|---|---|---|---|---|",
    ...c.components.map(
      (x) =>
        `| ${mdEscape(x.componentLabel)} | [${mdEscape(x.evaluation.resource.fullName ?? x.evaluation.resource.name)}](${x.evaluation.resource.canonicalUrl}) | ${x.evaluation.resource.language ?? "n/a"} | ${x.evaluation.resource.license ?? "none"} | ${x.evaluation.overall} | ${x.alternatives.map(mdEscape).join(", ") || "—"} |`,
    ),
    "",
    "### Why these",
    ...c.components.map((x) => `- **${mdEscape(x.componentLabel)}**: ${mdEscape(x.rationale)}`),
    "",
  ];
  if (c.issues.length)
    L.push(
      "### Potential conflicts & integration notes",
      ...c.issues
        .filter((i) => i.severity !== "info" || c.issues.length < 8)
        .map(
          (i) => `- [${i.severity}${i.status !== "verified" ? `, ${i.status}` : ""}] ${mdEscape(i.message)}`,
        ),
      "",
    );
  if (c.integrationDependencies.length)
    L.push("### Integration dependencies", ...c.integrationDependencies.map((d) => `- ${mdEscape(d)}`), "");
  if (c.missingComponents.length)
    L.push(
      "### Missing components (must be built or sourced)",
      ...c.missingComponents.map((m) => `- **${mdEscape(m.label)}** — ${mdEscape(m.reason)}`),
      "",
    );
  L.push(
    "### Implementation sequence",
    ...c.implementationSequence.map((s) => `${mdEscape(s)}`),
    "",
    "### Evidence",
    ...c.evidence.slice(0, 8).map((e) => `- ${mdEscape(e)}`),
  );
  return L.join("\n");
}

export function renderPlanMd(plan: ImplementationPlan): string {
  const L = [
    `# ${mdEscape(plan.title)}`,
    "",
    plan.summary,
    "",
    "## Reuse (do not rebuild)",
    ...plan.reuse.map(
      (r) => `- [${mdEscape(r.name)}](${r.url}) — ${mdEscape(r.role)} (${r.license ?? "licence unknown"})`,
    ),
    "",
    "## Must be built",
    ...plan.mustBuild.map((m) => `- ${mdEscape(m)}`),
    "",
    "## Steps",
    ...plan.steps.map(
      (s) =>
        `${s.order}. **${mdEscape(s.title)}**${s.approvalGate ? ` ⛔ *requires approval: ${s.approvalGate}*` : ""} — ${mdEscape(s.detail)}`,
    ),
    "",
    "## Approval gates",
    ...plan.approvalGates.flatMap((g) => [
      `- **${g.id}** (${g.action}): ${mdEscape(g.description)}`,
      ...g.commands.map((c) => `  - \`${c.replace(/`/g, "'")}\``),
    ]),
    "",
    "## Instructions for the coding agent",
    ...plan.agentInstructions.map((a) => `- ${mdEscape(a)}`),
    "",
    "## Risks",
    ...(plan.risks.length
      ? plan.risks.map((r) => `- ${mdEscape(r)}`)
      : ["- none identified (absence of evidence is not evidence of absence)"]),
  ];
  return L.join("\n");
}

export function renderTrendMd(title: string, entries: TrendEntry[], notes: string[]): string {
  const L = [
    `# ${mdEscape(title)}`,
    "",
    ...notes.map((x) => `> ${mdEscape(x)}`),
    "",
    "| Repository | ★ | Language | Trend | Maintenance | Signals |",
    "|---|---|---|---|---|---|",
  ];
  for (const e of entries) {
    const r = e.resource;
    const t =
      e.trend.label === "insufficient-data"
        ? "insufficient data"
        : `${e.trend.label.toUpperCase()} ${e.trend.starsPerDay ?? "?"}★/day`;
    L.push(
      `| [${mdEscape(r.fullName ?? r.name)}](${r.canonicalUrl}) | ${r.stars ?? "n/a"} | ${r.language ?? "n/a"} | ${t} | ${e.maintenance} | ${e.signals.slice(0, 3).map(mdEscape).join("; ")}${e.hiddenGemScore !== undefined ? `; gem ${e.hiddenGemScore}` : ""} |`,
    );
  }
  return L.join("\n");
}

export function renderCompareMd(c: {
  ranking: Array<{ rank: number; repository: string; overall: number; confidence: number }>;
  evaluations: Evaluation[];
  winnersByDimension: Record<string, string | undefined>;
  caveat: string;
}): string {
  const keys = [
    "overall",
    "relevance",
    "maintenance",
    "documentation",
    "quality",
    "compatibility",
    "security",
    "community",
    "license",
    "integration",
  ];
  const L = [
    "# Repository comparison",
    "",
    `| Dimension | ${c.evaluations.map((e) => mdEscape(e.resource.fullName ?? e.resource.name)).join(" | ")} | Best |`,
    `|---|${c.evaluations.map(() => "---").join("|")}|---|`,
    ...keys.map(
      (k) =>
        `| ${k} | ${c.evaluations.map((e) => scoreCell(e, k)).join(" | ")} | ${mdEscape(c.winnersByDimension[k] ?? "")} |`,
    ),
    "",
    "| Facts | " + c.evaluations.map((e) => mdEscape(e.resource.fullName ?? "")).join(" | ") + " |",
    `|---|${c.evaluations.map(() => "---").join("|")}|`,
    `| licence | ${c.evaluations.map((e) => e.license.spdx ?? "none").join(" | ")} |`,
    `| language | ${c.evaluations.map((e) => e.resource.language ?? "n/a").join(" | ")} |`,
    `| stars | ${c.evaluations.map((e) => e.resource.stars ?? "n/a").join(" | ")} |`,
    `| last push | ${c.evaluations.map((e) => date(e.resource.pushedAt)).join(" | ")} |`,
    `| confidence | ${c.evaluations.map((e) => Math.round(e.confidence * 100) + "%").join(" | ")} |`,
    "",
    ...c.evaluations.map(
      (e) =>
        `**${mdEscape(e.resource.fullName ?? e.resource.name)}** — limitations: ${e.limitations.map(mdEscape).join("; ") || "none noted"}`,
    ),
    "",
    `> ${mdEscape(c.caveat)}`,
  ];
  return L.join("\n");
}

// ---------------------------------------------------------------- terminal
const ESC = "\u001b[";
export function color(enabled: boolean) {
  const w = (c: string) => (s: string) => (enabled ? `${ESC}${c}m${s}${ESC}0m` : s);
  return {
    bold: w("1"),
    dim: w("2"),
    green: w("32"),
    yellow: w("33"),
    red: w("31"),
    cyan: w("36"),
    blue: w("34"),
  };
}
export function renderEvaluationTerminal(e: Evaluation, idx: number, useColor = false): string {
  const c = color(useColor);
  const r = e.resource;
  const sc = e.overall >= 65 ? c.green : e.overall >= 45 ? c.yellow : c.red;
  const L = [
    `${c.bold(`${idx}. ${r.fullName ?? r.name}`)}  ${sc(`${e.overall}/100`)}  ${c.dim(`confidence ${Math.round(e.confidence * 100)}% · ${e.level}`)}`,
    `   ${c.cyan(r.canonicalUrl)}`,
    `   ${r.type} · ${r.language ?? "?"} · ${e.license.spdx ?? "no licence"} · ★${r.stars ?? "n/a"} · active ${date(r.pushedAt ?? r.updatedAt)} · release ${r.latestRelease?.tag ?? r.version ?? "n/a"}`,
  ];
  if (r.description) L.push(`   ${sanitizeText(r.description, 140)}`);
  L.push(
    `   relevance ${n(e.scores.relevance?.value)} · maintenance ${n(e.scores.maintenance?.value)} · compat ${n(e.scores.compatibility?.value)} · security ${e.scores.security && e.scores.security.confidence >= 0.4 ? n(e.scores.security.value) : "unverified"} · docs ${n(e.scores.documentation?.value)}`,
  );
  if (e.reasons.length) L.push(`   ${c.green("+")} ${e.reasons.join("; ")}`);
  if (e.limitations.length) L.push(`   ${c.yellow("!")} ${e.limitations.slice(0, 2).join("; ")}`);
  return L.join("\n");
}
export function renderCountsTerminal(counts: {
  candidatesDiscovered: number;
  shortlisted: number;
  deeplyInspected: number;
  recommendedCombinations: number;
}): string {
  return `Candidates discovered: ${counts.candidatesDiscovered} · shortlisted: ${counts.shortlisted} · deeply inspected: ${counts.deeplyInspected} · recommended combinations: ${counts.recommendedCombinations}`;
}
