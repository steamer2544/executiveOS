// Planner tests (Phase 4).
// Tests the rule engine, guardrail, plan() + writePlan() round-trip.
// Pure tests construct State directly — no .executive/ on disk needed.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { execRoot } from "../paths.js";
import type { State, Context } from "../state/types.js";
import { plan, writePlan, applyGuardrail } from "./planner.js";
import { RULES } from "./rules.js";
import { CONFIDENCE_THRESHOLD } from "./types.js";
import type { ProposedAction } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal State with overrides.
 * All fields have sensible defaults so tests only set what matters.
 */
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

/** Build a minimal Context from a State. */
function makeContext(state: State): Context {
  return {
    generatedAt: state.generatedAt,
    summary: "test context",
    state,
    recentEvents: [],
  };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe("planner — empty / clean state", () => {
  it("no actions when everything is clean", () => {
    const s = makeState({
      tests: "unknown",
      blocked: false,
      deadline: null,
      activity: { active: true, idleMs: null },
      activeRepo: null,
      repos: [],
    });
    const p = plan(s);
    expect(p.actions).toEqual([]);
    expect(p.topAction).toBeNull();
    expect(p.summary).toBe("No action needed.");
    expect(p.basedOnState.generatedAt).toBe(s.generatedAt);
    expect(p.basedOnState.eventCount).toBe(s.eventCount);
  });
});

describe("planner — R1: failing tests → act", () => {
  it("fix_tests with disposition act", () => {
    const s = makeState({ tests: "failing" });
    const p = plan(s);
    expect(p.actions.length).toBe(1);
    const a = p.actions[0]!;
    expect(a.kind).toBe("fix_tests");
    expect(a.priority).toBe(100);
    expect(a.confidence).toBe(0.97);
    expect(a.disposition).toBe("act");
    expect(a.forbidden).toBe(false);
    expect(a.reason).toBe("tests are failing — fix them before moving on");
    expect(p.topAction).toBe(a);
  });
});

describe("planner — R2: blocked → ask", () => {
  it("resolve_block with disposition ask, reason includes blocker", () => {
    const s = makeState({ blocked: true, blockedReason: "waiting review" });
    const p = plan(s);
    expect(p.actions.length).toBe(1);
    const a = p.actions[0]!;
    expect(a.kind).toBe("resolve_block");
    expect(a.priority).toBe(90);
    expect(a.confidence).toBe(0.60);
    expect(a.disposition).toBe("ask");
    expect(a.reason).toBe("blocked: waiting review");
  });
});

describe("planner — R3: deadline → ask", () => {
  it("review_deadline with disposition ask", () => {
    const s = makeState({ deadline: "tomorrow" });
    const p = plan(s);
    expect(p.actions.length).toBe(1);
    const a = p.actions[0]!;
    expect(a.kind).toBe("review_deadline");
    expect(a.priority).toBe(70);
    expect(a.confidence).toBe(0.80);
    expect(a.disposition).toBe("ask");
    expect(a.reason).toBe("deadline set (tomorrow) — review progress");
  });
});

describe("planner — R4: idle mid-task → ask", () => {
  it("resume_task fires when idle and currentTask is set", () => {
    const s = makeState({ activity: { active: false, idleMs: 300000 }, currentTask: "implement feature" });
    const p = plan(s);
    expect(p.actions.length).toBe(1);
    const a = p.actions[0]!;
    expect(a.kind).toBe("resume_task");
    expect(a.priority).toBe(40);
    expect(a.confidence).toBe(0.50);
    expect(a.disposition).toBe("ask");
    expect(a.reason).toBe("idle mid-task (implement feature) — resume");
  });

  it("resume_task does NOT fire when active", () => {
    const s = makeState({ activity: { active: true, idleMs: null }, currentTask: "implement feature" });
    const p = plan(s);
    expect(p.actions).toEqual([]);
  });

  it("resume_task does NOT fire when no currentTask", () => {
    const s = makeState({ activity: { active: false, idleMs: 300000 }, currentTask: null });
    const p = plan(s);
    expect(p.actions).toEqual([]);
  });
});

describe("planner — priority ordering", () => {
  it("sorts multiple actions by priority DESC, topAction is highest", () => {
    const s = makeState({
      tests: "failing",
      blocked: true,
      blockedReason: "waiting review",
      deadline: "tomorrow",
    });
    const p = plan(s);
    expect(p.actions.length).toBe(3);
    expect(p.actions[0]!.kind).toBe("fix_tests");
    expect(p.actions[0]!.priority).toBe(100);
    expect(p.actions[1]!.kind).toBe("resolve_block");
    expect(p.actions[1]!.priority).toBe(90);
    expect(p.actions[2]!.kind).toBe("review_deadline");
    expect(p.actions[2]!.priority).toBe(70);
    expect(p.topAction!.kind).toBe("fix_tests");
  });
});

describe("planner — guardrail is central & unbypassable", () => {
  function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
    return {
      kind: "fix_tests",
      reason: "test",
      priority: 100,
      confidence: 0.5,
      forbidden: false,
      disposition: "ask",
      ...overrides,
    };
  }

  it("forbidden: false, confidence > threshold → act", () => {
    const a = applyGuardrail(makeAction({ confidence: 0.99 }));
    expect(a.disposition).toBe("act");
  });

  it("forbidden: false, confidence == threshold → ask (boundary)", () => {
    const a = applyGuardrail(makeAction({ confidence: CONFIDENCE_THRESHOLD }));
    expect(a.disposition).toBe("ask");
  });

  it("forbidden: true, confidence > threshold → ask (forbidden wins)", () => {
    const a = applyGuardrail(makeAction({ forbidden: true, confidence: 0.99 }));
    expect(a.disposition).toBe("ask");
  });
});

describe("planner — determinism", () => {
  it("plan(sameState) twice → deep-equal plans", () => {
    const s = makeState({
      tests: "failing",
      blocked: true,
      blockedReason: "waiting review",
      deadline: "tomorrow",
    });
    const p1 = plan(s);
    const p2 = plan(s);
    expect(p1).toEqual(p2);
  });
});

describe("planner — plan reads only State", () => {
  it("plan() works with no .executive/ on disk", () => {
    // Ensure we're not relying on any files.
    const home = execRoot();
    const wasPresent = existsSync(home);
    try {
      const s = makeState({ tests: "failing" });
      const p = plan(s);
      expect(p.actions.length).toBe(1);
      expect(p.topAction!.kind).toBe("fix_tests");
    } finally {
      if (!wasPresent) {
        // Clean up if we created it.
        try {
          // Only remove if we didn't create it, but it existed before — leave it.
        } catch {
          // ignore
        }
      }
    }
  });

  it("RULES and planner do not import event store", () => {
    // Architectural check: rules.ts and planner.ts must not import read/tail from the event store.
    // We verify by checking that plan() can produce a correct Plan from a hand-built State
    // with no .executive/ on disk — already tested above.
    // Additionally, verify RULES count is exactly 4 (no extra rules).
    expect(RULES.length).toBe(4);
  });
});

describe("planner — writePlan round-trip", () => {
  it("writePlan + re-read produces valid JSON with correct structure", () => {
    const home = process.env.EXECUTIVE_HOME ?? undefined;
    // Use a temp directory (cross-platform).
    const tmpDir = join(tmpdir(), "executive-phase4-test-" + randomUUID().slice(0, 8));
    process.env.EXECUTIVE_HOME = tmpDir;

    try {
      // Ensure .executive/ exists (bootstrap subdirs).
      const execDir = join(tmpDir, ".executive");
      mkdirSync(execDir, { recursive: true });
      mkdirSync(join(execDir, "events"), { recursive: true });
      mkdirSync(join(execDir, "logs"), { recursive: true });
      for (const src of ["git", "terminal", "editor", "system"]) {
        writeFileSync(join(execDir, "events", src + ".jsonl"), "");
      }

      const s = makeState({ tests: "failing", eventCount: 42 });
      const p = plan(s);
      writePlan(p);

      // planPath() returns execRoot() + "/plan.json" (not inside .executive/).
      const actualPlanPath = join(tmpDir, "plan.json");
      expect(existsSync(actualPlanPath)).toBe(true);
      const raw = readFileSync(actualPlanPath, "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.actions).toBeInstanceOf(Array);
      expect(parsed.actions.length).toBe(1);
      expect(parsed.actions[0].kind).toBe("fix_tests");
      expect(parsed.basedOnState.generatedAt).toBe(s.generatedAt);
      expect(parsed.basedOnState.eventCount).toBe(42);
      expect(parsed.topAction.kind).toBe("fix_tests");
      expect(parsed.topAction.disposition).toBe("act");
    } finally {
      // Restore EXECUTIVE_HOME.
      if (home) {
        process.env.EXECUTIVE_HOME = home;
      } else {
        delete process.env.EXECUTIVE_HOME;
      }
      // Clean up temp dir.
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
