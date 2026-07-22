// Rule definitions for the Planner (Phase 4).
// Each rule is a pure function: (state) => ProposedAction | null.
// The Planner is 100% rule-based — no LLM, no randomness, no side effects.

import type { State } from "../state/types.js";
import type { ProposedAction } from "./types.js";

/** R1: Tests are failing → fix them. Priority 100, confidence 0.97 → act. */
function fixTests(s: State): ProposedAction | null {
  if (s.tests !== "failing") return null;
  return {
    kind: "fix_tests",
    reason: "tests are failing — fix them before moving on",
    priority: 100,
    confidence: 0.97,
    forbidden: false,
  };
}

/** R2: Work is blocked → surface / resolve the blocker. Priority 90, confidence 0.60 → ask. */
function resolveBlock(s: State): ProposedAction | null {
  if (!s.blocked) return null;
  return {
    kind: "resolve_block",
    reason: "blocked: " + (s.blockedReason ?? "unknown reason"),
    priority: 90,
    confidence: 0.60,
    forbidden: false,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days `deadline` is past `nowIso`, or null when either is not a plain date.
 * Uses the state's own `generatedAt` as "now" so the rule stays a pure function of state.
 */
export function daysOverdue(deadline: string, nowIso: string): number | null {
  if (!DATE_ONLY.test(deadline)) return null;
  const today = nowIso.slice(0, 10);
  if (!DATE_ONLY.test(today)) return null;
  const ms = Date.parse(today + "T00:00:00Z") - Date.parse(deadline + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  const days = Math.floor(ms / 86_400_000);
  return days > 0 ? days : null;
}

/**
 * R3: A deadline exists → review progress against it. Priority 70, confidence 0.80 → ask.
 * An already-past deadline is a different (and more urgent) question — it can only be
 * closed out, rescheduled, or cleared — so it says so instead of repeating "review progress"
 * forever. Clearing is an empty `system.task {deadline:""}` (dashboard: "Clear deadline").
 */
function reviewDeadline(s: State): ProposedAction | null {
  if (s.deadline === null) return null;
  const overdue = daysOverdue(s.deadline, s.generatedAt);
  if (overdue !== null) {
    return {
      kind: "review_deadline",
      reason:
        "deadline (" + s.deadline + ") passed " + overdue + " day(s) ago — " +
        "close it out, reschedule, or clear it",
      priority: 75,
      confidence: 0.80,
      forbidden: false,
    };
  }
  return {
    kind: "review_deadline",
    reason: "deadline set (" + s.deadline + ") — review progress",
    priority: 70,
    confidence: 0.80,
    forbidden: false,
  };
}

/** R4: Idle mid-task → nudge back to the current task. Priority 40, confidence 0.50 → ask. */
function resumeTask(s: State): ProposedAction | null {
  if (s.activity.active || s.currentTask === null) return null;
  return {
    kind: "resume_task",
    reason: "idle mid-task (" + s.currentTask + ") — resume",
    priority: 40,
    confidence: 0.50,
    forbidden: false,
  };
}

/**
 * Ordered rule set.
 * Rules are evaluated in array order; the array index breaks priority ties (stable sort).
 */
export const RULES: Array<(s: State) => ProposedAction | null> = [
  fixTests,
  resolveBlock,
  reviewDeadline,
  resumeTask,
];
