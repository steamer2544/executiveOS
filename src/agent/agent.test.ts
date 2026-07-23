// Phase 35 — the conversational agent: protocols, the loop, path safety, the confirm gate.
// Entirely offline: the model is a scripted mock, so no test depends on the gateway.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { AgentTool, ChatBackend, ModelStep, TranscriptItem } from "./types.js";
import {
  parseJsonToolCall,
  stripToolBlock,
  renderToolsForPrompt,
  encodeNative,
  encodeJson,
  parseNativeStep,
  isToolsUnsupported,
} from "./protocol.js";
import { resolveSafePath, humanDuration, READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "./tools.js";
import { runTurn, resumeTurn } from "./loop.js";
import { readConversation, buildTranscript, readPending, AGENT_CONTRACT } from "./session.js";
import { loadConfig, defaultConfig, trustTool } from "../config.js";
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

  it("rejects a UNC path", () => {
    expect(resolveSafePath("//server/share/x", [root])).toBeNull();
  });

  it("returns null (never throws) for junk input", () => {
    expect(resolveSafePath("", [root])).toBeNull();
    expect(resolveSafePath("   ", [root])).toBeNull();
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

  it("trustTool is idempotent", () => {
    trustTool("run_command");
    trustTool("run_command");
    expect(loadConfig().agent!.trustedTools!.filter((t) => t === "run_command")).toHaveLength(1);
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
