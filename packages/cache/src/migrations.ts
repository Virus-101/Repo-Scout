export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE resources (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, type TEXT NOT NULL, canonical_url TEXT NOT NULL,
  full_name TEXT, json TEXT NOT NULL, retrieved_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_resources_url ON resources(canonical_url);
CREATE INDEX idx_resources_fullname ON resources(full_name);
CREATE TABLE kv_cache (
  namespace TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX idx_kv_expires ON kv_cache(expires_at);
CREATE TABLE snapshots (
  resource_id TEXT NOT NULL, observed_at INTEGER NOT NULL, stars INTEGER, forks INTEGER, open_issues INTEGER, watchers INTEGER, pushed_at TEXT,
  PRIMARY KEY (resource_id, observed_at)
);
CREATE TABLE relations (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE scores (
  resource_id TEXT NOT NULL, context_key TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (resource_id, context_key)
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY, last_ok_at INTEGER, last_error TEXT, last_error_at INTEGER, requests INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
];
