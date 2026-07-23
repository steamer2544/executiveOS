// Inference orchestrator (Phase 19).
// GUESSES block/deadline from context and writes .executive/inferred.json.
// SUGGESTIONS ONLY — never emits events, never mutates real state.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { randomUUID } from "node:crypto";
import type { Context } from "../state/types.js";
import type { InferenceResult, InferOptions } from "./types.js";
import { createInferer } from "./factory.js";
import { execRoot, inferredPath } from "../paths.js";

/**
 * Run inference over the given context. Returns an InferenceResult.
 * On any Inferer error, returns a result with `error` set and null guesses
 * (never throws) — a failed guess must never disrupt the runtime.
 */
export async function runInference(context: Context, opts: InferOptions): Promise<InferenceResult> {
  const inferer = opts.infererOverride ?? createInferer(opts.config);
  try {
    const g = await inferer.infer(context);
    return {
      generatedAt: new Date().toISOString(),
      backend: inferer.name,
      block: g.block,
      deadline: g.deadline,
      raw: g.raw,
      error: null,
    };
  } catch (err) {
    return {
      generatedAt: new Date().toISOString(),
      backend: inferer.name,
      block: null,
      deadline: null,
      raw: "",
      error: (err as Error).message,
    };
  }
}

/** Atomically write an InferenceResult to .executive/inferred.json. */
export function writeInference(r: InferenceResult): void {
  const root = execRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const tmp = inferredPath() + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  renameOverwrite(tmp, inferredPath());
}
