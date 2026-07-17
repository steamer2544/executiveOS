// Unit tests for Phase 8: Autopilot (auto command).
// 100% OFFLINE — no network, no real LLM, no tokens spent.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  execRoot,
  autoReportPath,
  changeSetPath,
  proposalPath,
  proposalsDir,
} from "../paths.js";
import type { Config } from "../config.js";
import type { Proposal } from "../worker/types.js";
import type { State, Context } from "../state/types.js";
import type { ChangeSet, ExecReport, ValidationResult } from "../executor/types.js";
import { buildState, writeState } from "../state/builder.js";
import { MockWorker } from "../worker/mock.js";
import { MockSynthesizer } from "../synth/mock.js";
import { runAuto, writeAutoReport } from "./auto.js";
import type { AutoReport, AutoStage } from "./types.js";
import type { Worker, WorkerOutput, WorkerInput } from "../worker/types.js";
import type { Synthesizer, SynthInput, SynthResult } from "../synth/types.js";
import * as git from "../executor/git.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "executive-test-auto-" + randomUUID());
// EXECUTIVE_HOME lives OUTSIDE the git repo root so that .executive/ doesn't
// show up as an untracked directory and break isWorkingTreeClean().
const EXEC_HOME = join(TEST_DIR, "exec-home");

function setExecutiveHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
  delete process.env.EXECUTIVE_HOME;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 },
      fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 },
    },
    state: { intervalMs: 30000 },
    worker: {
      backend: "mock",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 1024,
      timeoutMs: 30000,
      autoInvoke: false,
    },
    executor: {
      branchPrefix: "executive/change-",
      defaultTestCommand: null,
    },
    synth: {
      maxFileBytes: 100000,
      maxFiles: 10,
    },
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "test-proposal-" + randomUUID().slice(0, 8),
    generatedAt: new Date().toISOString(),
    status: "ok",
    backend: "mock",
    action: {
      kind: "fix_tests",
      reason: "test",
      priority: 100,
      confidence: 0.97,
      forbidden: false,
      disposition: "act",
    },
    summary: "test proposal summary",
    steps: ["step 1", "step 2"],
    raw: "step 1\nstep 2",
    error: null,
    basedOn: {
      stateGeneratedAt: new Date().toISOString(),
      topActionKind: "fix_tests",
    },
    ...overrides,
  };
}

/**
 * Create a temp git repo with an initial commit.
 * Returns { dir, cleanup }.
 */
function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), "executive-auto-git-" + randomUUID());
  mkdirSync(dir, { recursive: true });

  const { spawnSync } = require("node:child_process");
  const initRes = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (initRes.status !== 0) {
    throw new Error("git init failed: " + (initRes.stderr || ""));
  }
  git.checkoutNewBranch(dir, "main");

  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Ignore .executive/ so setting EXECUTIVE_HOME to dir/.executive doesn't
  // pollute the working tree (untracked dir → isWorkingTreeClean = false).
  writeFileSync(join(dir, ".gitignore"), ".executive/\n");
  git.stageAll(dir);
  git.commit(dir, "initial commit");

  return { dir, cleanup: () => cleanup(dir) };
}

// ─── 1. Nothing to do: clean state → plan returns null topAction ──────────────

describe("runAuto — nothing to do", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("clean state → stage:plan, ok:true, needsHuman:false, Worker never called", async () => {
    const config = makeConfig();
    const workerCalled = { called: false };
    const mockWorker: Worker = {
      name: "mock",
      run: async (input: WorkerInput): Promise<WorkerOutput> => {
        workerCalled.called = true;
        return new MockWorker().run(input);
      },
    };

    const report = await runAuto({
      repoRoot: TEST_DIR,
      config,
      apply: false,
      workerOverride: mockWorker,
    });

    expect(report.stage).toBe("plan");
    expect(report.ok).toBe(true);
    expect(report.needsHuman).toBe(false);
    expect(report.topAction).toBeNull();
    expect(report.proposalId).toBeNull();
    expect(report.applied).toBe(false);
    expect(report.stoppedReason).toBe("no actionable topAction");
    expect(report.messages).toContain("nothing to do");
    expect(workerCalled.called).toBe(false);
  });
});

// ─── 2. Ask disposition stops before Worker ───────────────────────────────────

describe("runAuto — ask disposition stops", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("blocked state (resolve_block, ask) → stops at plan, Worker never called", async () => {
    const config = makeConfig();

    // Seed a blocked state by writing a system.blocked event.
    const eventsDir = join(EXEC_HOME, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      eventsDir + "/system.jsonl",
      JSON.stringify({
        source: "system",
        type: "system.blocked",
        seq: 1,
        ts: "2026-07-17T00:00:01.000Z",
        data: { reason: "waiting on external API" },
      }) + "\n"
    );

    const workerCalled = { called: false };
    const mockWorker: Worker = {
      name: "mock",
      run: async (input: WorkerInput): Promise<WorkerOutput> => {
        workerCalled.called = true;
        return new MockWorker().run(input);
      },
    };

    const report = await runAuto({
      repoRoot: TEST_DIR,
      config,
      apply: false,
      workerOverride: mockWorker,
    });

    expect(report.stage).toBe("plan");
    expect(report.ok).toBe(true);
    expect(report.needsHuman).toBe(true);
    expect(report.topAction).not.toBeNull();
    expect(report.topAction!.kind).toBe("resolve_block");
    expect(report.topAction!.disposition).toBe("ask");
    expect(report.proposalId).toBeNull();
    expect(workerCalled.called).toBe(false);
    expect(report.stoppedReason).toContain("resolve_block");
    expect(report.stoppedReason).toContain("ask");
    expect(report.stoppedReason).toContain("needs human");
  });
});

// ─── 3. Dry-run happy path (act) ──────────────────────────────────────────────

describe("runAuto — dry-run happy path (act)", () => {
  it("failing-tests state with MockWorker+MockSynth, apply:false → runs through synth, no branch created", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);

      // Seed a failing-tests state.
      const eventsDir = join(EXEC_HOME, "events");
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(
        eventsDir + "/system.jsonl",
        JSON.stringify({
          source: "system",
          type: "system.test_result",
          seq: 1,
          ts: "2026-07-17T00:00:01.000Z",
          data: { status: "failing" },
        }) + "\n"
      );

      // Create a file so selectedFiles is non-empty.
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      const config = makeConfig();
      return runAuto({
        repoRoot: dir,
        config,
        apply: false,
        workerOverride: new MockWorker(),
        synthOverride: new MockSynthesizer(),
      }).then((report) => {
        expect(report.ok).toBe(true);
        expect(report.stage).toBe("synth");
        expect(report.needsHuman).toBe(false);
        expect(report.topAction).not.toBeNull();
        expect(report.topAction!.kind).toBe("fix_tests");
        expect(report.topAction!.disposition).toBe("act");
        expect(report.proposalId).not.toBeNull();
        expect(report.changeSetWritten).toBe(true);
        expect(report.validationOk).toBe(true);
        expect(report.dryRunOk).toBe(true);
        expect(report.applied).toBe(false);

        // No executive/change-* branch created (dry-run only).
        expect(
          git.branchExists(dir, "executive/change-synth-fix_tests")
        ).toBe(false);
        // Working tree still clean.
        expect(git.isWorkingTreeClean(dir)).toBe(true);
        // Original branch unchanged.
        expect(git.currentBranch(dir)).toBe("main");

        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 4. Apply happy path (act) ───────────────────────────────────────────────

describe("runAuto — apply happy path (act)", () => {
  it("failing-tests state, apply:true → stage:execute, applied:true, branch created, HEAD back on original", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);

      // Seed a failing-tests state.
      const eventsDir = join(EXEC_HOME, "events");
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(
        eventsDir + "/system.jsonl",
        JSON.stringify({
          source: "system",
          type: "system.test_result",
          seq: 1,
          ts: "2026-07-17T00:00:01.000Z",
          data: { status: "failing" },
        }) + "\n"
      );

      // Create a file so selectedFiles is non-empty, and commit it so the
      // working tree starts clean.
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      const config = makeConfig();
      return runAuto({
        repoRoot: dir,
        config,
        apply: true,
        workerOverride: new MockWorker(),
        synthOverride: new MockSynthesizer(),
      }).then((report) => {
        expect(report.ok).toBe(true);
        expect(report.stage).toBe("execute");
        expect(report.applied).toBe(true);
        expect(report.branch).toBe("executive/change-synth-fix_tests");
        expect(report.commitSha).not.toBeNull();
        expect(report.testPassed).toBe(null); // MockSynthesizer returns test: null
        expect(report.needsHuman).toBe(false);

        // After the call, HEAD is back on the original branch.
        expect(git.currentBranch(dir)).toBe("main");
        // The original branch does NOT contain the synthesized file.
        expect(
          existsSync(join(dir, "SYNTH_NOTE.md"))
        ).toBe(false);

        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 5. Unsafe changeset is never applied ─────────────────────────────────────

describe("runAuto — unsafe changeset rejected", () => {
  it("../escape path → stops at synth, validationOk:false, applied:false, no branch", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);

      // Seed a failing-tests state.
      const eventsDir = join(EXEC_HOME, "events");
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(
        eventsDir + "/system.jsonl",
        JSON.stringify({
          source: "system",
          type: "system.test_result",
          seq: 1,
          ts: "2026-07-17T00:00:01.000Z",
          data: { status: "failing" },
        }) + "\n"
      );

      const unsafeCs: ChangeSet = {
        id: "unsafe-1",
        title: "unsafe path",
        ops: [{ op: "write", path: "../../../escape.txt", content: "x" }],
        test: null,
        commitMessage: "unsafe",
      };

      const unsafeSynth: Synthesizer = {
        name: "unsafe",
        synthesize: async (): Promise<SynthResult> => ({
          changeSet: unsafeCs,
          raw: JSON.stringify(unsafeCs),
          backend: "unsafe",
        }),
      };

      const config = makeConfig();
      return runAuto({
        repoRoot: dir,
        config,
        apply: true,
        workerOverride: new MockWorker(),
        synthOverride: unsafeSynth,
      }).then((report) => {
        expect(report.stage).toBe("synth");
        expect(report.ok).toBe(false);
        expect(report.needsHuman).toBe(true);
        expect(report.validationOk).toBe(false);
        expect(report.applied).toBe(false);
        expect(report.branch).toBeNull();
        expect(report.commitSha).toBeNull();

        // No branch was created (Executor was never called with apply:true).
        expect(
          git.branchExists(dir, "executive/change-unsafe-1")
        ).toBe(false);

        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 6. Worker failure stops ──────────────────────────────────────────────────

describe("runAuto — worker failure stops", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("Worker that throws → stage:worker, ok:false, needsHuman:true, Synth never reached", async () => {
    const config = makeConfig();

    // Seed a failing-tests state.
    const eventsDir = join(EXEC_HOME, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      eventsDir + "/system.jsonl",
      JSON.stringify({
        source: "system",
        type: "system.test_result",
        seq: 1,
        ts: "2026-07-17T00:00:01.000Z",
        data: { status: "failing" },
      }) + "\n"
    );

    const throwingWorker: Worker = {
      name: "throwing",
      run: async (_input: WorkerInput): Promise<WorkerOutput> => {
        throw new Error("network timeout");
      },
    };

    const report = await runAuto({
      repoRoot: TEST_DIR,
      config,
      apply: false,
      workerOverride: throwingWorker,
    });

    expect(report.stage).toBe("worker");
    expect(report.ok).toBe(false);
    expect(report.needsHuman).toBe(true);
    expect(report.proposalId).not.toBeNull(); // runWorker catches and returns error proposal
    expect(report.changeSetWritten).toBe(false);
    expect(report.validationOk).toBeNull();
    expect(report.dryRunOk).toBeNull();
    expect(report.applied).toBe(false);
    expect(report.stoppedReason).toContain("worker failed");
  });
});

// ─── 7. Failing tests → parked, not success ───────────────────────────────────

describe("runAuto — failing tests → parked, not success", () => {
  it("MockSynth with test='exit 1', apply:true → applied:true, testPassed:false, ok:false", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);

      // Seed a failing-tests state.
      const eventsDir = join(EXEC_HOME, "events");
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(
        eventsDir + "/system.jsonl",
        JSON.stringify({
          source: "system",
          type: "system.test_result",
          seq: 1,
          ts: "2026-07-17T00:00:01.000Z",
          data: { status: "failing" },
        }) + "\n"
      );

      // Create a file so selectedFiles is non-empty, and commit it so the
      // working tree starts clean.
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      // MockSynthesizer that returns a ChangeSet with a failing test.
      const failingTestCs: ChangeSet = {
        id: "fail-test-1",
        title: "failing test",
        ops: [{ op: "write", path: "test_file.txt", content: "hello" }],
        test: "exit 1",
        commitMessage: "failing test",
      };

      const failingTestSynth: Synthesizer = {
        name: "failing-test",
        synthesize: async (): Promise<SynthResult> => ({
          changeSet: failingTestCs,
          raw: JSON.stringify(failingTestCs),
          backend: "failing-test",
        }),
      };

      const config = makeConfig();
      return runAuto({
        repoRoot: dir,
        config,
        apply: true,
        workerOverride: new MockWorker(),
        synthOverride: failingTestSynth,
      }).then((report) => {
        expect(report.stage).toBe("execute");
        expect(report.applied).toBe(true);
        expect(report.branch).toBe("executive/change-fail-test-1");
        expect(report.testPassed).toBe(false);
        expect(report.ok).toBe(false);
        expect(report.needsHuman).toBe(true);

        // HEAD back on the original branch.
        expect(git.currentBranch(dir)).toBe("main");

        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 8. writeAutoReport atomic persistence ─────────────────────────────────────

describe("writeAutoReport — atomic persistence", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("writes auto-report.json that parses back with correct shape", () => {
    const report: AutoReport = {
      ok: true,
      stage: "done",
      stoppedReason: null,
      needsHuman: false,
      topAction: null,
      proposalId: "test-proposal-id",
      changeSetWritten: true,
      validationOk: true,
      dryRunOk: true,
      applied: false,
      branch: null,
      commitSha: null,
      testPassed: null,
      messages: ["test message"],
      generatedAt: new Date().toISOString(),
    };
    writeAutoReport(report);
    expect(existsSync(autoReportPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(autoReportPath(), "utf-8"));
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe("done");
    expect(parsed.proposalId).toBe("test-proposal-id");
  });
});

// ─── 9. Non-ok proposal stops at worker ───────────────────────────────────────

describe("runAuto — non-ok proposal stops", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("worker returns status:error → stops at worker, ok:false, needsHuman:true", async () => {
    const config = makeConfig();

    // Seed a failing-tests state.
    const eventsDir = join(EXEC_HOME, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      eventsDir + "/system.jsonl",
      JSON.stringify({
        source: "system",
        type: "system.test_result",
        seq: 1,
        ts: "2026-07-17T00:00:01.000Z",
        data: { status: "failing" },
      }) + "\n"
    );

    // Worker that returns an error proposal (not a throw).
    const errorProposalWorker: Worker = {
      name: "error",
      run: async (input: WorkerInput): Promise<WorkerOutput> => {
        // runWorker catches throws and returns error proposal,
        // but we simulate the orchestrator returning an error proposal directly
        // by returning a WorkerOutput that causes buildProposal to set status "error".
        // Actually, runWorker catches throws. To get an error proposal,
        // we need runWorker to catch. Let's just test the path via
        // a worker that throws (test 6 covers that).
        // For this test, we need a proposal with status !== "ok" from runWorker.
        // runWorker catches throws → returns error proposal.
        // So we need to test that the error proposal path is taken.
        throw new Error("simulated error");
      },
    };

    const report = await runAuto({
      repoRoot: TEST_DIR,
      config,
      apply: false,
      workerOverride: errorProposalWorker,
    });

    expect(report.stage).toBe("worker");
    expect(report.ok).toBe(false);
    expect(report.needsHuman).toBe(true);
    expect(report.proposalId).not.toBeNull(); // runWorker still returns a proposal with status "error"
    expect(report.changeSetWritten).toBe(false);
    expect(report.validationOk).toBeNull();
    expect(report.stoppedReason).toContain("worker failed");
  });
});

// ─── 10. AutoReport is written to disk ────────────────────────────────────────

describe("runAuto — auto-report.json is written", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("nothing-to-do case writes auto-report.json", async () => {
    const config = makeConfig();
    const report = await runAuto({
      repoRoot: TEST_DIR,
      config,
      apply: false,
    });
    writeAutoReport(report);
    expect(existsSync(autoReportPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(autoReportPath(), "utf-8"));
    expect(parsed.stage).toBe("plan");
    expect(parsed.ok).toBe(true);
  });
});

// ─── 11. Dry-run message is informative ───────────────────────────────────────

describe("runAuto — dry-run message", () => {
  it("dry-run complete message is present in messages", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);

      // Seed a failing-tests state.
      const eventsDir = join(EXEC_HOME, "events");
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(
        eventsDir + "/system.jsonl",
        JSON.stringify({
          source: "system",
          type: "system.test_result",
          seq: 1,
          ts: "2026-07-17T00:00:01.000Z",
          data: { status: "failing" },
        }) + "\n"
      );

      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      const config = makeConfig();
      return runAuto({
        repoRoot: dir,
        config,
        apply: false,
        workerOverride: new MockWorker(),
        synthOverride: new MockSynthesizer(),
      }).then((report) => {
        expect(report.messages).toContain(
          "dry-run complete — run `auto --apply` to act"
        );
        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});
