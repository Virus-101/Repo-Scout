import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const p = (n: string) => fileURLToPath(new URL(`./packages/${n}/src/index.ts`, import.meta.url));
const names = [
  "schemas",
  "core",
  "cache",
  "providers",
  "intelligence",
  "scoring",
  "analysis",
  "composer",
  "trending",
  "discovery",
  "report",
  "mcp",
];
export default defineConfig({
  resolve: { alias: Object.fromEntries(names.map((n) => [`@repo-scout/${n}`, p(n)])) },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: process.env.REPO_SCOUT_LIVE ? [] : ["tests/integration/live/**"],
    testTimeout: 30000,
    pool: "forks",
  },
});
