// Behavioural pattern metrics (Phase 33, Job 2).
//
// The Planner reads State only — never the raw event logs (the Phase 4 contract that
// lets new watchers plug in without touching it). So the metrics that describe *how*
// the owner has been working, rather than what is currently broken, are derived here
// by the State Builder and exposed as State.patterns.
//
// Pure & deterministic: no I/O, no clock of its own, NO LLM.
//
// Every threshold that consumes these metrics was calibrated against the real
// 3,241-event log rather than guessed — see docs/scopes/phase-33-signal-to-judgment.md §3.2.
// Two candidate metrics (app switches, repo switches) were measured and found to be
// noise or absent; repoSwitches1h is kept for observability but drives no rule.

/** Minimal event shape these metrics need. */
export interface PatternEvent {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface Patterns {
  /** ms since the newest git.commit, or null when there has never been one. */
  msSinceLastCommit: number | null;
  /** editor.save events newer than the newest git.commit (0 when no commit exists). */
  editsSinceLastCommit: number;
  /** saves of the current file within the last 30 minutes. */
  sameFileSaves30m: number;
  /** length of the current continuous activity run; a gap >= SESSION_BREAK_MS starts a new run. */
  sessionMs: number | null;
  /** distinct repo changes among repo-tagged events in the last hour (observability only). */
  repoSwitches1h: number;
}

/**
 * A gap this long ends a working session. Calibrated: the p99 inter-event gap in the
 * real log is ~318s (5 min), so 15 min sits well outside normal working rhythm and
 * will not split a session just because the owner read something for a while.
 */
export const SESSION_BREAK_MS = 15 * 60 * 1000;

const THIRTY_MIN_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Parse an ISO timestamp to ms, or null when it is missing/unparseable. */
function tsMs(e: PatternEvent): number | null {
  const n = Date.parse(e.ts);
  return Number.isNaN(n) ? null : n;
}

export function emptyPatterns(): Patterns {
  return {
    msSinceLastCommit: null,
    editsSinceLastCommit: 0,
    sameFileSaves30m: 0,
    sessionMs: null,
    repoSwitches1h: 0,
  };
}

/**
 * Derive the pattern metrics.
 * @param events seq-ascending event list (as buildState already sorts them)
 * @param nowMs  the builder's clock, so the result stays a pure function of its inputs
 * @param currentFile State.currentFile, or null
 */
export function computePatterns(
  events: PatternEvent[],
  nowMs: number,
  currentFile: string | null
): Patterns {
  const out = emptyPatterns();
  if (events.length === 0) return out;

  // ── Commits: how much work is sitting uncommitted? ──────────────────────
  let lastCommitMs: number | null = null;
  for (const e of events) {
    if (e.type !== "git.commit") continue;
    const t = tsMs(e);
    if (t !== null) lastCommitMs = t; // seq-ascending, so the last one wins
  }
  if (lastCommitMs !== null) {
    out.msSinceLastCommit = Math.max(0, nowMs - lastCommitMs);
    for (const e of events) {
      if (e.type !== "editor.save") continue;
      const t = tsMs(e);
      if (t !== null && t > lastCommitMs) out.editsSinceLastCommit++;
    }
  }

  // ── Grinding: how many times has the current file been saved recently? ──
  if (currentFile !== null) {
    const since = nowMs - THIRTY_MIN_MS;
    for (const e of events) {
      if (e.type !== "editor.save") continue;
      if (e.data.path !== currentFile) continue;
      const t = tsMs(e);
      if (t !== null && t > since && t <= nowMs) out.sameFileSaves30m++;
    }
  }

  // ── Session: how long has this unbroken run of activity been going? ─────
  // Walk newest → oldest until a gap >= SESSION_BREAK_MS, then measure from there.
  const times: number[] = [];
  for (const e of events) {
    const t = tsMs(e);
    if (t !== null) times.push(t);
  }
  if (times.length > 0) {
    const last = times[times.length - 1]!;
    let start = last;
    for (let i = times.length - 1; i > 0; i--) {
      const gap = times[i]! - times[i - 1]!;
      if (gap >= SESSION_BREAK_MS) break;
      start = times[i - 1]!;
    }
    // If the owner has already been away longer than a break, the session is over.
    out.sessionMs = nowMs - last >= SESSION_BREAK_MS ? null : Math.max(0, last - start);
  }

  // ── Repo switches (observability only; no rule consumes this) ───────────
  const since = nowMs - ONE_HOUR_MS;
  let prevRepo: string | null = null;
  for (const e of events) {
    const repo = typeof e.data.repo === "string" ? e.data.repo : null;
    if (repo === null) continue;
    const t = tsMs(e);
    if (t === null || t <= since || t > nowMs) continue;
    if (prevRepo !== null && repo !== prevRepo) out.repoSwitches1h++;
    prevRepo = repo;
  }

  return out;
}
