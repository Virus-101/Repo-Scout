// Bundles the workspace into the publishable `repo-scout` package (packages/cli/dist) with esbuild.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli");
fs.rmSync(path.join(cli, "dist"), { recursive: true, force: true });
await build({
  entryPoints: {
    cli: path.join(cli, "src/cli.ts"),
    mcp: path.join(cli, "src/mcp.ts"),
    index: path.join(cli, "src/index.ts"),
  },
  outdir: path.join(cli, "dist"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  splitting: true,
  sourcemap: false,
  minify: false,
  tsconfig: path.join(root, "tsconfig.json"),
  external: [
    "commander",
    "zod",
    "zod/*",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "node:*",
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
// Shebang: esbuild keeps the first-line shebang of entry files only when banner is absent; re-add explicitly.
for (const f of ["cli.js", "mcp.js"]) {
  const p = path.join(cli, "dist", f);
  let s = fs.readFileSync(p, "utf8").replace(/^#!.*\n/, "");
  fs.writeFileSync(p, "#!/usr/bin/env node\n" + s);
  fs.chmodSync(p, 0o755);
}
// Ship docs, skill, integrations and licence inside the package.
const cp = (src, dst) => {
  fs.rmSync(dst, { recursive: true, force: true });
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
};
cp(path.join(root, "skills"), path.join(cli, "skills"));
cp(path.join(root, "integrations"), path.join(cli, "integrations"));
for (const f of ["LICENSE", "README.md"])
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(cli, f));
console.log("built packages/cli/dist");
