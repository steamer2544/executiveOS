// MockInferer — deterministic, offline, no network.
// Keyword-scans recent context to guess block/deadline. Used by tests and by
// config.worker.backend === "mock".

import type { Inferer, InferenceGuesses } from "./types.js";
import type { Context } from "../state/types.js";

const BLOCK_HINTS = ["wait", "waiting", "blocked", "stuck", "cannot", "can't", "pending", "need ", "needs ", "todo", "fixme"];
const DEADLINE_HINTS = ["deadline", "due", "ship", "release", "by friday", "by monday", "eod", "by end of"];

/** Gather searchable text from the context (summary + event data + commit subjects). */
function haystack(context: Context): string {
  const parts: string[] = [context.summary];
  for (const e of context.recentEvents) {
    parts.push(e.type);
    for (const v of Object.values(e.data ?? {})) {
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join(" \n ").toLowerCase();
}

export class MockInferer implements Inferer {
  readonly name = "mock";

  async infer(context: Context): Promise<InferenceGuesses> {
    const text = haystack(context);
    const blockHit = BLOCK_HINTS.find((h) => text.includes(h));
    const deadlineHit = DEADLINE_HINTS.find((h) => text.includes(h));
    return {
      block: blockHit
        ? { likely: true, reason: 'recent activity mentions "' + blockHit.trim() + '"' }
        : { likely: false, reason: "" },
      deadline: deadlineHit
        ? { likely: true, date: null, note: 'recent activity mentions "' + deadlineHit.trim() + '"' }
        : { likely: false, date: null, note: "" },
      raw: "[mock] block=" + Boolean(blockHit) + " deadline=" + Boolean(deadlineHit),
    };
  }
}
