// Orchestrator — the guardrailed entry point into the Worker.
// This is the ONLY place the rest of the system calls into the Worker.

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Context } from "../state/types.js";
import type { Plan } from "../planner/types.js";
import type { Config } from "../config.js";
import type { Worker, WorkerOutput } from "./types.js";
import type { Proposal } from "./types.js";
import { createWorker } from "./factory.js";
import { proposalsDir, proposalPath } from "../paths.js";

/**
 * Run the Worker if the plan has an actionable topAction.
 * Returns null when there is nothing to act on (normal outcome).
 */
export async function runWorker(
  context: Context,
  plan: Plan,
  config: Config,
  workerOverride?: Worker // tests inject a Worker here; production passes nothing
): Promise<Proposal | null> {
  // Guardrail gate (defense in depth).
  if (!plan.topAction) return null;
  if (plan.topAction.forbidden) return null;
  if (plan.topAction.disposition !== "act") return null;

  const worker = workerOverride ?? createWorker(config);

  try {
    const out = await worker.run({ action: plan.topAction, context });
    return buildProposal("ok", worker.name, plan.topAction, context, out, null);
  } catch (err) {
    return buildProposal(
      "error",
      worker.name,
      plan.topAction,
      context,
      { summary: "", steps: [], raw: "" },
      (err as Error).message
    );
  }
}

/** Assemble a Proposal from Worker output (or error). */
function buildProposal(
  status: "ok" | "error",
  backend: string,
  action: Proposal["action"],
  context: Context,
  out: WorkerOutput,
  error: string | null
): Proposal {
  return {
    id: randomUUID(),
    generatedAt: new Date().toISOString(),
    status,
    backend,
    action,
    summary: status === "error" ? "error: " + error! : out.summary,
    steps: status === "error" ? [] : out.steps,
    raw: status === "error" ? "" : out.raw,
    error,
    basedOn: {
      stateGeneratedAt: context.state.generatedAt,
      topActionKind: action.kind,
    },
  };
}

/**
 * Atomically write a Proposal to disk.
 * Writes both the history copy (proposals/<id>.json) and the latest pointer (proposal.json).
 */
export function writeProposal(p: Proposal): void {
  const dir = proposalsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(p, null, 2) + "\n";

  // History copy.
  const histPath = dir + "/" + p.id + ".json";
  const histTmp = histPath + "." + randomUUID();
  writeFileSync(histTmp, content);
  renameSync(histTmp, histPath);

  // Latest pointer.
  const latestPath = proposalPath();
  const latestTmp = latestPath + "." + randomUUID();
  writeFileSync(latestTmp, content);
  renameSync(latestTmp, latestPath);
}
