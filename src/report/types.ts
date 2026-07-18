// Types for the Digest / Report layer (Phase 11).
// The Digest reads existing .executive/ artifacts and renders one concise,
// human-readable Markdown summary — "here's where things stand, here's what
// the Planner recommends, here's what the Autopilot last did, and here's
// exactly what needs YOU."

/** One item the human must decide/act on. */
export interface NeedsYouItem {
  source: "plan" | "autopilot" | "executor" | "worker"; // where it came from
  summary: string;   // one-line, human-readable
  detail?: string;   // optional extra context (reason, branch, etc.)
}

/**
 * A structured, deterministic snapshot for rendering. Every section is optional/nullable
 * so a fresh repo (no artifacts yet) still produces a valid Digest.
 */
export interface Digest {
  generatedAt: string;               // ISO — when the digest was built

  now: {
    available: boolean;              // false when state.json missing/unreadable
    project: string | null;
    task: string | null;
    deadline: string | null;
    currentFile: string | null;
    tests: "passing" | "failing" | "unknown" | null;
    blocked: boolean | null;
    blockedReason: string | null;
    branch: string | null;
    idle: boolean | null;            // true when activity.active === false
    stateGeneratedAt: string | null; // provenance/staleness
  };

  recommended: {
    available: boolean;              // false when plan.json missing/unreadable
    topActionKind: string | null;
    disposition: "act" | "ask" | null;
    reason: string | null;
    confidence: number | null;
    actionCount: number;             // plan.actions.length (0 when unavailable)
  };

  lastAutopilot: {
    available: boolean;              // false when auto-report.json missing/unreadable
    stage: string | null;
    ok: boolean | null;
    applied: boolean | null;
    branch: string | null;
    commitSha: string | null;
    testPassed: boolean | null;
    needsHuman: boolean | null;
    stoppedReason: string | null;
    generatedAt: string | null;
  };

  needsYou: NeedsYouItem[];          // aggregated across sources; [] when nothing pending
}

export interface DigestOptions {
  now?: string; // ISO override for deterministic tests; default new Date().toISOString()
}
