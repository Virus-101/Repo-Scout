import type {
  Evaluation,
  EvidenceStatus,
  Inspection,
  Resource,
  Score,
  ScoreFactor,
  ScoreName,
  TaskSpec,
} from "@repo-scout/schemas";
import { clamp, daysSince } from "@repo-scout/core";
import { classifyLicense, licenseSuitability } from "./license.js";
import { deriveWeights, type WeightMap } from "./weights.js";
import { tokenize } from "./retrieval.js";

const STATUS_CONF: Record<EvidenceStatus, number> = {
  verified: 1,
  inferred: 0.6,
  assumption: 0.25,
  missing: 0,
};

/** Combine factors: 'missing' factors are excluded from the value (never guessed) and reduce confidence. */
export function combine(name: ScoreName, factors: ScoreFactor[], explanation: string): Score {
  const known = factors.filter((f) => f.status !== "missing");
  const wAll = factors.reduce((a, f) => a + f.weight, 0) || 1;
  const wKnown = known.reduce((a, f) => a + f.weight, 0);
  const value = wKnown > 0 ? (known.reduce((a, f) => a + f.value * f.weight, 0) / wKnown) * 100 : 50;
  const confidence = factors.reduce((a, f) => a + f.weight * STATUS_CONF[f.status], 0) / wAll;
  return {
    name,
    value: Math.round(value * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    factors,
    explanation:
      wKnown > 0
        ? explanation
        : `${explanation} (no evidence available: neutral 50 shown with zero confidence)`,
  };
}
const f = (
  name: string,
  value: number,
  weight: number,
  status: EvidenceStatus,
  detail: string,
  evidenceId?: string,
): ScoreFactor => ({ name, value: clamp(value), weight, status, detail, evidenceId });
const ev = (r: Resource) => r.evidence[0]?.id;

export interface EvalContext {
  spec?: TaskSpec;
  /** 0..1 hybrid retrieval score for this resource vs. the query. */
  relevance?: number;
  /** component keywords for the need this resource is evaluated against */
  componentKeywords?: string[];
  inspection?: Inspection;
  now?: number;
}

// ---------------------------------------------------------------- individual scores
function relevanceScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  if (c.relevance !== undefined)
    fs.push(
      f(
        "hybrid retrieval",
        c.relevance,
        0.7,
        "inferred",
        `BM25+metadata${c.relevance ? "" : " (no term overlap)"} score ${c.relevance.toFixed(2)}`,
      ),
    );
  else fs.push(f("hybrid retrieval", 0, 0.7, "missing", "no query was supplied"));
  if (c.componentKeywords?.length) {
    const text = new Set([
      ...tokenize(`${r.name} ${r.description}`),
      ...r.topics.flatMap((t) => tokenize(t)),
    ]);
    const hits = c.componentKeywords.filter((k) => tokenize(k).every((t) => text.has(t))).length;
    fs.push(
      f(
        "component keywords",
        Math.min(1, hits / Math.min(3, c.componentKeywords.length)),
        0.3,
        "inferred",
        `${hits}/${c.componentKeywords.length} component keywords found in name/description/topics`,
      ),
    );
  }
  return combine(
    "relevance",
    fs,
    "Match between the resource's name, description and topics and the request.",
  );
}
function maintenanceScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const dPush = daysSince(r.pushedAt ?? r.updatedAt, c.now);
  const recency = (d: number) =>
    d < 30 ? 1 : d < 90 ? 0.85 : d < 180 ? 0.65 : d < 365 ? 0.4 : d < 730 ? 0.2 : 0.05;
  fs.push(
    dPush === undefined
      ? f("last push", 0, 0.4, "missing", "no push/update date")
      : f("last push", recency(dPush), 0.4, "verified", `${Math.round(dPush)} days since last push`, ev(r)),
  );
  const rel = r.latestRelease;
  const dRel = daysSince(rel?.publishedAt, c.now);
  fs.push(
    dRel === undefined
      ? f(
          "release recency",
          0,
          0.2,
          r.type === "repository" ? "missing" : "missing",
          r.type === "package" ? "no publish date" : "no release information retrieved",
        )
      : f(
          "release recency",
          recency(dRel * 0.75),
          0.2,
          "verified",
          `latest release ${rel?.tag} ${Math.round(dRel)} days ago`,
        ),
  );
  const act = c.inspection?.commitActivity90d;
  fs.push(
    act === undefined
      ? f("commit activity", 0, 0.25, "missing", "commit statistics not retrieved")
      : f("commit activity", Math.min(1, act / 60), 0.25, "verified", `${act} commits in last ~90 days`),
  );
  if (r.archived !== undefined)
    fs.push(
      f(
        "not archived",
        r.archived ? 0 : 1,
        0.15,
        "verified",
        r.archived ? "repository is archived (read-only, no future fixes)" : "not archived",
        ev(r),
      ),
    );
  const s = combine(
    "maintenance",
    fs,
    "Recency of pushes/releases, recent commit volume and archive status.",
  );
  return r.archived ? { ...s, value: Math.min(s.value, 10) } : s;
}
function documentationScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const hasDesc = r.description.trim().length > 20;
  fs.push(
    f(
      "description",
      hasDesc ? 1 : r.description ? 0.4 : 0,
      0.15,
      "verified",
      hasDesc ? "descriptive summary present" : "missing/short description",
    ),
  );
  fs.push(
    f(
      "homepage/docs link",
      r.homepage ? 1 : 0.3,
      0.1,
      "verified",
      r.homepage ? `homepage: ${r.homepage}` : "no homepage",
    ),
  );
  fs.push(f("topics", Math.min(1, r.topics.length / 4), 0.1, "verified", `${r.topics.length} topics`));
  const readme = (r.metadata.readmeHead as string | undefined) ?? c.inspection?.readmeExcerpt;
  const len = r.metadata.readmeLength as number | undefined;
  if (readme !== undefined || len !== undefined) {
    const n = len ?? readme!.length;
    const lower = (readme ?? "").toLowerCase();
    fs.push(f("README size", Math.min(1, n / 3000), 0.25, "verified", `README ~${n} chars`));
    const sections = ["install", "usage", "example", "getting started", "api", "license", "contribut"].filter(
      (s) => lower.includes(s),
    ).length;
    if (readme)
      fs.push(
        f(
          "README sections",
          Math.min(1, sections / 4),
          0.25,
          "inferred",
          `${sections} common sections detected (install/usage/examples/API...)`,
        ),
      );
  } else fs.push(f("README", 0, 0.5, "missing", "README not retrieved at this level"));
  if (c.inspection?.structure)
    fs.push(
      f(
        "docs directory",
        c.inspection.structure.hasDocsDir ? 1 : 0.3,
        0.15,
        "verified",
        c.inspection.structure.hasDocsDir ? "docs/ present" : "no docs/ directory",
      ),
    );
  return combine(
    "documentation",
    fs,
    "README depth and structure, docs directory, homepage and description.",
  );
}
function qualityScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const s = c.inspection?.structure;
  if (s) {
    fs.push(
      f(
        "tests",
        s.hasTests ? 1 : 0.1,
        0.35,
        "verified",
        s.hasTests ? "test files/directories found in tree" : "no test files found in tree (static check)",
      ),
    );
    fs.push(
      f(
        "CI",
        s.hasCI ? 1 : 0.2,
        0.2,
        "verified",
        s.hasCI ? "CI workflow configuration present" : "no CI configuration found",
      ),
    );
    fs.push(
      f(
        "containerisation",
        s.hasDockerfile ? 0.8 : 0.4,
        0.05,
        "verified",
        s.hasDockerfile ? "Dockerfile present" : "no Dockerfile",
      ),
    );
    const typed =
      c.inspection!.architecturePatterns.some((p) => /typed|typescript|mypy|type-check/i.test(p)) ||
      r.language === "TypeScript" ||
      r.language === "Rust" ||
      r.language === "Go";
    fs.push(
      f(
        "static typing",
        typed ? 1 : 0.4,
        0.1,
        "inferred",
        typed ? "statically typed language or type-checking config" : "no static typing signal",
      ),
    );
    fs.push(
      f(
        "structure",
        s.topLevel.length > 3 ? 0.8 : 0.4,
        0.1,
        "verified",
        `${s.topLevel.length} top-level entries${s.truncated ? " (tree truncated)" : ""}`,
      ),
    );
  } else
    fs.push(f("tests/CI/structure", 0, 1, "missing", "repository tree not inspected (Level 3 required)"));
  if (c.inspection?.contributors !== undefined)
    fs.push(
      f(
        "contributors",
        Math.min(1, Math.log10(c.inspection.contributors + 1) / 1.5),
        0.2,
        "verified",
        `${c.inspection.contributors} contributors (bus-factor proxy)`,
      ),
    );
  return combine("quality", fs, "Static indicators (tests, CI, typing, structure). Not a code review.");
}
function compatibilityScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const spec = c.spec;
  const langs = spec?.languages ?? [];
  const explicit = langs.filter((l) => l.origin === "explicit").map((l) => l.value.toLowerCase());
  const pref = langs.map((l) => l.value.toLowerCase());
  const rl = r.language?.toLowerCase();
  const alias: Record<string, string[]> = {
    typescript: ["javascript", "typescript"],
    javascript: ["javascript", "typescript"],
    "c++": ["c++", "c"],
    python: ["python"],
  };
  const ok = (l: string) => rl !== undefined && (rl === l || (alias[l] ?? []).includes(rl));
  if (!langs.length) fs.push(f("language", 0.7, 0.4, "assumption", "no language preference given: neutral"));
  else if (!rl) fs.push(f("language", 0, 0.4, "missing", "primary language unknown"));
  else if (explicit.length)
    fs.push(
      f(
        "language",
        explicit.some(ok) ? 1 : 0.15,
        0.4,
        "verified",
        explicit.some(ok)
          ? `${r.language} matches requested ${explicit.join("/")}`
          : `${r.language} differs from requested ${explicit.join("/")}`,
      ),
    );
  else
    fs.push(
      f(
        "language",
        pref.some(ok) ? 0.9 : 0.5,
        0.4,
        "inferred",
        pref.some(ok)
          ? `${r.language} matches assumed ${pref.join("/")}`
          : `${r.language} differs from assumed ${pref.join("/")}`,
      ),
    );
  const fw = spec?.frameworks ?? [];
  if (fw.length) {
    const text = new Set([
      ...tokenize(`${r.name} ${r.description}`),
      ...r.topics.flatMap(tokenize),
      ...(c.inspection?.frameworks ?? []).flatMap(tokenize),
    ]);
    const hits = fw.filter((x) => tokenize(x.value).every((t) => text.has(t))).length;
    fs.push(
      f(
        "frameworks",
        hits ? Math.min(1, 0.5 + hits / fw.length / 2) : 0.4,
        0.25,
        c.inspection ? "verified" : "inferred",
        `${hits}/${fw.length} requested frameworks referenced`,
      ),
    );
  }
  const os = spec?.operatingSystems.filter((o) => o.origin === "explicit") ?? [];
  if (os.length) {
    const text = `${r.description} ${r.topics.join(" ")}`.toLowerCase();
    const hit = os.some((o) => text.includes(o.value.toLowerCase()));
    const crossPlatform =
      /cross-platform|crossplatform|electron|tauri|qt|flutter|python|node|java|rust|go\b/i.test(
        `${text} ${r.language ?? ""}`,
      );
    fs.push(
      f(
        "operating system",
        hit ? 1 : crossPlatform ? 0.6 : 0.35,
        0.2,
        "inferred",
        hit
          ? "OS referenced in metadata"
          : crossPlatform
            ? "language/runtime is typically cross-platform; OS support unverified"
            : "no OS evidence",
      ),
    );
  }
  if (r.type === "package")
    fs.push(
      f("runtime", 0.8, 0.15, "inferred", `${r.ecosystem} package; runtime ${r.language ?? "unknown"}`),
    );
  return combine(
    "compatibility",
    fs,
    "Match with requested languages, frameworks and OS. Runtime compatibility is not tested.",
  );
}
function securityScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const sec = c.inspection?.security;
  if (sec && sec.vulnerabilityCheck !== "not_performed") {
    const n = sec.vulnerabilities.length;
    fs.push(
      f(
        "known vulnerabilities (OSV)",
        n === 0 ? 1 : Math.max(0, 1 - n * 0.2),
        0.45,
        "verified",
        sec.vulnerabilityCheck === "partial"
          ? `${n} advisories for the dependencies that could be checked (PARTIAL coverage)`
          : `${n} known advisories in declared dependencies`,
      ),
    );
  } else
    fs.push(
      f(
        "known vulnerabilities (OSV)",
        0,
        0.45,
        "missing",
        "dependency vulnerability lookup was not performed",
      ),
    );
  if (sec?.hasSecurityPolicy !== undefined)
    fs.push(
      f(
        "security policy",
        sec.hasSecurityPolicy ? 1 : 0.3,
        0.15,
        "verified",
        sec.hasSecurityPolicy ? "SECURITY.md present" : "no SECURITY policy found",
      ),
    );
  if (sec?.hasLockfile !== undefined)
    fs.push(
      f(
        "lockfile",
        sec.hasLockfile ? 1 : 0.4,
        0.1,
        "verified",
        sec.hasLockfile ? "lockfile present" : "no lockfile",
      ),
    );
  if (sec)
    fs.push(
      f(
        "install scripts",
        sec.installScripts.length ? 0.3 : 1,
        0.15,
        "verified",
        sec.installScripts.length
          ? `lifecycle/install scripts present: ${sec.installScripts.join(", ")} (never executed by Repo Scout)`
          : "no install lifecycle scripts detected",
      ),
    );
  if (r.archived)
    fs.push(f("patchability", 0, 0.15, "verified", "archived: security issues will not be fixed"));
  if (sec?.promptInjectionFindings.length)
    fs.push(
      f(
        "untrusted-content flags",
        0.5,
        0.1,
        "inferred",
        `README contains agent-directed / injection-like text: ${sec.promptInjectionFindings.join("; ")}`,
      ),
    );
  const s = combine(
    "security",
    fs,
    "Security INDICATORS from supported metadata sources. This is not a security audit.",
  );
  return s;
}
function communityScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const lg = (n: number, full: number) => Math.min(1, Math.log10(n + 1) / Math.log10(full + 1));
  fs.push(
    r.stars === undefined
      ? f("stars", 0, 0.35, "missing", "stars not available for this resource type")
      : f(
          "stars",
          lg(r.stars, 50000),
          0.35,
          "verified",
          `${r.stars} stars (log-scaled; low weight by design)`,
        ),
  );
  fs.push(
    r.forks === undefined
      ? f("forks", 0, 0.2, "missing", "forks unavailable")
      : f("forks", lg(r.forks, 5000), 0.2, "verified", `${r.forks} forks`),
  );
  if (r.downloads !== undefined)
    fs.push(f("downloads", lg(r.downloads, 10_000_000), 0.35, "verified", `${r.downloads} recent downloads`));
  if (c.inspection?.contributors !== undefined)
    fs.push(
      f(
        "contributors",
        lg(c.inspection.contributors, 300),
        0.25,
        "verified",
        `${c.inspection.contributors} contributors`,
      ),
    );
  if (r.metadata.npmScore) {
    const p = (r.metadata.npmScore as any).popularity;
    if (typeof p === "number")
      fs.push(f("registry popularity", p, 0.2, "verified", `registry popularity ${p.toFixed(2)}`));
  }
  return combine("community", fs, "Adoption signals, log-scaled. Never the primary quality measure.");
}
function licenseScore(
  r: Resource,
  c: EvalContext,
): { score: Score; info: ReturnType<typeof classifyLicense> } {
  const info = classifyLicense(r.license);
  const v = licenseSuitability(info, c.spec);
  const st: EvidenceStatus = info.category === "unknown" ? "inferred" : info.status;
  return {
    info,
    score: combine(
      "license",
      [
        f(
          "licence suitability",
          v.suitability,
          1,
          st,
          `${info.spdx ?? "no licence"} (${info.category})${v.reasons.length ? ": " + v.reasons.join("; ") : ""}`,
          ev(r),
        ),
      ],
      "Fit of the licence with the task's constraints.",
    ),
  };
}
function integrationScore(r: Resource, c: EvalContext): Score {
  const fs: ScoreFactor[] = [];
  const topicText = `${r.topics.join(" ")} ${r.description}`.toLowerCase();
  const surface = /sdk|api|library|cli|mcp|plugin|framework|rest|grpc|websocket|openai-compatible/.test(
    topicText,
  );
  fs.push(
    f(
      "integration surface",
      r.type === "package" ? 0.9 : surface ? 0.8 : 0.45,
      0.35,
      "inferred",
      r.type === "package"
        ? "published as an installable package"
        : surface
          ? "SDK/API/CLI keywords in metadata"
          : "no explicit integration surface in metadata",
    ),
  );
  if (c.inspection) {
    fs.push(
      f(
        "manifests",
        c.inspection.manifests.length ? 0.9 : 0.3,
        0.25,
        "verified",
        c.inspection.manifests.length
          ? `manifests: ${c.inspection.manifests.join(", ")}`
          : "no dependency manifest found",
      ),
    );
    fs.push(
      f(
        "container support",
        c.inspection.structure?.hasDockerfile ? 0.9 : 0.5,
        0.1,
        "verified",
        c.inspection.structure?.hasDockerfile ? "Dockerfile present" : "no Dockerfile",
      ),
    );
    fs.push(
      f(
        "API surface",
        c.inspection.apiSurface.length ? 0.9 : 0.4,
        0.2,
        "inferred",
        c.inspection.apiSurface.length
          ? `exposes: ${c.inspection.apiSurface.join(", ")}`
          : "no API surface detected",
      ),
    );
  } else fs.push(f("manifests/containers", 0, 0.55, "missing", "not inspected at this level"));
  const lic = classifyLicense(r.license);
  fs.push(
    f(
      "licence friendliness",
      ["permissive", "public-domain"].includes(lic.category)
        ? 1
        : lic.category === "weak-copyleft"
          ? 0.7
          : 0.35,
      0.1,
      lic.status,
      `${lic.category} licence`,
    ),
  );
  return combine("integration", fs, "How easily this can be embedded or called from another system.");
}

// ---------------------------------------------------------------- Level 1
export interface FastResult {
  score: number;
  keep: boolean;
  reasons: string[];
}
/** LEVEL 1 fast filter: cheap signals only (name/description relevance, topics, language, stars/forks (low weight), recency, release, licence, docs hints). */
export function fastFilter(r: Resource, ctx: EvalContext & { minScore?: number } = {}): FastResult {
  const reasons: string[] = [];
  const rel = ctx.relevance ?? 0;
  const days = daysSince(r.pushedAt ?? r.updatedAt, ctx.now);
  const recency = days === undefined ? 0.3 : days < 90 ? 1 : days < 365 ? 0.7 : days < 730 ? 0.35 : 0.1;
  const lic = classifyLicense(r.license);
  const licOk = ["permissive", "public-domain", "weak-copyleft"].includes(lic.category)
    ? 1
    : lic.category === "unknown"
      ? 0.2
      : 0.5;
  const lg = (n: number | undefined, full: number) =>
    n === undefined ? 0.3 : Math.min(1, Math.log10(n + 1) / Math.log10(full + 1));
  const popularity =
    r.downloads !== undefined ? lg(r.downloads, 1e7) : lg(r.stars, 20000) * 0.7 + lg(r.forks, 2000) * 0.3;
  const doc = (r.description.length > 20 ? 0.5 : 0) + (r.homepage ? 0.25 : 0) + (r.topics.length ? 0.25 : 0);
  let langBoost = 0.5;
  const wantLang = ctx.spec?.languages
    .filter((l) => l.origin === "explicit")
    .map((l) => l.value.toLowerCase());
  if (wantLang?.length && r.language) langBoost = wantLang.includes(r.language.toLowerCase()) ? 1 : 0.2;
  const score =
    100 * (0.45 * rel + 0.15 * recency + 0.1 * licOk + 0.1 * popularity + 0.1 * doc + 0.1 * langBoost);
  reasons.push(`relevance ${rel.toFixed(2)}`, `recency ${recency.toFixed(2)}`, `licence ${lic.category}`);
  let keep = score >= (ctx.minScore ?? 20);
  if (r.archived) {
    keep = keep && rel > 0.5;
    reasons.push("archived (kept only if highly relevant)");
  }
  if (r.fork && !r.description) keep = false;
  return { score: Math.round(score * 10) / 10, keep, reasons };
}

// ---------------------------------------------------------------- Level 2 / 3
/** LEVEL 2 (no inspection) / LEVEL 3 (with inspection): task-adaptive evaluation with evidence-backed scores. */
export function evaluate(r: Resource, ctx: EvalContext = {}): Evaluation {
  const level: Evaluation["level"] = ctx.inspection ? "3-deep" : "2-adaptive";
  const profile = deriveWeights(ctx.spec);
  const lic = licenseScore(r, ctx);
  const scores: Record<string, Score> = {
    relevance: relevanceScore(r, ctx),
    maintenance: maintenanceScore(r, ctx),
    quality: qualityScore(r, ctx),
    documentation: documentationScore(r, ctx),
    compatibility: compatibilityScore(r, ctx),
    security: securityScore(r, ctx),
    community: communityScore(r, ctx),
    license: lic.score,
    integration: integrationScore(r, ctx),
  };
  let num = 0,
    den = 0,
    conf = 0;
  for (const [k, w] of Object.entries(profile.weights) as Array<[keyof WeightMap, number]>) {
    const s = scores[k]!;
    if (s.confidence > 0) {
      num += s.value * w;
      den += w;
    }
    conf += s.confidence * w;
  }
  let overall = den ? num / den : 50;
  // Relevance gate: a healthy, popular repository that does not match the request must not outrank a good match.
  const rel = scores.relevance!;
  if (rel.confidence > 0) {
    const gate = 0.35 + 0.65 * Math.min(1, rel.value / 60);
    if (gate < 1) {
      overall *= gate;
      profile.adjustments.push(
        `relevance gate x${gate.toFixed(2)} (relevance ${rel.value}/100; full weight at >=60)`,
      );
    }
  }
  const reasons: string[] = [],
    limitations: string[] = [];
  // hard gates (explained, never silent)
  if (lic.score.factors[0] && lic.score.value === 0) {
    overall = Math.min(overall, 20);
    limitations.push("Licence is forbidden by the task constraints: capped at 20.");
  }
  if (r.archived) {
    overall = Math.min(overall, 40);
    limitations.push("Repository is archived: overall capped at 40.");
  }
  const overallScore: Score = {
    name: "overall",
    value: Math.round(overall * 10) / 10,
    confidence: Math.round(conf * 100) / 100,
    factors: Object.entries(profile.weights).map(([k, w]) => ({
      name: k,
      value: scores[k]!.value / 100,
      weight: w,
      status:
        scores[k]!.confidence > 0.6
          ? ("verified" as const)
          : scores[k]!.confidence > 0
            ? ("inferred" as const)
            : ("missing" as const),
      detail: `${scores[k]!.value}/100 (confidence ${scores[k]!.confidence})`,
    })),
    explanation: `Weighted mean using the "${profile.name}" profile. ${profile.adjustments.join(" ")}`,
  };
  scores.overall = overallScore;
  const verified: string[] = [],
    inferred: string[] = [],
    missing: string[] = [],
    assumptions: string[] = [];
  for (const s of Object.values(scores))
    if (s.name !== "overall")
      for (const fa of s.factors) {
        const line = `${s.name}/${fa.name}: ${fa.detail}`;
        (fa.status === "verified"
          ? verified
          : fa.status === "inferred"
            ? inferred
            : fa.status === "missing"
              ? missing
              : assumptions
        ).push(line);
      }
  const top = (Object.entries(scores).filter(([k]) => k !== "overall") as Array<[string, Score]>).sort(
    (a, b) => b[1].value * b[1].confidence - a[1].value * a[1].confidence,
  );
  for (const [k, s] of top.slice(0, 3))
    if (s.value >= 60 && s.confidence > 0) reasons.push(`${k} ${s.value}/100`);
  const weak = Object.entries(scores).filter(
    ([k, s]) => k !== "overall" && s.confidence > 0 && s.value < 40,
  ) as Array<[string, Score]>;
  for (const [k, s] of weak) limitations.push(`low ${k} score (${s.value}/100)`);
  if (!ctx.inspection)
    limitations.push("Source not inspected: quality, security and integration scores rely on metadata only.");
  if (!scores.security!.confidence) limitations.push("No vulnerability data: this is not a security audit.");
  if (lic.info.category === "unknown")
    limitations.push("No licence detected: reuse is legally unsafe until clarified.");
  return {
    resource: r,
    level,
    scores,
    overall: overallScore.value,
    confidence: overallScore.confidence,
    license: lic.info,
    inspection: ctx.inspection,
    reasons,
    limitations,
    alternatives: [],
    verified,
    inferred,
    missing,
    assumptions,
    weightsProfile: profile.name,
  };
}
