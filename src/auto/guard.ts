// Re-trigger guard for the Autopilot (Phase 9).
// Pure, deterministic functions to decide whether the watch daemon should
// run the Autopilot on a given rebuild tick. No I/O, no Date.now() inside.

import type { Config } from "../config.js";
import type { State } from "../state/types.js";
import type { Plan } from "../planner/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** In-memory state the daemon keeps between rebuild ticks to avoid re-acting. */
export interface AutopilotGuardState {
  /** Signature of the state we last ran the Autopilot on. */
  lastActedSignature: string | null;
  /** Date.now() of the last Autopilot run (start), or null. */
  lastActedAt: number | null;
}

/** A fresh guard state (call once when the daemon starts). */
export function freshGuardState(): AutopilotGuardState {
  return { lastActedSignature: null, lastActedAt: null };
}

/** The decision returned to the daemon. */
export interface GuardDecision {
  /** Whether to call runAuto this tick. */
  run: boolean;
  /** The signature computed for this tick (daemon stores it after a run). */
  signature: string;
  /** Short human-readable reason (for the optional skip/act log line). */
  reason: string;
}

// ─── Signature ──────────────────────────────────────────────────────────────

/**
 * A cheap, stable signature of "is there a new actionable situation?".
 * Combines the newest observed event seq with the plan's top action kind+disposition.
 * Same signature => nothing actionable has changed => do not re-run.
 */
export function computeSignature(state: State, plan: Plan, latestSeq: number): string {
  const kind = plan.topAction ? plan.topAction.kind : "none";
  const disp = plan.topAction ? plan.topAction.disposition : "none";
  return latestSeq + "|" + kind + "|" + disp;
}

// ─── Decision ───────────────────────────────────────────────────────────────

/**
 * Decide whether the watch daemon should run the Autopilot this tick.
 * Pure — no I/O, no Date.now() inside (the daemon passes `now`).
 */
export function shouldRunAutopilot(args: {
  config: Config;
  state: State;
  plan: Plan;
  latestSeq: number;
  guard: AutopilotGuardState;
  now: number; // Date.now() from the caller
}): GuardDecision {
  const { config, state, plan, latestSeq, guard, now } = args;

  // 1. Master switch.
  if (config.autopilot?.enabled !== true) {
    const signature = computeSignature(state, plan, latestSeq);
    return { run: false, signature, reason: "autopilot disabled" };
  }

  // 2. Compute signature.
  const signature = computeSignature(state, plan, latestSeq);

  // 3. No actionable action.
  if (!plan.topAction || plan.topAction.disposition !== "act") {
    return { run: false, signature, reason: "nothing to act on (" + (plan.topAction ? plan.topAction.kind : "no action") + ")" };
  }

  // 4. Dedup: same state already acted on.
  if (guard.lastActedSignature === signature) {
    return { run: false, signature, reason: "already acted on this state" };
  }

  // 5. Cooldown.
  const cooldownMs = config.autopilot.cooldownMs ?? 300000;
  if (guard.lastActedAt !== null && now - guard.lastActedAt < cooldownMs) {
    const remaining = cooldownMs - (now - guard.lastActedAt);
    return { run: false, signature, reason: "cooldown (" + remaining + "ms remaining)" };
  }

  // 6. Go.
  return { run: true, signature, reason: "act: " + plan.topAction.kind };
}
