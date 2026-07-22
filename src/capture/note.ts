// Quality gate for dictated notes (Phase 32).
//
// Speech-to-text emits something for almost any sound, so a live mic fills the event log
// with counting ("1 2 3 1 2 3 4"), single mumbled syllables, and mic-test fragments. Those
// notes then flow into the Advisor's context with the same weight as a real thought.
//
// Pure, deterministic, no LLM — a mechanical low-signal filter, deliberately permissive:
// it only drops what could not carry meaning. Applied to VOICE notes only; a typed
// `capture` is an intentional act and is always kept.

/** Letters only (marks/tones excluded) — the real information carriers in Thai and Latin. */
function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/** Fraction of distinct tokens; low means the utterance is a repeated chant. */
function tokenVariety(s: string): number {
  const tokens = s.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 0;
  return new Set(tokens.map((t) => t.toLowerCase())).size / tokens.length;
}

export interface NoteVerdict {
  keep: boolean;
  /** Present when keep === false — why it was dropped (for logging, never shown as an error). */
  reason?: string;
}

/** Minimum letters for an utterance to plausibly carry meaning. */
const MIN_LETTERS = 5;
/** Below this distinct-token fraction (over enough tokens) it is a chant, not a thought. */
const MIN_VARIETY = 0.34;
const VARIETY_MIN_TOKENS = 6;

export function judgeNote(raw: string): NoteVerdict {
  const msg = raw.trim();
  if (msg.length === 0) return { keep: false, reason: "empty" };
  if (letterCount(msg) < MIN_LETTERS) return { keep: false, reason: "too few letters" };
  const tokens = msg.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length >= VARIETY_MIN_TOKENS && tokenVariety(msg) < MIN_VARIETY) {
    return { keep: false, reason: "repetitive" };
  }
  return { keep: true };
}

/** Convenience predicate. */
export function isMeaningfulNote(raw: string): boolean {
  return judgeNote(raw).keep;
}
