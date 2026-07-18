// Types for LLM signal inference (Phase 19).
// The Inferer GUESSES block/deadline from recent context. Its output is a
// SUGGESTION the owner confirms — never an auto-emitted fact.

import type { Context } from "../state/types.js";
import type { Config } from "../config.js";

export interface BlockGuess {
  likely: boolean;
  reason: string; // short, human-readable; empty when not likely
}

export interface DeadlineGuess {
  likely: boolean;
  date: string | null; // ISO date (YYYY-MM-DD) when the model gave one, else null
  note: string;        // short, human-readable; empty when not likely
}

/** Raw guesses from an Inferer, before persistence. */
export interface InferenceGuesses {
  block: BlockGuess | null;    // null = the model offered nothing
  deadline: DeadlineGuess | null;
  raw: string;                 // raw model text, kept for inspection
}

/** Persisted inference result (.executive/inferred.json). */
export interface InferenceResult extends InferenceGuesses {
  generatedAt: string; // ISO
  backend: string;     // Inferer.name that produced it
  error: string | null; // set when the Inferer threw
}

/** Turns recent context into block/deadline guesses. mock (offline) | anthropic (HTTP). */
export interface Inferer {
  readonly name: string;
  infer(context: Context): Promise<InferenceGuesses>;
}

export interface InferOptions {
  config: Config;
  infererOverride?: Inferer; // tests inject; production passes nothing
}
