// Tests for src/proactive/rules.ts — pure decision rules.
//
// All offline, no network, no real Date. Time is injected via the `now` parameter.

import { describe, test, expect } from "bun:test";
import {
  decideNudge,
  inQuietHours,
  sentToday,
} from "./rules.js";
import type { Nudge, NudgeRecord } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNudge(overrides?: Partial<Nudge>): Nudge {
  return { key: "plan|test", source: "plan" as const, summary: "Test nudge", ...overrides };
}

function makeDecisionInput(overrides?: {
  added?: Nudge[];
  firstTickDone?: boolean;
  lastSentAt?: number | null;
  now?: Date;
  history?: NudgeRecord[];
  config?: Record<string, unknown>;
}) {
  return {
    added: overrides?.added ?? [makeNudge()],
    state: {
      firstTickDone: overrides?.firstTickDone ?? true,
      lastSentAt: overrides?.lastSentAt ?? null,
      awaitingReplyId: null,
    },
    now: overrides?.now ?? new Date("2026-07-24T10:00:00Z"),
    history: overrides?.history ?? [],
    config: {
      enabled: true,
      maxPerDay: 6,
      minGapMs: 1800000,
      quietFrom: "22:00",
      quietTo: "08:00",
      ...overrides?.config,
    },
  };
}

// ─── inQuietHours ─────────────────────────────────────────────────────────────

describe("inQuietHours", () => {
  test("inside a normal window (09:00–17:00 at 12:00)", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    expect(inQuietHours(now, "09:00", "17:00")).toBe(true);
  });

  test("outside a normal window (23:00 with 09:00–17:00)", () => {
    const now = new Date();
    now.setHours(23, 0, 0, 0);
    expect(inQuietHours(now, "09:00", "17:00")).toBe(false);
  });

  test("exact from boundary is inside (09:00 with 09:00–17:00)", () => {
    const now = new Date();
    now.setHours(9, 0, 0, 0);
    expect(inQuietHours(now, "09:00", "17:00")).toBe(true);
  });

  test("exact to boundary is outside (17:00 with 09:00–17:00)", () => {
    const now = new Date();
    now.setHours(17, 0, 0, 0);
    expect(inQuietHours(now, "09:00", "17:00")).toBe(false);
  });

  test("wrapping window 22:00–08:00 at 23:30 (inside)", () => {
    const now = new Date();
    now.setHours(23, 30, 0, 0);
    expect(inQuietHours(now, "22:00", "08:00")).toBe(true);
  });

  test("wrapping window 22:00–08:00 at 02:00 (inside)", () => {
    const now = new Date();
    now.setHours(2, 0, 0, 0);
    expect(inQuietHours(now, "22:00", "08:00")).toBe(true);
  });

  test("wrapping window 22:00–08:00 at 12:00 (outside)", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    expect(inQuietHours(now, "22:00", "08:00")).toBe(false);
  });

  test("from === to disables quiet hours", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    expect(inQuietHours(now, "09:00", "09:00")).toBe(false);
  });
});

// ─── sentToday ────────────────────────────────────────────────────────────────

describe("sentToday", () => {
  test("counts only sent records on the same calendar day", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const history: NudgeRecord[] = [
      { event: "sent", id: "1", ts: "2026-07-24T08:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" },
      { event: "sent", id: "2", ts: "2026-07-24T09:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "fallback" },
      { event: "sent", id: "3", ts: "2026-07-23T23:00:00Z", key: "k", source: "plan", summary: "s", text: "t", composedBy: "llm" },
      { event: "answered", id: "4", ts: "2026-07-24T09:30:00Z" },
      { event: "suppressed", ts: "2026-07-24T09:45:00Z", key: "k", reason: "min gap" },
    ];
    expect(sentToday(history, now)).toBe(2);
  });

  test("ignores answered and suppressed records", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const history: NudgeRecord[] = [
      { event: "answered", id: "1", ts: "2026-07-24T08:00:00Z" },
      { event: "suppressed", ts: "2026-07-24T09:00:00Z", key: "k", reason: "test" },
    ];
    expect(sentToday(history, now)).toBe(0);
  });
});

// ─── decideNudge — one test per suppression reason ────────────────────────────

describe("decideNudge", () => {
  test("rule 1: disabled returns { nudge: null, reason: 'disabled' }", () => {
    const input = makeDecisionInput({
      config: { enabled: false },
      firstTickDone: true,
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("disabled");
  });

  test("rule 2: first tick never nudges even with items", () => {
    const input = makeDecisionInput({
      firstTickDone: false,
      added: [makeNudge({ summary: "Something urgent" })],
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("first tick");
  });

  test("rule 3: nothing new returns { nudge: null, reason: 'nothing new' }", () => {
    const input = makeDecisionInput({ added: [] });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("nothing new");
  });

  test("rule 4: quiet hours suppresses at 23:30 with 22:00–08:00", () => {
    const now = new Date();
    now.setHours(23, 30, 0, 0);
    const input = makeDecisionInput({
      now,
      config: { quietFrom: "22:00", quietTo: "08:00" },
      firstTickDone: true,
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("quiet hours");
  });

  test("rule 5: min gap suppresses when lastSentAt is too recent", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const input = makeDecisionInput({
      now,
      lastSentAt: now.getTime() - 60000, // 1 min ago
      config: { minGapMs: 1800000 }, // 30 min
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("min gap");
  });

  test("rule 6: daily budget spent suppresses when max reached", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const history: NudgeRecord[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({
        event: "sent",
        id: `sent-${i}`,
        ts: `2026-07-24T${String(8 + i).padStart(2, "0")}:00:00Z`,
        key: "k",
        source: "plan",
        summary: "s",
        text: "t",
        composedBy: "llm",
      });
    }
    const input = makeDecisionInput({
      now,
      history,
      config: { maxPerDay: 6 },
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("daily budget spent (6)");
  });

  test("rule 7: already nudged suppresses when all candidates repeated in 24h", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const history: NudgeRecord[] = [
      {
        event: "sent",
        id: "1",
        ts: "2026-07-24T08:00:00Z",
        key: "plan|test",
        source: "plan",
        summary: "test",
        text: "t",
        composedBy: "llm",
      },
    ];
    const input = makeDecisionInput({
      now,
      history,
      added: [makeNudge({ key: "plan|test" })],
    });
    const result = decideNudge(input);
    if (result.nudge) throw new Error("expected null");
    expect(result.reason).toBe("already nudged");
  });

  test("sends the first non-repeat candidate when some are fresh", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const history: NudgeRecord[] = [
      {
        event: "sent",
        id: "1",
        ts: "2026-07-24T08:00:00Z",
        key: "plan|old",
        source: "plan",
        summary: "old",
        text: "t",
        composedBy: "llm",
      },
    ];
    const input = makeDecisionInput({
      now,
      history,
      added: [
        makeNudge({ key: "plan|old" }), // repeat
        makeNudge({ key: "plan|fresh" }), // not in history
      ],
    });
    const result = decideNudge(input);
    if (!result.nudge) throw new Error("expected nudge");
    expect(result.nudge.key).toBe("plan|fresh");
  });

  test("first tick never nudges; second tick with same items does", () => {
    const now = new Date("2026-07-24T10:00:00Z");
    const added = [makeNudge({ summary: "Something" })];

    // First tick
    const input1 = makeDecisionInput({ now, added, firstTickDone: false });
    const result1 = decideNudge(input1);
    if (result1.nudge) throw new Error("expected null");
    expect(result1.reason).toBe("first tick");

    // Second tick (same items, but firstTickDone is now true)
    const input2 = makeDecisionInput({ now, added, firstTickDone: true });
    const result2 = decideNudge(input2);
    if (!result2.nudge) throw new Error("expected nudge");
    expect(result2.nudge.summary).toBe("Something");
  });

  test("same key twice → second suppressed; same key 25h apart → allowed", () => {
    const now = new Date("2026-07-24T10:00:00Z");

    // Same key within 24h → suppressed
    const history24h: NudgeRecord[] = [
      {
        event: "sent",
        id: "1",
        ts: "2026-07-24T09:00:00Z",
        key: "plan|test",
        source: "plan",
        summary: "test",
        text: "t",
        composedBy: "llm",
      },
    ];
    const inputSame = makeDecisionInput({
      now,
      history: history24h,
      added: [makeNudge({ key: "plan|test" })],
    });
    const r1 = decideNudge(inputSame);
    if (r1.nudge) throw new Error("expected null");

    // Same key 25h ago → allowed
    const history25h: NudgeRecord[] = [
      {
        event: "sent",
        id: "2",
        ts: "2026-07-23T08:00:00Z",
        key: "plan|test",
        source: "plan",
        summary: "test",
        text: "t",
        composedBy: "llm",
      },
    ];
    const input25h = makeDecisionInput({
      now,
      history: history25h,
      added: [makeNudge({ key: "plan|test" })],
    });
    const r2 = decideNudge(input25h);
    if (!r2.nudge) throw new Error("expected nudge");
  });
});
