// Types for the Advisor (Phase 22) — a proactive proposal queue.
// The Advisor PROPOSES small, reversible actions (work + life) for the owner to
// approve or reject. It never acts on its own; approval is always a human click.

import type { Context } from "../state/types.js";
import type { Config } from "../config.js";

export type ProposalStatus = "pending" | "approved" | "rejected";

/** One proposal in the owner's decision queue. */
export interface Proposal {
  id: string;
  createdAt: string;      // ISO
  category: string;       // "work" | "health" | "admin" | "learning" | "rest" | "personal" | ...
  title: string;          // short headline
  detail: string;         // why / what it involves
  action: string;         // one concrete next step (editable before approving)
  status: ProposalStatus;
  note?: string;          // the owner's optional addition at decision time
  decidedAt?: string;     // ISO, set when approved/rejected
  backend?: string;       // which Advisor produced it
}

/** Raw Advisor output before it becomes a queued Proposal. */
export interface ProposalDraft {
  category: string;
  title: string;
  detail: string;
  action: string;
}

/** Persisted queue (.executive/advisor.json). */
export interface AdvisorStore {
  items: Proposal[];
}

/** Generates fresh proposal drafts from context. mock (offline) | anthropic (HTTP). */
export interface Advisor {
  readonly name: string;
  /** `openTitles` are titles already pending, so the Advisor can avoid repeats. */
  propose(context: Context, openTitles: string[]): Promise<ProposalDraft[]>;
}

export interface AdvisorOptions {
  config: Config;
  advisorOverride?: Advisor; // tests inject; production passes nothing
}
