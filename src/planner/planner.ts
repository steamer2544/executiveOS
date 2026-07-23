// Planner engine (Phase 4).
// Reads State, applies rules, writes plan.json.
// 100% deterministic — same State in → same Plan out.
//
// Architectural note: plan() reads ONLY State (and optionally Context for provenance).
// It does NOT import the event store, read(), tail(), or any raw JSONL logs.
// This is the contract that lets new watchers be added without touching Phase 4.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { randomUUID } from "node:crypto";
import type { State, Context } from "../state/types.js";
import { planPath } from "../paths.js";
import { RULES } from "./rules.js";
import type { Plan, ProposedAction } from "./types.js";
import { CONFIDENCE_THRESHOLD } from "./types.js";

// ─── Guardrail ────────────────────────────────────────────────────────────────

/**
 * Set disposition on an action via the single guardrail rule:
 *   disposition = (!forbidden && confidence > CONFIDENCE_THRESHOLD) ? "act" : "ask"
 *
 * This is the ONLY place disposition is decided. Rules return actions with
 * forbidden set, but never disposition — the guardrail can never be bypassed.
 */
export function applyGuardrail(action: ProposedAction): ProposedAction {
  return {
    ...action,
    disposition: !action.forbidden && action.confidence > CONFIDENCE_THRESHOLD ? "act" : "ask",
  };
}

// ─── plan() ───────────────────────────────────────────────────────────────────

/**
 * Build a Plan from State (and optionally Context).
 * Pure function: no I/O, no clock, no randomness.
 */
export function plan(state: State, _context?: Context): Plan {
  // 1. Run every rule, collect non-null actions.
  const raw: ProposedAction[] = [];
  for (const rule of RULES) {
    const a = rule(state);
    if (a) raw.push(a);
  }

  // 2. Run each through the guardrail to set disposition.
  const actions = raw.map(applyGuardrail);

  // 3. Sort by priority DESC; ties keep rule order (stable).
  actions.sort((a, b) => b.priority - a.priority);

  // 4–6. Assemble Plan.
  const topAction = actions.length > 0 ? actions[0]! : null;
  return {
    generatedAt: state.generatedAt,
    basedOnState: {
      generatedAt: state.generatedAt,
      eventCount: state.eventCount,
    },
    topAction,
    actions,
    summary: buildSummary(actions),
  };
}

/** Build the one-line summary from a Plan's actions. */
function buildSummary(actions: ProposedAction[]): string {
  if (actions.length === 0) return "No action needed.";
  const top = actions[0]!;
  return `Top: ${top.kind} (${top.disposition}, p${top.priority}) — ${top.reason}`;
}

// ─── writePlan() ──────────────────────────────────────────────────────────────

/**
 * Atomically write plan.json to .executive/.
 * Writes to temp file then renames (same pattern as writeState).
 */
export function writePlan(p: Plan): void {
  const root = planPath().substring(0, planPath().lastIndexOf("/"));
  if (root && !existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const tmpPath = planPath() + "." + randomUUID();
  writeFileSync(tmpPath, JSON.stringify(p, null, 2) + "\n");
  renameOverwrite(tmpPath, planPath());
}
