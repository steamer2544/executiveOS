// Executor — applies a ChangeSet safely on an isolated git branch.
// 100% deterministic, rule-based, NO LLM.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { execRoot, execReportPath } from "../paths.js";
import type { ApplyOptions, ChangeSet, ExecReport, PlannedOp } from "./types.js";
import { validateChangeSet } from "./validate.js";
import { planChangeSet } from "./plan.js";
import * as git from "./git.js";

export { validateChangeSet } from "./validate.js";
export { planChangeSet } from "./plan.js";
export type { ApplyOptions, ChangeSet, ExecReport, PlannedOp } from "./types.js";

export function applyChangeSet(
  cs: ChangeSet,
  opts: ApplyOptions
): ExecReport {
  const repoRoot = opts.repoRoot;

  // 1. Validate first. Only plan when the changeset is structurally valid —
  // planChangeSet reads cs.ops, which a malformed changeset may be missing,
  // so planning an invalid changeset would throw instead of failing cleanly.
  const validation = validateChangeSet(cs, repoRoot);
  const plannedOps = validation.ok ? planChangeSet(cs, repoRoot) : [];

  const baseReport: ExecReport = {
    changeSetId: cs.id,
    title: cs.title,
    mode: opts.apply ? "apply" : "dry-run",
    ok: false,
    validation,
    plannedOps,
    branch: null,
    originalBranch: null,
    committed: false,
    commitSha: null,
    testCommand: null,
    testPassed: null,
    testOutput: null,
    messages: [],
    generatedAt: new Date().toISOString(),
  };

  // 2. Validation failed
  if (!validation.ok) {
    baseReport.messages.push("validation failed — no changes made");
    return baseReport;
  }

  // 3. Dry-run
  if (!opts.apply) {
    const allSucceed = plannedOps.every((p) => p.wouldSucceed);
    baseReport.ok = allSucceed;
    baseReport.messages.push(
      "DRY RUN — pass --apply to execute. " +
        plannedOps.length +
        " ops planned."
    );
    if (!allSucceed) {
      const blocked = plannedOps.filter((p) => !p.wouldSucceed);
      for (const b of blocked) {
        baseReport.messages.push("blocked: " + b.op + " " + b.path + " — " + (b.note || "unknown"));
      }
    }
    return baseReport;
  }

  // 4. Apply mode
  const report = { ...baseReport, mode: "apply" as const };

  // 4a. Is a git repo?
  if (!git.isGitRepo(repoRoot)) {
    report.messages.push("not a git repository");
    return report;
  }

  // 4b. Clean working tree?
  if (!git.isWorkingTreeClean(repoRoot)) {
    report.messages.push("working tree is dirty — commit or stash first");
    return report;
  }

  // 4c. Any blocked ops?
  const blocked = plannedOps.filter((p) => !p.wouldSucceed);
  if (blocked.length > 0) {
    for (const b of blocked) {
      report.messages.push("blocked: " + b.op + " " + b.path + " — " + (b.note || "unknown"));
    }
    return report;
  }

  // 4d. Create isolated branch
  const originalBranch = git.currentBranch(repoRoot);
  const branchPrefix = (opts.config.executor?.branchPrefix ?? "executive/change-") || "executive/change-";
  const branch = branchPrefix + cs.id;

  if (git.branchExists(repoRoot, branch)) {
    report.messages.push("branch " + branch + " already exists — delete it first");
    return report;
  }

  git.checkoutNewBranch(repoRoot, branch);
  report.branch = branch;
  report.originalBranch = originalBranch;

  // From here, wrap in try/catch for best-effort recovery.
  try {
    // 4f. Apply file ops
    for (const op of cs.ops) {
      const fullPath = resolve(repoRoot, op.path);
      switch (op.op) {
        case "write":
        case "create": {
          const dir = dirname(fullPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(fullPath, op.content);
          break;
        }
        case "delete": {
          rmSync(fullPath);
          break;
        }
      }
    }

    // 4g. Stage all
    git.stageAll(repoRoot);

    // 4h. Test
    const cmd = cs.test ?? opts.config.executor?.defaultTestCommand ?? null;
    if (cmd && typeof cmd === "string" && cmd.trim().length > 0) {
      const res = spawnSync(cmd, {
        cwd: repoRoot,
        shell: true,
        encoding: "utf8",
      });
      const combined = (res.stdout ?? "") + (res.stderr ?? "");
      report.testOutput = combined.slice(0, 4000);
      report.testCommand = cmd;
      if (res.error) {
        report.testPassed = false;
        report.testOutput = "spawn failed: " + res.error.message + "\n" + (report.testOutput || "");
      } else {
        report.testPassed = res.status === 0;
      }
    }

    // 4i. Commit on the branch
    const commitSha = git.commit(repoRoot, cs.commitMessage);
    report.commitSha = commitSha;
    report.committed = true;
    report.messages.push("committed: " + commitSha + " on " + branch);

    // Test result message
    if (report.testCommand) {
      report.messages.push(
        "test: " + (report.testPassed ? "passed" : "FAILED")
      );
    }

    // 4j. Return to original branch
    git.checkoutBranch(repoRoot, originalBranch);
    report.messages.push("returned to branch: " + originalBranch);

    // 4k. Set ok
    report.ok = report.testPassed !== false;

    // Hints
    report.messages.push("inspect: git diff " + originalBranch + ".." + branch);
    report.messages.push("discard: git branch -D " + branch);
  } catch (err) {
    // Best-effort recovery: try to return to original branch
    try {
      git.checkoutBranch(repoRoot, originalBranch);
    } catch {
      // Could not recover — report the error
    }
    report.messages.push("error during apply: " + (err as Error).message);
    report.ok = false;
  }

  return report;
}

/**
 * Atomically write an ExecReport to disk.
 * Writes to a temp file then renames (same pattern as writeProposal/writePlan).
 */
export function writeReport(r: ExecReport): void {
  const dir = execRoot();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(r, null, 2) + "\n";
  const reportPath = execReportPath();
  const tmpPath = reportPath + "." + randomUUID();

  writeFileSync(tmpPath, content);
  renameOverwrite(tmpPath, reportPath);
}
