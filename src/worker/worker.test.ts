// Unit tests for Phase 5: Worker (MockWorker, AnthropicWorker helpers, orchestrator, factory).
// 100% OFFLINE — no network, no real LLM, no tokens spent.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execRoot } from "../paths.js";
import type { State, Context } from "../state/types.js";
import type { Plan, ProposedAction } from "../planner/types.js";
import type { Config } from "../config.js";
import type { Worker, WorkerInput, WorkerOutput } from "./types.js";
import type { Proposal } from "./types.js";
import { MockWorker } from "./mock.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  buildRequestBody,
  parseAnthropicResponse,
  parseCompletion,
} from "./anthropic.js";
import { createWorker } from "./factory.js";
import { runWorker, writeProposal } from "./orchestrator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = "/tmp/executive-test-worker-" + randomUUID();

function setExecutiveHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
  delete process.env.EXECUTIVE_HOME;
}

function makeState(overrides: Partial<State> = {}): State {
  const now = new Date("2026-07-17T00:00:00.000Z");
  return {
    generatedAt: now.toISOString(),
    eventCount: 0,
    lastEventTs: null,
    currentProject: null,
    currentTask: null,
    deadline: null,
    currentFile: null,
    recentFiles: [],
    git: { branch: null, lastCommit: null },
    tests: "unknown",
    blocked: false,
    blockedReason: null,
    currentWindow: null,
    activity: { active: true, idleMs: null },
    activeRepo: null,
    repos: [],
    ...overrides,
  };
}

function makeContext(state: State): Context {
  return {
    generatedAt: state.generatedAt,
    summary: "test context",
    state,
    recentEvents: [],
  };
}

function makePlan(topAction: ProposedAction | null): Plan {
  return {
    generatedAt: new Date().toISOString(),
    basedOnState: {
      generatedAt: new Date().toISOString(),
      eventCount: 0,
    },
    topAction,
    actions: topAction ? [topAction] : [],
    summary: topAction ? topAction.kind : "No action.",
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 },
      fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 },
    },
    state: { intervalMs: 30000 },
    worker: {
      backend: "mock",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 1024,
      timeoutMs: 30000,
      autoInvoke: false,
    },
    ...overrides,
    // Merge overrides at top level
  };
}

function makeAction(
  overrides: Partial<ProposedAction> = {}
): ProposedAction {
  return {
    kind: "fix_tests",
    reason: "test",
    priority: 100,
    confidence: 0.97,
    forbidden: false,
    disposition: "act",
    ...overrides,
  };
}

// ─── 1. MockWorker is deterministic ───────────────────────────────────────────

describe("MockWorker — deterministic", () => {
  it("same input twice → identical output", async () => {
    const worker = new MockWorker();
    const input: WorkerInput = {
      action: makeAction({ kind: "fix_tests" }),
      context: makeContext(makeState()),
    };
    const out1 = await worker.run(input);
    const out2 = await worker.run(input);
    expect(out1).toEqual(out2);
  });

  it("steps is non-empty for every ActionKind", async () => {
    const worker = new MockWorker();
    const ctx = makeContext(makeState());
    const kinds: Array<ProposedAction["kind"]> = [
      "fix_tests",
      "resolve_block",
      "review_deadline",
      "resume_task",
    ];
    for (const kind of kinds) {
      const out = await worker.run({ action: makeAction({ kind }), context: ctx });
      expect(out).toHaveProperty("steps");
      expect(out.steps.length).toBeGreaterThan(0);
    }
  });

  it("name is 'mock'", () => {
    expect(new MockWorker().name).toBe("mock");
  });
});

// ─── 2. Orchestrator gate — null topAction ────────────────────────────────────

describe("runWorker — null topAction", () => {
  it("returns null when topAction is null", async () => {
    const ctx = makeContext(makeState());
    const p = makePlan(null);
    const cfg = makeConfig();
    const result = await runWorker(ctx, p, cfg);
    expect(result).toBeNull();
  });
});

// ─── 3. Orchestrator gate — disposition "ask" ─────────────────────────────────

describe("runWorker — disposition ask", () => {
  it("returns null and never calls the worker", async () => {
    const ctx = makeContext(makeState());
    const action = makeAction({ disposition: "ask" });
    const p = makePlan(action);
    const cfg = makeConfig();

    let called = false;
    const spyWorker: Worker = {
      name: "spy",
      run: async (): Promise<WorkerOutput> => {
        called = true;
        return { summary: "x", steps: [], raw: "" };
      },
    };

    const result = await runWorker(ctx, p, cfg, spyWorker);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

// ─── 4. Orchestrator gate — forbidden ─────────────────────────────────────────

describe("runWorker — forbidden", () => {
  it("returns null and never calls the worker even if disposition is act", async () => {
    const ctx = makeContext(makeState());
    const action = makeAction({ forbidden: true, disposition: "act" });
    const p = makePlan(action);
    const cfg = makeConfig();

    let called = false;
    const spyWorker: Worker = {
      name: "spy",
      run: async (): Promise<WorkerOutput> => {
        called = true;
        return { summary: "x", steps: [], raw: "" };
      },
    };

    const result = await runWorker(ctx, p, cfg, spyWorker);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

// ─── 5. Happy path with injected MockWorker ───────────────────────────────────

describe("runWorker — happy path", () => {
  it("returns a Proposal with status ok when MockWorker succeeds", async () => {
    const ctx = makeContext(makeState({ tests: "failing" }));
    const action = makeAction({ kind: "fix_tests" });
    const p = makePlan(action);
    const cfg = makeConfig();

    const result = await runWorker(ctx, p, cfg, new MockWorker());

    expect(result).not.toBeNull();
    expect(result!.status).toBe("ok");
    expect(result!.steps.length).toBeGreaterThan(0);
    expect(result!.backend).toBe("mock");
    expect(result!.basedOn.topActionKind).toBe("fix_tests");
    expect(result!.basedOn.stateGeneratedAt).toBe(ctx.state.generatedAt);
    expect(result!.error).toBeNull();
    expect(result!.action.kind).toBe("fix_tests");
  });
});

// ─── 6. Error path ────────────────────────────────────────────────────────────

describe("runWorker — error path", () => {
  it("returns Proposal with status error when worker throws", async () => {
    const ctx = makeContext(makeState());
    const action = makeAction({ kind: "fix_tests" });
    const p = makePlan(action);
    const cfg = makeConfig();

    const errWorker: Worker = {
      name: "failing",
      run: async (): Promise<WorkerOutput> => {
        throw new Error("network timeout");
      },
    };

    const result = await runWorker(ctx, p, cfg, errWorker);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("error");
    expect(result!.error).toBe("network timeout");
    expect(result!.summary).toBe("error: network timeout");
    expect(result!.steps).toEqual([]);
    expect(result!.raw).toBe("");
  });
});

// ─── 7. writeProposal persists atomically ─────────────────────────────────────

describe("writeProposal — atomic persistence", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("proposalPath() and proposals/<id>.json both exist and parse back", () => {
    const proposal: Proposal = {
      id: "test-id-123",
      generatedAt: new Date().toISOString(),
      status: "ok",
      backend: "mock",
      action: makeAction({ kind: "fix_tests" }),
      summary: "test proposal",
      steps: ["step 1", "step 2"],
      raw: "step 1\nstep 2",
      error: null,
      basedOn: {
        stateGeneratedAt: new Date().toISOString(),
        topActionKind: "fix_tests",
      },
    };

    writeProposal(proposal);

    // Latest pointer exists
    expect(existsSync(execRoot() + "/proposal.json")).toBe(true);
    const latest = JSON.parse(readFileSync(execRoot() + "/proposal.json", "utf-8"));
    expect(latest.id).toBe("test-id-123");
    expect(latest.status).toBe("ok");

    // History copy exists
    const histPath = join(execRoot(), "proposals", "test-id-123.json");
    expect(existsSync(histPath)).toBe(true);
    const hist = JSON.parse(readFileSync(histPath, "utf-8"));
    expect(hist.id).toBe("test-id-123");
  });
});

// ─── 8. Pure helpers ──────────────────────────────────────────────────────────

describe("parseCompletion", () => {
  it("strips bullets and returns summary + steps", () => {
    const result = parseCompletion("- do A\n- do B\n- do C");
    expect(result.summary).toBe("do A");
    expect(result.steps).toEqual(["do A", "do B", "do C"]);
    expect(result.raw).toBe("- do A\n- do B\n- do C");
  });

  it("strips numbered bullets", () => {
    const result = parseCompletion("1. first\n2. second");
    expect(result.summary).toBe("first");
    expect(result.steps).toEqual(["first", "second"]);
  });

  it("empty/whitespace → (empty completion)", () => {
    const result = parseCompletion("   ");
    expect(result.summary).toBe("(empty completion)");
    expect(result.steps).toEqual([]);
    expect(result.raw).toBe("   ");
  });

  it("single line → summary and steps are the same", () => {
    const result = parseCompletion("just one line");
    expect(result.summary).toBe("just one line");
    expect(result.steps).toEqual(["just one line"]);
  });
});

describe("buildRequestBody", () => {
  it("produces Anthropic shape with model, max_tokens, temperature, system, messages", () => {
    const input: WorkerInput = {
      action: makeAction({ kind: "fix_tests" }),
      context: makeContext(makeState()),
    };
    const body = buildRequestBody(input, "m", 512, "test identity");
    const obj = body as Record<string, unknown>;

    expect(obj.model).toBe("m");
    expect(obj.max_tokens).toBe(512);
    expect(obj.temperature).toBe(0);
    expect(typeof obj.system).toBe("string");
    expect((obj.system as string).length).toBeGreaterThan(0);

    expect(Array.isArray(obj.messages)).toBe(true);
    const msgs = obj.messages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(typeof msgs[0]!.content).toBe("string");
  });
});

describe("parseAnthropicResponse", () => {
  it("extracts text from a valid response", () => {
    const resp = { content: [{ type: "text", text: "hi" }] };
    expect(parseAnthropicResponse(resp)).toBe("hi");
  });

  it("concatenates multiple text blocks", () => {
    const resp = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(parseAnthropicResponse(resp)).toBe("first\nsecond");
  });

  it("ignores non-text blocks", () => {
    const resp = {
      content: [
        { type: "thinking", text: "thinking..." },
        { type: "text", text: "answer" },
      ],
    };
    expect(parseAnthropicResponse(resp)).toBe("answer");
  });

  it("throws when content is missing", () => {
    expect(() => parseAnthropicResponse({})).toThrow("worker: no text in response");
  });

  it("throws when content is an empty array", () => {
    expect(() => parseAnthropicResponse({ content: [] })).toThrow(
      "worker: no text in response"
    );
  });

  it("throws when content is not an array", () => {
    expect(() => parseAnthropicResponse({ content: "not an array" })).toThrow(
      "worker: no text in response"
    );
  });
});

describe("buildSystemPrompt", () => {
  it("returns a non-empty string about being a Worker CPU", () => {
    const prompt = buildSystemPrompt("You are the Worker of ExecutiveOS.");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Worker");
    expect(prompt).toContain("do NOT execute");
  });

  it("contains the identity text before the operational contract", () => {
    const prompt = buildSystemPrompt("MY IDENTITY");
    expect(prompt).toContain("MY IDENTITY");
    expect(prompt).toContain("do NOT execute");
    const identityIdx = prompt.indexOf("MY IDENTITY");
    const contractIdx = prompt.indexOf("do NOT execute");
    expect(identityIdx).toBeLessThan(contractIdx);
  });

  it("operational contract is present even with empty identity", () => {
    const prompt = buildSystemPrompt("");
    expect(prompt).toContain("do NOT execute");
    expect(prompt).toContain("Propose concrete, actionable steps");
  });
});

describe("buildUserMessage", () => {
  it("serializes action and context deterministically", () => {
    const ctx = makeContext(makeState({ tests: "failing" }));
    const input: WorkerInput = {
      action: makeAction({ kind: "fix_tests" }),
      context: ctx,
    };
    const msg = buildUserMessage(input);
    const parsed = JSON.parse(msg);
    expect(parsed.action.kind).toBe("fix_tests");
    expect(parsed.state.tests).toBe("failing");
    expect(typeof parsed.summary).toBe("string");
  });
});

// ─── 9. createWorker selects backend ──────────────────────────────────────────

describe("createWorker — backend selection", () => {
  it("backend 'mock' returns a worker with name 'mock'", () => {
    const cfg = makeConfig({ worker: { backend: "mock" } });
    const w = createWorker(cfg);
    expect(w.name).toBe("mock");
  });

  it("backend 'anthropic' returns a worker with name 'anthropic:<model>'", () => {
    const cfg = makeConfig({
      worker: {
        backend: "anthropic",
        model: "x",
        baseUrl: "https://example.com",
        apiKeyEnv: "",
        maxTokens: 512,
        timeoutMs: 10000,
        autoInvoke: false,
      },
    });
    const w = createWorker(cfg);
    expect(w.name).toBe("anthropic:x");
  });

  it("anthropic worker uses empty apiKey when env var is unset", () => {
    const cfg = makeConfig({
      worker: {
        backend: "anthropic",
        model: "x",
        baseUrl: "https://example.com",
        apiKeyEnv: "NONEXISTENT_VAR_XYZ",
        maxTokens: 512,
        timeoutMs: 10000,
        autoInvoke: false,
      },
    });
    const w = createWorker(cfg);
    expect(w.name).toBe("anthropic:x");
  });
});
