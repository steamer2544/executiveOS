// Digest / Report layer (Phase 11).
// Reads existing .executive/ artifacts and renders one concise, human-readable
// Markdown summary. 100% deterministic, rule-based, NO LLM.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { State } from "../state/types.js";
import type { Plan } from "../planner/types.js";
import type { AutoReport } from "../auto/types.js";
import type { ExecReport } from "../executor/types.js";
import type { Proposal } from "../worker/types.js";
import { statePath, planPath, autoReportPath, execReportPath, proposalPath, digestPath, inferredPath, execRoot } from "../paths.js";
import type { InferenceResult } from "../infer/types.js";
import type { Digest, DigestOptions, NeedsYouItem } from "./types.js";

// ── Defensive JSON reader ────────────────────────────────────────────────────

/** Read + JSON-parse a file defensively. Returns null on any error. Never throws. */
function readJson<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── buildDigest ───────────────────────────────────────────────────────────────

/**
 * Build a structured Digest from existing .executive/ artifacts.
 * Every input is optional and untrusted — missing or malformed files degrade gracefully.
 */
export function buildDigest(opts?: DigestOptions): Digest {
  const generatedAt = opts?.now ?? new Date().toISOString();

  // ── Now section ────────────────────────────────────────────────────────────
  const rawState = readJson<State>(statePath());
  let now: Digest["now"];
  if (!rawState) {
    now = {
      available: false,
      project: null, task: null, deadline: null, currentFile: null,
      tests: null, blocked: null, blockedReason: null, branch: null,
      idle: null, stateGeneratedAt: null, repos: [], activeRepo: null, currentWindow: null,
    };
  } else {
    now = {
      available: true,
      project: rawState.currentProject ?? null,
      task: rawState.currentTask ?? null,
      deadline: rawState.deadline ?? null,
      currentFile: rawState.currentFile ?? null,
      tests: rawState.tests ?? null,
      blocked: rawState.blocked ?? null,
      blockedReason: rawState.blockedReason ?? null,
      branch: rawState.git?.branch ?? null,
      idle: rawState.activity?.active === false ? true : rawState.activity?.active === true ? false : null,
      stateGeneratedAt: rawState.generatedAt ?? null,
      repos: ((rawState as any).repos ?? []).map((r: { name: string; branch: string | null }) => ({ name: r.name, branch: r.branch ?? null })),
      activeRepo: (rawState as any).activeRepo ?? null,
      currentWindow: (rawState as any).currentWindow ?? null,
    };
  }

  // ── Recommended section ────────────────────────────────────────────────────
  const rawPlan = readJson<Plan>(planPath());
  let recommended: Digest["recommended"];
  if (!rawPlan) {
    recommended = {
      available: false,
      topActionKind: null, disposition: null, reason: null,
      confidence: null, actionCount: 0,
    };
  } else {
    recommended = {
      available: true,
      topActionKind: rawPlan.topAction?.kind ?? null,
      disposition: rawPlan.topAction?.disposition ?? null,
      reason: rawPlan.topAction?.reason ?? null,
      confidence: rawPlan.topAction?.confidence ?? null,
      actionCount: rawPlan.actions?.length ?? 0,
    };
  }

  // ── Last Autopilot section ─────────────────────────────────────────────────
  const rawAuto = readJson<AutoReport>(autoReportPath());
  let lastAutopilot: Digest["lastAutopilot"];
  if (!rawAuto) {
    lastAutopilot = {
      available: false,
      stage: null, ok: null, applied: null, branch: null,
      commitSha: null, testPassed: null, needsHuman: null,
      stoppedReason: null, generatedAt: null,
    };
  } else {
    lastAutopilot = {
      available: true,
      stage: rawAuto.stage ?? null,
      ok: rawAuto.ok ?? null,
      applied: rawAuto.applied ?? null,
      branch: rawAuto.branch ?? null,
      commitSha: rawAuto.commitSha ?? null,
      testPassed: rawAuto.testPassed ?? null,
      needsHuman: rawAuto.needsHuman ?? null,
      stoppedReason: rawAuto.stoppedReason ?? null,
      generatedAt: rawAuto.generatedAt ?? null,
    };
  }

  // ── Needs You (aggregated, deduped) ────────────────────────────────────────
  const needsYou: NeedsYouItem[] = [];
  const seenSummaries = new Set<string>();

  function pushIfNew(item: NeedsYouItem): void {
    if (!seenSummaries.has(item.summary)) {
      seenSummaries.add(item.summary);
      needsYou.push(item);
    }
  }

  // 1. Plan: every fired action the Planner will NOT do autonomously (disposition "ask").
  //    Iterate the whole actions list (priority-desc), not just topAction, so a lower-priority
  //    "ask" (e.g. a block) is never masked by a higher-priority "act" top action.
  //    Fall back to [topAction] when actions is empty/absent (degenerate/malformed plan).
  const firedActions =
    rawPlan?.actions && rawPlan.actions.length > 0
      ? rawPlan.actions
      : rawPlan?.topAction
        ? [rawPlan.topAction]
        : [];
  for (const a of firedActions) {
    if (a.disposition === "ask") {
      pushIfNew({
        source: "plan",
        summary: "Planner needs your call: " + a.kind,
        detail: a.reason ?? undefined,
      });
    }
  }

  // 2. Autopilot: needsHuman
  if (rawAuto?.needsHuman === true) {
    pushIfNew({
      source: "autopilot",
      summary: "Autopilot stopped and needs you",
      detail: rawAuto.stoppedReason ?? undefined,
    });
  }

  // 3. Executor: parked change with failing tests
  const rawExec = readJson<ExecReport>(execReportPath());
  if (rawExec?.mode === "apply" && rawExec.committed === true && rawExec.testPassed === false) {
    pushIfNew({
      source: "executor",
      summary: "A change is parked on " + (rawExec.branch ?? "unknown branch") + " with FAILING tests",
      detail: rawExec.title ?? undefined,
    });
  }

  // 4. Worker: error status
  const rawProposal = readJson<Proposal>(proposalPath());
  if (rawProposal?.status === "error") {
    pushIfNew({
      source: "worker",
      summary: "The last Worker run errored",
      detail: rawProposal.error ?? undefined,
    });
  }

  // ── Suggestions (LLM guesses, unconfirmed) ─────────────────────────────────
  // Shown only when they add NEW information vs. the deterministic state:
  //   - a block guess only if not already blocked;
  //   - a deadline guess only if no deadline is set.
  const suggestions: Digest["suggestions"] = [];
  const rawInfer = readJson<InferenceResult>(inferredPath());
  if (rawInfer && !rawInfer.error) {
    if (rawInfer.block?.likely && !(rawState?.blocked === true)) {
      const reason = rawInfer.block.reason || "unspecified";
      suggestions.push({
        kind: "block",
        text: "Possible block — " + reason,
        emit: { type: "system.blocked", data: { reason } },
      });
    }
    // Only actionable when the model gave a concrete date to confirm.
    if (rawInfer.deadline?.likely && rawInfer.deadline.date && !(rawState?.deadline)) {
      suggestions.push({
        kind: "deadline",
        text: "Possible deadline (" + rawInfer.deadline.date + ") — " + (rawInfer.deadline.note || "confirm?"),
        emit: { type: "system.task", data: { deadline: rawInfer.deadline.date } },
      });
    }
  }

  return {
    generatedAt,
    now,
    recommended,
    lastAutopilot,
    needsYou,
    suggestions,
  };
}

// ── renderDigest ──────────────────────────────────────────────────────────────

/**
 * Render a Digest into a human-readable Markdown string.
 * Pure function — no I/O.
 */
export function renderDigest(d: Digest): string {
  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push("# ExecutiveOS — Digest");
  lines.push("");
  lines.push("_Generated at " + d.generatedAt + "_");
  lines.push("");

  // ── Now ────────────────────────────────────────────────────────────────────
  lines.push("## Now");
  lines.push("");
  if (!d.now.available) {
    lines.push("_No state yet._");
  } else {
    lines.push("- **Project:** " + field(d.now.project));
    lines.push("- **Task:** " + field(d.now.task));
    lines.push("- **Current file:** " + field(d.now.currentFile));
    lines.push("- **Tests:** " + (d.now.tests ? d.now.tests : "—"));
    if (d.now.blocked) {
      lines.push("- **Blocked:** yes — " + (d.now.blockedReason ?? "unknown reason"));
    } else {
      lines.push("- **Blocked:** no");
    }
    lines.push("- **Branch:** " + field(d.now.branch));
    lines.push("- **Deadline:** " + field(d.now.deadline));
    lines.push("- **Idle:** " + (d.now.idle === true ? "yes" : d.now.idle === false ? "no" : "—"));
    if (d.now.stateGeneratedAt) {
      lines.push("- _State generated at " + d.now.stateGeneratedAt + "_");
    }
    if (d.now.repos.length > 1) {
      const repoList = d.now.repos.map((r) => (r.name === d.now.activeRepo ? r.name + "*" : r.name) + " (" + (r.branch ?? "no branch") + ")").join(", ");
      lines.push("- **Repos:** " + repoList);
    }
    // Screen window — "Looking at: ..." line when present.
    if (d.now.currentWindow) {
      lines.push("- **Looking at:** " + d.now.currentWindow.title + "  (" + d.now.currentWindow.app + ")");
    }
  }
  lines.push("");

  // ── Recommended action ─────────────────────────────────────────────────────
  lines.push("## Recommended action");
  lines.push("");
  if (!d.recommended.available) {
    lines.push("_No plan yet._");
  } else {
    if (d.recommended.disposition === "ask") {
      lines.push(
        "⚠️ **ASK** — " +
        (d.recommended.topActionKind ?? "unknown") +
        (d.recommended.reason ? " (" + d.recommended.reason + ")" : "")
      );
    } else if (d.recommended.disposition === "act") {
      lines.push(
        "✅ **ACT** — " +
        (d.recommended.topActionKind ?? "unknown") +
        (d.recommended.reason ? " (" + d.recommended.reason + ")" : "")
      );
    } else {
      lines.push((d.recommended.topActionKind ?? "—") + (d.recommended.reason ? " (" + d.recommended.reason + ")" : ""));
    }
    lines.push(
      "_Confidence: " + (d.recommended.confidence != null ? Math.round(d.recommended.confidence * 100) + "%" : "—") +
      " | " + d.recommended.actionCount + " action(s) total_"
    );
  }
  lines.push("");

  // ── Last Autopilot run ─────────────────────────────────────────────────────
  lines.push("## Last Autopilot run");
  lines.push("");
  if (!d.lastAutopilot.available) {
    lines.push("_Autopilot has not run._");
  } else {
    lines.push("- **Stage:** " + (d.lastAutopilot.stage ?? "—"));
    lines.push("- **OK:** " + (d.lastAutopilot.ok !== null ? (d.lastAutopilot.ok ? "yes" : "no") : "—"));
    lines.push("- **Applied:** " + (d.lastAutopilot.applied !== null ? (d.lastAutopilot.applied ? "yes" : "no") : "—"));
    lines.push("- **Branch:** " + field(d.lastAutopilot.branch));
    lines.push("- **Commit:** " + (d.lastAutopilot.commitSha ?? "—"));
    lines.push("- **Tests passed:** " + (d.lastAutopilot.testPassed !== null ? (d.lastAutopilot.testPassed ? "yes" : "no") : "—"));
    lines.push("- **Needs human:** " + (d.lastAutopilot.needsHuman !== null ? (d.lastAutopilot.needsHuman ? "yes" : "no") : "—"));
    if (d.lastAutopilot.stoppedReason) {
      lines.push("- **Stopped reason:** " + d.lastAutopilot.stoppedReason);
    }
    if (d.lastAutopilot.generatedAt) {
      lines.push("- _Generated at " + d.lastAutopilot.generatedAt + "_");
    }
  }
  lines.push("");

  // ── Needs you ──────────────────────────────────────────────────────────────
  lines.push("## Needs you");
  lines.push("");
  if (d.needsYou.length === 0) {
    lines.push("_Nothing needs you right now._");
  } else {
    for (const item of d.needsYou) {
      lines.push("- **" + item.summary + "**" + (item.detail ? " — " + item.detail : ""));
    }
  }
  lines.push("");

  // ── Suggestions (LLM guesses — unconfirmed) ────────────────────────────────
  if (d.suggestions.length > 0) {
    lines.push("## Suggestions (unconfirmed — from the LLM)");
    lines.push("");
    for (const s of d.suggestions) {
      lines.push("- " + s.text);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── writeDigest ───────────────────────────────────────────────────────────────

/**
 * Write a rendered Digest to .executive/digest.md atomically (temp + rename).
 */
export function writeDigest(md: string): void {
  const root = execRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }

  const content = md;
  const tmpPath = digestPath() + "." + randomUUID();
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, digestPath());
}

// ── Signature helper ──────────────────────────────────────────────────────────

/**
 * A stable, order-independent signature of the "Needs you" queue.
 * Two queues with the same set of {source, summary} pairs produce the same string,
 * regardless of insertion order. Used by the watch daemon to alert only on change.
 */
export function needsYouSignature(items: NeedsYouItem[]): string {
  return items
    .map((i) => i.source + "|" + i.summary)
    .sort()
    .join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render a field value or "—" if null/undefined. */
function field(v: string | null): string {
  return v ?? "—";
}
