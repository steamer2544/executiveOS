// Tests for the shared digest tick (Phase 33, Job 1).
// All OFFLINE: seed artifacts into a temp EXECUTIVE_HOME, then tick.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect } from "bun:test";
import { statePath, planPath, digestPath, notificationsPath } from "../paths.js";
import { runDigestTick, createDigestTickState } from "./tick.js";
import { readNotifications } from "./notify.js";
import type { State } from "../state/types.js";
import type { Plan, ProposedAction } from "../planner/types.js";

function createTempHome(): string {
  const dir = process.cwd() + "/.executive-test-" + randomUUID();
  mkdirSync(dir, { recursive: true });
  process.env.EXECUTIVE_HOME = dir;
  return dir;
}

function cleanup(dir: string): void {
  delete process.env.EXECUTIVE_HOME;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function seedState(): void {
  const s: State = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    eventCount: 10,
    lastEventTs: "2026-01-01T00:00:00.000Z",
    currentProject: "demo",
    currentTask: null,
    deadline: null,
    currentFile: null,
    recentFiles: [],
    git: { branch: "main", lastCommit: null },
    tests: "unknown",
    blocked: false,
    blockedReason: null,
    currentWindow: null,
    activity: { active: true, idleMs: 0 },
    activeRepo: null,
    repos: [],
    patterns: {
      msSinceLastCommit: null,
      editsSinceLastCommit: 0,
      sameFileSaves30m: 0,
      sessionMs: null,
      repoSwitches1h: 0,
    },
  };
  writeFileSync(statePath(), JSON.stringify(s));
}

/** A plan with one "ask" action produces exactly one needs-you item.
 *  The digest keys a needs-you item on the action *kind* (not its reason), so
 *  callers that want a different item must pass a different kind. */
function seedPlanWithAsk(kind: ProposedAction["kind"], reason: string): void {
  const action: ProposedAction = {
    kind,
    reason,
    priority: 90,
    confidence: 0.6,
    forbidden: false,
    disposition: "ask" as const,
  };
  const p: Plan = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    basedOnState: { generatedAt: "2026-01-01T00:00:00.000Z", eventCount: 10 },
    topAction: action,
    actions: [action],
    summary: "blocked",
  };
  writeFileSync(planPath(), JSON.stringify(p));
}

function seedEmptyPlan(): void {
  const p: Plan = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    basedOnState: { generatedAt: "2026-01-01T00:00:00.000Z", eventCount: 10 },
    topAction: null,
    actions: [],
    summary: "No action needed.",
  };
  writeFileSync(planPath(), JSON.stringify(p));
}

test("first tick with a non-empty queue writes digest.md, logs added, and is not 'cleared'", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedPlanWithAsk("resolve_block", "blocked: waiting on the API key");

    const st = createDigestTickState();
    const r = runDigestTick(st);

    expect(r.changed).toBe(true);
    expect(r.cleared).toBe(false);
    expect(r.digest.needsYou.length).toBe(1);
    expect(r.added.length).toBe(1);
    expect(r.resolved.length).toBe(0);

    expect(existsSync(digestPath())).toBe(true);
    expect(readFileSync(digestPath(), "utf-8")).toContain("Needs you");

    const notes = readNotifications();
    expect(notes.length).toBe(1);
    expect(notes[0]!.event).toBe("added");
    expect(notes[0]!.source).toBe("plan");
  } finally {
    cleanup(dir);
  }
});

test("an unchanged queue on the next tick appends nothing and reports changed:false", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedPlanWithAsk("resolve_block", "blocked: waiting on the API key");

    const st = createDigestTickState();
    runDigestTick(st);
    const second = runDigestTick(st);

    expect(second.changed).toBe(false);
    expect(second.added.length).toBe(0);
    expect(second.resolved.length).toBe(0);
    // Still exactly the one record from the first tick — no per-tick spam.
    expect(readNotifications().length).toBe(1);
  } finally {
    cleanup(dir);
  }
});

test("non-empty → empty logs a 'resolved' record and reports cleared:true", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedPlanWithAsk("resolve_block", "blocked: waiting on the API key");

    const st = createDigestTickState();
    runDigestTick(st);

    seedEmptyPlan();
    const r = runDigestTick(st);

    expect(r.changed).toBe(true);
    expect(r.cleared).toBe(true);
    expect(r.resolved.length).toBe(1);
    expect(r.digest.needsYou.length).toBe(0);

    const notes = readNotifications();
    expect(notes.length).toBe(2);
    expect(notes[1]!.event).toBe("resolved");
  } finally {
    cleanup(dir);
  }
});

test("a first tick with an empty queue is not reported as 'cleared'", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedEmptyPlan();

    const st = createDigestTickState();
    const r = runDigestTick(st);

    // The queue changed (null → ""), but nothing was ever there to clear.
    expect(r.cleared).toBe(false);
    expect(r.added.length).toBe(0);
    expect(r.resolved.length).toBe(0);
    expect(existsSync(notificationsPath())).toBe(false);
  } finally {
    cleanup(dir);
  }
});

test("a changed queue replaces items: one resolved, one added", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedPlanWithAsk("resolve_block", "blocked: waiting on the API key");

    const st = createDigestTickState();
    runDigestTick(st);

    seedPlanWithAsk("review_deadline", "deadline set (2026-08-01) — review progress");
    const r = runDigestTick(st);

    expect(r.changed).toBe(true);
    expect(r.cleared).toBe(false);
    expect(r.added.length).toBe(1);
    expect(r.resolved.length).toBe(1);
    expect(readNotifications().length).toBe(3);
  } finally {
    cleanup(dir);
  }
});

test("digest.md is rewritten on every tick, even when the queue is unchanged", () => {
  const dir = createTempHome();
  try {
    seedState();
    seedEmptyPlan();

    const st = createDigestTickState();
    runDigestTick(st);
    rmSync(digestPath(), { force: true });
    runDigestTick(st);

    // The file comes back: the digest refresh is unconditional; only the
    // notification log is gated on a change.
    expect(existsSync(digestPath())).toBe(true);
  } finally {
    cleanup(dir);
  }
});
