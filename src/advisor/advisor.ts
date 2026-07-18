// Advisor orchestrator (Phase 22).
// Generates proposals into the queue, and applies the owner's approve/reject.
// PROPOSES ONLY — approving records the decision (and logs it); it never performs
// irreversible real-world actions on its own.

import type { Context } from "../state/types.js";
import type { Advisor, AdvisorOptions, Proposal } from "./types.js";
import { createAdvisor } from "./factory.js";
import { readStore, writeStore, addDrafts, decide, pendingTitles } from "./store.js";
import { appendNotifications } from "../report/notify.js";

export interface AdvisorRunResult {
  added: Proposal[];
  backend: string;
  error: string | null;
}

/**
 * Run the Advisor over context: generate drafts, append fresh ones to the queue.
 * Never throws — an Advisor error yields a result with `error` set and nothing added.
 */
export async function runAdvisor(context: Context, opts: AdvisorOptions): Promise<AdvisorRunResult> {
  const advisor: Advisor = opts.advisorOverride ?? createAdvisor(opts.config);
  const maxOpen = opts.config.advisor?.maxOpen ?? 8;
  const store = readStore();
  try {
    const drafts = await advisor.propose(context, pendingTitles(store));
    const added = addDrafts(store, drafts, advisor.name, maxOpen);
    if (added.length > 0) writeStore(store);
    return { added, backend: advisor.name, error: null };
  } catch (err) {
    return { added: [], backend: advisor.name, error: (err as Error).message };
  }
}

/**
 * Apply the owner's decision to a queued proposal.
 * On approve, append a durable notification so the decision is never lost.
 * Returns the updated Proposal, or null if the id is unknown.
 */
export function decideProposal(
  id: string,
  decision: "approve" | "reject",
  edits?: { action?: string; note?: string }
): Proposal | null {
  const store = readStore();
  const p = decide(store, id, decision, edits);
  if (!p) return null;
  writeStore(store);
  if (decision === "approve") {
    appendNotifications([
      {
        ts: p.decidedAt ?? new Date().toISOString(),
        event: "added",
        source: "worker",
        summary: "Approved: " + p.title,
        detail: (p.note ? p.note + " — " : "") + p.action,
      },
    ]);
  }
  return p;
}
