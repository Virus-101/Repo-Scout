import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ScoutError, ensureDir, type Config } from "@repo-scout/core";
import type { Resource } from "@repo-scout/schemas";
import { MIGRATIONS } from "./migrations.js";

export type CacheScope = "all" | "search" | "analysis" | "resources" | "snapshots" | "expired" | "scores";
export interface Snapshot {
  resourceId: string;
  observedAt: number;
  stars?: number;
  forks?: number;
  openIssues?: number;
  watchers?: number;
  pushedAt?: string;
}

/**
 * SQLite-backed local intelligence store (node:sqlite, no native build step).
 * WAL + busy_timeout + immediate transactions make it safe for several agents (processes) sharing one file.
 */
export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  constructor(
    readonly dbPath: string,
    private now: () => number = Date.now,
  ) {
    try {
      if (dbPath !== ":memory:") ensureDir(path.dirname(dbPath));
      this.db = new DatabaseSync(dbPath);
      this.db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 8000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
      );
      this.migrate();
      if (dbPath !== ":memory:") {
        try {
          fs.chmodSync(dbPath, 0o600);
        } catch {
          /* best effort (Windows) */
        }
      }
    } catch (e) {
      if (e instanceof ScoutError) throw e;
      throw new ScoutError(
        "DATABASE",
        `Cannot open database at ${dbPath}: ${(e as Error).message}`,
        "Check permissions or set REPO_SCOUT_HOME / REPO_SCOUT_DB.",
      );
    }
  }
  static open(cfg: Pick<Config, "dbPath">) {
    return new Store(cfg.dbPath);
  }

  private p(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ migrations
  schemaVersion(): number {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number | null;
    };
    return row.v ?? 0;
  }
  private migrate() {
    const current = this.schemaVersion();
    for (const m of MIGRATIONS.filter((x) => x.version > current)) {
      this.tx(() => {
        // re-check inside the write lock: another process may have migrated meanwhile
        const v =
          (this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null })
            .v ?? 0;
        if (v >= m.version) return;
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
          .run(m.version, m.name, this.now());
      });
    }
  }

  // ------------------------------------------------------------ generic cache
  getCache<T>(
    namespace: string,
    key: string,
    opts: { allowStale?: boolean } = {},
  ): { value: T; createdAt: number; stale: boolean } | undefined {
    const row = this.p("SELECT json, created_at, expires_at FROM kv_cache WHERE namespace=? AND key=?").get(
      namespace,
      key,
    ) as { json: string; created_at: number; expires_at: number } | undefined;
    if (!row) return undefined;
    const stale = row.expires_at <= this.now();
    if (stale && !opts.allowStale) return undefined;
    return { value: JSON.parse(row.json) as T, createdAt: row.created_at, stale };
  }
  setCache(namespace: string, key: string, value: unknown, ttlSeconds: number): void {
    const t = this.now();
    this.p(
      "INSERT INTO kv_cache(namespace,key,json,created_at,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET json=excluded.json, created_at=excluded.created_at, expires_at=excluded.expires_at",
    ).run(namespace, key, JSON.stringify(value), t, t + ttlSeconds * 1000);
  }
  invalidate(namespace: string, keyPrefix?: string): number {
    const r =
      keyPrefix === undefined
        ? this.p("DELETE FROM kv_cache WHERE namespace=?").run(namespace)
        : this.p("DELETE FROM kv_cache WHERE namespace=? AND key LIKE ? ESCAPE '\\'").run(
            namespace,
            keyPrefix.replace(/[\\%_]/g, "\\$&") + "%",
          );
    return Number(r.changes);
  }

  // ------------------------------------------------------------ resources (dedup by id; canonical url secondary)
  upsertResources(list: Resource[], ttlSeconds: number): void {
    const t = this.now();
    this.tx(() => {
      for (const r of list) {
        this.p(
          `INSERT INTO resources(id,provider,type,canonical_url,full_name,json,retrieved_at,expires_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET json=excluded.json, retrieved_at=excluded.retrieved_at, expires_at=excluded.expires_at, canonical_url=excluded.canonical_url, full_name=excluded.full_name`,
        ).run(
          r.id,
          r.provider,
          r.type,
          r.canonicalUrl,
          r.fullName ?? null,
          JSON.stringify(r),
          t,
          t + ttlSeconds * 1000,
        );
      }
    });
  }
  getResource(id: string, opts: { allowStale?: boolean } = {}): Resource | undefined {
    const row = this.p("SELECT json, expires_at FROM resources WHERE id=?").get(id) as
      { json: string; expires_at: number } | undefined;
    if (!row || (row.expires_at <= this.now() && !opts.allowStale)) return undefined;
    return JSON.parse(row.json) as Resource;
  }
  findResourceByFullName(fullName: string, type = "repository"): Resource | undefined {
    const row = this.p(
      "SELECT json, expires_at FROM resources WHERE lower(full_name)=lower(?) AND type=? ORDER BY retrieved_at DESC LIMIT 1",
    ).get(fullName, type) as { json: string; expires_at: number } | undefined;
    return row ? (JSON.parse(row.json) as Resource) : undefined;
  }

  // ------------------------------------------------------------ snapshots (persist forever until cleared)
  addSnapshot(s: Snapshot, minGapMs = 60_000): boolean {
    const last = this.p(
      "SELECT observed_at FROM snapshots WHERE resource_id=? ORDER BY observed_at DESC LIMIT 1",
    ).get(s.resourceId) as { observed_at: number } | undefined;
    if (last && s.observedAt - last.observed_at < minGapMs) return false;
    this.p(
      "INSERT OR IGNORE INTO snapshots(resource_id,observed_at,stars,forks,open_issues,watchers,pushed_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      s.resourceId,
      s.observedAt,
      s.stars ?? null,
      s.forks ?? null,
      s.openIssues ?? null,
      s.watchers ?? null,
      s.pushedAt ?? null,
    );
    return true;
  }
  getSnapshots(resourceId: string, sinceMs = 0): Snapshot[] {
    const rows = this.p(
      "SELECT * FROM snapshots WHERE resource_id=? AND observed_at>=? ORDER BY observed_at ASC",
    ).all(resourceId, sinceMs) as any[];
    return rows.map((r) => ({
      resourceId: r.resource_id,
      observedAt: r.observed_at,
      stars: r.stars ?? undefined,
      forks: r.forks ?? undefined,
      openIssues: r.open_issues ?? undefined,
      watchers: r.watchers ?? undefined,
      pushedAt: r.pushed_at ?? undefined,
    }));
  }

  // ------------------------------------------------------------ relations / scores / providers
  addRelation(from: string, to: string, kind: string) {
    this.p("INSERT OR REPLACE INTO relations(from_id,to_id,kind,created_at) VALUES (?,?,?,?)").run(
      from,
      to,
      kind,
      this.now(),
    );
  }
  getRelations(id: string): Array<{ from: string; to: string; kind: string }> {
    return (
      this.p("SELECT from_id,to_id,kind FROM relations WHERE from_id=? OR to_id=?").all(id, id) as any[]
    ).map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind }));
  }
  saveScore(resourceId: string, contextKey: string, value: unknown) {
    this.p("INSERT OR REPLACE INTO scores(resource_id,context_key,json,created_at) VALUES (?,?,?,?)").run(
      resourceId,
      contextKey,
      JSON.stringify(value),
      this.now(),
    );
  }
  getScore<T>(resourceId: string, contextKey: string): T | undefined {
    const r = this.p("SELECT json FROM scores WHERE resource_id=? AND context_key=?").get(
      resourceId,
      contextKey,
    ) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  recordProvider(id: string, ok: boolean, error?: string) {
    const t = this.now();
    this.p(
      `INSERT INTO providers(id,last_ok_at,last_error,last_error_at,requests,failures) VALUES (?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET requests=requests+1, failures=failures+?, last_ok_at=COALESCE(?, last_ok_at), last_error=COALESCE(?, last_error), last_error_at=COALESCE(?, last_error_at)`,
    ).run(
      id,
      ok ? t : null,
      ok ? null : (error ?? "error").slice(0, 300),
      ok ? null : t,
      ok ? 0 : 1,
      ok ? 0 : 1,
      ok ? t : null,
      ok ? null : (error ?? "error").slice(0, 300),
      ok ? null : t,
    );
  }
  providerStats(): Array<{
    id: string;
    lastOkAt?: number;
    lastError?: string;
    requests: number;
    failures: number;
  }> {
    return (this.p("SELECT * FROM providers ORDER BY id").all() as any[]).map((r) => ({
      id: r.id,
      lastOkAt: r.last_ok_at ?? undefined,
      lastError: r.last_error ?? undefined,
      requests: r.requests,
      failures: r.failures,
    }));
  }
  setMeta(key: string, value: string) {
    this.p("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(key, value);
  }
  getMeta(key: string): string | undefined {
    return (this.p("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }

  // ------------------------------------------------------------ maintenance
  status() {
    const c = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    const t = this.now();
    let size = 0;
    if (this.dbPath !== ":memory:") {
      try {
        size = fs.statSync(this.dbPath).size;
      } catch {
        /* ignore */
      }
    }
    return {
      dbPath: this.dbPath,
      sizeBytes: size,
      schemaVersion: this.schemaVersion(),
      resources: c("SELECT COUNT(*) n FROM resources"),
      cacheEntries: c("SELECT COUNT(*) n FROM kv_cache"),
      searchEntries: c("SELECT COUNT(*) n FROM kv_cache WHERE namespace='search'"),
      analysisEntries: c("SELECT COUNT(*) n FROM kv_cache WHERE namespace='analysis'"),
      expiredEntries:
        c(`SELECT COUNT(*) n FROM kv_cache WHERE expires_at<=${t}`) +
        c(`SELECT COUNT(*) n FROM resources WHERE expires_at<=${t}`),
      snapshots: c("SELECT COUNT(*) n FROM snapshots"),
      relations: c("SELECT COUNT(*) n FROM relations"),
      scores: c("SELECT COUNT(*) n FROM scores"),
      oldestSnapshot:
        (this.db.prepare("SELECT MIN(observed_at) m FROM snapshots").get() as { m: number | null }).m ??
        undefined,
    };
  }
  clear(scope: CacheScope = "expired"): Record<string, number> {
    const t = this.now();
    const out: Record<string, number> = {};
    this.tx(() => {
      const del = (label: string, sql: string, ...a: any[]) => {
        out[label] = Number(this.db.prepare(sql).run(...a).changes);
      };
      switch (scope) {
        case "expired":
          del("kv_cache", "DELETE FROM kv_cache WHERE expires_at<=?", t);
          del("resources", "DELETE FROM resources WHERE expires_at<=?", t);
          break;
        case "search":
          del("search", "DELETE FROM kv_cache WHERE namespace='search'");
          break;
        case "analysis":
          del("analysis", "DELETE FROM kv_cache WHERE namespace IN ('analysis','security','deps')");
          break;
        case "resources":
          del("resources", "DELETE FROM resources");
          break;
        case "scores":
          del("scores", "DELETE FROM scores");
          break;
        case "snapshots":
          del("snapshots", "DELETE FROM snapshots");
          break;
        case "all":
          for (const tb of ["kv_cache", "resources", "scores", "relations", "snapshots", "providers"])
            del(tb, `DELETE FROM ${tb}`);
          break;
      }
    });
    if (scope === "all" || scope === "expired") {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
      } catch {
        /* ignore if busy */
      }
    }
    return out;
  }
  integrityCheck(): string {
    return String((this.db.prepare("PRAGMA integrity_check").get() as any).integrity_check);
  }
  close() {
    this.stmts.clear();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
