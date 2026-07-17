// Types for the Autopilot (Phase 8).
// The Autopilot orchestrates Phase 3 → 4 → 5 → 7 → 6 end-to-end.

import type { Config } from "../config.js";
import type { ProposedAction } from "../planner/types.js";
import type { Worker } from "../worker/types.js";
import type { Synthesizer } from "../synth/types.js";

/** How far the Autopilot got before it stopped (or finished). */
export type AutoStage = "plan" | "worker" | "synth" | "execute" | "done";

export interface AutoOptions {
  repoRoot: string;
  config: Config;
  apply: boolean; // false = whole-chain dry-run (default); true = let the Executor commit to a branch
  explicitFiles?: string[]; // forwarded to runSynth (its --files)
  workerOverride?: Worker; // tests inject; production passes nothing
  synthOverride?: Synthesizer; // tests inject; production passes nothing
}

export interface AutoReport {
  ok: boolean; // true = ran to a safe, successful conclusion (incl. "nothing to do" / correctly declined)
  stage: AutoStage; // the furthest stage reached
  stoppedReason: string | null; // why it stopped before applying (null when it applied or completed a clean dry-run)
  needsHuman: boolean; // true when a human must act (ask-disposition, validation/dry-run failure, or failing tests)

  topAction: ProposedAction | null;
  proposalId: string | null;
  changeSetWritten: boolean;
  validationOk: boolean | null; // null if synth not reached
  dryRunOk: boolean | null; // null if synth not reached
  applied: boolean; // true only when apply:true and the Executor committed
  branch: string | null;
  commitSha: string | null;
  testPassed: boolean | null;

  messages: string[];
  generatedAt: string; // ISO
}
