import type { Config, SafeHttp } from "@repo-scout/core";
import { GithubProvider } from "./github.js";
import {
  ArxivProvider,
  AwesomeProvider,
  CodebergProvider,
  CratesProvider,
  GitlabProvider,
  MavenProvider,
  NpmProvider,
  PapersWithCodeProvider,
  PypiProvider,
  WebProvider,
} from "./others.js";
import type { Provider, ProviderContext } from "./types.js";

export class ProviderRegistry {
  readonly providers: Map<string, Provider> = new Map();
  readonly github: GithubProvider;
  constructor(readonly ctx: ProviderContext) {
    this.github = new GithubProvider(ctx);
    for (const p of [
      this.github,
      new AwesomeProvider(ctx),
      new NpmProvider(ctx),
      new PypiProvider(ctx),
      new CratesProvider(ctx),
      new MavenProvider(ctx),
      new GitlabProvider(ctx),
      new CodebergProvider(ctx),
      new ArxivProvider(ctx),
      new PapersWithCodeProvider(ctx),
      new WebProvider(ctx),
    ])
      this.providers.set(p.id, p);
  }
  static create(config: Config, http: SafeHttp) {
    return new ProviderRegistry({ config, http });
  }
  isEnabled(id: string) {
    const { enabled, disabled } = this.ctx.config.providers;
    return !disabled.includes(id) && (!enabled || enabled.includes(id));
  }
  get(id: string) {
    return this.providers.get(id);
  }
  /** Providers that can be queried right now. */
  active(opts: { includeOptIn?: boolean } = {}): Provider[] {
    const explicit = this.ctx.config.providers.enabled;
    return [...this.providers.values()].filter(
      (p) =>
        this.isEnabled(p.id) &&
        p.availability().ok &&
        (opts.includeOptIn || p.defaultSearch || explicit?.includes(p.id)),
    );
  }
  describe() {
    return [...this.providers.values()].map((p) => {
      const a = p.availability();
      return {
        id: p.id,
        name: p.name,
        defaultSearch: p.defaultSearch,
        description: p.description,
        resourceTypes: p.resourceTypes,
        auth: p.auth,
        credentialEnv: p.credentialEnv ?? [],
        enabled: this.isEnabled(p.id),
        available: a.ok && this.isEnabled(p.id),
        unavailableReason: !this.isEnabled(p.id) ? "disabled by configuration" : a.reason,
        docsUrl: p.docsUrl,
        limitations: p.limitations,
      };
    });
  }
}
