// Types for the Worker (Phase 5).
// The Worker turns a Planner action into a concrete Proposal.

import type { Context } from "../state/types.js";
import type { ActionKind, ProposedAction } from "../planner/types.js";

/** What the OS hands the LLM: the one action to reason about + the full context snapshot. */
export interface WorkerInput {
  action: ProposedAction; // the plan.topAction (guaranteed disposition "act" by the orchestrator)
  context: Context; // Phase 3 context.json (state + recent events + summary)
}

/** What a Worker returns from a successful run. */
export interface WorkerOutput {
  summary: string; // one-line rollup of the proposal
  steps: string[]; // concrete suggested steps (human executes; NOT run here)
  raw: string; // the raw model text, kept verbatim for inspectability
}

/**
 * A Worker turns a WorkerInput into a WorkerOutput.
 * Implementations: MockWorker (offline, deterministic) and AnthropicWorker (HTTP).
 * `run` may throw on transport/timeout errors — the orchestrator catches and records it.
 */
export interface Worker {
  readonly name: string; // e.g. "mock" or "anthropic:qwen3.6-35b-a3b"
  run(input: WorkerInput): Promise<WorkerOutput>;
}

/** The persisted artifact of a Worker run (written to .executive/). */
export interface Proposal {
  id: string; // crypto.randomUUID()
  generatedAt: string; // ISO, when this proposal was produced
  status: "ok" | "error"; // "error" when the Worker threw
  backend: string; // the Worker.name that produced it
  action: ProposedAction; // echo of the topAction, for provenance
  summary: string; // one-line ("error: ..." when status === "error")
  steps: string[]; // suggested steps ([] when status === "error")
  raw: string; // raw model text ("" when status === "error")
  error: string | null; // error message when status === "error", else null
  basedOn: { // provenance back to the inputs
    stateGeneratedAt: string; // context.state.generatedAt
    topActionKind: ActionKind;
  };
}
