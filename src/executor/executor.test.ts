// Unit tests for Phase 6: Executor.
// 100% OFFLINE — no network, no real LLM. Git tests use a temp git repo.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execRoot } from "../paths.js";
import type { Config } from "../config.js";
import type { ChangeSet, PlannedOp } from "./types.js";
import { execReportPath } from "../paths.js";
import { validateChangeSet } from "./validate.js";
import { planChangeSet } from "./plan.js";
import { applyChangeSet, writeReport } from "./executor.js";
import * as git from "./git.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "executive-test-executor-" + randomUUID());

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
    ...overrides,
  };
}

function makeChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "test-" + randomUUID().slice(0, 8),
    title: "Test change",
    ops: [{ op: "write", path: "test.txt", content: "hello" }],
    test: null,
    commitMessage: "test commit",
    ...overrides,
  };
}

// ─── Regression: malformed changeset must fail gracefully, never throw ─────────
// (planChangeSet reads cs.ops; a changeset missing `ops` used to crash before the
// validation gate returned. applyChangeSet now plans only when validation passes.)
describe("applyChangeSet — malformed input (regression)", () => {
  it("changeset missing ops fails gracefully without throwing", () => {
    const bad = { id: "x", title: "t", commitMessage: "c", test: null } as unknown as ChangeSet;
    let report: ReturnType<typeof applyChangeSet> | undefined;
    expect(() => {
      report = applyChangeSet(bad, { apply: false, repoRoot: process.cwd(), config: makeConfig() });
    }).not.toThrow();
    expect(report!.ok).toBe(false);
    expect(report!.plannedOps).toEqual([]);
    expect(report!.validation.errors.some((e) => e.includes("ops"))).toBe(true);
  });
});

/**
 * Create a temp git repo with an initial commit.
 * Returns { dir, cleanup }.
 */
function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), "executive-git-test-" + randomUUID());
  mkdirSync(dir, { recursive: true });

  // git init first, then checkout -b main
  const { spawnSync } = require("node:child_process");
  const initRes = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (initRes.status !== 0) {
    throw new Error("git init failed: " + (initRes.stderr || ""));
  }
  git.checkoutNewBranch(dir, "main");

  // Configure git locally
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Create an initial commit so there's a HEAD
  writeFileSync(join(dir, "INIT"), "initial");
  git.stageAll(dir);
  git.commit(dir, "initial commit");

  return { dir, cleanup: () => cleanup(dir) };
}

// ─── 1. Validation (pure) ─────────────────────────────────────────────────────

describe("validateChangeSet — well-formed", () => {
  it("returns ok:true for a valid ChangeSet", () => {
    const repoRoot = "/tmp";
    const cs = makeChangeSet();
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateChangeSet — path escape", () => {
  it("rejects ../outside.txt", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ ops: [{ op: "write", path: "../outside.txt", content: "x" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("../outside.txt");
  });
});

describe("validateChangeSet — absolute paths", () => {
  it("rejects /etc/x", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ ops: [{ op: "write", path: "/etc/x", content: "x" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("/etc/x");
  });

  it("rejects C:/x", () => {
    const repoRoot = "C:/Users/test";
    const cs = makeChangeSet({ ops: [{ op: "write", path: "C:/x", content: "x" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("C:/x");
  });
});

describe("validateChangeSet — protected directories", () => {
  it("rejects .git/config", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ ops: [{ op: "write", path: ".git/config", content: "x" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(".git");
  });

  it("rejects .executive/state.json", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ ops: [{ op: "write", path: ".executive/state.json", content: "x" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(".executive");
  });
});

describe("validateChangeSet — structural errors", () => {
  it("empty ops → ok:false", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ ops: [] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("ops");
  });

  it("empty id → ok:false", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ id: "" });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("id");
  });

  it("bad id with spaces and slashes → ok:false", () => {
    const repoRoot = "/tmp/repo";
    const cs = makeChangeSet({ id: "a b/c" });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("id");
  });

  it("write without content → ok:false", () => {
    const repoRoot = "/tmp/repo";
    // @ts-expect-error content is missing on purpose
    const cs = makeChangeSet({ ops: [{ op: "write", path: "x.txt" }] });
    const result = validateChangeSet(cs, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("content");
  });
});

// ─── 2. Plan (disk read, no mutation) ─────────────────────────────────────────

describe("planChangeSet — create over existing file", () => {
  it("wouldSucceed:false, note 'already exists'", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      writeFileSync(join(dir, "existing.txt"), "hello");
      const cs = makeChangeSet({
        id: "plan-test-1",
        ops: [{ op: "create", path: "existing.txt", content: "world" }],
      });
      const result = planChangeSet(cs, dir);
      expect(result.length).toBe(1);
      expect(result[0]!.wouldSucceed).toBe(false);
      expect(result[0]!.note).toBe("file already exists");
      expect(result[0]!.effect).toBe("create (blocked)");
    } finally {
      clean();
    }
  });
});

describe("planChangeSet — delete missing file", () => {
  it("wouldSucceed:false, note 'file does not exist'", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "plan-test-2",
        ops: [{ op: "delete", path: "nonexistent.txt" }],
      });
      const result = planChangeSet(cs, dir);
      expect(result.length).toBe(1);
      expect(result[0]!.wouldSucceed).toBe(false);
      expect(result[0]!.note).toBe("file does not exist");
      expect(result[0]!.effect).toBe("delete (blocked)");
    } finally {
      clean();
    }
  });
});

describe("planChangeSet — write over existing", () => {
  it("wouldSucceed:true, effect mentions 'overwrite'", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      writeFileSync(join(dir, "existing.txt"), "old content here");
      const cs = makeChangeSet({
        id: "plan-test-3",
        ops: [{ op: "write", path: "existing.txt", content: "new" }],
      });
      const result = planChangeSet(cs, dir);
      expect(result.length).toBe(1);
      expect(result[0]!.wouldSucceed).toBe(true);
      expect(result[0]!.effect).toContain("overwrite");
    } finally {
      clean();
    }
  });
});

// ─── 3. Dry-run (no mutation) ─────────────────────────────────────────────────

describe("applyChangeSet — dry-run", () => {
  it("mode:dry-run, branch:null, no mutation on disk", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({ id: "dry-test-1" });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: false, repoRoot: dir, config });

      expect(report.mode).toBe("dry-run");
      expect(report.branch).toBeNull();
      expect(report.ok).toBe(true);
      expect(report.plannedOps.length).toBe(1);

      // Git status is still clean
      expect(git.isWorkingTreeClean(dir)).toBe(true);

      // No executive/change-* branch exists
      expect(git.branchExists(dir, "executive/change-dry-test-1")).toBe(false);

      // Target file not created
      expect(existsSync(join(dir, "test.txt"))).toBe(false);
    } finally {
      clean();
    }
  });
});

// ─── 4. Apply (temp git repo) ─────────────────────────────────────────────────

describe("applyChangeSet — happy apply", () => {
  it("creates branch, applies ops, commits, returns to original branch", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "apply-test-1",
        ops: [{ op: "write", path: "new-file.txt", content: "new content" }],
        test: null,
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(true);
      expect(report.mode).toBe("apply");
      expect(report.branch).toBe("executive/change-apply-test-1");
      expect(report.committed).toBe(true);
      expect(report.commitSha).toBeTruthy();
      expect(typeof report.commitSha).toBe("string");
      expect((report.commitSha as string).length).toBeGreaterThan(0);

      // After the call, HEAD is back on original branch
      const currentBranch = git.currentBranch(dir);
      expect(currentBranch).toBe("main");

      // Original branch working tree is clean
      expect(git.isWorkingTreeClean(dir)).toBe(true);

      // Original branch does NOT contain the new file
      expect(existsSync(join(dir, "new-file.txt"))).toBe(false);

      // The branch contains the new file
      // We can verify by checking if the branch exists and has the file
      const branchFiles = gitBranchFiles(dir, report.branch!);
      expect(branchFiles).toContain("new-file.txt");
    } finally {
      clean();
    }
  });
});

/** List files tracked on a given branch (via git ls-tree). */
function gitBranchFiles(repoRoot: string, branch: string): string[] {
  const { spawnSync } = require("node:child_process");
  const res = spawnSync(
    "git",
    ["ls-tree", "--name-only", "-r", branch],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (res.status !== 0 || !res.stdout) return [];
  return (res.stdout as string)
    .trim()
    .split("\n")
    .filter(Boolean);
}

// ─── 5. Reversibility ─────────────────────────────────────────────────────────

describe("applyChangeSet — reversibility", () => {
  it("git branch -D executive/change-<id> succeeds and repo is pristine", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({ id: "rev-test-1" });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(true);
      expect(report.branch).toBe("executive/change-rev-test-1");

      // Delete the branch
      const { spawnSync } = require("node:child_process");
      const delRes = spawnSync("git", ["branch", "-D", report.branch!], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(delRes.status).toBe(0);

      // Branch no longer exists
      expect(git.branchExists(dir, "executive/change-rev-test-1")).toBe(false);

      // Repo is still clean
      expect(git.isWorkingTreeClean(dir)).toBe(true);
    } finally {
      clean();
    }
  });
});

// ─── 6. Dirty working tree ────────────────────────────────────────────────────

describe("applyChangeSet — dirty tree", () => {
  it("apply:true returns ok:false, message mentions dirty, no branch created", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      // Make the tree dirty
      writeFileSync(join(dir, "dirty.txt"), "uncommitted");

      const cs = makeChangeSet({ id: "dirty-test-1" });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(false);
      const dirtyMsg = report.messages.find((m) => m.toLowerCase().includes("dirty"));
      expect(dirtyMsg).toBeTruthy();

      // No branch created
      expect(git.branchExists(dir, "executive/change-dirty-test-1")).toBe(false);
    } finally {
      clean();
    }
  });
});

// ─── 7. Failing test command ──────────────────────────────────────────────────

describe("applyChangeSet — failing test", () => {
  it("testPassed:false, ok:false, committed:true, HEAD back on original", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "fail-test-1",
        test: "exit 1",
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.testPassed).toBe(false);
      expect(report.ok).toBe(false);
      expect(report.committed).toBe(true);
      expect(report.commitSha).toBeTruthy();

      // HEAD is back on original branch
      expect(git.currentBranch(dir)).toBe("main");

      // Branch still exists (parked)
      expect(git.branchExists(dir, "executive/change-fail-test-1")).toBe(true);
    } finally {
      clean();
    }
  });
});

// ─── 8. Not a git repo ────────────────────────────────────────────────────────

describe("applyChangeSet — not a git repo", () => {
  it("apply:true returns ok:false, message 'not a git repository', no mutation", () => {
    const dir = join(tmpdir(), "executive-no-git-" + randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
      const cs = makeChangeSet({ id: "no-git-test-1" });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(false);
      const gitMsg = report.messages.find((m) =>
        m.toLowerCase().includes("git repository")
      );
      expect(gitMsg).toBeTruthy();

      // No mutation
      expect(existsSync(join(dir, "test.txt"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── 9. Validation blocks apply ───────────────────────────────────────────────

describe("applyChangeSet — validation blocks apply", () => {
  it("invalid path → ok:false, no mutation", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "val-block-1",
        ops: [{ op: "write", path: "../../../escape.txt", content: "x" }],
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(false);
      expect(report.branch).toBeNull();
      expect(report.committed).toBe(false);
      expect(report.messages.find((m) => m.includes("validation failed"))).toBeTruthy();
    } finally {
      clean();
    }
  });
});

// ─── 10. writeReport persists atomically ───────────────────────────────────────

describe("writeReport — atomic persistence", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("execReportPath() exists and parses back correctly", () => {
    const report = {
      changeSetId: "report-test-1",
      title: "Test report",
      mode: "dry-run" as const,
      ok: true,
      validation: { ok: true, errors: [] },
      plannedOps: [{ op: "write" as const, path: "x.txt", effect: "create new file (5 bytes)", wouldSucceed: true }],
      branch: null,
      originalBranch: null,
      committed: false,
      commitSha: null,
      testCommand: null,
      testPassed: null,
      testOutput: null,
      messages: ["test message"],
      generatedAt: new Date().toISOString(),
    };

    writeReport(report);

    expect(existsSync(execRoot() + "/exec-report.json")).toBe(true);
    const latest = JSON.parse(readFileSync(execRoot() + "/exec-report.json", "utf-8"));
    expect(latest.changeSetId).toBe("report-test-1");
    expect(latest.ok).toBe(true);
  });
});

// ─── 11. Dry-run with blocked ops ─────────────────────────────────────────────

describe("applyChangeSet — dry-run with blocked ops", () => {
  it("ok:false when create would fail on existing file", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      writeFileSync(join(dir, "existing.txt"), "hello");
      const cs = makeChangeSet({
        id: "dry-block-1",
        ops: [{ op: "create", path: "existing.txt", content: "world" }],
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: false, repoRoot: dir, config });

      expect(report.mode).toBe("dry-run");
      expect(report.ok).toBe(false);
      expect(report.branch).toBeNull();
      expect(report.messages.find((m) => m.includes("blocked"))).toBeTruthy();
    } finally {
      clean();
    }
  });
});

// ─── 12. Apply with multiple ops ──────────────────────────────────────────────

describe("applyChangeSet — multiple ops", () => {
  it("applies all ops in order on the isolated branch", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "multi-test-1",
        ops: [
          { op: "write", path: "a.txt", content: "alpha" },
          { op: "write", path: "b.txt", content: "beta" },
        ],
        test: null,
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(true);
      expect(report.committed).toBe(true);

      // Both files on the branch
      const branchFiles = gitBranchFiles(dir, report.branch!);
      expect(branchFiles).toContain("a.txt");
      expect(branchFiles).toContain("b.txt");

      // Neither on original branch
      expect(existsSync(join(dir, "a.txt"))).toBe(false);
      expect(existsSync(join(dir, "b.txt"))).toBe(false);
    } finally {
      clean();
    }
  });
});

// ─── 13. Delete op ────────────────────────────────────────────────────────────

describe("applyChangeSet — delete op", () => {
  it("deletes an existing file on the isolated branch", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      // First commit a file to delete
      writeFileSync(join(dir, "to-delete.txt"), "delete me");
      git.stageAll(dir);
      git.commit(dir, "add file to delete");

      const cs = makeChangeSet({
        id: "del-test-1",
        ops: [{ op: "delete", path: "to-delete.txt" }],
        test: null,
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(true);
      expect(report.committed).toBe(true);

      // File still on original branch (we switched back)
      expect(existsSync(join(dir, "to-delete.txt"))).toBe(true);

      // But deleted on the change branch
      const branchFiles = gitBranchFiles(dir, report.branch!);
      expect(branchFiles).not.toContain("to-delete.txt");
    } finally {
      clean();
    }
  });
});

// ─── 14. Config branchPrefix ──────────────────────────────────────────────────

describe("applyChangeSet — custom branchPrefix", () => {
  it("uses config.executor.branchPrefix", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({ id: "prefix-test-1" });
      const config = makeConfig({ executor: { branchPrefix: "custom/" } });
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.ok).toBe(true);
      expect(report.branch).toBe("custom/prefix-test-1");
    } finally {
      clean();
    }
  });
});

// ─── 15. Test command that passes ─────────────────────────────────────────────

describe("applyChangeSet — passing test command", () => {
  it("testPassed:true, ok:true", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      const cs = makeChangeSet({
        id: "pass-test-1",
        test: "true",
      });
      const config = makeConfig();
      const report = applyChangeSet(cs, { apply: true, repoRoot: dir, config });

      expect(report.testPassed).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.committed).toBe(true);
    } finally {
      clean();
    }
  });
});
