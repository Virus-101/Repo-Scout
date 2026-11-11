import type {
  ComponentNeed,
  DiscoveryQuery,
  Domain,
  Requirement,
  TaggedValue,
  TaskSpec,
} from "@repo-scout/schemas";
import { uniq } from "@repo-scout/core";
import {
  COMPONENTS,
  DIRECT_LANGUAGE_WORDS,
  DOMAIN_KEYWORDS,
  FRAMEWORKS,
  INFRA,
  INTEGRATIONS,
  LANGUAGES,
  OPERATING_SYSTEMS,
  RUNTIMES,
  SYNONYMS,
  TEMPLATES,
  type ComponentDef,
} from "./lexicon.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text: string, term: string) =>
  new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`, "i").test(text);
const hasPrefix = (text: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(term)}`, "i").test(text);

function tagged(values: string[], origin: "explicit" | "assumed", reason?: string): TaggedValue[] {
  return uniq(values).map((value) => ({ value, origin, reason }));
}

function extractLanguages(text: string): string[] {
  const out: string[] = [];
  for (const [w, lang] of Object.entries(DIRECT_LANGUAGE_WORDS))
    if (has(text, w) && !(w === "go")) out.push(lang);
  if (/(?<![a-z])(in|with|using|written in|build in)\s+go(?![a-z])/i.test(text) || /\bgolang\b/i.test(text))
    out.push("Go");
  return uniq(out);
}
function impliedLanguages(text: string): string[] {
  const out: string[] = [];
  for (const [lang, words] of Object.entries(LANGUAGES)) if (words.some((w) => has(text, w))) out.push(lang);
  return uniq(out);
}

function parseLicense(text: string): TaskSpec["licenseConstraints"] {
  const allowed: string[] = [],
    forbidden: string[] = [];
  let projectLicense: string | undefined,
    commercialUse: boolean | undefined,
    explicit = false;
  const mark = () => {
    explicit = true;
  };
  const names: Array<[RegExp, string]> = [
    [/\bapache(?:[- ]?2(?:\.0)?)?\b/i, "Apache-2.0"],
    [/\bmit\b/i, "MIT"],
    [/\bbsd\b/i, "BSD-3-Clause"],
    [/\bmpl\b/i, "MPL-2.0"],
    [/\bagpl\b/i, "AGPL-3.0"],
    [/\blgpl\b/i, "LGPL-3.0"],
    [/\bgpl\b/i, "GPL-3.0"],
  ];
  if (/\b(no|avoid|without|not|exclude|never)\s+(any\s+)?(gpl|agpl|copyleft|strong copyleft)/i.test(text)) {
    mark();
    if (/no[^.]*copyleft|avoid copyleft|without copyleft/i.test(text)) forbidden.push("copyleft");
    else {
      if (/agpl/i.test(text)) forbidden.push("AGPL-3.0");
      forbidden.push("GPL-3.0");
      if (/\bagpl\b/i.test(text)) forbidden.push("AGPL-3.0");
    }
  }
  const only =
    text.match(/\b(mit|apache(?:[- ]?2(?:\.0)?)?|bsd|mpl)[- ]?(?:licen[sc]ed?|only|licen[sc]e)\b/i) ??
    text.match(/\blicen[sc]e[d]?\s*(?:must be|:|=|under)?\s*(mit|apache(?:[- ]?2(?:\.0)?)?|bsd)\b/i);
  if (only) {
    const n = names.find(([re]) => re.test(only[1]!));
    if (n) {
      allowed.push(n[1]);
      mark();
    }
  }
  if (/\b(permissive|permissively licensed|business[- ]friendly)\b/i.test(text)) {
    allowed.push("permissive");
    mark();
  }
  if (
    /\b(commercial(ly)?|for (my|our) (company|business|startup|product)|proprietary|closed[- ]source|sell)\b/i.test(
      text,
    )
  ) {
    commercialUse = true;
    mark();
  }
  if (/\bclosed[- ]source|proprietary (app|product|project|software)/i.test(text))
    projectLicense = "Proprietary";
  const pl = text.match(
    /\b(?:my|our|the)\s+project\s+(?:is|will be)\s+(?:licensed\s+)?(?:under\s+)?(mit|apache[- ]?2(?:\.0)?|gpl[- ]?3?|agpl|bsd)\b/i,
  );
  if (pl) {
    projectLicense = names.find(([re]) => re.test(pl[1]!))?.[1] ?? projectLicense;
    mark();
  }
  if (/\bopen[- ]source only|only open[- ]source|fully open[- ]source\b/i.test(text)) {
    mark();
    if (!allowed.length) allowed.push("permissive");
  }
  return {
    allowed: uniq(allowed),
    forbidden: uniq(forbidden),
    projectLicense,
    commercialUse,
    origin: explicit ? "explicit" : "assumed",
  };
}

const functionalVerb = /^(build|create|make|develop|i want|we need)/i;
function splitClauses(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(
      /(?<=[.!?;])\s+|\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:can|should|must|will|supports?|understands?|executes?|controls?|remembers?|handles?|provides?|allows?|lets?)\b)/i,
    )
    .map((s) => s.replace(/^(and|that|which)\s+/i, "").trim())
    .filter((s) => s.length > 3);
}
const PERF =
  /(real[- ]?time|low[- ]?latency|latency|fast|performan|throughput|scal|\b\d+\s?(ms|fps|qps|rps)\b|high[- ]volume|memory footprint|lightweight|efficient|gpu[- ]accelerat|offline)/i;
const SEC =
  /(secure|security|encrypt|privacy|private|gdpr|hipaa|soc2|sandbox|zero[- ]trust|audit|compliance|rbac|permission|local[- ]first|on-device|no telemetry|air[- ]gapped|authoriz)/i;
const NFR =
  /(reliab|maintain|testab|extens|plugin|modular|cross[- ]platform|accessib|i18n|localiz|open[- ]source|self[- ]hosted|easy to (deploy|install|use)|well[- ]documented|production[- ]ready|scalable|offline|lightweight)/i;

function detectDomain(text: string): { domain: Domain; confidence: number } {
  const scores: Array<[Domain, number]> = (Object.entries(DOMAIN_KEYWORDS) as Array<[Domain, string[]]>)
    .filter(([d]) => d !== "general")
    .map(([d, kws]) => [d, kws.reduce((a, k) => a + (has(text, k) ? (k.includes(" ") ? 2 : 1) : 0), 0)]);
  scores.sort((a, b) => b[1] - a[1]);
  const [top, second] = [scores[0]!, scores[1]!];
  if (top[1] === 0) return { domain: "general", confidence: 0.3 };
  // priority rule: explicit authentication focus beats generic web
  const total = scores.reduce((a, s) => a + s[1], 0);
  return {
    domain: top[0],
    confidence:
      Math.round(
        Math.min(0.95, 0.4 + (top[1] - (second?.[1] ?? 0)) / Math.max(1, total) + top[1] * 0.05) * 100,
      ) / 100,
  };
}

export function keyTerms(text: string, max = 5): string[] {
  const stop = new Set(
    "i want to build a an the that and or with for of in on my our we you it is are be can should will would like need needs make create develop using use app application project tool system software something thing things which also able allows allow supports support controls control understands understand executes execute remembers remember previous interactions tasks task must should have has not no any using based".split(
      " ",
    ),
  );
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 2 && !stop.has(w));
  const tech = new Set([...FRAMEWORKS, ...INFRA, ...INTEGRATIONS, ...Object.keys(DIRECT_LANGUAGE_WORDS)]);
  const scored = uniq(terms).map((t, i) => ({
    t,
    s: (tech.has(t) ? 3 : 0) + Math.min(2, t.length / 6) - i * 0.02,
  }));
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.t);
}

export interface UnderstandOptions {
  maxQueries?: number;
  language?: string;
  /** a project-level licence hint supplied by the caller */ projectLicense?: string;
}

/** Rule-based, model-free task understanding. Explicit facts vs. assumptions are tagged separately. */
export function understandTask(raw: string, opts: UnderstandOptions = {}): TaskSpec {
  const text = raw.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const assumptions: string[] = [];
  const clauses = splitClauses(text);
  const functional: Requirement[] = [],
    nonFunctional: Requirement[] = [],
    performance: Requirement[] = [],
    security: Requirement[] = [];
  for (const c of clauses) {
    let placed = false;
    const term = (re: RegExp) => c.match(re)![0].toLowerCase();
    if (PERF.test(c)) {
      performance.push({ text: term(PERF), origin: "explicit", category: "performance" });
      placed = true;
    }
    if (SEC.test(c)) {
      security.push({ text: term(SEC), origin: "explicit", category: "security" });
      placed = true;
    }
    if (NFR.test(c)) {
      nonFunctional.push({ text: term(NFR), origin: "explicit" });
      placed = true;
    }
    if (
      !placed ||
      functionalVerb.test(c) ||
      /\b(controls?|understands?|executes?|supports?|remembers?|detects?|transcribes?|summariz|searches|authenticates?|streams?|generates?|analy[sz]es?|monitors?|sends?|stores?|manages?|provides?|allows?)\b/i.test(
        c,
      )
    )
      functional.push({ text: c, origin: "explicit" });
  }
  if (!functional.length) functional.push({ text, origin: "explicit" });

  const explicitLangs = opts.language
    ? uniq([opts.language, ...extractLanguages(lower)])
    : extractLanguages(lower);
  const implied = impliedLanguages(lower).filter((l) => !explicitLangs.includes(l));
  const frameworks = FRAMEWORKS.filter((f) => has(lower, f));
  const oses = Object.entries(OPERATING_SYSTEMS)
    .filter(([, ws]) => ws.some((w) => has(lower, w)))
    .map(([k]) => k);
  const runtimes = RUNTIMES.filter((r) => has(lower, r));
  const infra = INFRA.filter((i) => has(lower, i));
  const integrations = INTEGRATIONS.filter((i) => has(lower, i));
  const { domain, confidence } = detectDomain(lower);

  const languages: TaggedValue[] = [
    ...tagged(explicitLangs, "explicit"),
    ...tagged(implied, "assumed", "implied by a named framework/tool"),
  ];
  if (!languages.length) {
    const dflt =
      domain === "ai-agents" ||
      domain === "speech-audio" ||
      domain === "data-engineering" ||
      domain === "computer-vision"
        ? ["Python", "TypeScript"]
        : domain === "web-development" || domain === "developer-tooling"
          ? ["TypeScript"]
          : domain === "embedded"
            ? ["C", "C++", "Rust"]
            : domain === "robotics"
              ? ["Python", "C++"]
              : [];
    if (dflt.length) {
      languages.push(...tagged(dflt, "assumed", `typical for ${domain}`));
      assumptions.push(`No language specified: assuming ${dflt.join("/")} (typical for ${domain}).`);
    }
  }
  if (!oses.length) {
    assumptions.push(
      "No operating system specified: assuming cross-platform (Windows/Linux/macOS) is desirable.",
    );
  }
  if (domain === "general")
    assumptions.push("No strong domain signal detected: using balanced scoring weights.");
  const license = parseLicense(lower + (opts.projectLicense ? ` my project is ${opts.projectLicense}` : ""));
  if (opts.projectLicense) license.projectLicense = opts.projectLicense;
  if (license.origin === "assumed")
    assumptions.push(
      "No licence constraints given: assuming permissive licences are preferred and copyleft needs review.",
    );

  // components: template-implied (assumed) + trigger-detected (explicit)
  const compMap = new Map<string, ComponentNeed>();
  const addComp = (d: ComponentDef, origin: "explicit" | "assumed", required = true) => {
    if (!compMap.has(d.id) || (origin === "explicit" && compMap.get(d.id)!.origin === "assumed"))
      compMap.set(d.id, {
        id: d.id,
        label: d.label,
        origin,
        keywords: d.keywords,
        required,
        typicalLanguages: d.languages ?? [],
      });
  };
  for (const d of COMPONENTS)
    if (d.triggers.some((t) => (t.length <= 4 ? has(lower, t) : hasPrefix(lower, t)))) addComp(d, "explicit");
  for (const t of TEMPLATES)
    if (t.triggers.some((x) => hasPrefix(lower, x))) {
      assumptions.push(
        `Recognised project archetype "${t.name}": components not mentioned explicitly are assumed typical for it.`,
      );
      for (const id of t.components) {
        const d = COMPONENTS.find((c) => c.id === id);
        if (d) addComp(d, "assumed", !["authentication", "deployment", "frontend", "search"].includes(id));
      }
    }
  // a generic "ai assistant/agent" shouldn't swallow everything if the user is specific
  const components = [...compMap.values()];
  if (!components.length) {
    const kt = keyTerms(text, 3);
    components.push({
      id: "primary",
      label: "Primary functionality",
      origin: "explicit",
      keywords: [kt.join(" ")].filter(Boolean),
      required: true,
      typicalLanguages: [],
    });
    assumptions.push("Request is a single focused capability: no multi-component decomposition applied.");
  }

  // objective
  const objective = text.length <= 220 ? text : text.slice(0, 217) + "...";

  // queries
  const queries: DiscoveryQuery[] = [];
  const add = (q: DiscoveryQuery) => {
    if (
      q.text.trim() &&
      !queries.some((x) => x.text === q.text && x.kind === q.kind && x.componentId === q.componentId)
    )
      queries.push(q);
  };
  const lang = explicitLangs[0] ?? opts.language;
  const kt = keyTerms(text, 4).join(" ");
  add({ text: kt, kind: "exact", weight: 1 });
  if (lang) add({ text: kt, kind: "technology", language: lang, weight: 0.9 });
  for (const f of frameworks.slice(0, 3))
    add({
      text: `${f} ${keyTerms(text, 2)
        .filter((t) => t !== f)
        .join(" ")}`.trim(),
      kind: "technology",
      weight: 0.8,
    });
  for (const c of components) {
    const def = COMPONENTS.find((d) => d.id === c.id);
    const w = c.origin === "explicit" ? 1 : 0.8;
    for (const [i, k] of c.keywords.entries())
      add({ text: k, kind: i === 0 ? "exact" : "feature", componentId: c.id, language: lang, weight: w });
    if (def?.semanticTerms?.[0])
      add({ text: def.semanticTerms[0], kind: "semantic", componentId: c.id, weight: w * 0.8 });
    const k0 = c.keywords[0];
    if (k0) {
      add({ text: `${k0} sdk`, kind: "package", componentId: c.id, weight: w * 0.7 });
      add({ text: `${k0} alternative`, kind: "alternative", componentId: c.id, weight: w * 0.6 });
    }
  }
  for (const [k, syns] of Object.entries(SYNONYMS))
    if (has(lower, k)) for (const s of syns.slice(0, 2)) add({ text: s, kind: "semantic", weight: 0.7 });
  if (domain !== "general")
    add({ text: `awesome ${keyTerms(text, 2).join(" ")}`.trim(), kind: "related", weight: 0.5 });
  const maxQ = opts.maxQueries ?? 40;
  const byWeight = queries.sort((a, b) => b.weight - a.weight);
  const must = new Set<DiscoveryQuery>(); // guarantee every query kind is represented
  for (const kind of [
    "exact",
    "technology",
    "feature",
    "semantic",
    "alternative",
    "related",
    "package",
  ] as const)
    byWeight
      .filter((q) => q.kind === kind)
      .slice(0, 2)
      .forEach((q) => must.add(q));
  const sorted = [...must, ...byWeight.filter((q) => !must.has(q))]
    .slice(0, maxQ)
    .sort((a, b) => b.weight - a.weight);

  return {
    raw: text,
    objective,
    functional,
    nonFunctional: dedupeReq(nonFunctional),
    languages,
    frameworks: tagged(frameworks, "explicit"),
    operatingSystems: tagged(oses.length ? oses : [], "explicit"),
    runtimes: tagged(runtimes, "explicit"),
    infrastructure: tagged(infra, "explicit"),
    performance: dedupeReq(performance),
    security: dedupeReq(security),
    licenseConstraints: license,
    integrations: tagged(integrations, "explicit"),
    domain,
    domainConfidence: confidence,
    components,
    queries: sorted,
    assumptions,
  };
}
function dedupeReq(r: Requirement[]): Requirement[] {
  const seen = new Set<string>();
  return r.filter((x) => !seen.has(x.text) && seen.add(x.text));
}

/** Queries for finding alternatives to a named library/project. */
export function alternativeQueries(name: string, description = "", topics: string[] = []): DiscoveryQuery[] {
  const bare = name.split("/").pop()!;
  const out: DiscoveryQuery[] = [
    { text: `${bare} alternative`, kind: "alternative", weight: 1 },
    { text: `alternative to ${bare}`, kind: "alternative", weight: 0.9 },
  ];
  const t = topics
    .filter((x) => x.toLowerCase() !== bare.toLowerCase())
    .slice(0, 3)
    .join(" ");
  if (t) out.push({ text: t, kind: "related", weight: 0.8 });
  const kt = keyTerms(description, 3)
    .filter((x) => x !== bare.toLowerCase())
    .join(" ");
  if (kt) out.push({ text: kt, kind: "semantic", weight: 0.7 });
  return out;
}
