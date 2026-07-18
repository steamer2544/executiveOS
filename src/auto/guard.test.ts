// Tests for the Autopilot re-trigger guard (Phase 9).
// Pure, deterministic — no daemon, no network, no git.

import { describe, it, expect } from "bun:test";
import {
  computeSignature,
  shouldRunAutopilot,
  freshGuardState,
} from "./guard.js";
import type { Config } from "../config.js";
import type { State } from "../state/types.js";
import type { Plan } from "../planner/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config["autopilot"]>): Config {
  return {
    version: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    autopilot: {
      enabled: false,
      apply: false,
      cooldownMs: 300000,
      ...overrides,
    },
  } as Config;
}

function makeState(): State {
  return {
    generatedAt: "2025-01-01T00:00:00.000Z",
    eventCount: 10,
    lastEventTs: "2025-01-01T00:00:00.000Z",
    currentProject: "executive",
    currentTask: "Phase 9",
    deadline: null,
    currentFile: "src/auto/guard.ts",
    recentFiles: ["src/auto/guard.ts"],
    git: { branch: "main", lastCommit: null },
    tests: "failing",
    blocked: false,
    blockedReason: null,
    activity: { active: true, idleMs: 5000 },
  };
}

function makePlan(topAction: Plan["topAction"]): Plan {
  return {
    generatedAt: "2025-01-01T00:00:00.000Z",
    basedOnState: { generatedAt: "2025-01-01T00:00:00.000Z", eventCount: 10 },
    topAction,
    actions: topAction ? [topAction] : [],
    summary: topAction ? topAction.kind : "nothing",
  };
}

const ACT_ACTION: Plan["topAction"] = {
  kind: "fix_tests",
  reason: "tests are failing",
  priority: 100,
  confidence: 0.97,
  forbidden: false,
  disposition: "act",
};

const ASK_ACTION: Plan["topAction"] = {
  kind: "resolve_block",
  reason: "work is blocked",
  priority: 90,
  confidence: 0.8,
  forbidden: false,
  disposition: "ask",
};

const NOW = 1_000_000_000_000;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("computeSignature", () => {
  it("produces a well-formed string", () => {
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const sig = computeSignature(state, plan, 42);
    expect(sig).toBe("42|fix_tests|act");
  });

  it("uses 'none' when topAction is null", () => {
    const state = makeState();
    const plan = makePlan(null);
    const sig = computeSignature(state, plan, 7);
    expect(sig).toBe("7|none|none");
  });

  it("is stable for identical inputs", () => {
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const a = computeSignature(state, plan, 42);
    const b = computeSignature(state, plan, 42);
    expect(a).toBe(b);
  });

  it("changes when latestSeq changes", () => {
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    expect(computeSignature(state, plan, 1)).not.toBe(computeSignature(state, plan, 2));
  });

  it("changes when kind changes", () => {
    const state = makeState();
    const planA = makePlan(ACT_ACTION);
    const planB = makePlan({ ...ASK_ACTION, kind: "review_deadline" });
    expect(computeSignature(state, planA, 1)).not.toBe(computeSignature(state, planB, 1));
  });

  it("changes when disposition changes", () => {
    const state = makeState();
    const planAct = makePlan({ ...ACT_ACTION, disposition: "act" });
    const planAsk = makePlan({ ...ACT_ACTION, disposition: "ask" });
    expect(computeSignature(state, planAct, 1)).not.toBe(computeSignature(state, planAsk, 1));
  });
});

describe("shouldRunAutopilot", () => {
  it("disabled → never runs (explicit false)", () => {
    const config = makeConfig({ enabled: false });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    const decision = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe("autopilot disabled");
  });

  it("disabled → never runs (no autopilot block)", () => {
    const config = {
      version: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
    } as Config;
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    const decision = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe("autopilot disabled");
  });

  it("non-actionable (null topAction) → skip", () => {
    const config = makeConfig({ enabled: true });
    const state = makeState();
    const plan = makePlan(null);
    const guard = freshGuardState();
    const decision = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("nothing to act on");
  });

  it("non-actionable (ask disposition) → skip", () => {
    const config = makeConfig({ enabled: true });
    const state = makeState();
    const plan = makePlan(ASK_ACTION);
    const guard = freshGuardState();
    const decision = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("nothing to act on");
  });

  it("fresh actionable → runs", () => {
    const config = makeConfig({ enabled: true });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    const decision = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe("act: fix_tests");
    expect(decision.signature).toBe("10|fix_tests|act");
  });

  it("dedup → skip when same signature", () => {
    const config = makeConfig({ enabled: true });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    // First run
    const d1 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d1.run).toBe(true);
    // Update guard as the daemon would
    guard.lastActedSignature = d1.signature;
    guard.lastActedAt = NOW;
    // Second tick, same state
    const d2 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d2.run).toBe(false);
    expect(d2.reason).toBe("already acted on this state");
  });

  it("new seq bypasses dedup → runs", () => {
    const config = makeConfig({ enabled: true, cooldownMs: 1000 });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    // First run at seq 10
    const d1 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d1.run).toBe(true);
    guard.lastActedSignature = d1.signature;
    guard.lastActedAt = NOW;
    // New event → seq 11, same action, cooldown elapsed
    const d2 = shouldRunAutopilot({ config, state, plan, latestSeq: 11, guard, now: NOW + 2000 });
    expect(d2.run).toBe(true);
    expect(d2.signature).toBe("11|fix_tests|act");
  });

  it("cooldown blocks → skip", () => {
    const config = makeConfig({ enabled: true, cooldownMs: 60000 });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    // First run
    const d1 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d1.run).toBe(true);
    guard.lastActedSignature = d1.signature;
    guard.lastActedAt = NOW;
    // Second tick, different signature but within cooldown
    const d2 = shouldRunAutopilot({ config, state, plan, latestSeq: 11, guard, now: NOW + 30000 });
    expect(d2.run).toBe(false);
    expect(d2.reason).toContain("cooldown");
  });

  it("cooldown elapsed → runs", () => {
    const config = makeConfig({ enabled: true, cooldownMs: 60000 });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    // First run
    const d1 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d1.run).toBe(true);
    guard.lastActedSignature = d1.signature;
    guard.lastActedAt = NOW;
    // After cooldown
    const d2 = shouldRunAutopilot({ config, state, plan, latestSeq: 11, guard, now: NOW + 60000 });
    expect(d2.run).toBe(true);
  });

  it("dedup precedence over cooldown", () => {
    const config = makeConfig({ enabled: true, cooldownMs: 60000 });
    const state = makeState();
    const plan = makePlan(ACT_ACTION);
    const guard = freshGuardState();
    // First run
    const d1 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW });
    expect(d1.run).toBe(true);
    guard.lastActedSignature = d1.signature;
    guard.lastActedAt = NOW;
    // Same signature AND within cooldown → dedup wins
    const d2 = shouldRunAutopilot({ config, state, plan, latestSeq: 10, guard, now: NOW + 30000 });
    expect(d2.run).toBe(false);
    expect(d2.reason).toBe("already acted on this state");
  });
});
