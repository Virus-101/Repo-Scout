import type { Dependency } from "@repo-scout/schemas";

export const MANIFEST_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "setup.py",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
];
export const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
];

export interface ManifestInfo {
  dependencies: Dependency[];
  installScripts: string[];
  runtime: string[];
  apiSurface: string[];
  license?: string;
  name?: string;
}

/** Static manifest parsing only. Never evaluates or executes manifest content. */
export function parseManifest(path: string, content: string): ManifestInfo {
  const file = path.split("/").pop()!;
  const out: ManifestInfo = { dependencies: [], installScripts: [], runtime: [], apiSurface: [] };
  try {
    switch (file) {
      case "package.json":
        parsePackageJson(path, content, out);
        break;
      case "requirements.txt":
        parseRequirements(path, content, out);
        break;
      case "pyproject.toml":
        parsePyproject(path, content, out);
        break;
      case "Cargo.toml":
        parseCargo(path, content, out);
        break;
      case "go.mod":
        parseGoMod(path, content, out);
        break;
      case "pom.xml":
        parsePom(path, content, out);
        break;
      case "setup.py":
        out.installScripts.push(`${path}: setup.py runs arbitrary Python at install time`);
        break;
      case "composer.json": {
        const j = JSON.parse(content);
        for (const [n, v] of Object.entries<string>({ ...(j.require ?? {}) }))
          if (n !== "php")
            out.dependencies.push({
              name: n,
              spec: String(v),
              ecosystem: "packagist",
              dev: false,
              manifest: path,
            });
        break;
      }
      default:
        break;
    }
  } catch {
    /* malformed manifest: report nothing rather than guess */
  }
  return out;
}

function parsePackageJson(path: string, content: string, out: ManifestInfo) {
  const j = JSON.parse(content);
  out.name = j.name;
  out.license = typeof j.license === "string" ? j.license : j.license?.type;
  for (const [n, v] of Object.entries<string>(j.dependencies ?? {}))
    out.dependencies.push({ name: n, spec: String(v), ecosystem: "npm", dev: false, manifest: path });
  for (const [n, v] of Object.entries<string>(j.devDependencies ?? {}))
    out.dependencies.push({ name: n, spec: String(v), ecosystem: "npm", dev: true, manifest: path });
  for (const [n, v] of Object.entries<string>(j.peerDependencies ?? {}))
    out.dependencies.push({ name: n, spec: String(v), ecosystem: "npm", dev: false, manifest: path });
  for (const s of ["preinstall", "install", "postinstall", "prepare"])
    if (j.scripts?.[s])
      out.installScripts.push(`${path}: scripts.${s} = ${String(j.scripts[s]).slice(0, 80)}`);
  if (j.engines?.node) out.runtime.push(`node ${j.engines.node}`);
  if (j.bin) out.apiSurface.push("CLI");
  if (j.main || j.exports || j.module) out.apiSurface.push("library");
  if (j.types || j.typings) out.apiSurface.push("typed library");
}
function parseRequirements(path: string, content: string, out: ManifestInfo) {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line || line.startsWith("-") || line.includes("://")) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(.*)$/);
    if (m)
      out.dependencies.push({
        name: m[1]!.toLowerCase(),
        spec: m[3]!.split(";")[0]!.trim() || "*",
        ecosystem: "pypi",
        dev: false,
        manifest: path,
      });
  }
}
function parsePyproject(path: string, content: string, out: ManifestInfo) {
  const start = content.match(/^\s*dependencies\s*=\s*\[/m);
  let body = "";
  if (start) {
    // bracket-aware scan: extras like "pkg[extra]" contain ']' inside quotes
    let i = start.index! + start[0].length,
      inStr: string | null = null;
    for (; i < content.length; i++) {
      const ch = content[i]!;
      if (inStr) {
        if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "]") break;
      body += ch;
    }
  }
  const dep = start ? [null, body] : null;
  if (dep)
    for (const m of dep[1]!.matchAll(/["']([^"']+)["']/g)) {
      const p = m[1]!.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
      if (p)
        out.dependencies.push({
          name: p[1]!.toLowerCase(),
          spec: p[2]!.split(";")[0]!.trim() || "*",
          ecosystem: "pypi",
          dev: false,
          manifest: path,
        });
    }
  const poetry = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (poetry)
    for (const m of poetry[1]!.matchAll(
      /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm,
    ))
      if (m[1]!.toLowerCase() !== "python")
        out.dependencies.push({
          name: m[1]!.toLowerCase(),
          spec: m[2] ?? m[3] ?? "*",
          ecosystem: "pypi",
          dev: false,
          manifest: path,
        });
  const rp = content.match(/requires-python\s*=\s*"([^"]+)"/);
  if (rp) out.runtime.push(`python ${rp[1]}`);
  if (/\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(content)) out.apiSurface.push("CLI");
  if (/\[build-system\]/.test(content)) out.apiSurface.push("library");
  const lic = content.match(/license\s*=\s*(?:\{\s*text\s*=\s*)?"([^"]+)"/);
  if (lic) out.license = lic[1];
}
function parseCargo(path: string, content: string, out: ManifestInfo) {
  for (const sec of content.matchAll(/\[((?:dev-|build-)?dependencies)\]([\s\S]*?)(?=\n\[|$)/g)) {
    const dev = sec[1]!.startsWith("dev-");
    for (const m of sec[2]!.matchAll(
      /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm,
    ))
      out.dependencies.push({
        name: m[1]!,
        spec: m[2] ?? m[3] ?? "*",
        ecosystem: "crates",
        dev,
        manifest: path,
      });
  }
  if (/^\[\[bin\]\]/m.test(content)) out.apiSurface.push("CLI");
  if (/^\[lib\]/m.test(content)) out.apiSurface.push("library");
  const lic = content.match(/^license\s*=\s*"([^"]+)"/m);
  if (lic) out.license = lic[1];
  out.runtime.push("rust toolchain");
}
function parseGoMod(path: string, content: string, out: ManifestInfo) {
  const g = content.match(/^go\s+(\S+)/m);
  if (g) out.runtime.push(`go ${g[1]}`);
  for (const m of content.matchAll(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+(v[\w.\-+]+)/gm))
    out.dependencies.push({ name: m[1]!, spec: m[2]!, ecosystem: "go", dev: false, manifest: path });
}
function parsePom(path: string, content: string, out: ManifestInfo) {
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = m[1]!.match(/<groupId>([^<]+)</)?.[1],
      a = m[1]!.match(/<artifactId>([^<]+)</)?.[1],
      v = m[1]!.match(/<version>([^<$]+)</)?.[1];
    if (g && a)
      out.dependencies.push({
        name: `${g}:${a}`,
        spec: v ?? "*",
        ecosystem: "maven",
        dev: /<scope>test</.test(m[1]!),
        manifest: path,
      });
  }
  out.runtime.push("jvm");
}

/** Lower-bound concrete version from a declared range (e.g. ^1.2.3 -> 1.2.3). Undefined if not derivable. */
export function declaredVersion(spec: string): string | undefined {
  const m = spec.match(/(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)/);
  return m ? m[1] : undefined;
}

export const FRAMEWORK_SIGNATURES: Array<[RegExp, string, string?]> = [
  [/^react(-dom)?$/, "React"],
  [/^next$/, "Next.js"],
  [/^vue$/, "Vue"],
  [/^svelte$/, "Svelte"],
  [/^@angular\/core$/, "Angular"],
  [/^express$/, "Express", "HTTP API"],
  [/^fastify$/, "Fastify", "HTTP API"],
  [/^@nestjs\/core$/, "NestJS", "HTTP API"],
  [/^electron$/, "Electron"],
  [/^@tauri-apps\/api$|^tauri$/, "Tauri"],
  [/^@modelcontextprotocol\/sdk$|^mcp$|^fastmcp$/, "MCP", "MCP server"],
  [/^langchain|^@langchain\//, "LangChain"],
  [/^langgraph/, "LangGraph"],
  [/^llama[-_]?index/, "LlamaIndex"],
  [/^crewai$/, "CrewAI"],
  [/^torch$|^pytorch$/, "PyTorch"],
  [/^tensorflow/, "TensorFlow"],
  [/^onnxruntime/, "ONNX Runtime"],
  [/^opencv/, "OpenCV"],
  [/^transformers$/, "Transformers"],
  [/^django$/, "Django", "HTTP API"],
  [/^flask$/, "Flask", "HTTP API"],
  [/^fastapi$/, "FastAPI", "HTTP API"],
  [/^pytest$/, "pytest"],
  [/^vitest$|^jest$/, "JS test runner"],
  [/^tokio$/, "tokio"],
  [/^axum$|^actix-web$|^rocket$/, "Rust web", "HTTP API"],
  [/^grpc|^@grpc\//, "gRPC", "gRPC"],
  [/graphql/, "GraphQL", "GraphQL"],
  [/^ws$|websocket|socket\.io/, "WebSocket", "WebSocket"],
  [/^openai$/, "OpenAI SDK"],
  [/^anthropic$|^@anthropic-ai\/sdk$/, "Anthropic SDK"],
  [/^ollama$/, "Ollama client"],
  [/^ros|^rclpy$|^rclcpp$/, "ROS"],
  [/^spring-boot/, "Spring Boot", "HTTP API"],
  [/^pandas$/, "pandas"],
  [/^pyspark$/, "Spark"],
  [/^airflow|^apache-airflow$/, "Airflow"],
  [/^playwright$|^puppeteer$|^selenium$/, "Browser automation"],
  [/^pyautogui$|^pywinauto$|^pynput$/, "Desktop automation"],
  [/^whisper|^faster-whisper$|^openai-whisper$/, "Whisper"],
  [/^sqlite|^better-sqlite3$/, "SQLite"],
  [/^chromadb$|^qdrant|^faiss|^pgvector|^lancedb$/, "Vector store"],
];

export function detectFrameworks(deps: Dependency[]): { frameworks: string[]; apiSurface: string[] } {
  const fw = new Set<string>(),
    api = new Set<string>();
  for (const d of deps)
    for (const [re, name, surface] of FRAMEWORK_SIGNATURES)
      if (re.test(d.name.toLowerCase())) {
        fw.add(name);
        if (surface) api.add(surface);
      }
  return { frameworks: [...fw], apiSurface: [...api] };
}
