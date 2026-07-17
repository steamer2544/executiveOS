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

/** R3: A deadline exists → review progress against it. Priority 70, confidence 0.80 → ask. */
function reviewDeadline(s: State): ProposedAction | null {
  if (s.deadline === null) return null;
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
