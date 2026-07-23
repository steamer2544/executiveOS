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
 * The most recent nudge that has been sent but not yet answered, or null.
 * Pure — derived from the log so it survives a restart and is the same answer in
 * every process (the daemon nudges; the dashboard may be where the owner replies).
 */
export function openNudgeId(history: NudgeRecord[]): string | null {
  const answered = new Set(history.filter((r) => r.event === "answered").map((r) => r.id));
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]!;
    if (r.event === "sent" && !answered.has(r.id)) return r.id;
  }
  return null;
}

/**
 * Call when the owner sends ANY message (Discord or dashboard): it closes the loop on
 * the open nudge. Sent-vs-answered per source is the whole point of the log — it is
 * the evidence for whether the rules are interrupting at good moments.
 *
 * No-op when nothing is open. Never throws.
 */
export function markNudgeAnswered(): void {
  const id = openNudgeId(readNudgeRecords());
  if (!id) return;
  appendNudgeRecords([{ event: "answered", id, ts: new Date().toISOString() }]);
}
