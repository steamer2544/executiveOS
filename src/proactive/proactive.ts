// Proactive tick runner (Phase 36).
//
// Glues the rules, compose, and log modules together, calling a Channel to
// deliver the nudge. This is the entry point the daemon calls each tick.
//
// Flow:
// 1. decideNudge — rules pick the moment
// 2. composeNudge — LLM writes the sentence
// 3. appendMessage — same conversation as dashboard
// 4. channel.send — deliver
// 5. log the result

import type { Channel } from "../channel/types.js";
import type { NeedsYouItem } from "../report/types.js";
import type { Config } from "../config.js";
import type { ChatBackend } from "../agent/types.js";
import type { Nudge, NudgeRecord, ProactiveState } from "./types.js";
import { decideNudge } from "./rules.js";
import { composeNudge } from "./compose.js";
import { appendNudgeRecords, readNudgeRecords } from "./log.js";
import { appendMessage } from "../agent/session.js";

export interface ProactiveTickOptions {
  added: NeedsYouItem[]; // from DigestTickResult.added
  state: ProactiveState; // advanced in place
  channel: Channel;
  config: Config;
  now?: Date; // default new Date(), injected in tests
  /** Injected backend factory for testing; defaults to createChatBackend. */
  backendFactory?: (cfg: Config) => ChatBackend;
}

export interface ProactiveTickResult {
  sent: { id: string; text: string; composedBy: "llm" | "fallback" } | null;
  /** Why nothing was sent. null when something was. */
  skipped: string | null;
}

/** Reasons that recur every tick — logging them would flood nudges.jsonl for no signal. */
const NON_LOGGED_REASONS = new Set(["disabled", "first tick", "nothing new"]);

/**
 * Run one proactive tick.
 *
 * Returns { sent } on success, { skipped } when nothing was sent.
 * Advances state in place.
 */
export async function runProactiveTick(
  opts: ProactiveTickOptions
): Promise<ProactiveTickResult> {
  const now = opts.now ?? new Date();

  // Read history from the nudge log
  const history = readNudgeRecords();

  // Convert added items to Nudge shape
  const added: Nudge[] = opts.added.map((item) => ({
    key: item.source + "|" + item.summary,
    source: item.source,
    summary: item.summary,
    detail: item.detail,
    label: item.label,
  }));

  // Build the decision input
  const decision = decideNudge({
    added,
    state: opts.state,
    now,
    history,
    config: {
      enabled: opts.config.agent?.proactive?.enabled ?? false,
      maxPerDay: opts.config.agent?.proactive?.maxPerDay ?? 6,
      minGapMs: opts.config.agent?.proactive?.minGapMs ?? 1800000,
      quietFrom: opts.config.agent?.proactive?.quietFrom ?? "22:00",
      quietTo: opts.config.agent?.proactive?.quietTo ?? "08:00",
    },
  });

  // No nudge decided.
  if (!decision.nudge) {
    // Log the suppression only when something WAS eligible but a budget/quiet/gap/
    // repeat rule held it back — that is the interesting signal. "disabled",
    // "first tick" and "nothing new" fire every 30s and would flood the log.
    if (!NON_LOGGED_REASONS.has(decision.reason)) {
      // The suppressed item is the first of `added` — the one a nudge would have
      // been about. Keying it lets "how often is X held back" be answered later.
      const key = added.length > 0 ? added[0]!.key : "";
      appendNudgeRecords([{ event: "suppressed", ts: now.toISOString(), key, reason: decision.reason }]);
    }

    opts.state.firstTickDone = true;
    return { sent: null, skipped: decision.reason };
  }

  // Compose the nudge sentence
  const composed = await composeNudge(decision.nudge, opts.config, opts.backendFactory);

  // Append the nudge to the conversation as an assistant message
  // (makes it one conversation: dashboard and Discord share the same transcript)
  appendMessage({ role: "assistant", text: composed.text });

  // Send via the channel
  const sendResult = await opts.channel.send({ text: composed.text });

  if (!sendResult.ok) {
    // Not delivered — do NOT spend the daily budget
    return { sent: null, skipped: `channel: ${sendResult.error ?? "unknown"}` };
  }

  // Success — log it and advance state
  const id = crypto.randomUUID();
  appendNudgeRecords([
    {
      event: "sent",
      id,
      ts: now.toISOString(),
      key: decision.nudge.key,
      source: decision.nudge.source,
      summary: decision.nudge.summary,
      text: composed.text,
      composedBy: composed.composedBy,
    },
  ]);

  opts.state.lastSentAt = now.getTime();
  opts.state.firstTickDone = true;

  return {
    sent: { id, text: composed.text, composedBy: composed.composedBy },
    skipped: null,
  };
}

/**
 * A reply only counts as answering a nudge if it arrives within this window.
 *
 * Measured from the real log: observed latencies were 51 s, 2.4 min, 8 min, 43 min and 1 h 55 min —
 * the last two are the owner happening to chat later, not a reply.
 *
 * This is still a PROXY: it counts "the owner sent any message soon after", not "the owner replied
 * to this". The unambiguous signal exists — Discord's `message_reference` on a real reply — but the
 * adapter drops it (`handleMessageCreate` keeps only `content`) and `Channel.send` does not return
 * the message id, so pairing would need both. Read the ratio with that caveat.
 *
 * A constant, not config — consistent with Phase 39's BLOCKED_TTL_MS / MANUAL_TASK_TTL_MS.
 */
export const ANSWER_WINDOW_MS = 30 * 60 * 1000;

/**
 * Every nudge that has been sent and not yet closed, oldest→newest.
 * Pure — derived from the log so it survives a restart and is the same answer in
 * every process (the daemon nudges; the dashboard may be where the owner replies).
 */
export function openNudges(history: NudgeRecord[]): Array<{ id: string; ts: string }> {
  const closed = new Set(
    history
      .filter((r) => r.event === "answered" || r.event === "expired")
      .map((r) => r.id)
  );
  return history
    .filter((r): r is Extract<NudgeRecord, { event: "sent" }> => r.event === "sent" && !closed.has(r.id))
    .map((r) => ({ id: r.id, ts: r.ts }));
}

/**
 * The most recent nudge that has been sent but not yet answered (or expired), or null.
 */
export function openNudgeId(history: NudgeRecord[]): string | null {
  const open = openNudges(history);
  return open.length > 0 ? open[open.length - 1]!.id : null;
}

/**
 * Call when the owner sends ANY message (Discord or dashboard): it closes the loop on
 * the open nudge. Sent-vs-answered per source is the whole point of the log — it is
 * the evidence for whether the rules are interrupting at good moments.
 *
 * ONE message closes EVERY open nudge, and can answer at most one of them:
 *   - the newest open nudge, if it is within ANSWER_WINDOW_MS → { "answered", latencyMs }
 *   - every other open nudge, and the newest one when it is older → { "expired", ageMs }
 *
 * Closing all of them is what makes the log readable. Before, only the newest was closed, so a
 * nudge the owner simply ignored kept NO record at all until they happened to send another N
 * messages — and `answered / (answered + expired)` read 100% while half the nudges were ignored,
 * which is the exact overcount this signal exists to stop. Now `answered + expired == sent` for
 * everything the owner has seen, so the ratio is a count, not a join.
 *
 * At most one `answered` per message also removes the hidden dependency on `minGapMs >= 30 min`:
 * two nudges live inside one window can no longer both be booked as replies.
 *
 * No-op when nothing is open. Never throws.
 */
export function markNudgeAnswered(now?: Date): void {
  const now_ = now ?? new Date();

  // Read the log ONCE. Two reads would let the file change between them, and this runs on
  // every owner message in both the daemon and the dashboard.
  const history = readNudgeRecords();
  const open = openNudges(history);
  if (open.length === 0) return;

  const records: NudgeRecord[] = [];
  const newestIndex = open.length - 1;

  open.forEach((nudge, i) => {
    const parsed = nudge.ts ? new Date(nudge.ts).getTime() : NaN;
    // Unparseable/missing ts → we do not know the age. Record the fact (this message did
    // reach it) but never invent a number: `latencyMs` is optional precisely so a record can
    // say "answered, age unknown" instead of the flattering "answered in 0 ms".
    const elapsed = isNaN(parsed) ? null : Math.max(0, now_.getTime() - parsed);

    const answerable = i === newestIndex && (elapsed === null || elapsed <= ANSWER_WINDOW_MS);
    if (answerable) {
      records.push(
        elapsed === null
          ? { event: "answered", id: nudge.id, ts: now_.toISOString() }
          : { event: "answered", id: nudge.id, ts: now_.toISOString(), latencyMs: elapsed }
      );
    } else {
      records.push({ event: "expired", id: nudge.id, ts: now_.toISOString(), ageMs: elapsed ?? 0 });
    }
  });

  appendNudgeRecords(records);
}
