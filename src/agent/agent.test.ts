// Phase 35 — the conversational agent: protocols, the loop, path safety, the confirm gate.
// Entirely offline: the model is a scripted mock, so no test depends on the gateway.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentTool, ChatBackend, ModelStep, TranscriptItem, ToolContext } from "./types.js";
import type { Config } from "../config.js";
import {
  parseJsonToolCall,
  stripToolBlock,
  renderToolsForPrompt,
  encodeNative,
  encodeJson,
  parseNativeStep,
  isToolsUnsupported,
  ContextTooHeavyError,
} from "./protocol.js";
import { resolveSafePath, resolveRepo, humanDuration, findTool, READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "./tools.js";
import { runTurn, resumeTurn, CONTEXT_LADDER } from "./loop.js";
import { readConversation, buildTranscript, trimTranscript, readPending, AGENT_CONTRACT, clearConversation, readSessionTrust, appendMessage } from "./session.js";
import { loadConfig, defaultConfig, trustTool, NEVER_TRUSTABLE } from "../config.js";
import { configPath } from "../paths.js";

const DIR = "/tmp/executive-test-agent-" + randomUUID();

function setupHome(agentPatch: Record<string, unknown> = {}): void {
  mkdirSync(DIR, { recursive: true });
  const cfg = defaultConfig();
  cfg.agent = { ...cfg.agent, enabled: true, ...agentPatch };
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ─── A scripted backend ───────────────────────────────────────────────────────

/** Replays a fixed list of steps; records what it was asked. */
function mockBackend(steps: ModelStep[], protocol: "native" | "json" = "native"): ChatBackend & {
  seen: Array<{ transcript: TranscriptItem[]; toolCount: number }>;
} {
  let i = 0;
  const seen: Array<{ transcript: TranscriptItem[]; toolCount: number }> = [];
  return {
    name: "mock",
    protocol,
    seen,
    async step(input) {
      seen.push({ transcript: input.transcript, toolCount: input.tools.length });
      const next = steps[Math.min(i, steps.length - 1)];
      i++;
      return next!;
    },
  };
}

function textStep(text: string): ModelStep {
  return { text, toolCalls: [] };
}
function callStep(name: string, args: Record<string, unknown> = {}): ModelStep {
  return { text: "", toolCalls: [{ id: randomUUID(), name, args }] };
}

/** A read tool with no side effects, so loop tests don't touch the real runtime. */
const fakeRead: AgentTool = {
  name: "get_state",
  description: "fake",
  kind: "read",
  inputSchema: { type: "object", properties: {} },
  async run() {
    return { ok: true, content: "branch: feat/dark-mode" };
  },
};

let writeRuns = 0;
const fakeWrite: AgentTool = {
  name: "emit_event",
  description: "fake write",
  kind: "write",
  inputSchema: { type: "object", properties: {} },
  async run() {
    writeRuns++;
    return { ok: true, content: "recorded" };
  },
};

const FAKE_TOOLS = [fakeRead, fakeWrite];

// ─── Protocol ─────────────────────────────────────────────────────────────────

describe("json protocol parsing", () => {
  it("extracts a fenced tool call", () => {
    const call = parseJsonToolCall('```json\n{"tool":"get_state","args":{}}\n```');
    expect(call).toEqual({ name: "get_state", args: {} });
  });

  it("tolerates prose around the fence (the model always chats first)", () => {
    const call = parseJsonToolCall(
      'Let me check.\n```json\n{"tool":"read_file","args":{"path":"src/a.ts"}}\n```\nOne moment.'
    );
    expect(call).toEqual({ name: "read_file", args: { path: "src/a.ts" } });
  });

  it("accepts a bare object with no fence", () => {
    expect(parseJsonToolCall('{"tool":"grep","args":{"pattern":"foo"}}')).toEqual({
      name: "grep",
      args: { pattern: "foo" },
    });
  });

  it("returns null for a plain answer, so prose is never mistaken for a call", () => {
    expect(parseJsonToolCall("คุณกำลังทำงานบน branch feat/dark-mode ครับ")).toBeNull();
  });

  it("returns null when the json has no tool name", () => {
    expect(parseJsonToolCall('```json\n{"args":{"a":1}}\n```')).toBeNull();
  });

  it("strips the fence so leftover prose reads cleanly", () => {
    expect(stripToolBlock('Checking.\n```json\n{"tool":"x"}\n```')).toBe("Checking.");
  });

  it("renders every tool and its arguments into the prompt", () => {
    const rendered = renderToolsForPrompt(READ_TOOLS);
    for (const t of READ_TOOLS) expect(rendered).toContain(t.name);
    expect(rendered).toContain("Repo-relative path"); // read_file's argument description
  });
});

describe("wire encoding", () => {
  const transcript: TranscriptItem[] = [
    { kind: "user", text: "hi" },
    { kind: "assistant", text: "", toolCalls: [{ id: "t1", name: "get_state", args: {} }] },
    { kind: "tool_results", results: [{ id: "t1", name: "get_state", ok: true, content: "branch: main" }] },
  ];

  it("native emits tool_use and tool_result blocks", () => {
    const wire = encodeNative(transcript);
    expect(wire[1]!.role).toBe("assistant");
    expect((wire[1]!.content as any[])[0].type).toBe("tool_use");
    expect((wire[2]!.content as any[])[0].type).toBe("tool_result");
    expect((wire[2]!.content as any[])[0].tool_use_id).toBe("t1");
  });

  it("native marks a failed tool result as an error", () => {
    const wire = encodeNative([
      { kind: "tool_results", results: [{ id: "t1", name: "x", ok: false, content: "boom" }] },
    ]);
    expect((wire[0]!.content as any[])[0].is_error).toBe(true);
  });

  it("json keeps everything as prose the model can read back", () => {
    const wire = encodeJson(transcript);
    expect(String(wire[1]!.content)).toContain('"tool":"get_state"');
    expect(String(wire[2]!.content)).toContain("Result of get_state");
    expect(wire[2]!.role).toBe("user");
  });
});

describe("parseNativeStep", () => {
  it("reads text and tool_use blocks", () => {
    const step = parseNativeStep({
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "a", name: "get_state", input: { x: 1 } },
      ],
      stop_reason: "tool_use",
    });
    expect(step.text).toBe("checking");
    expect(step.toolCalls[0]).toEqual({ id: "a", name: "get_state", args: { x: 1 } });
  });

  it("names token starvation instead of reporting a generic empty response", () => {
    // A budget exhaustion and a malformed answer must not look alike — that exact
    // ambiguity hid a real outage for hours (Phase 29.2 / 33.1).
    expect(() => parseNativeStep({ content: [], stop_reason: "max_tokens" })).toThrow(/max_tokens/);
    expect(() => parseNativeStep({ content: [], stop_reason: "end_turn" })).toThrow(/no text/);
  });
});

describe("isToolsUnsupported", () => {
  it("recognises a 4xx that names tools, and nothing else", () => {
    expect(isToolsUnsupported(new Error("agent HTTP 400: tools not supported"))).toBe(true);
    expect(isToolsUnsupported(new Error("agent HTTP 500: tools not supported"))).toBe(false);
    expect(isToolsUnsupported(new Error("agent HTTP 400: bad model"))).toBe(false);
  });
});

// ─── Path safety ──────────────────────────────────────────────────────────────

describe("resolveSafePath", () => {
  const root = DIR + "/repo";
  beforeEach(() => {
    mkdirSync(root + "/src", { recursive: true });
    mkdirSync(root + "/.git", { recursive: true });
    writeFileSync(root + "/src/a.ts", "export const a = 1;\n");
    writeFileSync(root + "/.git/config", "[core]\n");
    // A real file OUTSIDE the root. Without it, an escape test passes merely because
    // the target does not exist — the check never runs and the test is vacuous.
    writeFileSync(DIR + "/secret.txt", "TOKEN\n");
  });
  afterEach(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
  });

  it("resolves a legitimate repo-relative file", () => {
    expect(resolveSafePath("src/a.ts", [root])).toContain("a.ts");
  });

  it("rejects a parent escape", () => {
    expect(resolveSafePath("../../etc/passwd", [root])).toBeNull();
  });

  it("rejects an escape to a file that really is there", () => {
    expect(existsSync(DIR + "/secret.txt")).toBe(true); // the escape has a real target
    expect(resolveSafePath("../secret.txt", [root])).toBeNull();
    expect(resolveSafePath("src/../../secret.txt", [root])).toBeNull();
  });

  it("rejects an absolute path and a drive letter", () => {
    expect(resolveSafePath("/etc/passwd", [root])).toBeNull();
    expect(resolveSafePath("C:\\Windows\\win.ini", [root])).toBeNull();
  });

  it("rejects .git even though the file exists", () => {
    expect(existsSync(root + "/.git/config")).toBe(true);
    expect(resolveSafePath(".git/config", [root])).toBeNull();
  });

  it("rejects the runtime's own data directory", () => {
    expect(resolveSafePath(".executive/config.json", [root])).toBeNull();
  });

  it("rejects secret files even when they exist (agent must never read .env)", () => {
    // Plant real secret files so the rejection is not merely 'file not found'.
    writeFileSync(root + "/.env", "EXECUTIVE_DISCORD_TOKEN=super-secret\n");
    writeFileSync(root + "/.env.production", "KEY=1\n");
    mkdirSync(root + "/certs", { recursive: true });
    writeFileSync(root + "/certs/server.pem", "-----BEGIN KEY-----\n");
    expect(existsSync(root + "/.env")).toBe(true);
    expect(resolveSafePath(".env", [root])).toBeNull();
    expect(resolveSafePath(".env.production", [root])).toBeNull();
    expect(resolveSafePath("certs/server.pem", [root])).toBeNull();
  });

  it("still allows a committed .env template (not a secret)", () => {
    writeFileSync(root + "/.env.example", "KEY=changeme\n");
    expect(resolveSafePath(".env.example", [root])).toContain(".env.example");
  });

  it("rejects a UNC path", () => {
    expect(resolveSafePath("//server/share/x", [root])).toBeNull();
  });

  it("returns null (never throws) for junk input", () => {
    expect(resolveSafePath("", [root])).toBeNull();
    expect(resolveSafePath("   ", [root])).toBeNull();
  });
});

// ─── Repo resolution + discovery ──────────────────────────────────────────────
// The silent-fallback bug: asking about a repo the runtime does not know used to
// return the DEFAULT repo with ok:true, so the agent confidently answered about
// the wrong project. A named-but-unknown repo must resolve to null — UNLESS it can
// be discovered by name under a configured search root (no registration required).

describe("resolveRepo + discovery", () => {
  function ctxWith(opts: {
    repos?: Array<{ path: string; name: string }>;
    searchRoots?: string[];
  } = {}): ToolContext {
    const cfg = defaultConfig();
    cfg.agent!.repoSearchRoots = opts.searchRoots ?? [];
    if (opts.repos) cfg.watch = { ...cfg.watch, repos: opts.repos } as Config["watch"];
    return { config: cfg, roots: ["/default/root"] };
  }

  it("resolves a registered repo name to its path", () => {
    const ctx = ctxWith({ repos: [{ path: "/work/opm-be", name: "opm-be" }] });
    expect(resolveRepo("opm-be", ctx)).toBe("/work/opm-be");
  });

  it("returns null for an unknown name with no search roots (no silent fallback)", () => {
    const ctx = ctxWith({ repos: [{ path: "/work/executive", name: "executive" }] });
    expect(resolveRepo("opm-be", ctx)).toBeNull();
  });

  it("falls back to the default root ONLY when no name is given", () => {
    expect(resolveRepo(undefined, ctxWith())).toBe("/default/root");
    expect(resolveRepo("", ctxWith())).toBe("/default/root");
  });

  describe("filesystem discovery", () => {
    const base = DIR + "/disc";
    const searchRoot = base + "/repos";
    beforeEach(() => {
      // A real repo (has .git), an intermediate folder holding a nested repo, and a
      // plain non-repo folder that must NOT be discovered.
      mkdirSync(searchRoot + "/opm-be/.git", { recursive: true });
      mkdirSync(searchRoot + "/group/nested/.git", { recursive: true });
      mkdirSync(searchRoot + "/plain", { recursive: true });
    });
    afterEach(() => {
      try { rmSync(base, { recursive: true, force: true }); } catch {}
    });

    it("discovers a repo by name under a search root, no registration needed", () => {
      const ctx = ctxWith({ searchRoots: [searchRoot] });
      expect(resolveRepo("opm-be", ctx)).toBe(resolve(searchRoot + "/opm-be"));
    });

    it("discovers a repo nested one level deeper", () => {
      const ctx = ctxWith({ searchRoots: [searchRoot] });
      expect(resolveRepo("nested", ctx)).toBe(resolve(searchRoot + "/group/nested"));
    });

    it("does NOT resolve a folder that is not a git repo", () => {
      const ctx = ctxWith({ searchRoots: [searchRoot] });
      expect(resolveRepo("plain", ctx)).toBeNull();
    });

    it("never resolves an unsafe name to a path (guarded two ways: isSafeName + basename-only lookup)", () => {
      const ctx = ctxWith({ searchRoots: [searchRoot] });
      // A path-shaped or escaping name can never come back as a real directory: the
      // early isSafeName gate rejects it, and even without that gate resolveRepo only
      // returns discovered BASENAMES or registered paths — it never builds a path from
      // the supplied name. Both layers are asserted below.
      expect(resolveRepo("../opm-be", ctx)).toBeNull();
      expect(resolveRepo("a/b", ctx)).toBeNull();
      expect(resolveRepo(".git", ctx)).toBeNull();
      expect(resolveRepo("C:\\Windows", ctx)).toBeNull();
    });

    it("prefers a registered repo over a discovered one of the same name", () => {
      const ctx = ctxWith({
        repos: [{ path: "/registered/opm-be", name: "opm-be" }],
        searchRoots: [searchRoot],
      });
      expect(resolveRepo("opm-be", ctx)).toBe("/registered/opm-be");
    });
  });
});

// ─── Formatting ───────────────────────────────────────────────────────────────

describe("humanDuration", () => {
  it("spells the unit out — the model misreads bare milliseconds", () => {
    // Measured live: the model called sessionMs 2173707 "about 36 hours". It is 36 minutes.
    expect(humanDuration(2173707)).toBe("36 minutes");
    expect(humanDuration(2173707)).not.toContain("2173707");
  });

  it("scales through seconds, minutes, hours and days", () => {
    expect(humanDuration(5000)).toBe("5 seconds");
    expect(humanDuration(90 * 60 * 1000)).toBe("1.5 hours");
    expect(humanDuration(72 * 3600 * 1000)).toBe("3 days");
  });

  it("says unknown rather than inventing a zero", () => {
    expect(humanDuration(null)).toBe("unknown");
    expect(humanDuration(undefined)).toBe("unknown");
  });
});

// ─── Registry ─────────────────────────────────────────────────────────────────

describe("tool registry", () => {
  it("read tools are all read, write tools are all write", () => {
    expect(READ_TOOLS.every((t) => t.kind === "read")).toBe(true);
    expect(WRITE_TOOLS.every((t) => t.kind === "write")).toBe(true);
  });

  it("every tool name is unique (the model addresses them by name)", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool describes itself and declares an object schema", () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

// ─── The loop ─────────────────────────────────────────────────────────────────

describe("runTurn", () => {
  beforeEach(() => {
    process.env.EXECUTIVE_HOME = DIR;
    writeRuns = 0;
    setupHome();
  });
  afterEach(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  // Both protocols run the same body: the loop is protocol-neutral by construction,
  // so this is a claim about the design, not a duplicated test.
  for (const protocol of ["native", "json"] as const) {
    it(`calls a tool then answers (${protocol})`, async () => {
      const backend = mockBackend([callStep("get_state"), textStep("อยู่บน feat/dark-mode ครับ")], protocol);
      const turn = await runTurn("ตอนนี้ทำอะไรอยู่", {
        config: loadConfig(),
        backend,
        tools: FAKE_TOOLS,
      });

      expect(turn.reply).toContain("feat/dark-mode");
      expect(turn.toolCalls).toEqual([{ name: "get_state", ok: true, args: {} }]);
      expect(turn.pending).toBeNull();

      const log = readConversation();
      expect(log.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
      expect(log[1]!.toolName).toBe("get_state");
      expect(log[0]!.via).toBe("text");
    });
  }

  // The recovery for a context the model spirals on. Live measurement: the gateway kills
  // any request at ~125 s and the model runs at 33–48 tok/s, so a bigger ceiling can never
  // come back — but the same question answered 4/4 once the history was dropped.
  describe("context ladder (spiral recovery)", () => {
    /** Spirals while the transcript still has more than `answerAt` user turns. */
    function spiralUntil(answerAt: number, reply = "ตอบได้แล้วครับ") {
      const widths: number[] = [];
      const backend: ChatBackend = {
        name: "spiral",
        protocol: "native",
        async step(input) {
          const turns = input.transcript.filter((t) => t.kind === "user").length;
          widths.push(turns);
          if (turns > answerAt) throw new ContextTooHeavyError(3072);
          return textStep(reply);
        },
      };
      return { backend, widths };
    }

    function seedHistory(turns: number): void {
      for (let i = 0; i < turns; i++) {
        appendMessage({ role: "user", text: `เก่า ${i}` });
        appendMessage({ role: "assistant", text: `ตอบ ${i}` });
      }
    }

    it("shrinks the context and answers, instead of failing the turn", async () => {
      seedHistory(10);
      const { backend, widths } = spiralUntil(3);
      const turn = await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS });

      expect(turn.reply).toContain("ตอบได้แล้วครับ");
      // It tried the full window first, then a smaller one — never a bigger one.
      expect(widths.length).toBeGreaterThan(1);
      expect(widths[widths.length - 1]).toBeLessThan(widths[0]!);
    });

    it("falls all the way back to a single turn when nothing else works", async () => {
      seedHistory(10);
      const { backend, widths } = spiralUntil(1);
      const turn = await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS });

      expect(turn.reply).toContain("ตอบได้แล้วครับ");
      expect(widths[widths.length - 1]).toBe(1);
    });

    it("tells the owner it dropped history rather than silently forgetting", async () => {
      seedHistory(10);
      const { backend } = spiralUntil(3);
      const turn = await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS });

      expect(turn.degradedTurns).toBe(3);
      expect(turn.reply).toContain("ประวัติแชท");
      // …and the note is persisted, so the dashboard and Discord both show it.
      expect(readConversation().at(-1)!.text).toContain("ประวัติแชท");
    });

    it("says nothing about history when the full window worked", async () => {
      seedHistory(3);
      const backend = mockBackend([textStep("ปกติครับ")]);
      const turn = await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS });

      expect(turn.degradedTurns).toBeNull();
      expect(turn.reply).toBe("ปกติครับ");
    });

    it("gives up when even one turn spirals — and does not retry forever", async () => {
      seedHistory(10);
      const { backend, widths } = spiralUntil(0);
      await expect(
        runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS })
      ).rejects.toBeInstanceOf(ContextTooHeavyError);
      expect(widths.length).toBeLessThanOrEqual(CONTEXT_LADDER.length);
    });

    it("still reaches the smallest rung when the history is already short", async () => {
      // Regression: a 2-turn conversation makes the middle rung identical to the full
      // window. Stopping there (instead of skipping it) meant the single-turn rescue never
      // ran, and a short chat that spiralled failed outright — seen live.
      seedHistory(1);
      const { backend, widths } = spiralUntil(1);
      const turn = await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS });

      expect(turn.reply).toContain("ตอบได้แล้วครับ");
      expect(widths[widths.length - 1]).toBe(1);
      // The redundant rung is skipped, not re-sent: no two attempts of the same width.
      expect(new Set(widths).size).toBe(widths.length);
    });

    it("does not shrink for an ordinary error — only for a spent budget", async () => {
      seedHistory(10);
      let calls = 0;
      const backend: ChatBackend = {
        name: "boom",
        protocol: "native",
        async step() {
          calls++;
          throw new Error("agent HTTP 401: unauthorized");
        },
      };
      await expect(
        runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS })
      ).rejects.toThrow(/401/);
      expect(calls).toBe(1);
    });
  });

  it("feeds the tool result back before the next model call", async () => {
    const backend = mockBackend([callStep("get_state"), textStep("done")]);
    await runTurn("hi", { config: loadConfig(), backend, tools: FAKE_TOOLS });

    // Second call must see the tool exchange, or the model is answering blind.
    const second = backend.seen[1]!.transcript;
    expect(second.some((t) => t.kind === "tool_results")).toBe(true);
  });

  it("records a voice message as voice", async () => {
    const backend = mockBackend([textStep("ครับ")]);
    await runTurn("สวัสดี", { config: loadConfig(), backend, tools: FAKE_TOOLS, via: "voice" });
    expect(readConversation()[0]!.via).toBe("voice");
  });

  it("survives an unknown tool name instead of dying", async () => {
    const backend = mockBackend([callStep("no_such_tool"), textStep("ขอโทษครับ")]);
    const turn = await runTurn("hi", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    expect(turn.toolCalls[0]).toEqual({ name: "no_such_tool", ok: false, args: {} });
    expect(turn.reply).toBe("ขอโทษครับ");
  });

  it("reports a throwing tool as a failed result rather than crashing the turn", async () => {
    const boom: AgentTool = {
      name: "get_state",
      description: "x",
      kind: "read",
      inputSchema: { type: "object", properties: {} },
      async run() {
        throw new Error("disk on fire");
      },
    };
    const backend = mockBackend([callStep("get_state"), textStep("มีปัญหาครับ")]);
    const turn = await runTurn("hi", { config: loadConfig(), backend, tools: [boom] });
    expect(turn.toolCalls[0]!.ok).toBe(false);
    expect(readConversation()[1]!.text).toContain("disk on fire");
  });

  it("stops at maxToolRounds and still answers", async () => {
    setupHome({ maxToolRounds: 3 });
    // A model that never stops asking for tools — the loop must, or it spins forever.
    const backend = mockBackend([callStep("get_state")]);
    const turn = await runTurn("hi", { config: loadConfig(), backend, tools: FAKE_TOOLS });

    expect(turn.cappedOut).toBe(true);
    expect(turn.toolCalls).toHaveLength(3);
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(readConversation().filter((m) => m.role === "tool")).toHaveLength(3);
  });

  it("offers no tools on the forced final call, so the answer cannot be another tool call", async () => {
    setupHome({ maxToolRounds: 2 });
    const backend = mockBackend([callStep("get_state")]);
    await runTurn("hi", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    expect(backend.seen[backend.seen.length - 1]!.toolCount).toBe(0);
  });
});

// ─── The confirmation gate ────────────────────────────────────────────────────

describe("write confirmation", () => {
  beforeEach(() => {
    process.env.EXECUTIVE_HOME = DIR;
    writeRuns = 0;
    setupHome();
  });
  afterEach(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  it("does NOT run an untrusted write tool — it parks and asks", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("บอกว่าผมติดอยู่", {
      config: loadConfig(),
      backend,
      tools: FAKE_TOOLS,
    });

    expect(writeRuns).toBe(0);
    expect(turn.pending).not.toBeNull();
    expect(turn.pending!.toolName).toBe("emit_event");
    expect(turn.pending!.preview.length).toBeGreaterThan(0);
    expect(readPending()!.id).toBe(turn.pending!.id);
  });

  it("runs it after the owner taps yes, then continues the conversation", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("บอกว่าผมติดอยู่", { config: loadConfig(), backend, tools: FAKE_TOOLS });

    const after = mockBackend([textStep("บันทึกแล้วครับ")]);
    const resumed = await resumeTurn(turn.pending!.id, "run", {
      config: loadConfig(),
      backend: after,
      tools: FAKE_TOOLS,
    });

    expect(writeRuns).toBe(1);
    expect(resumed.reply).toBe("บันทึกแล้วครับ");
    expect(readPending()).toBeNull();
  });

  it("'trust' persists the tool so the owner is never asked again", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("x", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    await resumeTurn(turn.pending!.id, "trust", {
      config: loadConfig(),
      backend: mockBackend([textStep("ok")]),
      tools: FAKE_TOOLS,
    });

    expect(loadConfig().agent!.trustedTools).toContain("emit_event");

    // Second time: no parking, it just runs.
    const again = mockBackend([callStep("emit_event", { type: "system.blocked" }), textStep("ok")]);
    const turn2 = await runTurn("อีกที", { config: loadConfig(), backend: again, tools: FAKE_TOOLS });
    expect(turn2.pending).toBeNull();
    expect(writeRuns).toBe(2);
  });

  it("'trust_session' trusts the tool for THIS conversation only, never in config", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("x", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    await resumeTurn(turn.pending!.id, "trust_session", {
      config: loadConfig(),
      backend: mockBackend([textStep("ok")]),
      tools: FAKE_TOOLS,
    });

    // Session store holds it; config does NOT (this is the whole point — bounded, not persistent).
    expect(readSessionTrust()).toContain("emit_event");
    expect(loadConfig().agent?.trustedTools ?? []).not.toContain("emit_event");

    // Second time in the same conversation: no parking, it just runs.
    const again = mockBackend([callStep("emit_event", { type: "system.blocked" }), textStep("ok")]);
    const turn2 = await runTurn("อีกที", { config: loadConfig(), backend: again, tools: FAKE_TOOLS });
    expect(turn2.pending).toBeNull();
    expect(writeRuns).toBe(2);
  });

  it("clearing the chat resets session trust — the owner is asked again", async () => {
    const turn = await runTurn("x", {
      config: loadConfig(),
      backend: mockBackend([callStep("emit_event", { type: "system.blocked" })]),
      tools: FAKE_TOOLS,
    });
    await resumeTurn(turn.pending!.id, "trust_session", {
      config: loadConfig(),
      backend: mockBackend([textStep("ok")]),
      tools: FAKE_TOOLS,
    });
    expect(readSessionTrust()).toContain("emit_event");

    clearConversation();
    expect(readSessionTrust()).toEqual([]);

    // Now it parks again instead of auto-running.
    const turn2 = await runTurn("x", {
      config: loadConfig(),
      backend: mockBackend([callStep("emit_event", { type: "system.blocked" })]),
      tools: FAKE_TOOLS,
    });
    expect(turn2.pending).not.toBeNull();
  });

  it("'no' declines without running, and tells the model so it stops retrying", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("x", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    const resumed = await resumeTurn(turn.pending!.id, "no", {
      config: loadConfig(),
      backend: mockBackend([textStep("โอเคครับ ไม่ทำ")]),
      tools: FAKE_TOOLS,
    });

    expect(writeRuns).toBe(0);
    expect(resumed.reply).toContain("ไม่ทำ");
    expect(readConversation().some((m) => m.role === "tool" && m.toolOk === false)).toBe(true);
  });

  it("a stale or unknown pending id is refused, not replayed", async () => {
    const turn = await resumeTurn("nope-" + randomUUID(), "run", {
      config: loadConfig(),
      backend: mockBackend([textStep("x")]),
      tools: FAKE_TOOLS,
    });
    expect(writeRuns).toBe(0);
    expect(turn.reply).toContain("หมดอายุ");
  });

  it("trustTool is idempotent (for a trustable tool)", () => {
    trustTool("emit_event");
    trustTool("emit_event");
    expect(loadConfig().agent!.trustedTools!.filter((t) => t === "emit_event")).toHaveLength(1);
  });
});

// ─── Phase 38 — sandbox run_command + hard trust rule ───────────────────────────

/** A fake run_command that just counts, so the loop tests never spawn a shell. */
let runCmdRuns = 0;
const fakeRunCommand: AgentTool = {
  name: "run_command",
  description: "fake run",
  kind: "write",
  inputSchema: { type: "object", properties: {} },
  async run() {
    runCmdRuns++;
    return { ok: true, content: "ran" };
  },
};

describe("run_command sandbox", () => {
  beforeEach(() => {
    process.env.EXECUTIVE_HOME = DIR;
    runCmdRuns = 0;
    writeRuns = 0;
    setupHome();
  });
  afterEach(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  it("run_command / edit_files are in NEVER_TRUSTABLE; emit_event is not", () => {
    expect(NEVER_TRUSTABLE.has("run_command")).toBe(true);
    expect(NEVER_TRUSTABLE.has("edit_files")).toBe(true);
    expect(NEVER_TRUSTABLE.has("emit_event")).toBe(false);
  });

  it("trustTool refuses run_command / edit_files — no-op, config not changed", () => {
    trustTool("run_command");
    trustTool("edit_files");
    expect(loadConfig().agent!.trustedTools).toEqual([]);
  });

  it("the loop still parks a run_command even when config lists it as trusted (isTrusted ignores it)", async () => {
    setupHome({ trustedTools: ["run_command"] });
    const backend = mockBackend([callStep("run_command", { cmd: "bun test" })]);
    const turn = await runTurn("รันเทสต์", {
      config: loadConfig(),
      backend,
      tools: [fakeRead, fakeRunCommand],
    });
    expect(turn.pending).not.toBeNull();       // parked, not auto-run
    expect(turn.pending!.trustable).toBe(false); // no "trust forever" button
    expect(runCmdRuns).toBe(0);
  });

  it("a parked emit_event is trustable (contrast)", async () => {
    const backend = mockBackend([callStep("emit_event", { type: "system.blocked" })]);
    const turn = await runTurn("x", { config: loadConfig(), backend, tools: FAKE_TOOLS });
    expect(turn.pending!.trustable).not.toBe(false);
  });

  it("the confirm preview flags a destructive command and badges a safe one", async () => {
    const bad = await runTurn("ลบทิ้ง", {
      config: loadConfig(),
      backend: mockBackend([callStep("run_command", { cmd: "rm -rf /" })]),
      tools: [fakeRead, fakeRunCommand],
    });
    expect(bad.pending!.preview).toContain("⛔");

    const good = await runTurn("รันเทสต์", {
      config: loadConfig(),
      backend: mockBackend([callStep("run_command", { cmd: "bun test" })]),
      tools: [fakeRead, fakeRunCommand],
    });
    expect(good.pending!.preview).toContain("known-safe");
  });

  it("the REAL run_command refuses a destructive command and never spawns it", async () => {
    const runCmd = findTool("run_command")!;
    const ctx = { config: loadConfig(), roots: [DIR] };
    // If the deny gate were removed, `sh` would run and echo the marker into the output.
    const r = await runCmd.run(
      { cmd: "echo SPAWNED_MARKER && rm -rf junk" },
      ctx
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("ถูกปฏิเสธ");        // the refusal reason
    expect(r.content).not.toContain("SPAWNED_MARKER"); // proves nothing was executed
  });

  it("the REAL run_command lets a non-destructive command through the deny gate", async () => {
    const runCmd = findTool("run_command")!;
    const ctx = { config: loadConfig(), roots: [DIR] };
    // Whether `sh` is present or not, a safe command must not hit the refusal branch.
    const r = await runCmd.run({ cmd: "echo hello" }, ctx);
    expect(r.content).not.toContain("ถูกปฏิเสธ");
  });
});

// ─── Session ──────────────────────────────────────────────────────────────────

describe("buildTranscript", () => {
  it("trims by user turn, never mid tool-exchange", () => {
    const msgs = [
      { id: "1", ts: "", role: "user" as const, text: "one" },
      { id: "2", ts: "", role: "tool" as const, text: "r", toolName: "get_state", toolOk: true },
      { id: "3", ts: "", role: "assistant" as const, text: "a1" },
      { id: "4", ts: "", role: "user" as const, text: "two" },
      { id: "5", ts: "", role: "assistant" as const, text: "a2" },
    ];
    const t = buildTranscript(msgs, 1);
    expect(t[0]).toEqual({ kind: "user", text: "two" });
    expect(t).toHaveLength(2);
  });

  it("expands a tool message into a call plus its result, so the pair always matches", () => {
    const t = buildTranscript(
      [
        { id: "u", ts: "", role: "user", text: "hi" },
        { id: "t1", ts: "", role: "tool", text: "out", toolName: "grep", toolArgs: { pattern: "x" }, toolOk: true },
      ],
      10
    );
    expect(t[1]).toMatchObject({ kind: "assistant", toolCalls: [{ id: "t1", name: "grep" }] });
    expect(t[2]).toMatchObject({ kind: "tool_results", results: [{ id: "t1", ok: true }] });
  });

  it("carries a failed tool through as failed", () => {
    const t = buildTranscript(
      [{ id: "t1", ts: "", role: "tool", text: "bad", toolName: "grep", toolOk: false }],
      10
    );
    expect((t[1] as any).results[0].ok).toBe(false);
  });
});

// The recovery lever for a model that spends its whole budget thinking. Measured on the
// transcript that triggered it: full history answered 0/7, the last few turns 3/3, a
// single turn 4/4 — so shrinking context is the only thing that moves, and it must never
// hand the model a tool_result whose tool_use was cut away.
describe("trimTranscript", () => {
  const conv = [
    { id: "u1", ts: "", role: "user" as const, text: "one" },
    { id: "t1", ts: "", role: "tool" as const, text: "r1", toolName: "get_state", toolOk: true },
    { id: "a1", ts: "", role: "assistant" as const, text: "a1" },
    { id: "u2", ts: "", role: "user" as const, text: "two" },
    { id: "t2", ts: "", role: "tool" as const, text: "r2", toolName: "grep", toolOk: true },
    { id: "a2", ts: "", role: "assistant" as const, text: "a2" },
    { id: "u3", ts: "", role: "user" as const, text: "three" },
  ];

  it("keeps only the last N user turns and everything after them", () => {
    const t = trimTranscript(buildTranscript(conv, 20), 1);
    expect(t).toEqual([{ kind: "user", text: "three" }]);
  });

  it("keeps the tool exchanges that belong to the kept turns", () => {
    const t = trimTranscript(buildTranscript(conv, 20), 2);
    expect(t[0]).toEqual({ kind: "user", text: "two" });
    expect(t.some((i) => i.kind === "tool_results")).toBe(true);
  });

  it("never leaves a tool_result without its tool_use — at every cut depth", () => {
    // A deeper fixture than `conv`: every turn carries a tool exchange, so a cut made by
    // raw item count (rather than at a user boundary) really does land between a tool_use
    // and its tool_result. With the shallow fixture this test passed against a broken
    // implementation, which is the whole failure mode GOTCHA §4 exists to catch.
    const deep = [1, 2, 3, 4, 5].flatMap((i) => [
      { id: `u${i}`, ts: "", role: "user" as const, text: `ถาม ${i}` },
      { id: `t${i}`, ts: "", role: "tool" as const, text: `ผล ${i}`, toolName: "grep", toolOk: true },
      { id: `a${i}`, ts: "", role: "assistant" as const, text: `ตอบ ${i}` },
    ]);
    const full = buildTranscript(deep, 20);

    for (let n = 1; n <= 4; n++) {
      const t = trimTranscript(full, n);
      // The invariant that makes orphaning impossible: a trim always starts at a user turn.
      expect(t[0]!.kind).toBe("user");
      t.forEach((item, i) => {
        if (item.kind !== "tool_results") return;
        const prev = t[i - 1];
        expect(prev?.kind).toBe("assistant");
        const ids = (prev as { toolCalls: Array<{ id: string }> }).toolCalls.map((c) => c.id);
        for (const r of item.results) expect(ids).toContain(r.id);
      });
    }
  });

  it("returns the transcript untouched when it is already short enough", () => {
    const full = buildTranscript(conv, 20);
    expect(trimTranscript(full, 99)).toBe(full);
  });

  it("shrinks monotonically — a smaller rung is never larger", () => {
    const full = buildTranscript(conv, 20);
    expect(trimTranscript(full, 1).length).toBeLessThanOrEqual(trimTranscript(full, 2).length);
  });

  it("the ladder only ever shrinks, and ends at a single turn", () => {
    // If this ever grows a rung that raises the ceiling again, the measurement that killed
    // that idea (a bigger response cannot come back before the gateway wall) is being undone.
    const rungs = CONTEXT_LADDER.filter((r): r is number => r !== null);
    expect(rungs).toEqual([...rungs].sort((a, b) => b - a));
    expect(rungs[rungs.length - 1]).toBe(1);
  });
});

describe("agent contract", () => {
  it("forbids answering about the owner's work from memory", () => {
    // The rule that keeps a chatbot from confidently inventing the owner's state.
    expect(AGENT_CONTRACT).toContain("NEVER state a fact");
  });
});

describe("config", () => {
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  it("an old config with no agent block still loads, with the agent off", () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" }));
    const c = loadConfig();
    expect(c.agent!.enabled).toBe(false);
    expect(c.agent!.trustedTools).toEqual([]);
    expect(c.agent!.maxToolRounds).toBe(8);
  });
});
