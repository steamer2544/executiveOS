// Advisor orchestrator (Phase 22).
// Generates proposals into the queue, and applies the owner's approve/reject.
// PROPOSES ONLY — approving records the decision (and logs it); it never performs
// irreversible real-world actions on its own.

import type { Context } from "../state/types.js";
import type { Config } from "../config.js";
import type { Advisor, AdvisorOptions, Proposal, ProposalDraft } from "./types.js";
import { createAdvisor } from "./factory.js";
import { readStore, writeStore, addDrafts, decide, pendingTitles } from "./store.js";
import { appendNotifications } from "../report/notify.js";

export interface AdvisorRunResult {
  added: Proposal[];
  backend: string;
  error: string | null;
}

// ─── Code filter (Phase 27) ───────────────────────────────────────────────────

/**
 * Sensitive category keywords — if the draft's category (lowercased) matches any
 * of these, the draft MUST NOT be executable regardless of what the model says.
 */
const SENSITIVE_KEYWORDS = [
  "relationship", "relationships", "romance", "family", "friend",
  "moral", "morality", "ethic", "ethics",
  "spend", "spending", "money", "finance", "financial",
  "invest", "purchase", "buy",
  "goal", "life goal", "life-goal", "career-change",
];

/**
 * Pure, exported code filter. Runs on every draft when enqueuing, regardless of backend.
 * A jailbroken/confused model can never smuggle a sensitive task into the executable path.
 */
export function sanitizeExecutable(draft: ProposalDraft): { executable: boolean; repo?: string; files?: string[] } {
  const cat = (draft.category ?? "").toLowerCase();
  const sensitive = SENSITIVE_KEYWORDS.some((kw) => cat.includes(kw));
  const executable =
    draft.executable === true &&
    !sensitive &&
    // category is a work/code category (e.g. "work","code","dev","engineering","refactor","test","bug")
    /(^work$|^code$|^dev$|^engineering$|^refactor$|^test$|^bug$)/.test(cat) &&
    typeof draft.repo === "string" &&
    draft.repo.length > 0 &&
    typeof draft.action === "string" &&
    draft.action.length > 0;
  if (!executable) {
    return { executable: false };
  }
  return { executable: true, repo: draft.repo, files: draft.files };
}

// ─── Run / Decide ──────────────────────────────────────────────────────────────

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
 * If the proposal is executable, runs the Synth → Executor pipeline.
 * Returns the updated Proposal, or null if the id is unknown.
 */
export async function decideProposal(
  id: string,
  decision: "approve" | "reject",
  edits?: { action?: string; note?: string },
  config?: Config
): Promise<Proposal | null> {
  const store = readStore();
  const p = decide(store, id, decision, edits);
  if (!p) return null;
  writeStore(store);
  if (decision === "approve") {
    // Phase 27: if executable, run the Synth → Executor pipeline.
    if (p.executable === true) {
      const { executeProposal } = await import("./execute.js");
      const applyOnApprove = config?.advisor?.applyOnApprove === true;
      let execResult: Proposal["execution"];
      try {
        execResult = await executeProposal(p, config!, { apply: applyOnApprove });
      } catch (err) {
        execResult = {
          ran: true, applied: false, branch: null,
          changeSetWritten: false, valid: false, testPassed: null,
          message: "execution threw: " + (err as Error).message,
        };
      }
      p.execution = execResult;
      writeStore(store);
    }
    // Notification summary reflects the outcome.
    let summary: string;
    if (p.executable === true && p.execution) {
      summary = p.execution.applied
        ? "Approved + branched: " + p.title
        : p.execution.changeSetWritten
          ? "Approved (dry-run ready): " + p.title
          : "Approved: " + p.title;
    } else {
      summary = "Approved: " + p.title;
    }
    appendNotifications([
      {
        ts: p.decidedAt ?? new Date().toISOString(),
        event: "added",
        source: "worker",
        summary,
        detail: (p.note ? p.note + " — " : "") + p.action,
      },
    ]);
  }
  return p;
}
