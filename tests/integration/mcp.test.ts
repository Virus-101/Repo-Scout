import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, TOOLS } from "@repo-scout/mcp";
import { ghRepo, testEngine, type Route } from "../helpers.js";

const REQUIRED = [
  "scout_understand_task",
  "scout_search",
  "scout_find_repositories",
  "scout_find_packages",
  "scout_find_alternatives",
  "scout_analyze_repository",
  "scout_compare_repositories",
  "scout_inspect_dependencies",
  "scout_check_license",
  "scout_check_security",
  "scout_compose_solution",
  "scout_generate_implementation_plan",
  "scout_find_trending",
  "scout_find_hidden_gems",
  "scout_find_related_projects",
  "scout_get_repository_details",
  "scout_cache_status",
  "scout_clear_cache",
];
const routes: Route[] = [
  {
    match: "api.github.com/search/repositories",
    json: { items: [ghRepo("acme/mcp-kit"), ghRepo("foo/agent-lib", { language: "Python" })] },
  },
  { match: "registry.npmjs.org/-/v1/search", json: { objects: [] } },
  { match: "pypi.org", status: 404, body: "" },
  { match: "crates.io", json: { crates: [] } },
  { match: "search.maven.org", json: { response: { docs: [] } } },
  { match: "arxiv.org", body: "<feed/>" },
  { match: "paperswithcode", status: 302, body: "" },
  { match: "gitlab.com", json: [] },
  { match: "codeberg.org", json: { data: [] } },
  { match: "raw.githubusercontent.com", status: 404, body: "" },
  { match: "api.github.com/repos/acme/mcp-kit", json: ghRepo("acme/mcp-kit") },
  { match: "api.github.com/repos", status: 403, body: "{}" },
  { match: "osv.dev", status: 500, body: "" },
];
async function connect() {
  const { engine, fetchImpl } = testEngine(routes);
  const server = createMcpServer(engine);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, engine, fetchImpl };
}

describe("MCP server (official SDK, in-memory transport)", () => {
  it("exposes every required tool with schemas and annotations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of REQUIRED) expect(names, n).toContain(n);
    expect(names).toContain("scout_list_providers");
    expect(tools.length).toBe(TOOLS.length);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations).toBeDefined();
    }
    expect(tools.find((t) => t.name === "scout_clear_cache")!.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(tools.find((t) => t.name === "scout_search")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(client.getInstructions()).toMatch(/UNTRUSTED/);
  });
  it("returns a consistent envelope with structured data and readable text", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({
      name: "scout_understand_task",
      arguments: { task: "A real-time object detection service in Python" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, tool: "scout_understand_task", warnings: [] });
    expect(r.structuredContent.meta.untrustedContentNotice).toMatch(/UNTRUSTED/);
    expect(r.structuredContent.data.domain).toBeDefined();
    expect(r.content[0].text).toMatch(/Domain/);
  });
  it("scout_search returns recommendation records with all required fields", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({
      name: "scout_search",
      arguments: { query: "mcp server", providers: ["github"], limit: 5 },
    });
    const rec = r.structuredContent.data.results[0];
    for (const k of [
      "name",
      "canonicalUrl",
      "resourceType",
      "description",
      "primaryLanguage",
      "license",
      "stars",
      "lastActivity",
      "release",
      "scores",
      "securityIndicators",
      "confidence",
      "evidence",
      "reasons",
      "limitations",
      "alternatives",
    ])
      expect(rec, k).toHaveProperty(k);
    for (const k of ["relevance", "maintenance", "compatibility"]) expect(rec.scores).toHaveProperty(k);
    expect(r.structuredContent.data.counts).toHaveProperty("candidatesDiscovered");
    expect(r.structuredContent.data.page).toMatchObject({ offset: 0 });
  });
  it("paginates", async () => {
    const { client } = await connect();
    const p1: any = await client.callTool({
      name: "scout_search",
      arguments: { query: "mcp server", providers: ["github"], limit: 1 },
    });
    const p2: any = await client.callTool({
      name: "scout_search",
      arguments: { query: "mcp server", providers: ["github"], limit: 1, offset: 1 },
    });
    expect(p1.structuredContent.data.results[0].name).not.toBe(p2.structuredContent.data.results[0].name);
    expect(p1.structuredContent.data.page.hasMore).toBe(true);
  });
  it("validates input with Zod and reports structured errors", async () => {
    const { client } = await connect();
    const bad: any = await client.callTool({
      name: "scout_analyze_repository",
      arguments: { repository: "not a repo!!" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe("INVALID_INPUT");
    const missing: any = await client
      .callTool({ name: "scout_search", arguments: {} })
      .catch((e) => ({ isError: true, thrown: String(e) }));
    expect(missing.isError).toBe(true);
    const nf: any = await client.callTool({
      name: "scout_get_repository_details",
      arguments: { repository: "no/such" },
    });
    expect(nf.isError).toBe(true);
    expect(["NOT_FOUND", "PROVIDER_ERROR"]).toContain(nf.structuredContent.error.code);
  });
  it("destructive tool requires confirm=true (approval boundary)", async () => {
    const { client, engine } = await connect();
    engine.store.setCache("search", "k", 1, 100);
    const no: any = await client.callTool({
      name: "scout_clear_cache",
      arguments: { scope: "search", confirm: false },
    });
    expect(no.isError).toBe(true);
    expect(engine.store.status().searchEntries).toBe(1);
    const yes: any = await client.callTool({
      name: "scout_clear_cache",
      arguments: { scope: "search", confirm: true },
    });
    expect(yes.isError).toBeFalsy();
    expect(engine.store.status().searchEntries).toBe(0);
  });
  it("cache status, providers, details, dependency text and implementation plan work through MCP", async () => {
    const { client } = await connect();
    const st: any = await client.callTool({ name: "scout_cache_status", arguments: {} });
    expect(st.structuredContent.data.schemaVersion).toBeGreaterThan(0);
    const pr: any = await client.callTool({ name: "scout_list_providers", arguments: {} });
    expect(pr.structuredContent.data.providers.length).toBe(11);
    const det: any = await client.callTool({
      name: "scout_get_repository_details",
      arguments: { repository: "acme/mcp-kit" },
    });
    expect(det.structuredContent.data.resource.fullName).toBe("acme/mcp-kit");
    const dep: any = await client.callTool({
      name: "scout_inspect_dependencies",
      arguments: {
        manifestPath: "package.json",
        manifestContent: JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      },
    });
    expect(dep.structuredContent.data.dependencies[0].name).toBe("express");
    expect(dep.structuredContent.data.vulnerabilityCheck).toBeDefined();
    const plan: any = await client.callTool({
      name: "scout_generate_implementation_plan",
      arguments: { task: "an mcp server for searching documents with an llm" },
    });
    expect(plan.isError).toBeFalsy();
    expect(plan.structuredContent.data.plan.approvalGates).toHaveLength(5);
    expect(plan.structuredContent.data.untrustedContentNotice).toMatch(/UNTRUSTED/);
  });
  it("never leaks credentials in outputs", async () => {
    const { engine } = testEngine(routes, { credentials: { githubToken: "ghp_" + "z".repeat(36) } });
    const server = createMcpServer(engine);
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r: any = await client.callTool({ name: "scout_cache_status", arguments: {} });
    const p: any = await client.callTool({ name: "scout_list_providers", arguments: {} });
    expect(JSON.stringify([r, p])).not.toContain("ghp_");
  });
});
