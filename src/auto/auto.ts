// Autopilot orchestrator (Phase 8).
// Runs the full chain: plan → worker → synth → execute, gated by existing guardrails.
// Reuses Phase 3 (state), Phase 4 (plan), Phase 5 (Worker), Phase 6 (Executor), Phase 7 (Synthesizer).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { randomUUID } from "node:crypto";
import type { Plan } from "../planner/types.js";
import type { Config } from "../config.js";
import type { Proposal, Worker } from "../worker/types.js";
import type { Synthesizer, SynthReport } from "../synth/types.js";
import type { ChangeSet, ExecReport } from "../executor/types.js";
import { buildState, writeState } from "../state/builder.js";
import { plan, writePlan } from "../planner/planner.js";
import { runWorker, writeProposal } from "../worker/orchestrator.js";
import { runSynth } from "../synth/synth.js";
import { applyChangeSet } from "../executor/executor.js";
import { autoReportPath, changeSetPath, execRoot } from "../paths.js";
import type { AutoOptions, AutoReport, AutoStage } from "./types.js";

// ─── runAuto ──────────────────────────────────────────────────────────────────

/**
 * Run the full Autopilot chain: plan → worker → synth → (optionally) execute.
 * Each stage is an existing function. The Autopilot only decides whether to continue.
 */
export async function runAuto(opts: AutoOptions): Promise<AutoReport> {
  const report: AutoReport = {
    ok: false,
    stage: "plan",
    stoppedReason: null,
    needsHuman: false,
    topAction: null,
    proposalId: null,
    changeSetWritten: false,
    validationOk: null,
    dryRunOk: null,
    applied: false,
    branch: null,
    commitSha: null,
    testPassed: null,
    messages: [],
    generatedAt: new Date().toISOString(),
  };

  // 1. Plan.
  const built = buildState();
  writeState(built);
  const p: Plan = plan(built.state, built.context);
  writePlan(p);
  report.topAction = p.topAction;

  // 2. Gate — actionable?
  if (!p.topAction) {
    report.stage = "plan";
    report.ok = true;
    report.needsHuman = false;
    report.stoppedReason = "no actionable topAction";
    report.messages.push("nothing to do");
    report.generatedAt = new Date().toISOString();
    return report;
  }

  if (p.topAction.disposition !== "act") {
    report.stage = "plan";
    report.ok = true;
    report.needsHuman = true;
    report.stoppedReason =
      "topAction is '" + p.topAction.kind + "' with disposition 'ask' — needs human";
    report.messages.push(report.stoppedReason);
    report.generatedAt = new Date().toISOString();
    return report;
  }

  // 3. Worker.
  let proposal: Proposal | null;
  try {
    proposal = await runWorker(
      built.context,
      p,
      opts.config,
      opts.workerOverride
    );
  } catch (err) {
    report.stage = "worker";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "worker threw: " + (err as Error).message;
    report.messages.push(report.stoppedReason);
    report.generatedAt = new Date().toISOString();
    return report;
  }

  if (proposal === null) {
    report.stage = "worker";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "worker produced no proposal";
    report.messages.push(report.stoppedReason);
    report.generatedAt = new Date().toISOString();
    return report;
  }

  writeProposal(proposal);
  report.proposalId = proposal.id;

  if (proposal.status !== "ok") {
    report.stage = "worker";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "worker failed: " + (proposal.error ?? proposal.status);
    report.messages.push(report.stoppedReason);
    report.generatedAt = new Date().toISOString();
    return report;
  }

  // 4. Synth.
  const synthReport: SynthReport = await runSynth({
    repoRoot: opts.repoRoot,
    config: opts.config,
    explicitFiles: opts.explicitFiles,
    proposalId: proposal.id,
    synthOverride: opts.synthOverride,
  });

  report.changeSetWritten = synthReport.changeSetWritten;
  report.validationOk = synthReport.validation.ok;
  report.dryRunOk = synthReport.execReport ? synthReport.execReport.ok : null;
  report.messages.push(...synthReport.messages);

  if (!synthReport.changeSetWritten) {
    report.stage = "synth";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "synthesizer failed";
    report.generatedAt = new Date().toISOString();
    return report;
  }

  if (!synthReport.validation.ok) {
    report.stage = "synth";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "changeset failed validation";
    report.generatedAt = new Date().toISOString();
    return report;
  }

  if (synthReport.execReport && !synthReport.execReport.ok) {
    report.stage = "synth";
    report.ok = false;
    report.needsHuman = true;
    report.stoppedReason = "dry-run: some ops would fail";
    report.generatedAt = new Date().toISOString();
    return report;
  }

  // 5. Apply gate.
  if (!opts.apply) {
    report.stage = "synth";
    report.ok = true;
    report.needsHuman = false;
    report.applied = false;
    report.stoppedReason = null;
    report.messages.push(
      "dry-run complete — run `auto --apply` to act"
    );
    report.generatedAt = new Date().toISOString();
    return report;
  }

  // opts.apply === true → execute.
  const cs: ChangeSet = JSON.parse(
    readFileSync(changeSetPath(), "utf-8")
  ) as ChangeSet;

  const execReport: ExecReport = applyChangeSet(cs, {
    apply: true,
    repoRoot: opts.repoRoot,
    config: opts.config,
  });

  report.applied = execReport.committed;
  report.branch = execReport.branch;
  report.commitSha = execReport.commitSha;
  report.testPassed = execReport.testPassed;
  report.messages.push(...execReport.messages);
  report.stage = "execute";
  report.ok = execReport.ok;
  report.needsHuman = !execReport.ok;
  report.stoppedReason = execReport.ok ? null : "apply completed with issues";
  report.generatedAt = new Date().toISOString();
  return report;
}

// ─── writeAutoReport ──────────────────────────────────────────────────────────

/**
 * Atomically write an AutoReport to disk.
 * Writes to a temp file then renames (same pattern as writeProposal/writePlan).
 */
export function writeAutoReport(r: AutoReport): void {
  const root = execRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }

  const content = JSON.stringify(r, null, 2) + "\n";
  const tmpPath = autoReportPath() + "." + randomUUID();
  writeFileSync(tmpPath, content);
  renameOverwrite(tmpPath, autoReportPath());
}


