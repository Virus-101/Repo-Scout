import type { Resource, TrendEntry } from "@repo-scout/schemas";
import { daysSince } from "@repo-scout/core";
import type { Snapshot, Store } from "@repo-scout/cache";
import type { Provider } from "@repo-scout/providers";
import { evaluate } from "@repo-scout/scoring";

const DAY = 86400000;
export interface TrendOptions {
  minObservations?: number;
  minWindowDays?: number;
  now?: number;
}

export function maintenanceStatus(r: Resource, now = Date.now()): TrendEntry["maintenance"] {
  if (r.archived) return "archived";
  const d = daysSince(r.pushedAt ?? r.updatedAt, now);
  if (d === undefined) return "unknown";
  return d < 45 ? "active" : d < 180 ? "slowing" : d < 540 ? "stale" : "abandoned";
}

/**
 * Growth is OBSERVED only when >= minObservations local snapshots span >= minWindowDays.
 * Otherwise a clearly labelled lifetime-average ESTIMATE (stars / age) is given, or insufficient-data. Nothing is fabricated.
 */
export function computeTrend(r: Resource, snaps: Snapshot[], o: TrendOptions = {}): TrendEntry["trend"] {
  const minObs = o.minObservations ?? 2,
    minWin = o.minWindowDays ?? 1;
  const withStars = snaps.filter((s) => s.stars !== undefined).sort((a, b) => a.observedAt - b.observedAt);
  if (withStars.length >= minObs) {
    const first = withStars[0]!,
      last = withStars[withStars.length - 1]!;
    const days = (last.observedAt - first.observedAt) / DAY;
    if (days >= minWin) {
      const delta = last.stars! - first.stars!;
      return {
        label: "observed",
        starsPerDay: Math.round((delta / days) * 100) / 100,
        starGrowthPct: first.stars! > 0 ? Math.round((delta / first.stars!) * 1000) / 10 : undefined,
        observations: withStars.length,
        windowDays: Math.round(days * 10) / 10,
        note: `Observed from ${withStars.length} local snapshots over ${days.toFixed(1)} days (${first.stars} → ${last.stars} stars).`,
      };
    }
  }
  const age = daysSince(r.createdAt, o.now);
  if (r.stars !== undefined && age !== undefined && age >= 1)
    return {
      label: "estimated",
      starsPerDay: Math.round((r.stars / age) * 100) / 100,
      observations: withStars.length,
      windowDays: Math.round(age),
      note: `ESTIMATE: lifetime average (${r.stars} stars / ${Math.round(age)} days). Not an observed growth rate; run again later to accumulate snapshots.`,
    };
  return {
    label: "insufficient-data",
    observations: withStars.length,
    note: "Not enough history or metadata to estimate growth.",
  };
}

export function hiddenGemScore(r: Resource, now = Date.now()): { score: number; signals: string[] } {
  const ev = evaluate(r, { now });
  const stars = r.stars ?? 0;
  const obscurity = stars <= 50 ? 1 : stars <= 500 ? 0.85 : stars <= 2000 ? 0.5 : 0.1;
  const base =
    ev.scores.maintenance!.value * 0.4 +
    ev.scores.documentation!.value * 0.25 +
    ev.scores.license!.value * 0.15 +
    (r.topics.length ? 10 : 0) +
    (r.description.length > 30 ? 10 : 0);
  const signals = [
    `maintenance ${ev.scores.maintenance!.value}`,
    `documentation ${ev.scores.documentation!.value}`,
    `licence ${ev.license.spdx ?? "none"}`,
    `${stars} stars (smaller repositories are NOT excluded)`,
  ];
  if (r.archived) return { score: 0, signals: ["archived"] };
  return { score: Math.round(base * obscurity * 10) / 10, signals };
}

export interface RadarQuery {
  text?: string;
  language?: string;
  topic?: string;
  minStars?: number;
  createdWithinDays?: number;
  pushedWithinDays?: number;
  maxAgeDays?: number;
  minAgeDays?: number;
  limit?: number;
  maxStars?: number;
  minActivityDays?: number;
}
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class TrendRadar {
  constructor(
    private github: Provider,
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  private async fetch(q: RadarQuery, sort: "stars" | "updated", extra: string[] = []): Promise<Resource[]> {
    const t = this.now();
    const parts = [q.text ?? "", ...extra];
    if (q.maxStars !== undefined) parts.push(`stars:<=${q.maxStars}`);
    return this.github.search({
      text: parts.join(" ").trim() || "stars:>1",
      language: q.language,
      topic: q.topic,
      minStars: q.minStars,
      sort,
      createdAfter: q.createdWithinDays ? isoDay(t - q.createdWithinDays * DAY) : undefined,
      pushedAfter: q.pushedWithinDays ? isoDay(t - q.pushedWithinDays * DAY) : undefined,
      limit: 50,
    });
  }
  private snapshot(list: Resource[]) {
    const t = this.now();
    for (const r of list)
      this.store.addSnapshot({
        resourceId: r.id,
        observedAt: t,
        stars: r.stars,
        forks: r.forks,
        openIssues: r.openIssues,
        pushedAt: r.pushedAt,
      });
  }
  private entry(r: Resource): TrendEntry {
    const snaps = this.store.getSnapshots(r.id);
    const trend = computeTrend(r, snaps, { now: this.now() });
    const signals: string[] = [];
    const age = daysSince(r.createdAt, this.now());
    if (age !== undefined && age < 180) signals.push(`new (${Math.round(age)} days old)`);
    if (r.forks && r.stars && r.forks / r.stars > 0.15) signals.push("high fork ratio (active usage)");
    const m = maintenanceStatus(r, this.now());
    if (m === "active") signals.push("recent pushes");
    return {
      resource: r,
      trend,
      maintenance: m,
      ageDays: age !== undefined ? Math.round(age) : undefined,
      signals,
      hiddenGemScore: undefined,
    };
  }

  /** Fast-growing / emerging repositories. Ranked by observed growth when available, else clearly-labelled estimates. */
  async trending(q: RadarQuery = {}): Promise<{ entries: TrendEntry[]; notes: string[] }> {
    const q2 = { ...q, createdWithinDays: q.createdWithinDays ?? 90, minStars: q.minStars ?? 50 };
    const list = (await this.fetch(q2, "stars")).filter((r) =>
      q.minActivityDays ? (daysSince(r.pushedAt, this.now()) ?? 9999) <= q.minActivityDays : true,
    );
    this.snapshot(list);
    const entries = list
      .map((r) => this.entry(r))
      .filter(
        (e) =>
          (q.minAgeDays ? (e.ageDays ?? 0) >= q.minAgeDays : true) &&
          (q.maxAgeDays ? (e.ageDays ?? 0) <= q.maxAgeDays : true),
      );
    entries.sort((a, b) => rankKey(b) - rankKey(a));
    const observed = entries.filter((e) => e.trend.label === "observed").length;
    return {
      entries: entries.slice(0, q.limit ?? 20),
      notes: [
        observed
          ? `${observed} entries have OBSERVED growth from local snapshots.`
          : "No observed growth yet: values are lifetime-average ESTIMATES. Snapshots were recorded now; run again later (>=1 day apart) to obtain observed growth.",
        "Rankings never use fabricated history.",
      ],
    };
  }

  /** Smaller repositories that look healthy and useful. Small size is never an exclusion criterion. */
  async hiddenGems(q: RadarQuery = {}): Promise<{ entries: TrendEntry[]; notes: string[] }> {
    const q2 = { ...q, maxStars: q.maxStars ?? 500, pushedWithinDays: q.pushedWithinDays ?? 180 };
    const list = await this.fetch(q2, "updated");
    this.snapshot(list);
    const entries = list
      .map((r) => {
        const e = this.entry(r);
        const g = hiddenGemScore(r, this.now());
        e.hiddenGemScore = g.score;
        e.signals.push(...g.signals);
        return e;
      })
      .sort((a, b) => (b.hiddenGemScore ?? 0) - (a.hiddenGemScore ?? 0));
    return {
      entries: entries.slice(0, q.limit ?? 20),
      notes: [
        "Gem score = maintenance, documentation, licence and metadata completeness, scaled by obscurity. It is a heuristic, not a quality guarantee.",
      ],
    };
  }

  /** Established projects that look abandoned or declining (observed negative growth, archived, or long inactivity). */
  async declining(q: RadarQuery = {}): Promise<{ entries: TrendEntry[]; notes: string[] }> {
    const list = await this.fetch({ ...q, minStars: q.minStars ?? 500 }, "stars");
    this.snapshot(list);
    const entries = list
      .map((r) => this.entry(r))
      .filter(
        (e) =>
          ["abandoned", "stale", "archived"].includes(e.maintenance) ||
          (e.trend.label === "observed" && (e.trend.starsPerDay ?? 0) < 0),
      );
    return {
      entries: entries.slice(0, q.limit ?? 20),
      notes: [
        "Status is derived from last-push date and archive flag (verified metadata). Negative growth is reported only when observed in local snapshots.",
      ],
    };
  }

  /** Contributor-activity proxy: needs repository extras, so only available per repo. */
  history(resourceId: string) {
    return this.store.getSnapshots(resourceId);
  }
}
function rankKey(e: TrendEntry): number {
  const v = e.trend.starsPerDay ?? 0;
  return e.trend.label === "observed" ? 1e6 + v : v;
}
