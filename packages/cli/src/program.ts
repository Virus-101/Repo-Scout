import { Command, CommanderError, Option } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, type EngineOptions } from "@repo-scout/discovery";
import {
  ScoutError,
  describeConfig,
  loadConfig,
  configFilePath,
  safeExec,
  type Config,
} from "@repo-scout/core";
import { VERSION } from "@repo-scout/schemas";
import { executeTool, runStdioServer } from "@repo-scout/mcp";
import { INTEGRATIONS, findIntegration } from "./integrations.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}
export interface CliDeps {
  io?: Partial<CliIO>;
  engineOptions?: EngineOptions;
  createEngine?: (cfg: Config) => Engine;
}

const EXIT: Record<string, number> = {
  INVALID_INPUT: 2,
  NOT_FOUND: 3,
  PROVIDER_ERROR: 4,
  PROVIDER_UNAVAILABLE: 4,
  NETWORK: 4,
  TIMEOUT: 4,
  RATE_LIMITED: 5,
  SECURITY_BLOCKED: 6,
  CONFIG: 7,
  DATABASE: 8,
  INTERNAL: 1,
};

type Fmt = "text" | "json" | "markdown";
interface GlobalOpts {
  json?: boolean;
  format?: Fmt;
  markdown?: boolean;
  verbose?: boolean;
  color?: boolean;
  offline?: boolean;
  db?: string;
  home?: string;
  output?: string;
  force?: boolean;
}

export function buildProgram(deps: CliDeps = {}) {
  const io: CliIO = {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    isTTY: !!process.stdout.isTTY,
    env: process.env,
    ...deps.io,
  };
  let exitCode = 0;
  let engine: Engine | undefined;
  const program = new Command();
  program
    .name("repo-scout")
    .description(
      "Find the building blocks. Build smarter.\nLocal-first repository discovery & implementation intelligence for developers and AI coding agents.",
    )
    .version(VERSION, "-V, --version")
    .showHelpAfterError("(run with --help for usage)")
    .option("--json", "machine-readable JSON output (same envelope as the MCP tools)")
    .option("--markdown", "Markdown report output")
    .option("-v, --verbose", "debug logging to stderr")
    .option("--no-color", "disable ANSI colours")
    .option("--offline", "never use the network (cache only)")
    .option("--db <path>", "SQLite database path (default: per-user data dir)")
    .option("--home <dir>", "Repo Scout data directory")
    .option("-o, --output <file>", "write the report to a file instead of stdout")
    .option("--force", "overwrite --output file if it exists")
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, "")),
      writeErr: (s) => io.err(s.replace(/\n$/, "")),
    })
    .exitOverride();

  const g = (): GlobalOpts => program.opts();
  const format = (): Fmt => (g().json ? "json" : g().markdown ? "markdown" : "text");
  const getEngine = () => {
    if (engine) return engine;
    const o = g();
    const cfg = loadConfig(io.env, {
      dataDir: o.home,
      dbPath: o.db,
      offline: o.offline ? true : undefined,
      logLevel: o.verbose ? "debug" : undefined,
    });
    engine = deps.createEngine
      ? deps.createEngine(cfg)
      : new Engine({ ...(deps.engineOptions ?? {}), config: cfg });
    return engine;
  };
  const emit = (text: string) => {
    const o = g();
    if (o.output) {
      const target = path.resolve(o.output);
      if (fs.existsSync(target) && !o.force)
        throw new ScoutError("INVALID_INPUT", `${target} exists`, "Use --force to overwrite.");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text.endsWith("\n") ? text : text + "\n");
      io.err(`Report written to ${target}`);
    } else io.out(text);
  };

  /** Execute an MCP-equivalent tool and print it in the requested format. */
  async function run(tool: string, args: Record<string, unknown>) {
    const r = await executeTool(getEngine(), tool, args);
    if (!r.envelope.ok) {
      const code = r.envelope.error?.code ?? "INTERNAL";
      exitCode = EXIT[code] ?? 1;
      if (format() === "json") emit(JSON.stringify(r.envelope, null, 2));
      else {
        io.err(`error [${code}]: ${r.envelope.error?.message}`);
        if (r.envelope.error?.hint) io.err(`hint: ${r.envelope.error.hint}`);
      }
      return;
    }
    const f = format();
    if (f === "json") emit(JSON.stringify(r.envelope, null, 2));
    else if (f === "markdown") emit(r.markdown ?? r.envelope.summary);
    else {
      const useColor = g().color !== false && io.isTTY && !io.env.NO_COLOR;
      void useColor;
      emit([r.envelope.summary, "", r.terminal ?? r.markdown ?? ""].join("\n").trim());
    }
    for (const w of r.envelope.warnings) io.err(`warning: ${w.trim()}`);
  }
  const int = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new CommanderError(2, "invalid", `Expected a non-negative integer, got "${v}"`);
    return n;
  };
  const withListOpts = (c: Command) =>
    c
      .option("-n, --limit <n>", "max results", int)
      .option("--offset <n>", "pagination offset", int)
      .option("-l, --language <lang>", "preferred language")
      .option("-p, --provider <id...>", "restrict to provider ids")
      .addOption(new Option("--sort <by>", "sort order").choices(["score", "stars", "updated"]));

  withListOpts(
    program
      .command("search <query...>")
      .description("search repositories, packages, papers and curated lists")
      .option("--kind <kind...>", "resource kinds: repository package paper documentation collection website")
      .option("--deep <n>", "deeply inspect top N GitHub repos", int),
  ).action((q: string[], o) =>
    run("scout_search", {
      query: q.join(" "),
      kinds: o.kind,
      providers: o.provider,
      language: o.language,
      limit: o.limit,
      offset: o.offset,
      deep: o.deep,
      sort: o.sort,
    }),
  );
  withListOpts(
    program
      .command("find <task...>")
      .description(
        "full discovery pipeline for a described task (understand → search → filter → score → inspect)",
      )
      .option("--deep <n>", "deep-inspect top N (default 5)", int)
      .option("--min-score <n>", "minimum overall score", Number),
  ).action((t: string[], o) =>
    run("scout_find_repositories", {
      task: t.join(" "),
      language: o.language,
      providers: o.provider,
      limit: o.limit,
      offset: o.offset,
      deep: o.deep,
      minScore: o.minScore,
    }),
  );
  program
    .command("analyze <repository>")
    .description("deep static analysis of owner/repo")
    .option("--task <text>", "task context for adaptive scoring")
    .option("--refresh", "bypass cache")
    .action((r: string, o) =>
      run("scout_analyze_repository", { repository: r, task: o.task, refresh: o.refresh }),
    );
  program
    .command("compare <repositories...>")
    .description("compare 2-6 repositories")
    .option("--task <text>", "task context")
    .action((r: string[], o) => run("scout_compare_repositories", { repositories: r, task: o.task }));
  program
    .command("compose <task...>")
    .description("compose complete solutions from several compatible repositories")
    .option("-l, --language <lang>")
    .option("--packages", "also consider registry packages linked to a source repo")
    .option("--max-solutions <n>", "options to return", int)
    .option("--deep <n>", "deep-inspect top N per component", int)
    .action((t: string[], o) =>
      run("scout_compose_solution", {
        task: t.join(" "),
        language: o.language,
        includePackages: o.packages,
        maxSolutions: o.maxSolutions,
        deepPerComponent: o.deep,
      }),
    );
  program
    .command("plan <task...>")
    .description("implementation plan with explicit approval gates (for your AI agent)")
    .option("-l, --language <lang>")
    .option("--option <n>", "which composed option (0-based)", int)
    .action((t: string[], o) =>
      run("scout_generate_implementation_plan", {
        task: t.join(" "),
        language: o.language,
        solutionIndex: o.option,
      }),
    );
  program
    .command("understand <task...>")
    .description("show how Repo Scout parses a task (no network)")
    .option("-l, --language <lang>")
    .option("--project-license <spdx>")
    .action((t: string[], o) =>
      run("scout_understand_task", {
        task: t.join(" "),
        language: o.language,
        projectLicense: o.projectLicense,
      }),
    );
  program
    .command("alternatives <name>")
    .description("alternatives to a library / project")
    .option("-n, --limit <n>", "max results", int)
    .option("-l, --language <lang>")
    .option("-p, --provider <id...>")
    .action((n: string, o) =>
      run("scout_find_alternatives", {
        name: n,
        limit: o.limit,
        language: o.language,
        providers: o.provider,
      }),
    );
  program
    .command("related <repository>")
    .description("related projects")
    .option("-n, --limit <n>", "", int)
    .option("-p, --provider <id...>")
    .action((r: string, o) =>
      run("scout_find_related_projects", { repository: r, limit: o.limit, providers: o.provider }),
    );
  program
    .command("details <repository>")
    .description("raw metadata for a repository")
    .option("--readme", "include README excerpt")
    .option("--tree", "include file tree")
    .option("--refresh")
    .action((r: string, o) =>
      run("scout_get_repository_details", {
        repository: r,
        includeReadme: o.readme,
        includeTree: o.tree,
        refresh: o.refresh,
      }),
    );
  program
    .command("license <repository>")
    .description("licence classification & suitability")
    .option("--task <text>")
    .option("--project-license <spdx>")
    .action((r: string, o) =>
      run("scout_check_license", { repository: r, task: o.task, projectLicense: o.projectLicense }),
    );
  program
    .command("security <repository>")
    .description("security indicators (not an audit)")
    .action((r: string) => run("scout_check_security", { repository: r }));
  program
    .command("deps [repository]")
    .description("dependency inspection (repository, or --file of your own manifest)")
    .option("--file <path>", "local manifest file to parse (never executed)")
    .option("--no-vuln", "skip OSV lookup")
    .action(async (r: string | undefined, o) => {
      if (o.file) {
        const p = path.resolve(o.file);
        if (!fs.existsSync(p)) throw new ScoutError("NOT_FOUND", `${p} not found`);
        return run("scout_inspect_dependencies", {
          manifestPath: path.basename(p),
          manifestContent: fs.readFileSync(p, "utf8"),
          vulnerabilities: o.vuln,
        });
      }
      return run("scout_inspect_dependencies", { repository: r, vulnerabilities: o.vuln });
    });
  const radar = (name: string, desc: string, tool: string, extra: Record<string, unknown> = {}) =>
    program
      .command(name)
      .description(desc)
      .option("-l, --language <lang>")
      .option("--topic <topic>")
      .option("--text <query>", "keyword filter")
      .option("-n, --limit <n>", "", int)
      .option("--days <n>", "created within N days (trending) / pushed within N days (hidden-gems)", int)
      .option("--min-stars <n>", "", int)
      .option("--max-stars <n>", "", int)
      .option("--min-activity-days <n>", "require a push within N days", int)
      .option("--min-age <days>", "", int)
      .option("--max-age <days>", "", int)
      .action((o) =>
        run(tool, {
          language: o.language,
          topic: o.topic,
          text: o.text,
          limit: o.limit,
          createdWithinDays: tool === "scout_find_trending" ? o.days : undefined,
          pushedWithinDays: tool === "scout_find_hidden_gems" ? o.days : undefined,
          minStars: o.minStars,
          maxStars: o.maxStars,
          minActivityDays: o.minActivityDays,
          minAgeDays: o.minAge,
          maxAgeDays: o.maxAge,
          ...extra,
        }),
      );
  radar("trending", "fast-growing repositories (observed vs estimated growth)", "scout_find_trending");
  radar("declining", "abandoned or declining established projects", "scout_find_trending", {
    mode: "declining",
  });
  radar("hidden-gems", "healthy smaller repositories", "scout_find_hidden_gems");
  program
    .command("providers")
    .description("list discovery providers and their availability")
    .action(() => run("scout_list_providers", {}));

  const cache = program.command("cache").description("local database & cache");
  cache
    .command("status")
    .description("show database status")
    .action(() => run("scout_cache_status", {}));
  cache
    .command("clear")
    .description("delete cached data")
    .addOption(
      new Option("--scope <scope>", "what to clear")
        .choices(["expired", "search", "analysis", "resources", "scores", "snapshots", "all"])
        .default("expired"),
    )
    .option("-y, --yes", "confirm without prompting (required)")
    .action((o) => run("scout_clear_cache", { scope: o.scope, confirm: !!o.yes }));

  program
    .command("mcp")
    .description("start the MCP server on stdio (used by AI agents)")
    .action(async () => {
      await runStdioServer(getEngine());
      await new Promise(() => {});
    });

  program
    .command("integrate [agent]")
    .description("print MCP configuration for an agent: " + INTEGRATIONS.map((i) => i.id).join(", "))
    .option("--command <cmd>", "launch command", "npx")
    .option("--args <args...>", "launch args", ["-y", "repo-scout", "mcp"])
    .action((agent: string | undefined, o) => {
      const list = agent
        ? [findIntegration(agent)].filter((x): x is NonNullable<typeof x> => !!x)
        : INTEGRATIONS;
      if (!list.length)
        throw new ScoutError(
          "INVALID_INPUT",
          `Unknown agent "${agent}"`,
          `Choose one of: ${INTEGRATIONS.map((i) => i.id).join(", ")}`,
        );
      const txt = list
        .map(
          (i) =>
            `## ${i.name}\nConfig location: ${i.configPath}\n\n${i.snippet({ command: o.command, args: o.args })}\n\n${i.notes.map((n) => `- ${n}`).join("\n")}\n`,
        )
        .join("\n");
      if (format() === "json")
        emit(
          JSON.stringify(
            list.map((i) => ({
              id: i.id,
              name: i.name,
              configPath: i.configPath,
              snippet: i.snippet({ command: o.command, args: o.args }),
              notes: i.notes,
            })),
            null,
            2,
          ),
        );
      else emit(txt);
    });
  program
    .command("skill")
    .description("print the path of the bundled agent skill (SKILL.md)")
    .action(() => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const cands = [
        path.join(here, "..", "skills", "repo-scout"),
        path.join(here, "..", "..", "..", "skills", "repo-scout"),
      ];
      const found = cands.find((c) => fs.existsSync(path.join(c, "SKILL.md")));
      if (!found) throw new ScoutError("NOT_FOUND", "Bundled skill not found");
      emit(
        found +
          "\n\nCopy this directory to your agent's skills folder, e.g.\n  cp -r " +
          found +
          " ~/.claude/skills/repo-scout",
      );
    });

  program
    .command("doctor")
    .description("diagnose installation, database, network and credentials")
    .action(async () => {
      const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
      const add = (name: string, status: "ok" | "warn" | "fail", detail: string) =>
        checks.push({ name, status, detail });
      const major = Number(process.versions.node.split(".")[0]),
        minor = Number(process.versions.node.split(".")[1]);
      add(
        "node",
        major > 22 || (major === 22 && minor >= 13) ? "ok" : "fail",
        `v${process.versions.node} (needs >=22.13 for stable node:sqlite)`,
      );
      add("platform", "ok", `${process.platform}/${process.arch}`);
      let cfg: Config | undefined;
      try {
        cfg = loadConfig(io.env, {
          dataDir: g().home,
          dbPath: g().db,
          offline: g().offline ? true : undefined,
        });
        add(
          "config",
          "ok",
          `file: ${configFilePath(io.env)} (${fs.existsSync(configFilePath(io.env)) ? "present" : "not present, defaults used"})`,
        );
      } catch (e) {
        add("config", "fail", (e as Error).message);
      }
      if (cfg) {
        try {
          const eng = getEngine();
          const st = eng.store.status();
          const ic = eng.store.integrityCheck();
          add(
            "database",
            ic === "ok" ? "ok" : "fail",
            `${st.dbPath} · schema v${st.schemaVersion} · integrity ${ic} · ${(st.sizeBytes / 1024).toFixed(0)} KiB`,
          );
        } catch (e) {
          add("database", "fail", (e as Error).message);
        }
        add(
          "github token",
          cfg.credentials.githubToken ? "ok" : "warn",
          cfg.credentials.githubToken
            ? "configured (not displayed)"
            : "not set: GitHub allows only 60 core/10 search requests per hour anonymously. Set GITHUB_TOKEN.",
        );
        add(
          "embeddings",
          "ok",
          cfg.embeddings.provider === "none"
            ? "none (lexical + metadata retrieval; fully functional)"
            : `${cfg.embeddings.provider} @ ${cfg.embeddings.url}`,
        );
        if (cfg.offline) add("network", "warn", "offline mode: provider checks skipped");
        else {
          try {
            const r = await getEngine().http.request("https://api.github.com/rate_limit", {
              provider: "doctor",
              timeoutMs: 8000,
              headers: cfg.credentials.githubToken
                ? { authorization: `Bearer ${cfg.credentials.githubToken}` }
                : {},
            });
            const j = JSON.parse(r.text);
            add(
              "network (GitHub)",
              r.status === 200 ? "ok" : "warn",
              `HTTP ${r.status}; search quota ${j.resources?.search?.remaining ?? "?"}/${j.resources?.search?.limit ?? "?"}, core ${j.resources?.core?.remaining ?? "?"}/${j.resources?.core?.limit ?? "?"}`,
            );
          } catch (e) {
            add("network (GitHub)", "fail", (e as Error).message);
          }
        }
        const prov = getEngine().registry.describe();
        add(
          "providers",
          "ok",
          `${prov.filter((p) => p.available).length}/${prov.length} available (${
            prov
              .filter((p) => !p.available)
              .map((p) => `${p.id}: ${p.unavailableReason}`)
              .join("; ") || "all"
          })`,
        );
      }
      try {
        const v = await safeExec("git", ["--version"]);
        add(
          "git",
          "ok",
          v.stdout.trim() + " (used by your agent for approved clones; Repo Scout itself never clones)",
        );
      } catch {
        add("git", "warn", "git not found: your agent will not be able to clone repositories");
      }
      const failed = checks.some((c) => c.status === "fail");
      if (failed) exitCode = 1;
      if (format() === "json")
        emit(
          JSON.stringify(
            { ok: !failed, version: VERSION, checks, config: cfg ? describeConfig(cfg) : undefined },
            null,
            2,
          ),
        );
      else
        emit(
          [
            `repo-scout ${VERSION} doctor`,
            "",
            ...checks.map(
              (c) =>
                `${c.status === "ok" ? "✔" : c.status === "warn" ? "!" : "✘"} ${c.name.padEnd(18)} ${c.detail}`,
            ),
            "",
            failed ? "Some checks failed." : "All critical checks passed.",
          ].join("\n"),
        );
    });

  async function main(argv: string[]): Promise<number> {
    exitCode = 0;
    try {
      await program.parseAsync(argv, { from: "user" });
    } catch (e) {
      if (e instanceof CommanderError) {
        if (
          e.code === "commander.helpDisplayed" ||
          e.code === "commander.version" ||
          e.code === "commander.help"
        )
          exitCode = 0;
        else exitCode = 2;
      } else if (e instanceof ScoutError) {
        io.err(`error [${e.code}]: ${e.message}`);
        if (e.hint) io.err(`hint: ${e.hint}`);
        exitCode = EXIT[e.code] ?? 1;
      } else {
        io.err(`error: ${(e as Error).message}`);
        exitCode = 1;
      }
    } finally {
      if (!(argv[0] === "mcp")) {
        engine?.close();
      }
    }
    return exitCode;
  }
  return { program, main };
}
