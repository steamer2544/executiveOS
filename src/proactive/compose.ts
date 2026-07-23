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
 * Gives the nudge summary + detail, a compact line of context from
 * buildState().state (currentTask, currentFile, branch), and asks for
 * one or two sentences in Thai, addressed to the owner, ending in a
 * question they can answer with one line.
 */
function buildPrompt(nudge: Nudge): string {
  const detailLine = nudge.detail ? `\n\nรายละเอียด: ${nudge.detail}` : "";

  return (
    `งานที่ต้องตัดสินใจ: ${nudge.summary}${detailLine}\n\n` +
    `เขียนข้อความแจ้งเตือน 1-2 ประโยคเป็นภาษาไทย:\n` +
    `- เขียนถึงเจ้าของโดยตรง (เรียก "คุณ", แทนตัวเองว่า "ผม")\n` +
    `- ending in a question they can answer with one line\n` +
    `- NO greetings, NO restating the whole state\n` +
    `- DO NOT invent anything not in the input above\n` +
    `- Keep it short — the owner is reading on a dashboard or hearing it spoken`
  );
}

/**
 * Deterministic fallback text when the LLM is unreachable.
 * Not an error path — a requirement.
 */
function deterministicFallback(nudge: Nudge): string {
  return `${nudge.summary}${nudge.detail ? " — " + nudge.detail : ""}`;
}
