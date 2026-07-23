// Types for the Planner (Phase 4).
// The Planner is a 100% rule-based engine that reads State and proposes actions.
// It never executes anything — only writes plan.json.

/** The finite, stable set of actions the rule engine can propose. */
export type ActionKind =
  // Phase 4 — something is broken.
  | "fix_tests"        // tests are failing → fix them
  | "resolve_block"    // work is blocked → surface / resolve the blocker
  | "review_deadline"  // a deadline exists → review progress against it
  | "resume_task"      // idle mid-task → nudge back to the current task
  // Phase 33 — nothing is broken, but the working pattern says something.
  | "checkpoint_work"  // many edits riding on an old commit → checkpoint
  | "grinding_on_file" // the same file saved over and over → possibly stuck
  | "long_session";    // a long unbroken run at the machine → step away

/** Whether the Planner considers this safe to do autonomously, or must ask first. */
export type Disposition = "act" | "ask";

export interface ProposedAction {
  kind: ActionKind;
  reason: string;         // human-readable, references the State field that fired it
  priority: number;       // higher = more urgent
  confidence: number;     // 0..1 — how sure the rule is this is the right call
  forbidden: boolean;     // true if it touches a guardrail category → always "ask"
  disposition?: Disposition; // set by applyGuardrail — rules do NOT set this
}

export interface Plan {
  generatedAt: string;    // ISO, when this plan was built (from State.generatedAt)
  basedOnState: {         // provenance link back to the snapshot this was derived from
    generatedAt: string;
    eventCount: number;
  };
  topAction: ProposedAction | null;  // highest-priority action, or null if none fired
  actions: ProposedAction[];         // ALL fired actions, sorted priority DESC (then rule order)
  summary: string;                   // one-line human-readable rollup
}

/** Guardrail: only propose autonomous action when strictly above 95% confidence. */
export const CONFIDENCE_THRESHOLD = 0.95;
