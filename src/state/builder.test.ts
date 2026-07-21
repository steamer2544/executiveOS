// Unit tests for Phase 3: State Builder.
// Covers buildState derivation, writeState atomic writes, and edge cases.
// Uses EXECUTIVE_HOME to isolate tests in a temp directory.

import {
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrap } from "../bootstrap.js";
import { append, read } from "../events/store.js";
import { execRoot, eventLogPath } from "../paths.js";
import { buildState, writeState, taskFromBranch } from "./builder.js";
import { statePath, contextPath } from "../paths.js";
import type { EventSource } from "../events/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_DIR = "/tmp/executive-test-state-" + randomUUID();

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

/**
 * Write a raw event line directly to a source's JSONL file.
 * Bypasses nextSeq so we can control seq values precisely.
 */
function writeRawEvent(source: EventSource, seq: number, type: string, data: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const event = { seq, id: randomUUID(), ts, source, type, data };
  const dir = eventLogPath(source).substring(0, eventLogPath(source).lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(eventLogPath(source), JSON.stringify(event) + "\n", { flag: "a" });
}

// ─── 1. empty ───────────────────────────────────────────────────────────────

describe("buildState — empty", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns defaults with no events", () => {
    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    expect(state.eventCount).toBe(0);
    expect(state.lastEventTs).toBeNull();
    expect(state.currentFile).toBeNull();
    expect(state.recentFiles).toEqual([]);
    expect(state.git.branch).toBeNull();
    expect(state.git.lastCommit).toBeNull();
    expect(state.tests).toBe("unknown");
    expect(state.blocked).toBe(false);
    expect(state.blockedReason).toBeNull();
    expect(state.currentProject).toBeNull();
    expect(state.currentTask).toBeNull();
    expect(state.deadline).toBeNull();
    expect(state.activity.active).toBe(false);
    expect(state.activity.idleMs).toBeNull();
  });
});

// ─── 2. currentFile / recentFiles ───────────────────────────────────────────

describe("buildState — currentFile / recentFiles", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("derives currentFile and recentFiles from editor.save events", () => {
    // seq 1-7: editor.save events, some duplicates
    writeRawEvent("editor", 1, "editor.save", { path: "src/a.ts" });
    writeRawEvent("editor", 2, "editor.save", { path: "src/b.ts" });
    writeRawEvent("editor", 3, "editor.save", { path: "src/a.ts" });
    writeRawEvent("editor", 4, "editor.save", { path: "src/c.ts" });
    writeRawEvent("editor", 5, "editor.save", { path: "src/d.ts" });
    writeRawEvent("editor", 6, "editor.save", { path: "src/e.ts" });
    writeRawEvent("editor", 7, "editor.save", { path: "src/f.ts" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentFile).toBe("src/f.ts");
    // Distinct newest→oldest, max 5. a.ts appears at seq 3 (newer than b.ts at seq 2),
    // so the walk sees f,e,d,c,a (b.ts at seq 2 is skipped because a.ts at seq 3 already
    // claimed that path — wait, they're different paths. b.ts is still distinct.)
    // Actually: walk newest→oldest: f(7), e(6), d(5), c(4), a(3), b(2), a(1).
    // Distinct: f, e, d, c, a → b is 6th distinct, cut off.
    expect(state.recentFiles).toEqual(["src/f.ts", "src/e.ts", "src/d.ts", "src/c.ts", "src/a.ts"]);
  });
});

// ─── 3. git derivation ──────────────────────────────────────────────────────

describe("buildState — git derivation", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("derives git.lastCommit and git.branch correctly", () => {
    // seq 1: commit on main
    writeRawEvent("git", 1, "git.commit", { sha: "aaa111", subject: "first commit", branch: "main" });
    // seq 2: branch switch to feature
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feature" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.git.lastCommit).toEqual({
      sha: "aaa111",
      subject: "first commit",
      ts: expect.any(String),
    });
    // branch_switch (seq 2) is newer than commit (seq 1), so branch = "feature"
    expect(state.git.branch).toBe("feature");
  });

  it("commit.branch wins when it is newer than branch_switch", () => {
    // seq 1: branch switch to develop
    writeRawEvent("git", 1, "git.branch_switch", { from: "main", to: "develop" });
    // seq 2: commit on feature (newer than branch_switch)
    writeRawEvent("git", 2, "git.commit", { sha: "bbb222", subject: "work", branch: "feature" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    expect(state.git.branch).toBe("feature");
  });
});

// ─── 4. newest-wins for system fields ───────────────────────────────────────

describe("buildState — newest-wins for system fields", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("tests: newest system.test_result wins", () => {
    writeRawEvent("system", 1, "system.test_result", { status: "failing" });
    writeRawEvent("system", 2, "system.test_result", { status: "passing" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    expect(state.tests).toBe("passing");
  });

  it("blocked/unblocked: newest wins", () => {
    // seq 1: blocked
    writeRawEvent("system", 1, "system.blocked", { reason: "x" });
    // seq 2: unblocked
    writeRawEvent("system", 2, "system.unblocked", {});

    let { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    expect(state.blocked).toBe(false);
    expect(state.blockedReason).toBeNull();

    // seq 3: blocked again
    writeRawEvent("system", 3, "system.blocked", { reason: "y" });

    ({ state } = buildState(new Date("2026-07-17T00:00:00.000Z")));
    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toBe("y");
  });
});

// ─── 5. system.task ─────────────────────────────────────────────────────────

describe("buildState — system.task", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("derives currentProject, currentTask, deadline from system.task", () => {
    writeRawEvent("system", 1, "system.task", {
      project: "my-project",
      task: "fix login bug",
      deadline: "tomorrow",
    });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentProject).toBe("my-project");
    expect(state.currentTask).toBe("fix login bug");
    expect(state.deadline).toBe("tomorrow");
  });
});

// ─── 6. activity ────────────────────────────────────────────────────────────

describe("buildState — activity", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("active when lastEventTs within 5 min of now", () => {
    const now = new Date("2026-07-17T00:05:00.000Z");
    const oneMinAgo = new Date("2026-07-17T00:04:00.000Z").toISOString();
    const fs = require("node:fs");
    const dir = eventLogPath("editor").substring(0, eventLogPath("editor").lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({
      seq: 1,
      id: randomUUID(),
      ts: oneMinAgo,
      source: "editor",
      type: "editor.save",
      data: { path: "x.ts" },
    });
    fs.writeFileSync(eventLogPath("editor"), content + "\n");

    const { state } = buildState(now);
    expect(state.activity.active).toBe(true);
    expect(state.activity.idleMs).toBeCloseTo(60_000, 0);
  });

  it("idle when lastEventTs more than 5 min before now", () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const tenMinAgo = new Date("2026-07-16T23:50:00.000Z").toISOString();
    const fs = require("node:fs");
    const dir = eventLogPath("editor").substring(0, eventLogPath("editor").lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({
      seq: 1,
      id: randomUUID(),
      ts: tenMinAgo,
      source: "editor",
      type: "editor.save",
      data: { path: "x.ts" },
    });
    fs.writeFileSync(eventLogPath("editor"), content + "\n");

    const { state } = buildState(now);
    expect(state.activity.active).toBe(false);
    expect(state.activity.idleMs).toBeCloseTo(600_000, 0);
  });
});

// ─── 7. malformed data doesn't throw ────────────────────────────────────────

describe("buildState — malformed data doesn't throw", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("editor.save with no path field is skipped gracefully", () => {
    const fs = require("node:fs");
    const dir = eventLogPath("editor").substring(0, eventLogPath("editor").lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({
      seq: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      source: "editor",
      type: "editor.save",
      data: {},
    });
    fs.writeFileSync(eventLogPath("editor"), content + "\n");

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    expect(state.currentFile).toBeNull();
    expect(state.recentFiles).toEqual([]);
  });
});

// ─── 8. writeState round-trips ──────────────────────────────────────────────

describe("writeState round-trips", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("creates valid JSON at statePath and contextPath", () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const built = buildState(now);
    writeState(built);

    // Both files exist
    expect(existsSync(statePath())).toBe(true);
    expect(existsSync(contextPath())).toBe(true);

    // Re-read and parse
    const stateJson = JSON.parse(readFileSync(statePath(), "utf-8"));
    const contextJson = JSON.parse(readFileSync(contextPath(), "utf-8"));

    // context.state deep-equals state
    expect(contextJson.state).toEqual(stateJson);

    // context.recentEvents length <= 20
    expect(contextJson.recentEvents.length).toBeLessThanOrEqual(20);

    // generatedAt matches
    expect(stateJson.generatedAt).toBe("2026-07-17T00:00:00.000Z");
    expect(contextJson.generatedAt).toBe("2026-07-17T00:00:00.000Z");
  });

  it("recentEvents is seq-ascending", () => {
    // Write some events
    writeRawEvent("editor", 1, "editor.save", { path: "a.ts" });
    writeRawEvent("git", 2, "git.commit", { sha: "abc", subject: "wip", branch: "main" });
    writeRawEvent("system", 3, "system.task", { project: "P", task: "T" });

    const { state, context } = buildState(new Date("2026-07-17T00:00:00.000Z"));
    writeState({ state, context });

    const contextJson = JSON.parse(readFileSync(contextPath(), "utf-8"));
    const seqs = contextJson.recentEvents.map((e: { seq: number }) => e.seq);
    // Must be ascending
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

// ── taskFromBranch (Phase 15: auto-task from git branch) ──────────────────────

describe("taskFromBranch", () => {
  it("humanizes a prefixed branch", () => {
    expect(taskFromBranch("feat/login-page")).toBe("login page");
  });
  it("strips only recognized type prefixes", () => {
    expect(taskFromBranch("fix/JIRA-12-null-crash")).toBe("JIRA 12 null crash");
    expect(taskFromBranch("yiw/experiment-thing")).toBe("yiw experiment thing");
  });
  it("returns null for default branches", () => {
    for (const b of ["main", "master", "develop", "MAIN"]) {
      expect(taskFromBranch(b)).toBeNull();
    }
  });
  it("returns null for empty/null/prefix-only", () => {
    expect(taskFromBranch(null)).toBeNull();
    expect(taskFromBranch("")).toBeNull();
    expect(taskFromBranch("feat/")).toBeNull();
  });
  it("keeps a plain non-default branch as the task", () => {
    expect(taskFromBranch("experiment")).toBe("experiment");
  });
});

describe("buildState — task inferred from branch", () => {
  const DIR = "/tmp/executive-test-taskbranch-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("fills currentTask from branch when no system.task exists", () => {
    writeRawEvent("git", 1, "git.branch_switch", { to: "feat/login-page" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.git.branch).toBe("feat/login-page");
    expect(state.currentTask).toBe("login page");
  });

  it("explicit system.task wins over the branch inference", () => {
    writeRawEvent("git", 1, "git.branch_switch", { to: "feat/login-page" });
    writeRawEvent("system", 2, "system.task", { task: "the real task" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentTask).toBe("the real task");
  });

  it("stays null on a default branch", () => {
    writeRawEvent("git", 1, "git.branch_switch", { to: "main" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentTask).toBeNull();
  });
});

describe("buildState — project inferred from git repo", () => {
  const DIR = "/tmp/executive-test-project-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("fills currentProject from a git.commit repo tag when no system.task", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "abc", subject: "x", branch: "main", repo: "myshi" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentProject).toBe("myshi");
  });

  it("uses the newest git event's repo", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "a", subject: "x", branch: "main", repo: "old-repo" });
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feat/x", repo: "new-repo" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentProject).toBe("new-repo");
  });

  it("explicit system.task project wins over the repo inference", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "a", subject: "x", branch: "main", repo: "myshi" });
    writeRawEvent("system", 2, "system.task", { project: "explicit-project" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentProject).toBe("explicit-project");
  });
});

// ── 9. Multi-repo: activeRepo + repos ──────────────────────────────────────

describe("buildState — multi-repo: single-repo unchanged", () => {
  const DIR = "/tmp/executive-test-multirepo-single-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("single-repo log produces identical git/project/task + additive repo fields", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "abc111", subject: "init", branch: "main", repo: "myrepo" });
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feat/login", repo: "myrepo" });
    writeRawEvent("editor", 3, "editor.save", { path: "src/main.ts", repo: "myrepo" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));

    // New fields
    expect(state.activeRepo).toBe("myrepo");
    expect(state.repos).toHaveLength(1);
    expect(state.repos[0]!.name).toBe("myrepo");
    expect(state.repos[0]!.branch).toBe("feat/login");
    expect(state.repos[0]!.lastCommit).toEqual({
      sha: "abc111",
      subject: "init",
      ts: expect.any(String),
    });
    expect(state.repos[0]!.lastActivityTs).toBeDefined();

    // Existing fields must match the pre-multi-repo derivation
    expect(state.git.branch).toBe("feat/login");
    expect(state.git.lastCommit).toEqual({
      sha: "abc111",
      subject: "init",
      ts: expect.any(String),
    });
    expect(state.currentProject).toBe("myrepo");
    expect(state.currentTask).toBe("login");
  });
});

describe("buildState — multi-repo: two repos, active = newest", () => {
  const DIR = "/tmp/executive-test-multirepo-two-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("activeRepo = repo with highest-seq event; branch matches active repo", () => {
    // Repo A events
    writeRawEvent("git", 1, "git.commit", { sha: "aaa", subject: "A1", branch: "main", repo: "A" });
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feat/a", repo: "A" });
    // Repo B events (newest overall)
    writeRawEvent("git", 3, "git.commit", { sha: "bbb", subject: "B1", branch: "develop", repo: "B" });
    writeRawEvent("git", 4, "git.branch_switch", { from: "develop", to: "feat/b", repo: "B" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));

    expect(state.activeRepo).toBe("B");
    expect(state.git.branch).toBe("feat/b");
    expect(state.currentProject).toBe("B");
    expect(state.repos).toHaveLength(2);
    // B first (newer activity at seq 4 vs A's seq 2)
    expect(state.repos[0]!.name).toBe("B");
    expect(state.repos[0]!.branch).toBe("feat/b");
    expect(state.repos[1]!.name).toBe("A");
    expect(state.repos[1]!.branch).toBe("feat/a");
  });
});

describe("buildState — multi-repo: active flips on new activity", () => {
  const DIR = "/tmp/executive-test-multirepo-flip-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("Project and Branch move together when active repo changes", () => {
    // Initial: B is active (seq 4)
    writeRawEvent("git", 1, "git.commit", { sha: "aaa", subject: "A1", branch: "main", repo: "A" });
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feat/a", repo: "A" });
    writeRawEvent("git", 3, "git.commit", { sha: "bbb", subject: "B1", branch: "develop", repo: "B" });
    writeRawEvent("git", 4, "git.branch_switch", { from: "develop", to: "feat/b", repo: "B" });

    let { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.activeRepo).toBe("B");
    expect(state.git.branch).toBe("feat/b");
    expect(state.currentProject).toBe("B");

    // Append: A gets a newer commit (seq 5)
    writeRawEvent("git", 5, "git.commit", { sha: "aaa2", subject: "A2", branch: "feat/a", repo: "A" });

    ({ state } = buildState(new Date("2026-01-01T00:00:10.000Z")));
    expect(state.activeRepo).toBe("A");
    expect(state.git.branch).toBe("feat/a");
    expect(state.currentProject).toBe("A");
  });
});

describe("buildState — multi-repo: explicit system.task wins", () => {
  const DIR = "/tmp/executive-test-multirepo-explicit-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("system.task overrides currentProject/currentTask regardless of activeRepo", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "a", subject: "x", branch: "main", repo: "A" });
    writeRawEvent("git", 2, "git.branch_switch", { from: "main", to: "feat/a", repo: "A" });
    writeRawEvent("git", 3, "git.commit", { sha: "b", subject: "y", branch: "develop", repo: "B" });
    writeRawEvent("git", 4, "git.branch_switch", { from: "develop", to: "feat/b", repo: "B" });
    writeRawEvent("system", 5, "system.task", { project: "X", task: "manual task" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));

    // activeRepo still follows the newest repo-tagged event (seq 4 = B)
    expect(state.activeRepo).toBe("B");
    // But explicit task overrides project/task
    expect(state.currentProject).toBe("X");
    expect(state.currentTask).toBe("manual task");
  });
});

describe("buildState — multi-repo: file-save repo tagging", () => {
  const DIR = "/tmp/executive-test-multirepo-fs-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("activeRepo can be set purely from an editor.save with data.repo", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "a", subject: "x", branch: "main", repo: "A" });
    writeRawEvent("editor", 2, "editor.save", { path: "src/x.ts", repo: "B" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));

    expect(state.activeRepo).toBe("B");
    // B has no git events, so branch is null
    expect(state.git.branch).toBeNull();
    expect(state.currentProject).toBe("B");
  });
});

describe("buildState — multi-repo: state.repos shape and sort", () => {
  const DIR = "/tmp/executive-test-multirepo-shape-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("repos array has all four fields and is sorted by lastActivityTs desc", () => {
    const now = new Date("2026-01-01T00:00:10.000Z");

    // Write events with distinct timestamps by writing raw JSONL directly.
    const gitDir = eventLogPath("git").substring(0, eventLogPath("git").lastIndexOf("/"));
    mkdirSync(gitDir, { recursive: true });
    // Realistic: seq increases with ts (events are appended in time order).
    // Repo A: oldest activity (seq 1, ts 01)
    writeFileSync(eventLogPath("git"), JSON.stringify({ seq: 1, id: randomUUID(), ts: "2026-01-01T00:00:01.000Z", source: "git", type: "git.commit", data: { sha: "aaa", subject: "A1", branch: "main", repo: "A" } }) + "\n", { flag: "w" });
    // Repo B: middle activity (seq 2, ts 05)
    writeFileSync(eventLogPath("git"), JSON.stringify({ seq: 2, id: randomUUID(), ts: "2026-01-01T00:00:05.000Z", source: "git", type: "git.commit", data: { sha: "bbb", subject: "B1", branch: "main", repo: "B" } }) + "\n", { flag: "a" });
    // Repo C: newest activity (seq 3, ts 08)
    writeFileSync(eventLogPath("git"), JSON.stringify({ seq: 3, id: randomUUID(), ts: "2026-01-01T00:00:08.000Z", source: "git", type: "git.commit", data: { sha: "ccc", subject: "C1", branch: "main", repo: "C" } }) + "\n", { flag: "a" });

    const { state } = buildState(now);

    expect(state.repos).toHaveLength(3);

    // Verify all four fields exist on each entry
    for (const r of state.repos) {
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("branch");
      expect(r).toHaveProperty("lastCommit");
      expect(r).toHaveProperty("lastActivityTs");
      expect(typeof r.name).toBe("string");
      expect(r.lastCommit).toHaveProperty("sha");
      expect(r.lastCommit).toHaveProperty("subject");
      expect(r.lastCommit).toHaveProperty("ts");
    }

    // Sorted newest-first by latestActivitySeq (== ts order here): C (3) > B (2) > A (1)
    expect(state.repos[0]!.name).toBe("C");
    expect(state.repos[1]!.name).toBe("B");
    expect(state.repos[2]!.name).toBe("A");
    // repos[0] must equal activeRepo (highest-seq repo-tagged event)
    expect(state.activeRepo).toBe("C");
  });
});

// ── 10. currentWindow derivation (Phase 28) ────────────────────────────────

describe("buildState — currentWindow derivation", () => {
  const DIR = "/tmp/executive-test-currentwindow-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("null when no screen.window events exist", () => {
    writeRawEvent("git", 1, "git.commit", { sha: "abc", subject: "x", branch: "main" });
    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentWindow).toBeNull();
  });

  it("equals the newest screen.window event when present", () => {
    writeRawEvent("screen", 1, "screen.window", { title: "Chrome", app: "chrome" });
    writeRawEvent("screen", 2, "screen.window", { title: "VS Code", app: "code" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentWindow).toEqual({ title: "VS Code", app: "code" });
  });

  it("newest wins even when mixed with other event types", () => {
    writeRawEvent("editor", 1, "editor.save", { path: "src/a.ts" });
    writeRawEvent("screen", 2, "screen.window", { title: "Slack", app: "slack" });
    writeRawEvent("git", 3, "git.commit", { sha: "def", subject: "y", branch: "main" });
    writeRawEvent("screen", 4, "screen.window", { title: "Trello", app: "chrome" });

    const { state } = buildState(new Date("2026-01-01T00:00:10.000Z"));
    expect(state.currentWindow).toEqual({ title: "Trello", app: "chrome" });
  });
});
