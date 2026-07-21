// Offline tests for LLM signal inference (Phase 19). MockInferer + parsing only.

import { describe, it, expect } from "bun:test";
import { MockInferer } from "./mock.js";
import { parseGuesses, extractText } from "./anthropic.js";
import { runInference } from "./infer.js";
import type { Context } from "../state/types.js";
import type { Config } from "../config.js";

function ctx(summary: string, events: Array<{ type: string; data: Record<string, unknown> }>): Context {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary,
    state: {
      generatedAt: "2026-01-01T00:00:00.000Z", eventCount: events.length, lastEventTs: null,
      currentProject: null, currentTask: null, deadline: null, currentFile: null, recentFiles: [],
      git: { branch: null, lastCommit: null }, tests: "unknown", blocked: false, blockedReason: null,
      activity: { active: true, idleMs: 0 }, currentWindow: null, activeRepo: null, repos: [],
    },
    recentEvents: events.map((e, i) => ({ seq: i + 1, ts: "2026-01-01T00:00:00.000Z", source: "system", type: e.type, data: e.data })),
  };
}

const MOCK_CONFIG = { worker: { backend: "mock" } } as Config;

describe("MockInferer", () => {
  it("guesses a block from blocking keywords", async () => {
    const g = await new MockInferer().infer(ctx("On branch main; task: x", [
      { type: "git.commit", data: { subject: "still waiting on the vendor API key" } },
    ]));
    expect(g.block?.likely).toBe(true);
    expect(g.block?.reason).toContain("wait");
  });

  it("guesses a deadline from deadline keywords", async () => {
    const g = await new MockInferer().infer(ctx("x", [
      { type: "editor.save", data: { path: "notes.md" } },
      { type: "system.note", data: { msg: "must ship by friday" } },
    ]));
    expect(g.deadline?.likely).toBe(true);
  });

  it("guesses nothing from neutral activity", async () => {
    const g = await new MockInferer().infer(ctx("all good", [
      { type: "editor.save", data: { path: "a.ts" } },
    ]));
    expect(g.block?.likely).toBe(false);
    expect(g.deadline?.likely).toBe(false);
  });
});

describe("parseGuesses", () => {
  it("parses plain JSON", () => {
    const g = parseGuesses('{"block":{"likely":true,"reason":"waiting"},"deadline":{"likely":false,"date":null,"note":""}}');
    expect(g.block?.likely).toBe(true);
    expect(g.block?.reason).toBe("waiting");
    expect(g.deadline?.likely).toBe(false);
  });

  it("parses JSON inside ```json fences", () => {
    const g = parseGuesses('```json\n{"block":{"likely":false,"reason":""},"deadline":{"likely":true,"date":"2026-08-01","note":"ship"}}\n```');
    expect(g.deadline?.date).toBe("2026-08-01");
    expect(g.deadline?.likely).toBe(true);
  });

  it("parses JSON with surrounding prose", () => {
    const g = parseGuesses('Here is my guess: {"block":{"likely":true,"reason":"stuck"},"deadline":{"likely":false,"date":null,"note":""}} hope that helps');
    expect(g.block?.reason).toBe("stuck");
  });

  it("coerces missing/wrong-typed fields safely", () => {
    const g = parseGuesses('{"block":{"likely":"yes"}}');
    expect(typeof g.block?.likely).toBe("boolean");
    expect(g.block?.reason).toBe("");
    expect(g.deadline?.likely).toBe(false);
  });
});

describe("extractText", () => {
  it("concatenates text blocks", () => {
    expect(extractText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });
  it("throws when there is no text", () => {
    expect(() => extractText({ content: [] })).toThrow();
  });
});

describe("runInference", () => {
  it("returns a result with guesses using an injected Inferer", async () => {
    const r = await runInference(ctx("waiting on vendor", [{ type: "git.commit", data: { subject: "waiting" } }]), {
      config: MOCK_CONFIG,
      infererOverride: new MockInferer(),
    });
    expect(r.error).toBeNull();
    expect(r.backend).toBe("mock");
    expect(r.block?.likely).toBe(true);
  });

  it("captures an Inferer error instead of throwing", async () => {
    const throwing = { name: "boom", async infer() { throw new Error("network down"); } };
    const r = await runInference(ctx("x", []), { config: MOCK_CONFIG, infererOverride: throwing });
    expect(r.error).toBe("network down");
    expect(r.block).toBeNull();
  });
});
