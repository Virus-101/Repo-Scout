import type { LicenseCategory, LicenseInfo, TaskSpec } from "@repo-scout/schemas";

const TABLE: Record<string, LicenseCategory> = {
  "CC0-1.0": "public-domain",
  Unlicense: "public-domain",
  "0BSD": "public-domain",
  WTFPL: "public-domain",
  MIT: "permissive",
  "MIT-0": "permissive",
  ISC: "permissive",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "BSD-3-Clause-Clear": "permissive",
  "Apache-2.0": "permissive",
  Zlib: "permissive",
  "BSL-1.0": "permissive",
  "PSF-2.0": "permissive",
  "Python-2.0": "permissive",
  "Artistic-2.0": "permissive",
  "BlueOak-1.0.0": "permissive",
  "CC-BY-4.0": "permissive",
  OpenSSL: "permissive",
  NCSA: "permissive",
  X11: "permissive",
  "LGPL-2.1": "weak-copyleft",
  "LGPL-2.1-only": "weak-copyleft",
  "LGPL-2.1-or-later": "weak-copyleft",
  "LGPL-3.0": "weak-copyleft",
  "LGPL-3.0-only": "weak-copyleft",
  "LGPL-3.0-or-later": "weak-copyleft",
  "MPL-2.0": "weak-copyleft",
  "EPL-1.0": "weak-copyleft",
  "EPL-2.0": "weak-copyleft",
  "CDDL-1.0": "weak-copyleft",
  "CC-BY-SA-4.0": "weak-copyleft",
  "GPL-2.0": "strong-copyleft",
  "GPL-2.0-only": "strong-copyleft",
  "GPL-2.0-or-later": "strong-copyleft",
  "GPL-3.0": "strong-copyleft",
  "GPL-3.0-only": "strong-copyleft",
  "GPL-3.0-or-later": "strong-copyleft",
  "EUPL-1.2": "strong-copyleft",
  "OSL-3.0": "strong-copyleft",
  "AGPL-3.0": "network-copyleft",
  "AGPL-3.0-only": "network-copyleft",
  "AGPL-3.0-or-later": "network-copyleft",
  "SSPL-1.0": "network-copyleft",
  "BUSL-1.1": "source-available",
  "Elastic-2.0": "source-available",
  "CC-BY-NC-4.0": "source-available",
  "CC-BY-NC-SA-4.0": "source-available",
  "PolyForm-Noncommercial-1.0.0": "source-available",
  "Commons-Clause": "source-available",
  Proprietary: "proprietary",
  "LicenseRef-Proprietary": "proprietary",
};
const ALIASES: Record<string, string> = {
  "apache 2.0": "Apache-2.0",
  apache: "Apache-2.0",
  "apache-2": "Apache-2.0",
  bsd: "BSD-3-Clause",
  gpl: "GPL-3.0",
  gplv3: "GPL-3.0",
  gplv2: "GPL-2.0",
  agpl: "AGPL-3.0",
  lgpl: "LGPL-3.0",
  "mit license": "MIT",
  "isc license": "ISC",
  unlicense: "Unlicense",
  "mpl 2.0": "MPL-2.0",
};

export function normalizeSpdx(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s || /^(noassertion|other|unknown|none|see license)/i.test(s)) return undefined;
  const hit = Object.keys(TABLE).find((k) => k.toLowerCase() === s.toLowerCase());
  return hit ?? ALIASES[s.toLowerCase()] ?? s;
}

/** Classify a licence string (SPDX id or simple OR-expression). Expressions with OR take the most permissive option. */
export function classifyLicense(raw?: string): LicenseInfo {
  const spdx = normalizeSpdx(raw);
  if (!spdx)
    return {
      category: "unknown",
      status: raw ? "inferred" : "missing",
      notes: [
        "No recognised licence was found. Without an explicit licence, default copyright applies: do not reuse the code until the licence is clarified.",
      ],
      commercialUseOk: undefined,
    };
  if (/\s+OR\s+/i.test(spdx)) {
    const parts = spdx
      .replace(/[()]/g, "")
      .split(/\s+OR\s+/i)
      .map((p) => classifyLicense(p));
    const rank: LicenseCategory[] = [
      "public-domain",
      "permissive",
      "weak-copyleft",
      "strong-copyleft",
      "network-copyleft",
      "source-available",
      "proprietary",
      "unknown",
    ];
    const best = parts.sort((a, b) => rank.indexOf(a.category) - rank.indexOf(b.category))[0]!;
    return {
      ...best,
      spdx,
      notes: [...best.notes, "Dual-licensed (OR): the most permissive option can be elected."],
    };
  }
  const category = TABLE[spdx] ?? guessCategory(spdx);
  const notes: string[] = [];
  let commercialUseOk: boolean | undefined = true;
  switch (category) {
    case "public-domain":
    case "permissive":
      notes.push(
        "Permits commercial use, modification and redistribution; attribution/notice terms may apply.",
      );
      break;
    case "weak-copyleft":
      notes.push(
        "File- or library-level copyleft: modifications to the licensed files must be shared; linking is usually fine.",
      );
      break;
    case "strong-copyleft":
      notes.push(
        "Strong copyleft: distributing a combined work requires releasing it under a compatible copyleft licence.",
      );
      break;
    case "network-copyleft":
      notes.push(
        "Network copyleft: offering the software as a network service triggers source-disclosure obligations.",
      );
      break;
    case "source-available":
      notes.push("Source-available, not OSI open source; commercial or competing use may be restricted.");
      commercialUseOk = /NC|Noncommercial|Commons-Clause/i.test(spdx) ? false : undefined;
      break;
    case "proprietary":
      notes.push("Proprietary terms.");
      commercialUseOk = undefined;
      break;
    default:
      notes.push("Licence not in Repo Scout's table: review manually.");
      commercialUseOk = undefined;
  }
  if (/GPL-2\.0(-only)?$/.test(spdx))
    notes.push("GPL-2.0-only is incompatible with Apache-2.0 and GPL-3.0 code.");
  return { spdx, category, status: TABLE[spdx] ? "verified" : "inferred", commercialUseOk, notes };
}
function guessCategory(s: string): LicenseCategory {
  if (/^AGPL/i.test(s)) return "network-copyleft";
  if (/^LGPL/i.test(s)) return "weak-copyleft";
  if (/^GPL/i.test(s)) return "strong-copyleft";
  if (/^(MPL|EPL|CDDL)/i.test(s)) return "weak-copyleft";
  if (/^(BSD|MIT|Apache|ISC)/i.test(s)) return "permissive";
  if (/NC|Noncommercial/i.test(s)) return "source-available";
  return "unknown";
}

export interface LicenseVerdict {
  suitability: number;
  ok: boolean;
  reasons: string[];
}
/** How well a licence fits the task's constraints (0..1). */
export function licenseSuitability(
  info: LicenseInfo,
  spec?: Pick<TaskSpec, "licenseConstraints">,
): LicenseVerdict {
  const reasons: string[] = [];
  const c = spec?.licenseConstraints;
  const base: Record<LicenseCategory, number> = {
    "public-domain": 1,
    permissive: 1,
    "weak-copyleft": 0.7,
    "strong-copyleft": 0.4,
    "network-copyleft": 0.25,
    "source-available": 0.2,
    proprietary: 0.1,
    unknown: 0.15,
  };
  let s = base[info.category];
  if (info.category === "unknown") reasons.push("licence missing or unrecognised");
  if (c) {
    const id = info.spdx?.toLowerCase();
    if (c.forbidden.some((f) => matchesLicenseRule(f, info))) {
      s = 0;
      reasons.push(`licence is forbidden by the task (${info.spdx ?? info.category})`);
    } else if (c.allowed.length && !c.allowed.some((a) => matchesLicenseRule(a, info))) {
      s = Math.min(s, 0.1);
      reasons.push(`licence is not in the allowed list (${c.allowed.join(", ")})`);
    } else if (c.allowed.length && id) reasons.push("licence explicitly allowed");
    if (
      c.commercialUse &&
      ["strong-copyleft", "network-copyleft", "source-available"].includes(info.category)
    ) {
      s = Math.min(s, 0.3);
      reasons.push("commercial use requested: copyleft / source-available terms need review");
    }
    if (c.projectLicense) {
      const pl = classifyLicense(c.projectLicense);
      const conflict = pairConflict(info, pl);
      if (conflict) {
        s = Math.min(s, 0.15);
        reasons.push(conflict);
      }
    }
  }
  return { suitability: s, ok: s >= 0.5, reasons };
}
function matchesLicenseRule(rule: string, info: LicenseInfo): boolean {
  const r = rule.toLowerCase();
  if (info.spdx?.toLowerCase() === r) return true;
  if (r === "copyleft")
    return ["weak-copyleft", "strong-copyleft", "network-copyleft"].includes(info.category);
  if (r === "gpl") return /gpl/i.test(info.spdx ?? "") && !/^l?a?gpl/i.test("");
  if (r === "agpl") return /^agpl/i.test(info.spdx ?? "");
  if (r === "permissive") return info.category === "permissive" || info.category === "public-domain";
  if (r === "strong-copyleft")
    return info.category === "strong-copyleft" || info.category === "network-copyleft";
  return info.category === (r as LicenseCategory);
}
/** Is dependency licence `dep` usable inside a project licensed `project`? Returns a message when it is not. */
function pairConflict(dep: LicenseInfo, project: LicenseInfo): string | undefined {
  const closed = project.category === "proprietary" || (project.category === "unknown" && !project.spdx);
  if (closed && ["strong-copyleft", "network-copyleft"].includes(dep.category))
    return `${dep.spdx ?? dep.category} code cannot be combined into a closed-source project without releasing it`;
  if (project.category === "permissive" && ["strong-copyleft", "network-copyleft"].includes(dep.category))
    return `${dep.spdx} would force the combined work to be copyleft; incompatible with a ${project.spdx} project`;
  if (dep.spdx && project.spdx) {
    if (/^GPL-2\.0(-only)?$/.test(dep.spdx) && /^(Apache-2\.0|GPL-3\.0)/.test(project.spdx))
      return `${dep.spdx} is incompatible with ${project.spdx}`;
    if (/^Apache-2\.0$/.test(dep.spdx) && /^GPL-2\.0(-only)?$/.test(project.spdx))
      return `Apache-2.0 is incompatible with ${project.spdx}`;
  }
  return undefined;
}

export interface LicenseSetReport {
  issues: Array<{ severity: "info" | "warning" | "conflict"; message: string; between: string[] }>;
  summary: string;
  categories: Record<string, LicenseCategory>;
}
/** Cross-component licence analysis for a combined solution. */
export function analyzeLicenseSet(
  items: Array<{ name: string; license?: string }>,
  projectLicense?: string,
): LicenseSetReport {
  const infos = items.map((i) => ({ name: i.name, info: classifyLicense(i.license) }));
  const issues: LicenseSetReport["issues"] = [];
  for (const { name, info } of infos) {
    if (info.category === "unknown")
      issues.push({
        severity: "warning",
        message: `${name}: no recognised licence - clarify before reuse`,
        between: [name],
      });
    if (info.category === "network-copyleft")
      issues.push({
        severity: "warning",
        message: `${name}: ${info.spdx} network copyleft applies if deployed as a service`,
        between: [name],
      });
    if (info.category === "source-available")
      issues.push({
        severity: "warning",
        message: `${name}: ${info.spdx} is source-available, not open source`,
        between: [name],
      });
    if (projectLicense) {
      const c = pairConflict(info, classifyLicense(projectLicense));
      if (c) issues.push({ severity: "conflict", message: `${name}: ${c}`, between: [name] });
    }
  }
  for (let i = 0; i < infos.length; i++)
    for (let j = i + 1; j < infos.length; j++) {
      const a = infos[i]!,
        b = infos[j]!;
      const pairs: Array<[typeof a, typeof b]> = [
        [a, b],
        [b, a],
      ];
      for (const [x, y] of pairs)
        if (
          x.info.spdx &&
          y.info.spdx &&
          /^GPL-2\.0(-only)?$/.test(x.info.spdx) &&
          /^(Apache-2\.0|GPL-3\.0(-only)?)$/.test(y.info.spdx)
        )
          issues.push({
            severity: "conflict",
            message: `${x.name} (${x.info.spdx}) and ${y.name} (${y.info.spdx}) are not licence-compatible when combined into one work`,
            between: [x.name, y.name],
          });
    }
  const copyleft = infos.filter((i) => ["strong-copyleft", "network-copyleft"].includes(i.info.category));
  const summary = copyleft.length
    ? `Contains copyleft components (${copyleft.map((c) => `${c.name}:${c.info.spdx}`).join(", ")}); the combined distribution may need to be copyleft.`
    : infos.every((i) => ["permissive", "public-domain"].includes(i.info.category))
      ? "All components use permissive licences."
      : "Mixed licences; see issues.";
  return { issues, summary, categories: Object.fromEntries(infos.map((i) => [i.name, i.info.category])) };
}
