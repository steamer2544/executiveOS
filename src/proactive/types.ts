// Types for the proactive nudge engine (Phase 36).
//
// The proactive engine decides whether a new "Needs you" item is worth interrupting
// the owner for, and if so, composes a one-or-two sentence nudge that reaches them
// over any channel (Discord, dashboard, etc.).
//
// State is carried across ticks by the caller (just like DigestTickState).
// This module owns the types and the state factory.

import type { NeedsYouItem } from "../report/types.js";

/** One thing worth interrupting the owner for. */
export interface Nudge {
  /** Stable dedup key. `${source}|${summary}` — the same keying notify.ts uses. */
  key: string;
  source: NeedsYouItem["source"];
  summary: string;
  detail?: string;
}

/** One line in .executive/nudges.jsonl. Append-only; never rewritten in place. */
export type NudgeRecord =
  | { event: "sent"; id: string; ts: string; key: string; source: string; summary: string; text: string; composedBy: "llm" | "fallback" }
  | { event: "answered"; id: string; ts: string; latencyMs?: number }
  | { event: "expired"; id: string; ts: string; ageMs: number }
  | { event: "suppressed"; ts: string; key: string; reason: string };

/**
 * Carried by the caller across ticks (like DigestTickState).
 *
 * Deliberately does NOT hold "which nudge is awaiting a reply". That has to survive a
 * restart and be visible to the dashboard process as well as the daemon, so it is
 * derived from the log instead (see `openNudgeId`). A field here would have been
 * silently lost on every restart — and the sent-vs-answered ratio is the only
 * evidence we will have for whether the rules pick good moments.
 */
export interface ProactiveState {
  /** false = this process has never ticked. The first tick NEVER nudges (see rules.ts). */
  firstTickDone: boolean;
  /** ms epoch of the last nudge actually sent, or null. */
  lastSentAt: number | null;
}

/** Result of composing a nudge sentence. */
export interface ComposedNudge {
  text: string;
  composedBy: "llm" | "fallback";
}

export function createProactiveState(): ProactiveState {
  return { firstTickDone: false, lastSentAt: null };
}
