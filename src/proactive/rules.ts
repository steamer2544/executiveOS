// Pure nudge decision rules (Phase 36).
//
// No I/O, no Date.now(), no network. Everything is injected from the caller.
// This is the judgment layer — the LLM only writes the sentence; the rules pick
// the moment.
//
// Rules are evaluated in order; the first that applies wins.

import type { Nudge, NudgeRecord, ProactiveState } from "./types.js";

export interface NudgeDecisionInput {
  /** Items that ENTERED the needs-you queue this tick (DigestTickResult.added). */
  added: Nudge[];
  state: ProactiveState;
  /** Wall-clock, injected — the rules must be testable without mocking time. */
  now: Date;
  /** Records already in nudges.jsonl, oldest→newest. */
  history: NudgeRecord[];
  config: {
    enabled: boolean;
    maxPerDay: number;
    minGapMs: number;
    quietFrom: string; // "HH:MM"
    quietTo: string;   // "HH:MM"
  };
}

export type NudgeDecision =
  | { nudge: Nudge }
  | { nudge: null; reason: string };

/**
 * Decide whether to nudge for the given input.
 *
 * Evaluate rules in order, returning the first that applies:
 * 1. !config.enabled → "disabled"
 * 2. !firstTickDone → "first tick"
 * 3. added.length === 0 → "nothing new"
 * 4. quiet hours overlap → "quiet hours"
 * 5. min gap not met → "min gap"
 * 6. daily budget spent → "daily budget spent (N)"
 * 7. all candidates are repeats → "already nudged"
 * 8. otherwise → send the first non-repeat candidate
 */
export function decideNudge(input: NudgeDecisionInput): NudgeDecision {
  // 1. Disabled
  if (!input.config.enabled) {
    return { nudge: null, reason: "disabled" };
  }

  // 2. First tick guard
  if (!input.state.firstTickDone) {
    return { nudge: null, reason: "first tick" };
  }

  // 3. Nothing new
  if (input.added.length === 0) {
    return { nudge: null, reason: "nothing new" };
  }

  // 4. Quiet hours
  if (inQuietHours(input.now, input.config.quietFrom, input.config.quietTo)) {
    return { nudge: null, reason: "quiet hours" };
  }

  // 5. Min gap
  if (
    input.state.lastSentAt !== null &&
    input.now.getTime() - input.state.lastSentAt < input.config.minGapMs
  ) {
    return { nudge: null, reason: "min gap" };
  }

  // 6. Daily budget
  const todayCount = sentToday(input.history, input.now);
  if (todayCount >= input.config.maxPerDay) {
    return { nudge: null, reason: `daily budget spent (${todayCount})` };
  }

  // 7. Repeat suppression — find the first item whose key has no "sent" record in last 24h
  const cutoff = input.now.getTime() - 24 * 60 * 60 * 1000;
  let candidate: Nudge | null = null;
  for (const item of input.added) {
    const hasRecentSent = input.history.some(
      (r) =>
        r.event === "sent" &&
        r.key === item.key &&
        new Date(r.ts).getTime() >= cutoff
    );
    if (!hasRecentSent) {
      candidate = item;
      break;
    }
  }

  if (candidate === null) {
    return { nudge: null, reason: "already nudged" };
  }

  // 8. Send
  return { nudge: candidate };
}

/**
 * Check if `now` falls inside the quiet hours window [from, to).
 *
 * The window wraps midnight. If from === to, quiet hours are off.
 *
 * Examples:
 *   "22:00"–"08:00" → quiet at 23:30, quiet at 02:00, not quiet at 12:00
 *   "09:00"–"17:00" → quiet at 12:00, not quiet at 23:00
 *   "09:00"–"09:00" → always off
 */
export function inQuietHours(now: Date, from: string, to: string): boolean {
  if (from === to) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const fromMinutes = toMinutes(from);
  const toMin = toMinutes(to);

  if (fromMinutes < toMin) {
    // Normal window (e.g. 09:00–17:00)
    return nowMinutes >= fromMinutes && nowMinutes < toMin;
  }

  // Wraps midnight (e.g. 22:00–08:00)
  return nowMinutes >= fromMinutes || nowMinutes < toMin;
}

/** "HH:MM" → minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

/**
 * Count `event: "sent"` records in `history` whose ts falls on the same
 * local calendar day as `now`. Ignores "answered" and "suppressed" records.
 */
export function sentToday(history: NudgeRecord[], now: Date): number {
  const dayStart = startOfDay(now);
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;

  return history.filter(
    (r) =>
      r.event === "sent" &&
      r.ts !== undefined &&
      new Date(r.ts).getTime() >= dayStart.getTime() &&
      new Date(r.ts).getTime() < dayEnd
  ).length;
}

/**
 * Get the start of the local calendar day for `d`.
 * This is a local-day computation — no timezone conversion.
 */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
