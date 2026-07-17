// MockWorker — deterministic, offline, no network.
// Same input → same output. Used by tests and by `config.worker.backend === "mock"`.

import type { Worker, WorkerInput, WorkerOutput } from "./types.js";
import type { ActionKind } from "../planner/types.js";

/** Fixed, plausible steps per ActionKind. No I/O, no randomness. */
const MOCK_STEPS: Record<ActionKind, string[]> = {
  fix_tests: [
    "Run the failing test suite to see the error",
    "Locate the assertion that fails",
    "Patch the code, re-run until green",
  ],
  resolve_block: [
    "Read the blockedReason to identify the blocker",
    "Surface the blocker to the owner with a summary",
    "Suggest a path forward or escalation",
  ],
  review_deadline: [
    "List the current task and its progress",
    "Compare remaining work against the deadline",
    "Recommend whether to proceed, delegate, or adjust",
  ],
  resume_task: [
    "Recap the current task and where work left off",
    "Suggest the next concrete step to unblock progress",
    "Propose a short checklist to get back on track",
  ],
};

export class MockWorker implements Worker {
  readonly name = "mock";

  async run(input: WorkerInput): Promise<WorkerOutput> {
    const kind = input.action.kind;
    const steps = MOCK_STEPS[kind];
    return {
      summary: `[mock] proposal for ${kind}`,
      steps,
      raw: steps.join("\n"),
    };
  }
}
