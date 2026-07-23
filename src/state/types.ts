// Types for the State Builder (Phase 3).
// State = compact current snapshot derived from events.
// Context = State + recent events + one-line summary.

import type { Patterns } from "./patterns.js";
export type { Patterns } from "./patterns.js";

/** Metadata about the latest git commit. */
export interface CommitInfo {
  sha: string;
  subject: string;
  ts: string; // ISO timestamp of the git.commit event
}

/**
 * Compact current snapshot derived from event history.
 * Every field is a pure function of the event log — no randomness, no LLM.
 */
export interface State {
  /** ISO timestamp when this snapshot was built. */
  generatedAt: string;
  /** Total events across all sources. */
  eventCount: number;
  /** ISO timestamp of the newest event, or null if none. */
  lastEventTs: string | null;

  // ── Project / task (from system.task events) ───────────────────────────
  currentProject: string | null;
  currentTask: string | null;
  deadline: string | null;

  // ── Editor (from editor.save events) ───────────────────────────────────
  currentFile: string | null;
  recentFiles: string[]; // up to 5 distinct paths, newest first

  // ── Git (from git.commit / git.branch_switch events) ───────────────────
  git: {
    branch: string | null;
    lastCommit: CommitInfo | null;
  };

  // ── Multi-repo (from repo-tagged git / editor events) ──────────────────
  activeRepo: string | null;
  repos: Array<{
    name: string;
    branch: string | null;
    lastCommit: { sha: string; subject: string; ts: string } | null;
    lastActivityTs: string | null;
  }>;

  // ── Screen (from screen.window events) ─────────────────────────────────
  currentWindow: { title: string; app: string } | null;

  // ── Health signals (from system.* events) ──────────────────────────────
  tests: "passing" | "failing" | "unknown";
  blocked: boolean;
  blockedReason: string | null;

  // ── Activity (derived from lastEventTs + now) ──────────────────────────
  activity: {
    active: boolean; // true if lastEventTs within idleThresholdMs of now
    idleMs: number | null; // now - lastEventTs in ms, or null if no events
  };

  /** Behavioural metrics over event history — how the owner has been working, not
   *  just what is currently broken. Lets the Planner fire on patterns while still
   *  reading State only. See src/state/patterns.ts. */
  patterns: Patterns;
}

/**
 * Full context for a future reasoning step (Phase 4 Planner).
 * Embeds the State plus recent event history.
 */
export interface Context {
  /** ISO timestamp when this context was built. */
  generatedAt: string;
  /** One-line human-readable rollup derived from State. */
  summary: string;
  /** The full snapshot embedded. */
  state: State;
  /** Last N events across all sources, seq-ascending. */
  recentEvents: Array<{
    seq: number;
    ts: string;
    source: string;
    type: string;
    data: Record<string, unknown>;
  }>;
}

/** Milliseconds before a user is considered idle (5 min). */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** Number of recent events to keep in Context. */
export const RECENT_EVENTS = 20;
