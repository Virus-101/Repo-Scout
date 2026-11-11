import { sanitizeText, type Config, type SafeHttp } from "@repo-scout/core";
import type { Resource, ResourceType, EvidenceRef } from "@repo-scout/schemas";

export interface ProviderContext {
  http: SafeHttp;
  config: Config;
  now?: () => number;
}
export interface ProviderQuery {
  text: string;
  limit?: number;
  language?: string;
  sort?: "relevance" | "stars" | "updated";
  minStars?: number;
  pushedAfter?: string;
  createdAfter?: string;
  topic?: string;
}
export interface ProviderAvailability {
  ok: boolean;
  reason?: string;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly resourceTypes: ResourceType[];
  readonly auth: "none" | "optional" | "required";
  readonly credentialEnv?: string[];
  readonly docsUrl: string;
  readonly limitations: string[];
  /** Included in default discovery fan-out. Opt-in providers are used only when named via --provider / config. */
  readonly defaultSearch: boolean;
  availability(): ProviderAvailability;
  search(q: ProviderQuery): Promise<Resource[]>;
  /** Fetch one resource by provider-specific reference (owner/repo, package name, arXiv id ...). */
  get?(ref: string): Promise<Resource | undefined>;
}

let counter = 0;
/** Build a normalised Resource with provenance. `verified` evidence is attached to API-provided fields. */
export function makeResource(
  ctx: ProviderContext,
  base: Omit<Resource, "freshness" | "evidence" | "topics" | "metadata" | "description"> &
    Partial<Pick<Resource, "topics" | "metadata" | "description" | "evidence">>,
  evidenceUrl?: string,
): Resource {
  const t = (ctx.now ?? Date.now)();
  const iso = new Date(t).toISOString();
  const id = sanitizeText(base.id, 300);
  const ev: EvidenceRef = {
    id: `${id}#api-${++counter}`,
    status: "verified",
    source: base.provider,
    url: evidenceUrl ?? base.canonicalUrl,
    detail: `Metadata retrieved from ${base.provider} API`,
    retrievedAt: iso,
  };
  // Provider-supplied strings are untrusted: strip control/ANSI/bidi characters from every displayed field and
  // keep only http(s) URLs, so terminal output and agent context cannot be hijacked through names or links.
  const url = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      const p = new URL(u);
      return p.protocol === "https:" || p.protocol === "http:" ? sanitizeText(p.toString(), 500) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    metadata: {},
    description: "",
    ...base,
    id,
    name: sanitizeText(base.name, 200),
    fullName: base.fullName === undefined ? undefined : sanitizeText(base.fullName, 200),
    canonicalUrl: url(base.canonicalUrl) ?? "about:invalid",
    repositoryUrl: url(base.repositoryUrl),
    homepage: url(base.homepage),
    language: base.language === undefined ? undefined : sanitizeText(base.language, 40),
    license: base.license === undefined ? undefined : sanitizeText(base.license, 80),
    version: base.version === undefined ? undefined : sanitizeText(base.version, 60),
    topics: (base.topics ?? []).map((x) => sanitizeText(x, 60)).filter(Boolean),
    authors: base.authors?.map((x) => sanitizeText(x, 80)),
    evidence: [ev, ...(base.evidence ?? [])],
    freshness: { retrievedAt: iso, ageSeconds: 0, fromCache: false, stale: false },
  };
}
export function canonicalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.search = "";
    let s = url
      .toString()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    s = s.replace("://www.", "://");
    return s.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}
export function authHeader(token?: string, scheme = "Bearer"): Record<string, string> {
  return token ? { authorization: `${scheme} ${token}` } : {};
}
export const enc = encodeURIComponent;
export function unavailableIfOffline(ctx: ProviderContext): ProviderAvailability {
  return ctx.config.offline ? { ok: false, reason: "offline mode" } : { ok: true };
}
