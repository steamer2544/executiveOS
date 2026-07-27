// Tests for src/proactive/proactive.ts and src/proactive/compose.ts (Phase 36).
//
// All offline, no network, no real Channel. Uses dependency injection for the
// backend, session, and log modules.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  runProactiveTick,
  markNudgeAnswered,
  openNudgeId,
  ANSWER_WINDOW_MS,
} from "./proactive.js";
import { composeNudge } from "./compose.js";
import { readNudgeRecords } from "./log.js";
import type { ChatBackend, ModelStep } from "../agent/types.js";
import type { Channel, OutboundMessage, InboundMessage } from "../channel/types.js";
import type { Config } from "../config.js";
import type { ProactiveState } from "./types.js";

/** The proactive config sub-block, with `agent` narrowed from optional. */
type ProactiveCfg = NonNullable<NonNullable<Config["agent"]>["proactive"]>;

// ─── Temp home setup ──────────────────────────────────────────────────────────

const TEST_HOME = "/tmp/executive-test-proactive-" + randomUUID();

/** A well-formed Thai reply the fake backend returns — used wherever we assert the text round-trips. */
const REPLY = "มีงานต้องจัดการ — ให้ผมช่วยไหมครับ?";

function setupHome(): void {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.EXECUTIVE_HOME = TEST_HOME;
}

function teardownHome(): void {
  try {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  } catch { /* ignore */ }
  delete process.env.EXECUTIVE_HOME;
}

// ─── Fake channel ─────────────────────────────────────────────────────────────

class FakeChannel implements Channel {
  name = "fake";
  messages: OutboundMessage[] = [];
  _inboundHandler: ((m: InboundMessage) => Promise<void>) | null = null;

  onInbound(handler: (m: InboundMessage) => Promise<void>): void {
    this._inboundHandler = handler;
  }
  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }

  async send(msg: OutboundMessage): Promise<{ ok: boolean; error?: string }> {
    this.messages.push(msg);
    return { ok: true };
  }
}

// ─── Fake backend ─────────────────────────────────────────────────────────────

class FakeBackend implements ChatBackend {
  name = "fake";
  protocol: "native" | "json" = "native";
  shouldThrow = false;
  responseText = "You got something to handle — want me to take care of it?";

  step(): Promise<ModelStep> {
    if (this.shouldThrow) throw new Error("backend down");
    return Promise.resolve({
      text: this.responseText,
      toolCalls: [],
    });
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

function makeConfig(proactivePatch?: Partial<ProactiveCfg>): Config {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    watch: { git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 }, fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 } },
    state: { intervalMs: 30000 },
    worker: { backend: "anthropic", baseUrl: "http://localhost:9999", model: "test", apiKeyEnv: "TEST_KEY", maxTokens: 4096, timeoutMs: 120000, autoInvoke: false },
    agent: {
      enabled: true,
      toolProtocol: "auto",
      maxToolRounds: 8,
      historyTurns: 20,
      speak: false,
      trustedTools: [],
      commandTimeoutMs: 60000,
      proactive: {
        enabled: true,
        maxPerDay: 6,
        minGapMs: 1800000,
        quietFrom: "22:00",
        quietTo: "08:00",
        ...proactivePatch,
      },
    },
  } as Config;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: {
  state?: Partial<ProactiveState>;
  config?: Partial<ProactiveCfg>;
  backend?: FakeBackend;
  channel?: FakeChannel;
  now?: Date;
} = {}) {
  const channel = overrides.channel ?? new FakeChannel();
  const backend = overrides.backend ?? new FakeBackend();

  return {
    added: [
      { source: "plan" as const, summary: "Plan deadline approaching", detail: "2 days left" },
      { source: "worker" as const, summary: "Inference block guessed", detail: "block until 18:00" },
    ],
    // Default to a LIVE tick (past the first-tick guard); tests that want the guard
    // pass state: { firstTickDone: false } explicitly.
    state: { firstTickDone: true, lastSentAt: null, ...overrides.state } as ProactiveState,
    channel,
    config: makeConfig(overrides.config),
    now: overrides.now ?? new Date("2026-07-24T10:00:00Z"),
    backendFactory: overrides.backend ? () => overrides.backend! : undefined,
  };
}

// ─── composeNudge ─────────────────────────────────────────────────────────────

describe("composeNudge", () => {
  test("with a backend that throws → fallback with detail (not summary)", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = true;

    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "Test nudge",
      detail: "Extra detail",
    };

    const result = await composeNudge(nudge, makeConfig(), () => backend);

    expect(result.composedBy).toBe("fallback");
    expect(result.text).toBe("Extra detail");
    expect(result.text).not.toContain("Test nudge");
  });

  test("with a backend returning text → llm", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;
    backend.responseText = REPLY;

    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "Test nudge",
    };

    const result = await composeNudge(nudge, makeConfig(), () => backend);

    expect(result.composedBy).toBe("llm");
    expect(result.text).toBe(REPLY);
  });

  test("empty response → fallback", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;
    backend.responseText = "";

    const nudge = {
      key: "plan|test",
      source: "plan" as const,
      summary: "Empty response test",
    };

    const result = await composeNudge(nudge, makeConfig(), () => backend);

    expect(result.composedBy).toBe("fallback");
    expect(result.text).toBe("Empty response test");
  });
});

// ─── runProactiveTick ─────────────────────────────────────────────────────────

describe("runProactiveTick", () => {
  beforeEach(() => {
    setupHome();
  });
  afterEach(() => {
    teardownHome();
  });

  test("happy path: sends exactly one message, logs sent record, advances state", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;
    backend.responseText = REPLY;

    const input = makeInput({ backend });
    const result = await runProactiveTick(input);

    // Exactly one message sent
    expect(input.channel.messages).toHaveLength(1);
    expect(input.channel.messages[0]!.text).toBe(REPLY);

    // Exactly one sent record logged
    const records = readNudgeRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!).toMatchObject({
      event: "sent",
      text: REPLY,
    });

    // State advanced
    expect(input.state.lastSentAt).not.toBeNull();
    expect(input.state.firstTickDone).toBe(true);
    // The open nudge is now derivable from the log (not held in state).
    expect(openNudgeId(readNudgeRecords())).toBe(result.sent!.id);

    // Result
    expect(result.sent).not.toBeNull();
    expect(result.sent!.text).toBe(REPLY);
    expect(result.skipped).toBeNull();
  });

  test("backend throws → fallback text (detail), still sent", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = true;

    const input = makeInput({ backend });
    const result = await runProactiveTick(input);

    expect(input.channel.messages).toHaveLength(1);
    expect(input.channel.messages[0]!.text).toBe("2 days left");
    const records = readNudgeRecords();
    expect(records[0]!).toMatchObject({
      event: "sent",
      composedBy: "fallback",
    });
    expect(result.sent).not.toBeNull();
    expect(result.sent!.composedBy).toBe("fallback");
  });

  test("channel returns {ok:false} → no sent record, lastSentAt unchanged", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;
    backend.responseText = "ok";

    const channel = new FakeChannel();
    channel.send = async () => ({ ok: false, error: "network error" });

    const input = makeInput({ backend, channel });
    const beforeLastSent = input.state.lastSentAt;

    const result = await runProactiveTick(input);

    const records = readNudgeRecords();
    expect(records).toHaveLength(0);
    expect(input.state.lastSentAt).toBe(beforeLastSent);
    expect(result.sent).toBeNull();
    expect(result.skipped).toBe("channel: network error");
  });

  test("two ticks in a row send at most one message", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;

    const input = makeInput({
      backend,
      state: { firstTickDone: true },
    });

    await runProactiveTick(input);
    const firstCount = input.channel.messages.length;

    await runProactiveTick(input);
    const secondCount = input.channel.messages.length;

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1); // no second message
  });

  test("first tick with items sends nothing (skipped: first tick)", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;

    const input = makeInput({
      backend,
      state: { firstTickDone: false },
    });

    const result = await runProactiveTick(input);

    expect(result.sent).toBeNull();
    expect(result.skipped).toBe("first tick");
    expect(input.channel.messages).toHaveLength(0);
  });
});

// ─── Conversation after tick ──────────────────────────────────────────────────

describe("conversation after tick", () => {
  beforeEach(() => {
    setupHome();
  });
  afterEach(() => {
    teardownHome();
  });

  test("readConversation ends with assistant message equal to sent text", async () => {
    const backend = new FakeBackend();
    backend.shouldThrow = false;
    backend.responseText = REPLY;

    const input = makeInput({ backend });
    const result = await runProactiveTick(input);

    // The appendMessage call should have written to the conversation file
    const { readConversation } = await import("../agent/session.js");
    const messages = readConversation();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.text).toBe(result.sent!.text);
  });
});

// ─── markNudgeAnswered ────────────────────────────────────────────────────────

describe("markNudgeAnswered", () => {
  beforeEach(() => {
    setupHome();
  });
  afterEach(() => {
    teardownHome();
  });

  test("logs an answered record for the open nudge (derived from the log)", () => {
    // One sent nudge on disk, unanswered → it is the open one.
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "some-id", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );

    expect(openNudgeId(readNudgeRecords())).toBe("some-id");
    markNudgeAnswered(new Date("2026-07-24T08:05:00Z"));

    const records = readNudgeRecords();
    expect(records).toHaveLength(2);
    expect(records[1]!).toMatchObject({ event: "answered", id: "some-id", latencyMs: 300000 });
    // Now nothing is open.
    expect(openNudgeId(readNudgeRecords())).toBeNull();
  });

  test("no-op when nothing is open", () => {
    // Empty log → no open nudge.
    markNudgeAnswered();
    expect(readNudgeRecords()).toHaveLength(0);
  });

  test("marks only the most recent unanswered nudge", () => {
    // Two sent, the first already answered → the second is open.
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "a", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n" +
      JSON.stringify({ event: "answered", id: "a", ts: "2026-07-24T08:05:00Z", latencyMs: 300000 }) + "\n" +
      JSON.stringify({ event: "sent", id: "b", ts: "2026-07-24T09:00:00Z", key: "k", source: "plan", summary: "s2", text: "t2", composedBy: "llm" }) + "\n"
    );

    expect(openNudgeId(readNudgeRecords())).toBe("b");
    markNudgeAnswered(new Date("2026-07-24T09:05:00Z"));
    const answered = readNudgeRecords().filter((r) => r.event === "answered");
    expect(answered.map((r) => (r as { id: string }).id)).toEqual(["a", "b"]);
  });
});

// ─── readNudgeRecords (real file) ─────────────────────────────────────────────

describe("readNudgeRecords", () => {
  test("missing file → []", () => {
    setupHome();
    const records = readNudgeRecords();
    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(0);
    teardownHome();
  });

  test("corrupt line is skipped, surrounding lines survive", () => {
    setupHome();
    const path = join(TEST_HOME, "nudges.jsonl");
    writeFileSync(path,
      JSON.stringify({ event: "sent", id: "1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n" +
      "{ broken json\n" +
      JSON.stringify({ event: "sent", id: "2", ts: "2026-07-24T09:00:00Z", key: "k", source: "plan", summary: "s2", text: "t2", composedBy: "llm" }) + "\n"
    );

    const records = readNudgeRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.event).toBe("sent");
    expect(records[1]!).toMatchObject({ event: "sent", summary: "s2" });

    teardownHome();
  });
});

// ─── Job 2 — answer signal (criteria 9–16) ────────────────────────────────────

describe("answer signal — markNudgeAnswered with window", () => {
  beforeEach(() => {
    setupHome();
  });
  afterEach(() => {
    teardownHome();
  });

  test("nudge sent 5 minutes ago → answered with correct latencyMs (criterion 9)", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );

    markNudgeAnswered(new Date("2026-07-24T08:05:00Z"));

    const records = readNudgeRecords();
    expect(records).toHaveLength(2);
    expect(records[1]!).toMatchObject({ event: "answered", id: "n1", latencyMs: 300000 });
  });

  test("nudge sent 2 hours ago → expired, no answered record (criterion 10)", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );

    markNudgeAnswered(new Date("2026-07-24T10:00:00Z"));

    const records = readNudgeRecords();
    expect(records).toHaveLength(2);
    expect(records[1]!).toMatchObject({ event: "expired", ageMs: 7200000 });
    const answered = records.filter((r) => r.event === "answered");
    expect(answered).toHaveLength(0);
  });

  test("boundary: exactly ANSWER_WINDOW_MS → answered; 1ms past → expired (criterion 11)", () => {
    // Exactly at the window → answered
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );
    markNudgeAnswered(new Date("2026-07-24T08:30:00Z"));
    expect(readNudgeRecords()[1]!).toMatchObject({ event: "answered" });

    // One ms past → expired
    teardownHome();
    setupHome();
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n2", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );
    markNudgeAnswered(new Date("2026-07-24T08:30:00.001Z"));
    expect(readNudgeRecords()[1]!).toMatchObject({ event: "expired" });
  });

  test("after expired, second markNudgeAnswered appends nothing (criterion 12)", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );

    // First call → expired
    markNudgeAnswered(new Date("2026-07-24T10:00:00Z"));
    expect(readNudgeRecords()).toHaveLength(2);

    // Second call → no-op (openNudgeId treats expired as closed)
    markNudgeAnswered(new Date("2026-07-24T11:00:00Z"));
    expect(readNudgeRecords()).toHaveLength(2);
  });

  test("no open nudge → no-op, no throw (criterion 13)", () => {
    // Empty log
    expect(() => markNudgeAnswered(new Date())).not.toThrow();
    expect(readNudgeRecords()).toHaveLength(0);

    teardownHome();
    setupHome();

    // All nudges already closed
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n" +
      JSON.stringify({ event: "answered", id: "n1", ts: "2026-07-24T08:05:00Z", latencyMs: 300000 }) + "\n"
    );
    expect(() => markNudgeAnswered(new Date())).not.toThrow();
    expect(readNudgeRecords()).toHaveLength(2);
  });
});

describe("answer signal — backward compatibility & edge cases", () => {
  beforeEach(() => {
    setupHome();
  });
  afterEach(() => {
    teardownHome();
  });

  test("legacy answered record without latencyMs reads without throwing (criterion 14)", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n" +
      JSON.stringify({ event: "answered", id: "n1", ts: "2026-07-24T08:05:00Z" }) + "\n"
    );

    // Should not throw and should treat as closed
    expect(openNudgeId(readNudgeRecords())).toBeNull();
  });

  test("unparseable sent ts → answered with NO latencyMs, not a fabricated 0 (criterion 15)", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "not-a-date", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n"
    );

    markNudgeAnswered(new Date("2026-07-24T10:00:00Z"));
    const records = readNudgeRecords();
    expect(records).toHaveLength(2);
    expect(records[1]!).toMatchObject({ event: "answered", id: "n1" });
    // `latencyMs: 0` would be the FLATTERING claim — an instant reply — injected straight into
    // the latency distribution this log exists to make honest. The field is optional so the
    // record can say "answered, age unknown".
    expect(records[1]!).not.toHaveProperty("latencyMs");
  });

  test("sentToday counts only sent records when history has expired (criterion 16)", async () => {
    const { sentToday } = await import("./rules.js");
    const now = new Date("2026-07-24T12:00:00Z");

    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      JSON.stringify({ event: "sent", id: "n1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n" +
      JSON.stringify({ event: "expired", id: "n2", ts: "2026-07-24T09:00:00Z", ageMs: 7200000 }) + "\n" +
      JSON.stringify({ event: "answered", id: "n3", ts: "2026-07-24T10:00:00Z", latencyMs: 300000 }) + "\n"
    );

    const history = readNudgeRecords();
    expect(sentToday(history, now)).toBe(1);
  });
});

// ─── Post-Phase-42 review: the ratio must be a count, not a join ──────────────
//
// Before this, markNudgeAnswered closed only the NEWEST open nudge, so a nudge the owner
// simply ignored kept no closing record at all — and answered/(answered+expired) read 100%
// in exactly the scenario the signal exists to expose.

describe("answer signal — every open nudge is closed", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  function sentLine(id: string, ts: string): string {
    return JSON.stringify({ event: "sent", id, ts, key: "k-" + id, source: "plan", summary: "s", text: "t", composedBy: "llm" }) + "\n";
  }

  test("an ignored older nudge is closed as expired in the SAME call that answers the newest", () => {
    // A sent 10:00 and ignored; B sent 11:00; the owner messages at 11:05.
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      sentLine("A", "2026-07-24T10:00:00Z") + sentLine("B", "2026-07-24T11:00:00Z"));

    markNudgeAnswered(new Date("2026-07-24T11:05:00Z"));

    const records = readNudgeRecords();
    const answered = records.filter((r) => r.event === "answered");
    const expired = records.filter((r) => r.event === "expired");

    expect(answered).toHaveLength(1);
    expect(answered[0]!).toMatchObject({ id: "B", latencyMs: 300000 });
    expect(expired).toHaveLength(1);
    expect(expired[0]!).toMatchObject({ id: "A", ageMs: 3900000 });

    // The whole point: closed == sent, so the ratio needs no join against open `sent` rows.
    expect(answered.length + expired.length).toBe(records.filter((r) => r.event === "sent").length);
    expect(openNudgeId(records)).toBeNull();
  });

  test("one message answers at most ONE nudge, even when two are inside the window", () => {
    // A lowered minGapMs can put two nudges inside ANSWER_WINDOW_MS. Booking both as replies
    // would re-inflate the ratio, so the older one expires regardless of its age.
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      sentLine("A", "2026-07-24T11:00:00Z") + sentLine("B", "2026-07-24T11:10:00Z"));

    markNudgeAnswered(new Date("2026-07-24T11:15:00Z"));

    const records = readNudgeRecords();
    expect(records.filter((r) => r.event === "answered")).toHaveLength(1);
    expect(records.filter((r) => r.event === "answered")[0]!).toMatchObject({ id: "B" });
    // A was only 15 min old — still expired, because one message is one reply.
    expect(records.filter((r) => r.event === "expired")[0]!).toMatchObject({ id: "A", ageMs: 900000 });
  });

  test("a second message after everything is closed appends nothing", () => {
    writeFileSync(join(TEST_HOME, "nudges.jsonl"),
      sentLine("A", "2026-07-24T10:00:00Z") + sentLine("B", "2026-07-24T11:00:00Z"));

    markNudgeAnswered(new Date("2026-07-24T11:05:00Z"));
    expect(readNudgeRecords()).toHaveLength(4);
    markNudgeAnswered(new Date("2026-07-24T11:30:00Z"));
    expect(readNudgeRecords()).toHaveLength(4);
  });
});
