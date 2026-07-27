// Compose the nudge sentence via LLM, with a deterministic fallback (Phase 36).
//
// The LLM writes the sentence; rules pick the moment. If the LLM is unreachable,
// a deterministic fallback ensures the nudge still fires — the gateway goes down
// regularly, and a nudge that doesn't fire because the LLM was unreachable is the
// very failure this phase exists to fix.
//
// composeNudge NEVER throws.

import type { Config } from "../config.js";
import type { Nudge, ComposedNudge } from "./types.js";
import type { ChatBackend } from "../agent/types.js";
import { createChatBackend } from "../agent/protocol.js";

/**
 * Compose a nudge sentence for the given nudge item.
 *
 * Uses createChatBackend with tools: [] — this is writing a sentence,
 * not doing work. Transcript: a single { kind: "user", text: <prompt> }.
 *
 * Falls back to a deterministic sentence if the LLM throws, times out,
 * or returns empty text.
 *
 * @param backendFactory — injectable; defaults to createChatBackend(config).
 */
export async function composeNudge(
  nudge: Nudge,
  config: Config,
  backendFactory?: (cfg: Config) => ChatBackend
): Promise<ComposedNudge> {
  const factory = backendFactory ?? createChatBackend;
  try {
    const backend = factory(config);
    const prompt = buildPrompt(nudge);

    const step = await backend.step({
      system: "",
      transcript: [{ kind: "user", text: prompt }],
      tools: [],
    });

    const text = step.text?.trim();
    if (!text) {
      // Empty response → fallback
      return { text: deterministicFallback(nudge), composedBy: "fallback" };
    }

    return { text, composedBy: "llm" };
  } catch {
    // Any error (network, timeout, parse) → fallback
    return { text: deterministicFallback(nudge), composedBy: "fallback" };
  }
}

/**
 * Build the one-shot prompt for the LLM.
 *
 * Leads with the human-meaningful subject (detail when present, else summary).
 * Never sends internal identifiers (summary) when a human detail exists.
 */
function buildPrompt(nudge: Nudge): string {
  // The subject is the ONLY payload. `summary` is deliberately never sent when a detail
  // exists — measured live, the model echoed the internal label back to the owner in 2 of
  // 4 nudges ("คุณต้องโทรหา Planner สำหรับ long_session"), reading "needs your call" as a
  // telephone call. nudgeSubject already falls back to summary when there is no detail, so
  // nothing is lost for the autopilot/executor/worker sources.
  return (
    `งานที่ต้องตัดสินใจ: ${nudgeSubject(nudge)}\n\n` +
    `เขียนข้อความแจ้งเตือน 1-2 ประโยคเป็นภาษาไทย:\n` +
    `- เขียนถึงเจ้าของโดยตรง (เรียก "คุณ", แทนตัวเองว่า "ผม")\n` +
    `- ending in a question they can answer with one line\n` +
    `- NO greetings, NO restating the whole state\n` +
    `- DO NOT invent anything not in the input above\n` +
    // Describe the CATEGORY, never an instance: naming the identifiers here would put those
    // exact strings back into the prompt, which is the bug this phase exists to fix.
    `- ห้ามใช้ชื่อภายในระบบ ชื่อโมดูล หรือชื่อกฎ (identifier แบบ snake_case) — เขียนด้วยภาษาคนธรรมดา\n` +
    `- Keep it short — the owner is reading on a dashboard or hearing it spoken`
  );
}

/**
 * The human-meaningful subject of a nudge.
 *
 * `summary` is an INTERNAL dedup key (e.g. "Planner needs your call: long_session") — it keys
 * suppression and notification dedup, so it must stay stable and must never be shown to the owner.
 * `detail` is the human sentence (PlannerAction.reason). Prefer it.
 */
export function nudgeSubject(nudge: Nudge): string {
  if (nudge.detail && nudge.detail.trim().length > 0) return nudge.detail.trim();
  if (nudge.summary && nudge.summary.trim().length > 0) return nudge.summary.trim();
  return "";
}

/**
 * Deterministic fallback text when the LLM is unreachable.
 * Not an error path — a requirement.
 */
function deterministicFallback(nudge: Nudge): string {
  return nudgeSubject(nudge);
}
