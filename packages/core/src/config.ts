import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScoutError } from "./errors.js";

export const ConfigSchema = z.object({
  dataDir: z.string(),
  dbPath: z.string(),
  cacheTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(6 * 3600),
  searchTtlSeconds: z.number().int().positive().default(3600),
  analysisTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(24 * 3600),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("warn"),
  offline: z.boolean().default(false),
  providers: z
    .object({
      enabled: z.array(z.string()).optional().describe("allow-list; default = all public providers"),
      disabled: z.array(z.string()).default([]),
      timeoutMs: z.record(z.string(), z.number().int().positive()).default({}),
    })
    .default({ disabled: [], timeoutMs: {} }),
  credentials: z
    .object({
      githubToken: z.string().optional(),
      gitlabToken: z.string().optional(),
      codebergToken: z.string().optional(),
      braveApiKey: z.string().optional(),
      searxngUrl: z.string().optional(),
    })
    .default({}),
  embeddings: z
    .object({
      provider: z.enum(["none", "ollama"]).default("none"),
      url: z.string().default("http://127.0.0.1:11434"),
      model: z.string().default("nomic-embed-text"),
    })
    .default({ provider: "none", url: "http://127.0.0.1:11434", model: "nomic-embed-text" }),
  limits: z
    .object({
      maxCandidates: z.number().int().positive().default(120),
      maxShortlist: z.number().int().positive().default(15),
      maxDeepInspect: z.number().int().positive().default(5),
    })
    .default({ maxCandidates: 120, maxShortlist: 15, maxDeepInspect: 5 }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPO_SCOUT_HOME) return path.resolve(env.REPO_SCOUT_HOME);
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "repo-scout");
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "repo-scout");
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "repo-scout");
}
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPO_SCOUT_CONFIG) return path.resolve(env.REPO_SCOUT_CONFIG);
  return path.join(defaultDataDir(env), "config.json");
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** Load config: defaults < config file < environment. Secrets are never written by Repo Scout. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Record<string, unknown>> = {},
): Config {
  let file: Record<string, any> = {};
  const cf = configFilePath(env);
  try {
    if (fs.existsSync(cf)) file = JSON.parse(fs.readFileSync(cf, "utf8"));
  } catch (e) {
    throw new ScoutError(
      "CONFIG",
      `Cannot parse config file ${cf}: ${(e as Error).message}`,
      "Fix or delete the file.",
    );
  }
  const dataDir = path.resolve(
    String(overrides.dataDir ?? env.REPO_SCOUT_HOME ?? file.dataDir ?? defaultDataDir(env)),
  );
  const merged = {
    ...file,
    dataDir,
    dbPath: path.resolve(
      String(overrides.dbPath ?? env.REPO_SCOUT_DB ?? file.dbPath ?? path.join(dataDir, "scout.sqlite")),
    ),
    cacheTtlSeconds: num(env.REPO_SCOUT_CACHE_TTL) ?? file.cacheTtlSeconds,
    logLevel: env.REPO_SCOUT_LOG_LEVEL ?? file.logLevel,
    offline: env.REPO_SCOUT_OFFLINE === "1" ? true : file.offline,
    credentials: {
      ...(file.credentials ?? {}),
      ...(env.GITHUB_TOKEN || env.GH_TOKEN ? { githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN } : {}),
      ...(env.GITLAB_TOKEN ? { gitlabToken: env.GITLAB_TOKEN } : {}),
      ...(env.CODEBERG_TOKEN ? { codebergToken: env.CODEBERG_TOKEN } : {}),
      ...(env.BRAVE_API_KEY ? { braveApiKey: env.BRAVE_API_KEY } : {}),
      ...(env.SEARXNG_URL ? { searxngUrl: env.SEARXNG_URL } : {}),
    },
    embeddings: {
      ...(file.embeddings ?? {}),
      ...(env.REPO_SCOUT_EMBEDDINGS ? { provider: env.REPO_SCOUT_EMBEDDINGS } : {}),
      ...(env.OLLAMA_HOST ? { url: env.OLLAMA_HOST } : {}),
    },
    ...(overrides.logLevel ? { logLevel: overrides.logLevel } : {}),
    ...(overrides.offline !== undefined ? { offline: overrides.offline } : {}),
  };
  for (const k of ["credentials", "providers", "limits", "embeddings"] as const)
    if (overrides[k] && typeof overrides[k] === "object")
      (merged as any)[k] = { ...(merged as any)[k], ...(overrides[k] as object) };
  for (const k of ["cacheTtlSeconds", "searchTtlSeconds", "analysisTtlSeconds"] as const)
    if (typeof overrides[k] === "number") (merged as any)[k] = overrides[k];
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success)
    throw new ScoutError(
      "CONFIG",
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

/** Config safe for display: credentials reduced to booleans. */
export function describeConfig(c: Config) {
  const { credentials, ...rest } = c;
  return {
    ...rest,
    credentials: Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, Boolean(v)])),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
