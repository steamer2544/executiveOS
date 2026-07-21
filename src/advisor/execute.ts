// executeProposal — run the Synth → Executor pipeline for an approved executable proposal.
// Phase 27: Approve → Execute (for code proposals).
// This is the bridge from Advisor approval to concrete code changes on an isolated branch.

import type { Config } from "../config.js";
import type { Proposal } from "./types.js";
import type { Synthesizer, SynthOptions } from "../synth/types.js";
import { runSynth } from "../synth/synth.js";
import { validateChangeSet, applyChangeSet } from "../executor/executor.js";
import { changeSetPath, execRoot } from "../paths.js";
import { readFileSync } from "node:fs";

/**
 * Execute an approved executable proposal.
 * - If not executable → short-circuit with ran:false.
 * - Resolves target repo from config.watch.repos by name.
 * - Runs Synth (with instruction override from p.action), validates, dry-runs.
 * - Only applies (commits to branch) when opts.apply is true.
 * - Never throws — every error is caught and surfaced in the result.
 */
export async function executeProposal(
  p: Proposal,
  config: Config,
  opts?: { apply?: boolean; synthOverride?: Synthesizer }
): Promise<Proposal["execution"]> {
  // 1. Non-executable → short-circuit.
  if (p.executable !== true) {
    return {
      ran: false,
      applied: false,
      branch: null,
      changeSetWritten: false,
      valid: false,
      testPassed: null,
      message: "not executable — recorded only",
    };
  }

  // 2. Resolve target repo root.
  const repoRoot = resolveRepoRoot(p.repo, config);

  // 3. Run Synth with instruction override.
  const synthOpts: SynthOptions = {
    repoRoot,
    config,
    instruction: p.action,
    explicitFiles: p.files,
    synthOverride: opts?.synthOverride,
  };

  let synthReport: Awaited<ReturnType<typeof runSynth>>;
  try {
    synthReport = await runSynth(synthOpts);
  } catch (err) {
    return {
      ran: true,
      applied: false,
      branch: null,
      changeSetWritten: false,
      valid: false,
      testPassed: null,
      message: "synth threw: " + (err as Error).message,
    };
  }

  // 4. If synth failed or validation is invalid → return without applying.
  if (!synthReport.ok || !synthReport.validation.ok) {
    return {
      ran: true,
      applied: false,
      branch: null,
      changeSetWritten: synthReport.changeSetWritten,
      valid: false,
      testPassed: null,
      message: synthReport.messages.join("; ") || "synthesis failed",
    };
  }

  // 5. Valid + apply requested → commit to isolated branch.
  if (opts?.apply === true) {
    try {
      const csRaw = readFileSync(changeSetPath(), "utf-8");
      const cs = JSON.parse(csRaw) as Parameters<typeof applyChangeSet>[0];
      const execReport = applyChangeSet(cs, {
        apply: true,
        repoRoot,
        config,
      });
      return {
        ran: true,
        applied: execReport.committed,
        branch: execReport.branch,
        changeSetWritten: true,
        valid: true,
        testPassed: execReport.testPassed,
        message: execReport.committed
          ? "applied to branch " + execReport.branch!
          : "applied but commit failed",
      };
    } catch (err) {
      return {
        ran: true,
        applied: false,
        branch: null,
        changeSetWritten: true,
        valid: true,
        testPassed: null,
        message: "apply threw: " + (err as Error).message,
      };
    }
  }

  // 6. Valid + not applying → dry-run ready.
  return {
    ran: true,
    applied: false,
    branch: null,
    changeSetWritten: true,
    valid: true,
    testPassed: null,
    message: "dry-run changeset ready — review then execute --apply",
  };
}

/**
 * Resolve the target repo root for an executable proposal.
 * Looks up config.watch.repos by name; falls back to process.cwd().
 */
function resolveRepoRoot(repoName: string | undefined, config: Config): string {
  if (repoName && config.watch?.repos && config.watch.repos.length > 0) {
    const found = config.watch.repos.find((r) => r.name === repoName);
    if (found) return found.path;
  }
  return process.cwd();
}
