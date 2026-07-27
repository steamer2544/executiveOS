// Types for the Digest / Report layer (Phase 11).
// The Digest reads existing .executive/ artifacts and renders one concise,
// human-readable Markdown summary — "here's where things stand, here's what
// the Planner recommends, here's what the Autopilot last did, and here's
// exactly what needs YOU."

/**
 * One item the human must decide/act on.
 *
 * `summary` and `label` are NOT interchangeable — see the note above `needsYouLabel`
 * in digest.ts. `summary` is the stable dedup KEY (repeat-suppression, needsYouSignature,
 * notify.ts); `label` is the sentence a human or a model may read.
 */
export interface NeedsYouItem {
  source: "plan" | "autopilot" | "executor" | "worker"; // where it came from
  summary: string;   // the KEY — stable forever, may contain internal identifiers
  detail?: string;   // optional extra context (reason, branch, etc.)
  /** The owner-facing sentence. Set at construction; render sites must use it (via needsYouLabel). */
  label?: string;
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
    repos: Array<{ name: string; branch: string | null }>; // watched repos (from git watcher)
    activeRepo: string | null;       // the currently active repo name
    currentWindow: { title: string; app: string } | null; // active foreground window (from screen watcher)
    /** Human-readable working-pattern line, or null when there is nothing to say. */
    workingPattern: string | null;
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

  /** LLM guesses to confirm (from .executive/inferred.json), shown only when they add info.
   *  Empty unless the infer feature ran and produced a novel, actionable suggestion. */
  suggestions: Suggestion[];
}

/** An LLM guess the owner can confirm with one click. `emit` is exactly what confirming sends. */
export interface Suggestion {
  kind: "block" | "deadline" | "task";
  text: string; // human-readable line
  emit: { type: string; data: Record<string, unknown> };
}

export interface DigestOptions {
  now?: string; // ISO override for deterministic tests; default new Date().toISOString()
}
