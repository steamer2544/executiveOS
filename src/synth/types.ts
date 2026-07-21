// Types for the Synthesizer — Phase 7: Proposal → ChangeSet.

import type { Proposal } from "../worker/types.js";
import type { ChangeSet, ValidationResult, ExecReport } from "../executor/types.js";
import type { Config } from "../config.js";

/** One existing file's current content, handed to the LLM as material. */
export interface SynthFile {
  path: string;    // repo-relative
  content: string; // current content
  bytes: number;   // Buffer.byteLength(content, "utf8")
}

/** What the OS hands the LLM to synthesize a ChangeSet. */
export interface SynthInput {
  proposal: Proposal;   // the intent (prose steps) from Phase 5
  summary: string;      // compact context summary
  files: SynthFile[];   // current contents of the selected (bounded) files
}

/** A Synthesizer's raw output — the candidate ChangeSet before validation. */
export interface SynthResult {
  changeSet: ChangeSet; // parsed candidate (NOT yet validated)
  raw: string;          // raw model text, kept verbatim for inspectability
  backend: string;      // the Synthesizer.name that produced it
}

/**
 * Turns a SynthInput into a candidate ChangeSet.
 * MockSynthesizer (offline, deterministic) and AnthropicSynthesizer (HTTP).
 * `synthesize` may throw on transport/parse errors — runSynth catches and records it.
 */
export interface Synthesizer {
  readonly name: string; // e.g. "mock" or "anthropic:qwen3.6-35b-a3b"
  synthesize(input: SynthInput): Promise<SynthResult>;
}

export interface SynthOptions {
  repoRoot: string;
  config: Config;
  explicitFiles?: string[];      // from --files; when absent, fall back to State
  proposalId?: string | null;    // from --proposal; when absent, use the latest proposal.json
  instruction?: string;          // NEW: when set, use THIS text as the synthesis instruction
                                 // instead of loading proposal.json. Backward-compatible (absent = today).
  synthOverride?: Synthesizer;   // tests inject a Synthesizer; production passes nothing
}

export interface SynthReport {
  ok: boolean;
  proposalId: string | null;
  synthesizer: string | null;
  selectedFiles: string[];       // paths actually fed to the LLM
  changeSetWritten: boolean;     // whether .executive/changeset.json was written
  validation: ValidationResult;  // result of validateChangeSet on the candidate
  execReport: ExecReport | null; // Phase 6 DRY-RUN report (null if validation failed or synth failed)
  messages: string[];
  error: string | null;          // set when the Synthesizer threw
  generatedAt: string;           // ISO
}
