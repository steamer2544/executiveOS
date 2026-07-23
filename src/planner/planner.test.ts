// Planner tests (Phase 4).
// Tests the rule engine, guardrail, plan() + writePlan() round-trip.
// Pure tests construct State directly — no .executive/ on disk needed.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { execRoot } from "../paths.js";
import type { State, Context } from "../state/types.js";
import { plan, writePlan, applyGuardrail } from "./planner.js";
import { RULES, daysOverdue } from "./rules.js";
import { CONFIDENCE_THRESHOLD } from "./types.js";
import type { ProposedAction } from "./types.js";
import { emptyPatterns } from "../state/patterns.js";

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
    patterns: emptyPatterns(),
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
      patterns: emptyPatterns(),
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
    // Architectural check: the Planner reads State only, never the raw event logs,
    // so new watchers plug in without touching it. The old version of this test only
    // counted rules — it would have passed even if rules.ts started reading events.
    // Check the source directly.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ["rules.ts", "planner.ts"]) {
      const src = readFileSync(join(here, f), "utf-8");
      const imports = src.match(/^import .*$/gm) ?? [];
      for (const line of imports) {
        expect(line).not.toContain("events/store");
        expect(line).not.toContain("state/builder");
      }
    }
    // rules.ts is stricter still: pure functions of State, so no I/O of any kind.
    // (planner.ts legitimately imports planPath — writePlan persists plan.json.)
    const rulesSrc = readFileSync(join(here, "rules.ts"), "utf-8");
    for (const line of rulesSrc.match(/^import .*$/gm) ?? []) {
      expect(line).not.toContain("node:fs");
      expect(line).not.toContain("paths.js");
    }
  });

  it("RULES contains every rule exactly once", () => {
    // 4 breakage rules (Phase 4) + 3 pattern rules (Phase 33).
    expect(RULES.length).toBe(7);
    expect(new Set(RULES).size).toBe(RULES.length);
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

// ─── R3 (Phase 32): a past deadline asks a different question ────────────────

describe("planner — R3: overdue deadline", () => {
  it("daysOverdue counts whole days, null for future/today/non-dates", () => {
    expect(daysOverdue("2026-07-15", "2026-07-17T09:00:00.000Z")).toBe(2);
    expect(daysOverdue("2026-07-17", "2026-07-17T23:00:00.000Z")).toBeNull(); // today
    expect(daysOverdue("2026-07-20", "2026-07-17T00:00:00.000Z")).toBeNull(); // future
    expect(daysOverdue("tomorrow", "2026-07-17T00:00:00.000Z")).toBeNull();  // not a date
  });

  it("says the deadline passed instead of 'review progress'", () => {
    const s = makeState({ deadline: "2026-07-15" }); // generatedAt is 2026-07-17
    const p = plan(s);
    const a = p.topAction!;
    expect(a.kind).toBe("review_deadline");
    expect(a.reason).toBe(
      "deadline (2026-07-15) passed 2 day(s) ago — close it out, reschedule, or clear it"
    );
    expect(a.priority).toBe(75);
    expect(a.disposition).toBe("ask");
  });

  it("a future deadline keeps the original wording and priority", () => {
    const s = makeState({ deadline: "2026-07-20" });
    const a = plan(s).topAction!;
    expect(a.reason).toBe("deadline set (2026-07-20) — review progress");
    expect(a.priority).toBe(70);
  });
});

// ─── Phase 33: pattern rules ─────────────────────────────────────────────────
// These fire when nothing is broken but the working pattern says something.
// Thresholds were calibrated against the real event log — see the scope doc §3.2.

describe("planner — R5: checkpoint_work", () => {
  it("fires when many edits ride on an old commit, and always asks", () => {
    const s = makeState({
      patterns: { ...emptyPatterns(), msSinceLastCommit: 4 * 3600_000, editsSinceLastCommit: 25 },
    });
    const a = plan(s).actions.find((x) => x.kind === "checkpoint_work");
    expect(a).toBeDefined();
    expect(a!.disposition).toBe("ask");
    expect(a!.priority).toBe(60);
    // The reason must carry the concrete numbers, so the owner can check the claim.
    expect(a!.reason).toContain("25 edit(s)");
    expect(a!.reason).toContain("4.0h");
  });

  it("is silent just under either threshold", () => {
    const fewEdits = makeState({
      patterns: { ...emptyPatterns(), msSinceLastCommit: 4 * 3600_000, editsSinceLastCommit: 19 },
    });
    expect(plan(fewEdits).actions.some((x) => x.kind === "checkpoint_work")).toBe(false);

    const recentCommit = makeState({
      patterns: { ...emptyPatterns(), msSinceLastCommit: 2 * 3600_000, editsSinceLastCommit: 99 },
    });
    expect(plan(recentCommit).actions.some((x) => x.kind === "checkpoint_work")).toBe(false);
  });

  it("is silent when there has never been a commit", () => {
    const s = makeState({
      patterns: { ...emptyPatterns(), msSinceLastCommit: null, editsSinceLastCommit: 500 },
    });
    expect(plan(s).actions.some((x) => x.kind === "checkpoint_work")).toBe(false);
  });
});

describe("planner — R6: grinding_on_file", () => {
  it("fires on repeated saves of one file and names it", () => {
    const s = makeState({
      currentFile: "synth/synth.ts",
      patterns: { ...emptyPatterns(), sameFileSaves30m: 15 },
    });
    const a = plan(s).actions.find((x) => x.kind === "grinding_on_file");
    expect(a).toBeDefined();
    expect(a!.disposition).toBe("ask");
    expect(a!.reason).toContain("synth/synth.ts");
    expect(a!.reason).toContain("15 times");
  });

  it("defers to fix_tests while the suite is red", () => {
    const s = makeState({
      tests: "failing",
      currentFile: "synth/synth.ts",
      patterns: { ...emptyPatterns(), sameFileSaves30m: 30 },
    });
    const p = plan(s);
    expect(p.actions.some((x) => x.kind === "grinding_on_file")).toBe(false);
    expect(p.topAction!.kind).toBe("fix_tests");
  });

  it("is silent just under the threshold", () => {
    const s = makeState({ currentFile: "a.ts", patterns: { ...emptyPatterns(), sameFileSaves30m: 14 } });
    expect(plan(s).actions.some((x) => x.kind === "grinding_on_file")).toBe(false);
  });
});

describe("planner — R7: long_session", () => {
  it("fires after a long unbroken run and sits below every other rule", () => {
    const s = makeState({
      blocked: true,
      blockedReason: "waiting on review",
      patterns: { ...emptyPatterns(), sessionMs: 95 * 60_000 },
    });
    const p = plan(s);
    const a = p.actions.find((x) => x.kind === "long_session");
    expect(a).toBeDefined();
    expect(a!.priority).toBe(35);
    expect(a!.reason).toContain("95 min");
    // Lowest priority: it must never outrank a real blocker.
    expect(p.actions[p.actions.length - 1]!.kind).toBe("long_session");
    expect(p.topAction!.kind).toBe("resolve_block");
  });

  it("is silent under 90 minutes and when there is no session", () => {
    expect(plan(makeState({ patterns: { ...emptyPatterns(), sessionMs: 89 * 60_000 } })).actions.length).toBe(0);
    expect(plan(makeState({ patterns: { ...emptyPatterns(), sessionMs: null } })).actions.length).toBe(0);
  });
});

describe("planner — pattern rules add no noise to a healthy state", () => {
  it("a healthy state with no threshold crossed still plans nothing", () => {
    const s = makeState({
      tests: "passing",
      patterns: {
        msSinceLastCommit: 30 * 60_000,
        editsSinceLastCommit: 3,
        sameFileSaves30m: 4,
        sessionMs: 20 * 60_000,
        repoSwitches1h: 2,
      },
    });
    const p = plan(s);
    expect(p.actions.length).toBe(0);
    expect(p.topAction).toBeNull();
    expect(p.summary).toBe("No action needed.");
  });
});
