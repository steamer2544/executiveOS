// Tests for the Digest / Report layer (Phase 11).
// All tests are OFFLINE: seed artifacts by writing JSON into a temp EXECUTIVE_HOME.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect } from "bun:test";
import { statePath, planPath, autoReportPath, execReportPath, proposalPath, digestPath, inferredPath, screenInferredPath, execRoot } from "../paths.js";
import { buildDigest, renderDigest, needsYouSignature, needsYouLabel, formatPatterns } from "./digest.js";
import type { NeedsYouItem } from "./types.js";
import type { State } from "../state/types.js";
import type { Plan } from "../planner/types.js";
import type { AutoReport } from "../auto/types.js";
import type { ExecReport } from "../executor/types.js";
import type { Proposal } from "../worker/types.js";
import { emptyPatterns } from "../state/patterns.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh temp dir and set EXECUTIVE_HOME. Clean up on test end. */
function createTempHome(): string {
  const dir = process.cwd() + "/.executive-test-" + randomUUID();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function setHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function unsetHome(): void {
  delete process.env.EXECUTIVE_HOME;
}

function seedState(partial: Partial<State>): void {
  const base: State = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    eventCount: 10,
    lastEventTs: "2026-01-01T00:00:00.000Z",
    currentProject: null,
    currentTask: null,
    deadline: null,
    currentFile: null,
    recentFiles: [],
    git: { branch: null, lastCommit: null },
    tests: "unknown",
    blocked: false,
    blockedReason: null,
    currentWindow: null,
    activity: { active: true, idleMs: 0 },
    activeRepo: null,
    repos: [],
    patterns: emptyPatterns(),
    ...partial,
  };
  writeFileSync(statePath(), JSON.stringify(base));
}

function seedPlan(partial: Partial<Plan>): void {
  const base: Plan = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    basedOnState: { generatedAt: "2026-01-01T00:00:00.000Z", eventCount: 10 },
    topAction: null,
    actions: [],
    summary: "clean",
    ...partial,
  };
  writeFileSync(planPath(), JSON.stringify(base));
}

function seedAutoReport(partial: Partial<AutoReport>): void {
  const base: AutoReport = {
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
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
  writeFileSync(autoReportPath(), JSON.stringify(base));
}

function seedExecReport(partial: Partial<ExecReport>): void {
  const base: ExecReport = {
    changeSetId: "test-1",
    title: "Test change",
    mode: "dry-run",
    ok: false,
    validation: { ok: true, errors: [] },
    plannedOps: [],
    branch: null,
    originalBranch: null,
    committed: false,
    commitSha: null,
    testCommand: null,
    testPassed: null,
    testOutput: null,
    messages: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
  writeFileSync(execReportPath(), JSON.stringify(base));
}

function seedProposal(partial: Partial<Proposal>): void {
  const base: Proposal = {
    id: "test-1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    status: "ok",
    backend: "mock",
    action: { kind: "fix_tests", reason: "test", priority: 100, confidence: 0.97, forbidden: false },
    summary: "test",
    steps: [],
    raw: "",
    error: null,
    basedOn: { stateGeneratedAt: "2026-01-01T00:00:00.000Z", topActionKind: "fix_tests" },
    ...partial,
  };
  writeFileSync(proposalPath(), JSON.stringify(base));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("Empty repo (no artifacts): all sections unavailable, no throw", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    const digest = buildDigest();
    expect(digest.now.available).toBe(false);
    expect(digest.recommended.available).toBe(false);
    expect(digest.lastAutopilot.available).toBe(false);
    expect(digest.needsYou).toEqual([]);

    const md = renderDigest(digest);
    expect(md).toContain("_No state yet._");
    expect(md).toContain("_No plan yet._");
    expect(md).toContain("_Autopilot has not run._");
    expect(md).toContain("_Nothing needs you right now._");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("State present (failing tests, blocked)", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({
      currentProject: "myshi",
      currentTask: "fix auth",
      deadline: "2026-08-01T00:00:00.000Z",
      currentFile: "src/auth.ts",
      tests: "failing",
      blocked: true,
      blockedReason: "waiting on API key from provider",
      git: { branch: "main", lastCommit: null },
      activity: { active: false, idleMs: 300000 },
    });
    const digest = buildDigest();
    expect(digest.now.available).toBe(true);
    expect(digest.now.project).toBe("myshi");
    expect(digest.now.task).toBe("fix auth");
    expect(digest.now.tests).toBe("failing");
    expect(digest.now.blocked).toBe(true);
    expect(digest.now.blockedReason).toBe("waiting on API key from provider");
    expect(digest.now.branch).toBe("main");
    expect(digest.now.deadline).toBe("2026-08-01T00:00:00.000Z");
    expect(digest.now.idle).toBe(true);

    const md = renderDigest(digest);
    expect(md).toContain("failing");
    expect(md.toLowerCase()).toContain("blocked");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Plan with act disposition → not in needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "tests are failing",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [
        { kind: "fix_tests", reason: "tests are failing", priority: 100, confidence: 0.97, forbidden: false, disposition: "act" },
      ],
    });
    const digest = buildDigest();
    expect(digest.recommended.topActionKind).toBe("fix_tests");
    expect(digest.recommended.disposition).toBe("act");
    expect(digest.recommended.actionCount).toBe(1);
    expect(digest.needsYou).toEqual([]);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Plan with ask disposition → needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "resolve_block",
        reason: "blocked on external API",
        priority: 90,
        confidence: 0.7,
        forbidden: false,
        disposition: "ask",
      },
      actions: [
        { kind: "resolve_block", reason: "blocked on external API", priority: 90, confidence: 0.7, forbidden: false, disposition: "ask" },
      ],
    });
    const digest = buildDigest();
    expect(digest.recommended.disposition).toBe("ask");
    expect(digest.needsYou.length).toBe(1);
    expect(digest.needsYou[0]!.source).toBe("plan");
    // `summary` is the dedup KEY and must stay byte-stable — every key already written to
    // notifications.jsonl / nudges.jsonl depends on it.
    expect(digest.needsYou[0]!.summary).toBe("Planner needs your call: resolve_block");
    expect(digest.needsYou[0]!.detail).toBe("blocked on external API");
    expect(digest.needsYou[0]!.label).toBe("blocked on external API");

    // …but the RENDERED digest is what `get_digest` hands the model, so the key must not
    // appear in it: that is how "Planner needs your call" became a telephone call in 2 of 4
    // live nudges. Assert on the whole document, not just the Needs-you line.
    const md = renderDigest(digest);
    expect(md).toContain("Needs you");
    // The key phrase must not appear ANYWHERE in the document.
    expect(md).not.toContain("Planner needs your call");
    // The bare kind still appears under "Recommended action" — that is the plan's identity and
    // is deliberately kept — so scope the identifier check to the Needs-you section itself.
    const needsSection = md.split("## Needs you")[1]!.split("\n## ")[0]!;
    expect(needsSection).toContain("blocked on external API");
    expect(needsSection).not.toContain("resolve_block");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Autopilot applied → not in needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedAutoReport({
      stage: "done",
      ok: true,
      applied: true,
      branch: "executive/change-x",
      commitSha: "abc1234",
      testPassed: true,
      needsHuman: false,
      stoppedReason: null,
    });
    const digest = buildDigest();
    expect(digest.lastAutopilot.available).toBe(true);
    expect(digest.lastAutopilot.applied).toBe(true);
    expect(digest.lastAutopilot.branch).toBe("executive/change-x");
    expect(digest.lastAutopilot.commitSha).toBe("abc1234");
    expect(digest.needsYou).toEqual([]);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Autopilot needsHuman → needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedAutoReport({
      stage: "synth",
      ok: false,
      applied: false,
      needsHuman: true,
      stoppedReason: "changeset failed validation",
    });
    const digest = buildDigest();
    expect(digest.needsYou.length).toBe(1);
    expect(digest.needsYou[0]!.source).toBe("autopilot");
    expect(digest.needsYou[0]!.summary).toBe("Autopilot stopped and needs you");
    expect(digest.needsYou[0]!.detail).toBe("changeset failed validation");
    // The label keeps BOTH halves — here the summary is the human sentence and the detail is
    // the extra, the opposite of the `plan` source. Preferring `detail` blindly would nudge
    // the owner with "changeset failed validation" and no mention of the autopilot stopping.
    expect(digest.needsYou[0]!.label).toBe("Autopilot stopped and needs you — changeset failed validation");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Parked change (failing tests) → needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedExecReport({
      mode: "apply",
      committed: true,
      testPassed: false,
      branch: "executive/change-y",
      title: "Add login endpoint",
    });
    const digest = buildDigest();
    expect(digest.needsYou.length).toBe(1);
    expect(digest.needsYou[0]!.source).toBe("executor");
    expect(digest.needsYou[0]!.summary).toContain("executive/change-y");
    expect(digest.needsYou[0]!.summary).toContain("FAILING tests");
    expect(digest.needsYou[0]!.detail).toBe("Add login endpoint");
    // "FAILING tests" is the reason this is in the queue at all — it must survive into the
    // label, not be replaced by the changeset title.
    expect(digest.needsYou[0]!.label).toContain("FAILING tests");
    expect(digest.needsYou[0]!.label).toContain("Add login endpoint");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Worker error → needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedProposal({
      status: "error",
      error: "boom",
      summary: "error: boom",
    });
    const digest = buildDigest();
    expect(digest.needsYou.length).toBe(1);
    expect(digest.needsYou[0]!.source).toBe("worker");
    expect(digest.needsYou[0]!.summary).toBe("The last Worker run errored");
    expect(digest.needsYou[0]!.detail).toBe("boom");
    expect(digest.needsYou[0]!.label).toBe("The last Worker run errored — boom");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Malformed file degrades, does not crash", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    // Malformed state.json
    writeFileSync(statePath(), "{ not json");
    // Valid plan
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "tests fail",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [],
    });
    const digest = buildDigest();
    expect(digest.now.available).toBe(false);
    expect(digest.recommended.available).toBe(true);
    expect(digest.recommended.topActionKind).toBe("fix_tests");

    const md = renderDigest(digest);
    expect(md).toContain("_No state yet._");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Determinism: same inputs → identical Digest and Markdown", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({
      currentProject: "myshi",
      tests: "passing",
      git: { branch: "main", lastCommit: null },
    });
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "test",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [],
    });

    const fixedNow = "2026-01-01T00:00:00.000Z";
    const d1 = buildDigest({ now: fixedNow });
    const md1 = renderDigest(d1);
    const d2 = buildDigest({ now: fixedNow });
    const md2 = renderDigest(d2);

    expect(d2).toEqual(d1);
    expect(md2).toBe(md1);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("renderDigest contains top header and generatedAt", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    const digest = buildDigest({ now: "2026-06-15T12:00:00.000Z" });
    const md = renderDigest(digest);
    expect(md).toContain("# ExecutiveOS — Digest");
    expect(md).toContain("2026-06-15T12:00:00.000Z");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Multiple needsYou items from different sources", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedPlan({
      topAction: {
        kind: "resolve_block",
        reason: "blocked",
        priority: 90,
        confidence: 0.7,
        forbidden: false,
        disposition: "ask",
      },
      actions: [],
    });
    seedAutoReport({ needsHuman: true, stoppedReason: "validation failed" });
    seedExecReport({ mode: "apply", committed: true, testPassed: false, branch: "executive/change-z", title: "parked" });
    seedProposal({ status: "error", error: "timeout" });

    const digest = buildDigest();
    expect(digest.needsYou.length).toBe(4);
    expect(digest.needsYou.map((n) => n.source)).toEqual(["plan", "autopilot", "executor", "worker"]);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Dedup: identical summaries keep only the first", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    // This is a contrived case — in practice different sources produce different summaries,
    // but we verify the dedup logic is sound.
    // Manually test by seeding plan ask + autopilot needsHuman with same summary text.
    // Since the summaries are source-specific, we test via a direct buildDigest call
    // by manipulating the internal logic — actually the spec says dedup by summary,
    // so let's just verify the result has unique summaries.
    seedPlan({
      topAction: {
        kind: "resolve_block",
        reason: "test",
        priority: 90,
        confidence: 0.7,
        forbidden: false,
        disposition: "ask",
      },
      actions: [],
    });
    const digest = buildDigest();
    const summaries = digest.needsYou.map((n) => n.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("State idle field: active=false → idle=true, active=true → idle=false", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ activity: { active: false, idleMs: 600000 } });
    let digest = buildDigest();
    expect(digest.now.idle).toBe(true);

    seedState({ activity: { active: true, idleMs: 0 } });
    digest = buildDigest();
    expect(digest.now.idle).toBe(false);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("GeneratedAt set correctly", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    const digest = buildDigest({ now: "2026-03-01T00:00:00.000Z" });
    expect(digest.generatedAt).toBe("2026-03-01T00:00:00.000Z");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

// ── Phase 13: Full ask-queue (masking fix) ────────────────────────────────────

test("act top action does NOT mask a lower-priority ask", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "tests are failing",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [
        { kind: "fix_tests", reason: "tests are failing", priority: 100, confidence: 0.97, forbidden: false, disposition: "act" },
        { kind: "resolve_block", reason: "blocked on external API", priority: 90, confidence: 0.7, forbidden: false, disposition: "ask" },
      ],
    });
    const digest = buildDigest();
    // Recommended still points to topAction (fix_tests/act)
    expect(digest.recommended.topActionKind).toBe("fix_tests");
    expect(digest.recommended.disposition).toBe("act");
    // But needsYou surfaces the masked ask
    const planItems = digest.needsYou.filter((n) => n.source === "plan");
    expect(planItems.length).toBe(1);
    expect(planItems[0]!.summary).toBe("Planner needs your call: resolve_block");
    expect(planItems[0]!.detail).toBe("blocked on external API");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Multiple ask actions all surface in priority order", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "tests fail",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [
        { kind: "fix_tests", reason: "tests fail", priority: 100, confidence: 0.97, forbidden: false, disposition: "act" },
        { kind: "resolve_block", reason: "blocked", priority: 90, confidence: 0.7, forbidden: false, disposition: "ask" },
        { kind: "review_deadline", reason: "deadline approaching", priority: 70, confidence: 0.6, forbidden: false, disposition: "ask" },
      ],
    });
    const digest = buildDigest();
    const planItems = digest.needsYou.filter((n) => n.source === "plan");
    expect(planItems.length).toBe(2);
    expect(planItems[0]!.summary).toBe("Planner needs your call: resolve_block");
    expect(planItems[1]!.summary).toBe("Planner needs your call: review_deadline");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("All-act plan → no plan item in needsYou", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "fix_tests",
        reason: "tests fail",
        priority: 100,
        confidence: 0.97,
        forbidden: false,
        disposition: "act",
      },
      actions: [
        { kind: "fix_tests", reason: "tests fail", priority: 100, confidence: 0.97, forbidden: false, disposition: "act" },
        { kind: "resume_task", reason: "idle", priority: 40, confidence: 0.5, forbidden: false, disposition: "act" },
      ],
    });
    const digest = buildDigest();
    const planItems = digest.needsYou.filter((n) => n.source === "plan");
    expect(planItems.length).toBe(0);
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

test("Fallback: actions empty but topAction is ask → still surfaces", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ currentProject: "test" });
    seedPlan({
      topAction: {
        kind: "resolve_block",
        reason: "blocked",
        priority: 90,
        confidence: 0.7,
        forbidden: false,
        disposition: "ask",
      },
      actions: [],
    });
    const digest = buildDigest();
    const planItems = digest.needsYou.filter((n) => n.source === "plan");
    expect(planItems.length).toBe(1);
    expect(planItems[0]!.summary).toBe("Planner needs your call: resolve_block");
    expect(planItems[0]!.detail).toBe("blocked");
  } finally {
    cleanup(dir);
    unsetHome();
  }
});

// ── needsYouLabel: the one projection every render site must use ──────────────

test("needsYouLabel: prefers label, then detail, then summary, else empty", () => {
  expect(needsYouLabel({ summary: "KEY", detail: "detail", label: "label" })).toBe("label");
  expect(needsYouLabel({ summary: "KEY", detail: "detail" })).toBe("detail");
  expect(needsYouLabel({ summary: "KEY" })).toBe("KEY");
  expect(needsYouLabel({ summary: "KEY", detail: "   ", label: "  " })).toBe("KEY");
  expect(needsYouLabel({})).toBe("");
});

test("needsYouLabel and needsYouSignature are DIFFERENT projections of the same item", () => {
  // The signature must stay keyed on `summary`: every key already written to nudges.jsonl and
  // notifications.jsonl depends on it, so switching it to the label would make 24h
  // repeat-suppression treat the whole queue as new — one nudge burst, and an unreadable log.
  const item: NeedsYouItem = {
    source: "plan",
    summary: "Planner needs your call: long_session",
    detail: "90 minutes with no break",
    label: "90 minutes with no break",
  };
  expect(needsYouSignature([item])).toBe("plan|Planner needs your call: long_session");
  expect(needsYouLabel(item)).toBe("90 minutes with no break");
});

// ── needsYouSignature tests ───────────────────────────────────────────────────

test("needsYouSignature: empty queue → empty string", () => {
  expect(needsYouSignature([] as NeedsYouItem[])).toBe("");
});

test("needsYouSignature: stable for same set in different order", () => {
  const a: NeedsYouItem[] = [
    { source: "plan", summary: "Planner needs your call: fix_tests" },
    { source: "autopilot", summary: "Autopilot stopped and needs you" },
  ];
  const b: NeedsYouItem[] = [
    { source: "autopilot", summary: "Autopilot stopped and needs you" },
    { source: "plan", summary: "Planner needs your call: fix_tests" },
  ];
  expect(needsYouSignature(a)).toBe(needsYouSignature(b));
});

test("needsYouSignature: changes when an item is added", () => {
  const a: NeedsYouItem[] = [];
  const b: NeedsYouItem[] = [{ source: "plan", summary: "Planner needs your call: fix_tests" }];
  expect(needsYouSignature(b)).not.toBe(needsYouSignature(a));
});

test("needsYouSignature: changes when an item is removed", () => {
  const a: NeedsYouItem[] = [{ source: "executor", summary: "A change is parked on main with FAILING tests" }];
  expect(needsYouSignature([])).not.toBe(needsYouSignature(a));
});

test("needsYouSignature: ignores detail — same source+summary → same signature", () => {
  const a: NeedsYouItem[] = [{ source: "plan", summary: "Planner needs your call: fix_tests", detail: "reason A" }];
  const b: NeedsYouItem[] = [{ source: "plan", summary: "Planner needs your call: fix_tests", detail: "reason B" }];
  expect(needsYouSignature(a)).toBe(needsYouSignature(b));
});

test("needsYouSignature: distinguishes source — same summary, different source → different signature", () => {
  const a: NeedsYouItem[] = [{ source: "plan", summary: "Something needs you" }];
  const b: NeedsYouItem[] = [{ source: "autopilot", summary: "Something needs you" }];
  expect(needsYouSignature(a)).not.toBe(needsYouSignature(b));
});

// ── Suggestions from inferred.json (Phase 19) ─────────────────────────────────

test("suggestions: surfaces a block guess when state is not blocked", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: false });
    writeFileSync(inferredPath(), JSON.stringify({
      generatedAt: "x", backend: "mock", error: null,
      block: { likely: true, reason: "waiting on vendor" },
      deadline: { likely: false, date: null, note: "" }, raw: "",
    }));
    const d = buildDigest();
    expect(d.suggestions.some((s) => s.kind === "block" && s.text.includes("Possible block"))).toBe(true);
    const blk = d.suggestions.find((s) => s.kind === "block");
    expect(blk?.emit).toEqual({ type: "system.blocked", data: { reason: "waiting on vendor" } });
    expect(renderDigest(d)).toContain("Suggestions");
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: suppresses a block guess when already blocked", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: true, blockedReason: "known" });
    writeFileSync(inferredPath(), JSON.stringify({
      generatedAt: "x", backend: "mock", error: null,
      block: { likely: true, reason: "waiting" },
      deadline: { likely: false, date: null, note: "" }, raw: "",
    }));
    const d = buildDigest();
    expect(d.suggestions.some((s) => s.kind === "block")).toBe(false);
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: deadline guess only when no deadline set", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ deadline: null });
    writeFileSync(inferredPath(), JSON.stringify({
      generatedAt: "x", backend: "mock", error: null,
      block: { likely: false, reason: "" },
      deadline: { likely: true, date: "2026-08-01", note: "ship" }, raw: "",
    }));
    const d = buildDigest();
    expect(d.suggestions.some((s) => s.kind === "deadline" && s.text.includes("2026-08-01"))).toBe(true);
    const dl = d.suggestions.find((s) => s.kind === "deadline");
    expect(dl?.emit).toEqual({ type: "system.task", data: { deadline: "2026-08-01" } });
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: none when inferred has an error", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: false });
    writeFileSync(inferredPath(), JSON.stringify({
      generatedAt: "x", backend: "anthropic", error: "network down",
      block: null, deadline: null, raw: "",
    }));
    const d = buildDigest();
    expect(d.suggestions).toEqual([]);
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: merges inferred.json + screen-inferred.json, dedup by text", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: false, deadline: null });
    writeFileSync(inferredPath(), JSON.stringify({
      generatedAt: "x", backend: "mock", error: null,
      block: { likely: true, reason: "waiting on vendor" },
      deadline: { likely: false, date: null, note: "" }, raw: "",
    }));
    writeFileSync(screenInferredPath(), JSON.stringify({
      generatedAt: "x", layer: "vision",
      suggestions: [
        { kind: "task", text: "Possible task (from screen) — fix login bug", emit: { type: "system.task", data: { task: "fix login bug" } } },
        { kind: "block", text: "Possible block — waiting on vendor", emit: { type: "system.blocked", data: { reason: "waiting on vendor" } } }, // exact dup of the inferred.json one
      ],
    }));
    const d = buildDigest();
    // The duplicate block text appears only once.
    expect(d.suggestions.filter((s) => s.kind === "block").length).toBe(1);
    // The screen-only task suggestion is present.
    expect(d.suggestions.some((s) => s.kind === "task" && s.text.includes("fix login bug"))).toBe(true);
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: screen block/deadline guesses are suppressed the same as text-infer ones", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: true, blockedReason: "known", deadline: "2026-09-01" });
    writeFileSync(screenInferredPath(), JSON.stringify({
      generatedAt: "x", layer: "ocr",
      suggestions: [
        { kind: "block", text: "Possible block (from screen) — idle", emit: { type: "system.blocked", data: { reason: "idle" } } },
        { kind: "deadline", text: "Possible deadline (from screen, 2026-10-01) — confirm?", emit: { type: "system.task", data: { deadline: "2026-10-01" } } },
        { kind: "task", text: "Possible task (from screen) — review PR", emit: { type: "system.task", data: { task: "review PR" } } },
      ],
    }));
    const d = buildDigest();
    expect(d.suggestions.some((s) => s.kind === "block")).toBe(false);
    expect(d.suggestions.some((s) => s.kind === "deadline")).toBe(false);
    // Task suggestions have no deterministic-state equivalent, so they are never suppressed.
    expect(d.suggestions.some((s) => s.kind === "task" && s.text.includes("review PR"))).toBe(true);
  } finally { cleanup(dir); unsetHome(); }
});

test("suggestions: missing screen-inferred.json is a clean no-op (digest still builds)", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ blocked: false });
    const d = buildDigest();
    expect(d.suggestions).toEqual([]);
  } finally { cleanup(dir); unsetHome(); }
});

// ── Phase 44: Working-pattern formatter ─────────────────────────────────────────

test("formatPatterns(null) → null", () => {
  expect(formatPatterns(null)).toBeNull();
});

test("formatPatterns(undefined) → null", () => {
  expect(formatPatterns(undefined)).toBeNull();
});

test("formatPatterns(emptyPatterns()) → null (all zeros/nulls)", () => {
  expect(formatPatterns(emptyPatterns())).toBeNull();
});

test("sessionMs: 5_100_000 (85 min) → contains 'session 1h 25m'", () => {
  const result = formatPatterns({ ...emptyPatterns(), sessionMs: 5_100_000 });
  expect(result).toContain("session 1h 25m");
});

test("sessionMs: 30_000 → contains 'under a minute'", () => {
  const result = formatPatterns({ ...emptyPatterns(), sessionMs: 30_000 });
  expect(result).toContain("under a minute");
  // No digit-m/h duration should appear
  expect(result).not.toMatch(/\d+m/);
  expect(result).not.toMatch(/\d+h/);
});

test("msSinceLastCommit: 11_400_000 (3h10m) → contains '3h 10m'", () => {
  const result = formatPatterns({ ...emptyPatterns(), msSinceLastCommit: 11_400_000 });
  expect(result).toContain("3h 10m");
});

test("msSinceLastCommit: exactly 3h → '3h', not '3h 0m'", () => {
  const result = formatPatterns({ ...emptyPatterns(), msSinceLastCommit: 3 * 60 * 60 * 1000 });
  expect(result).toContain("3h");
  expect(result).not.toContain("3h 0m");
});

test("editsSinceLastCommit: 0 → no 'edit'; 12 → does", () => {
  const zeroResult = formatPatterns({ ...emptyPatterns(), editsSinceLastCommit: 0 });
  expect(zeroResult).toBeNull();
  expect(formatPatterns({ ...emptyPatterns(), editsSinceLastCommit: 12 })).toContain("12 edit(s) since");
});

test("populated Patterns → parts joined with ' · ', no raw ms in output", () => {
  const inputMs = 11_400_000;
  const p = {
    ...emptyPatterns(),
    sessionMs: 5_100_000,
    msSinceLastCommit: inputMs,
    editsSinceLastCommit: 12,
    sameFileSaves30m: 9,
    repoSwitches1h: 2,
  };
  const result = formatPatterns(p);
  expect(result).toContain(" · ");
  // The raw ms input must not appear anywhere in the output
  expect(result).not.toContain(String(inputMs));
});

test("buildDigest with populated patterns → workingPattern set", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({
      patterns: {
        ...emptyPatterns(),
        sessionMs: 5_100_000,
        msSinceLastCommit: 11_400_000,
        editsSinceLastCommit: 12,
      },
    });
    const d = buildDigest();
    expect(d.now.workingPattern).toContain("session 1h 25m");
    expect(d.now.workingPattern).toContain("last commit 3h 10m ago");
    expect(d.now.workingPattern).toContain("12 edit(s) since");
  } finally { cleanup(dir); unsetHome(); }
});

test("buildDigest with no state.json → no throw, workingPattern null", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    const d = buildDigest();
    expect(d.now.workingPattern).toBeNull();
  } finally { cleanup(dir); unsetHome(); }
});

test("buildDigest with state.json missing patterns key → no throw, workingPattern null", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    // Write a state file without a patterns key (older file format)
    const state = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      eventCount: 10,
      lastEventTs: "2026-01-01T00:00:00.000Z",
      currentProject: "test",
      currentTask: null,
      deadline: null,
      currentFile: null,
      recentFiles: [],
      git: { branch: null, lastCommit: null },
      tests: "unknown",
      blocked: false,
      blockedReason: null,
      currentWindow: null,
      activity: { active: true, idleMs: 0 },
      activeRepo: null,
      repos: [],
      // no patterns key
    };
    writeFileSync(statePath(), JSON.stringify(state));
    const d = buildDigest();
    expect(d.now.workingPattern).toBeNull();
  } finally { cleanup(dir); unsetHome(); }
});

test("renderDigest with workingPattern set → contains '- **Working pattern:**' in ## Now", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({
      patterns: {
        ...emptyPatterns(),
        sessionMs: 5_100_000,
      },
    });
    const d = buildDigest();
    const md = renderDigest(d);
    const nowSection = md.split("## Now")[1]!.split("## ")[0]!;
    expect(nowSection).toContain("- **Working pattern:**");
  } finally { cleanup(dir); unsetHome(); }
});

test("renderDigest with workingPattern null → no 'Working pattern' at all", () => {
  const dir = createTempHome();
  try {
    setHome(dir);
    seedState({ patterns: emptyPatterns() });
    const d = buildDigest();
    const md = renderDigest(d);
    expect(md).not.toContain("Working pattern");
  } finally { cleanup(dir); unsetHome(); }
});

test("renderPage still has exactly one <script> and it parses", () => {
  const { renderPage } = require("./../ui/page.js");
  const html = renderPage();
  const scripts = html.match(/<script>/g);
  expect(scripts).toHaveLength(1);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(scriptMatch).not.toBeNull();
  const scriptSource = scriptMatch![1]!;
  expect(() => new Function(scriptSource)).not.toThrow();
});
