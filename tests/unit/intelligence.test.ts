import { describe, expect, it } from "vitest";
import { alternativeQueries, understandTask } from "@repo-scout/intelligence";
import { TaskSpecSchema } from "@repo-scout/schemas";

const DESKTOP =
  "I want to build an autonomous AI desktop assistant that controls Windows, understands screenshots, executes tasks, supports MCP, and remembers previous interactions.";

describe("task understanding", () => {
  it("produces a schema-valid spec for the flagship example", () => {
    const s = understandTask(DESKTOP);
    expect(TaskSpecSchema.safeParse(s).success).toBe(true);
    expect(s.domain).toBe("ai-agents");
    expect(s.operatingSystems.map((o) => o.value)).toContain("Windows");
    const ids = s.components.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "desktop-automation",
        "screenshot-understanding",
        "mcp-support",
        "agent-memory",
        "agent-framework",
      ]),
    );
    expect(s.functional.length).toBeGreaterThanOrEqual(4);
  });
  it("distinguishes explicit requirements from assumptions", () => {
    const s = understandTask(DESKTOP);
    expect(s.languages.every((l) => l.origin === "assumed")).toBe(true);
    expect(s.assumptions.join()).toMatch(/No language specified/);
    const e = understandTask("A Rust CLI that parses logs on Linux");
    expect(e.languages[0]).toMatchObject({ value: "Rust", origin: "explicit" });
    expect(e.operatingSystems[0]).toMatchObject({ value: "Linux", origin: "explicit" });
  });
  it("marks archetype-implied components as assumed", () => {
    const s = understandTask("Build a self-hosted AI meeting assistant");
    const byId = Object.fromEntries(s.components.map((c) => [c.id, c]));
    for (const id of [
      "audio-capture",
      "speech-to-text",
      "speaker-identification",
      "summarization",
      "vector-storage",
      "search",
      "authentication",
      "frontend",
      "backend",
      "deployment",
      "llm-integration",
    ])
      expect(byId[id], id).toBeDefined();
    expect(byId["speech-to-text"]!.origin).toBe("assumed");
    expect(s.assumptions.join()).toMatch(/archetype/);
  });
  it("parses licence constraints", () => {
    expect(understandTask("needs to be MIT licensed").licenseConstraints).toMatchObject({
      allowed: ["MIT"],
      origin: "explicit",
    });
    expect(understandTask("no GPL please").licenseConstraints.forbidden).toContain("GPL-3.0");
    expect(understandTask("avoid copyleft licenses").licenseConstraints.forbidden).toContain("copyleft");
    expect(understandTask("for my company's closed-source product").licenseConstraints).toMatchObject({
      commercialUse: true,
      projectLicense: "Proprietary",
    });
    expect(understandTask("an http client").licenseConstraints.origin).toBe("assumed");
    expect(
      understandTask("an http client", { projectLicense: "Apache-2.0" }).licenseConstraints.projectLicense,
    ).toBe("Apache-2.0");
  });
  it("extracts performance, security, frameworks, infra and integrations", () => {
    const s = understandTask(
      "A low-latency, secure, encrypted API using FastAPI and PostgreSQL on Docker that integrates with Slack and OpenAI",
    );
    expect(s.performance.length).toBeGreaterThan(0);
    expect(s.security.length).toBeGreaterThan(0);
    expect(s.frameworks.map((f) => f.value)).toContain("fastapi");
    expect(s.infrastructure.map((f) => f.value)).toEqual(expect.arrayContaining(["docker", "postgresql"]));
    expect(s.integrations.map((f) => f.value)).toEqual(expect.arrayContaining(["slack", "openai"]));
    expect(s.languages.find((l) => l.value === "Python")?.origin).toBe("assumed");
  });
  it.each([
    ["authenticate users with OAuth2 and OIDC single sign-on", "authentication"],
    ["detect objects in a camera feed using YOLO and OpenCV", "computer-vision"],
    ["a real-time low latency streaming pipeline over websockets", "real-time"],
    ["a beginner tutorial course for students to learn compilers", "education"],
    ["an autonomous LLM agent framework with tool use", "ai-agents"],
    ["a full-stack website with a React frontend and REST API", "web-development"],
    ["firmware for an ESP32 microcontroller with an RTOS", "embedded"],
    ["an ETL data pipeline orchestrated with Airflow into a data warehouse", "data-engineering"],
    ["a linter and formatter command line developer tool", "developer-tooling"],
    ["ROS2 navigation and SLAM for a mobile robot", "robotics"],
    ["a vulnerability scanner and secrets scanning for CI", "security-tooling"],
    ["speech to text transcription with speaker diarization", "speech-audio"],
  ])("domain: %s -> %s", (t, d) => {
    expect(understandTask(t).domain).toBe(d);
  });
  it("generates diverse queries (exact, technology, feature, semantic, alternative, related, package)", () => {
    const s = understandTask("a self-hosted AI meeting assistant in Python");
    const kinds = new Set(s.queries.map((q) => q.kind));
    for (const k of ["exact", "technology", "feature", "semantic", "alternative", "package"])
      expect(kinds.has(k as any), k).toBe(true);
    expect(s.queries.length).toBeGreaterThan(15);
    expect(s.queries.length).toBeLessThanOrEqual(40);
    expect(s.queries.every((q) => q.text.split(/\s+/).length <= 6)).toBe(true); // GitHub search needs short queries
  });
  it("handles a vague one-liner without inventing requirements", () => {
    const s = understandTask("json diff");
    expect(s.components).toHaveLength(1);
    expect(s.components[0]!.id).toBe("primary");
    expect(s.queries.length).toBeGreaterThan(0);
    expect(s.functional).toHaveLength(1);
  });
  it("rejects nothing but stays bounded for long inputs", () => {
    const s = understandTask("build a web app. ".repeat(500));
    expect(s.objective.length).toBeLessThanOrEqual(220);
  });
  it("alternative queries", () => {
    const q = alternativeQueries("owner/express", "Fast web framework", ["http", "server"]);
    expect(q.map((x) => x.text)).toEqual(
      expect.arrayContaining(["express alternative", "alternative to express", "http server"]),
    );
  });
});
