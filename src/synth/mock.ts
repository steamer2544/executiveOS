// MockSynthesizer — deterministic, offline, no network.
// Same input → same output. Used by tests and by `config.worker.backend === "mock"`.

import type { Synthesizer, SynthInput, SynthResult } from "./types.js";
import type { ChangeSet } from "../executor/types.js";

/**
 * Deterministic ChangeSet derived from the proposal.
 * id from the action kind + fixed suffix, title from summary,
 * a single write op to SYNTH_NOTE.md.
 */
function buildDeterministicChangeSet(input: SynthInput): ChangeSet {
  const kind = input.proposal.action.kind;
  const id = "synth-" + kind;
  const title = "synthesized: " + input.proposal.summary;
  const stepsText = input.proposal.steps.join("\n");
  const content =
    "# Synthesized ChangeSet\n\n" +
    "Summary: " + input.proposal.summary + "\n\n" +
    "Steps:\n" + stepsText + "\n";
  return {
    id,
    title,
    ops: [{ op: "write", path: "SYNTH_NOTE.md", content }],
    test: null,
    commitMessage: title,
    basedOnProposal: input.proposal.id,
  };
}

export class MockSynthesizer implements Synthesizer {
  readonly name = "mock";

  async synthesize(input: SynthInput): Promise<SynthResult> {
    const changeSet = buildDeterministicChangeSet(input);
    return {
      changeSet,
      raw: JSON.stringify(changeSet),
      backend: "mock",
    };
  }
}
