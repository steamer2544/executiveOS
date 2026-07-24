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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrap } from "../bootstrap.js";
import { append, read } from "../events/store.js";
import { execRoot, eventLogPath } from "../paths.js";
import { buildState, writeState, taskFromBranch, BLOCKED_TTL_MS, MANUAL_TASK_TTL_MS } from "./builder.js";
import { updateAutonomyConfig } from "../config.js";
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

/**
 * Like writeRawEvent but with an EXPLICIT ts — needed to exercise Phase 39 decay
 * (writeRawEvent stamps ts=now, which can never be "stale" against a past test clock).
 */
function writeRawEventAt(
  source: EventSource, seq: number, type: string, data: Record<string, unknown>, ts: string,
): void {
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
    // Create real files under TEST_DIR so fileStillExists finds them (cwd fallback).
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of files) {
      const fullPath = join(TEST_DIR, f);
      mkdirSync(join(TEST_DIR, f.substring(0, f.lastIndexOf("/"))), { recursive: true });
      writeFileSync(fullPath, "// " + f + "\n");
    }
    // seq 1-7: editor.save events, some duplicates — use absolute paths so existsSync finds them.
    writeRawEvent("editor", 1, "editor.save", { path: join(TEST_DIR, "src/a.ts") });
    writeRawEvent("editor", 2, "editor.save", { path: join(TEST_DIR, "src/b.ts") });
    writeRawEvent("editor", 3, "editor.save", { path: join(TEST_DIR, "src/a.ts") });
    writeRawEvent("editor", 4, "editor.save", { path: join(TEST_DIR, "src/c.ts") });
    writeRawEvent("editor", 5, "editor.save", { path: join(TEST_DIR, "src/d.ts") });
    writeRawEvent("editor", 6, "editor.save", { path: join(TEST_DIR, "src/e.ts") });
    writeRawEvent("editor", 7, "editor.save", { path: join(TEST_DIR, "src/f.ts") });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    const base = join(TEST_DIR, "src");
    expect(state.currentFile).toBe(join(base, "f.ts"));
    // Distinct newest→oldest, max 5. a.ts appears at seq 3 (newer than b.ts at seq 2),
    // so the walk sees f,e,d,c,a (b.ts at seq 2 is skipped because a.ts at seq 3 already
    // claimed that path — wait, they're different paths. b.ts is still distinct.)
    // Actually: walk newest→oldest: f(7), e(6), d(5), c(4), a(3), b(2), a(1).
    // Distinct: f, e, d, c, a → b is 6th distinct, cut off.
    expect(state.recentFiles).toEqual([
      join(base, "f.ts"), join(base, "e.ts"), join(base, "d.ts"),
      join(base, "c.ts"), join(base, "a.ts"),
    ]);
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

// ── Part 1: currentFile / recentFiles must exist on disk ──────────────────────

describe("buildState — currentFile existence (Part 1)", () => {
  const DIR = "/tmp/executive-test-fileexist-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("stale file dropped: nonexistent path at highest seq, real file at lower seq", () => {
    // Create a real temp file that exists on disk
    const realFile = join(DIR, "src", "real.ts");
    mkdirSync(join(DIR, "src"), { recursive: true });
    writeFileSync(realFile, "// real file\n");

    // The nonexistent file has highest seq
    writeRawEvent("editor", 2, "editor.save", { path: "does-not-exist-xyz.ts" });
    // The real file has lower seq
    writeRawEvent("editor", 1, "editor.save", { path: realFile });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    // The stale file should be skipped; the real file becomes currentFile
    expect(state.currentFile).toBe(realFile);
    expect(state.recentFiles).toEqual([realFile]);
  });

  it("all editor.save paths nonexistent → currentFile null, recentFiles empty", () => {
    writeRawEvent("editor", 1, "editor.save", { path: "ghost-1.ts" });
    writeRawEvent("editor", 2, "editor.save", { path: "ghost-2.ts" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentFile).toBeNull();
    expect(state.recentFiles).toEqual([]);
  });

  it("existing file kept: a real file on disk becomes currentFile", () => {
    const realFile = join(DIR, "src", "keep-me.ts");
    mkdirSync(join(DIR, "src"), { recursive: true });
    writeFileSync(realFile, "// keep me\n");

    writeRawEvent("editor", 1, "editor.save", { path: realFile });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentFile).toBe(realFile);
    expect(state.recentFiles).toEqual([realFile]);
  });

  it("a directory is NOT a currentFile (isFile check, not just existsSync)", () => {
    // Regression: bare watcher paths can resolve to a real DIRECTORY (e.g. "src/state").
    const aDir = join(DIR, "src", "adir");
    const aFile = join(DIR, "src", "afile.ts");
    mkdirSync(aDir, { recursive: true });
    writeFileSync(aFile, "// file\n");

    writeRawEvent("editor", 1, "editor.save", { path: aFile });
    writeRawEvent("editor", 2, "editor.save", { path: aDir }); // highest seq, but it's a dir

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    // The directory must be skipped even though it exists on disk.
    expect(state.currentFile).toBe(aFile);
    expect(state.recentFiles).toEqual([aFile]);
  });

  it("resolves a watcher-relative path against config.watch.fs.paths (not just repo root)", () => {
    // Regression: the FsWatcher watches "<root>/src", so editor.save records a path
    // relative to THAT dir ("foo.ts", not "src/foo.ts"). The existence check must
    // resolve against the watched dir, or every real file is wrongly dropped.
    const watchedDir = join(DIR, "watched-src");
    mkdirSync(watchedDir, { recursive: true });
    writeFileSync(join(watchedDir, "foo.ts"), "// foo\n");
    // config.json points the fs watcher at watchedDir.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "config.json"), JSON.stringify({ watch: { fs: { paths: [watchedDir] } } }));

    // editor.save path is RELATIVE to the watched dir.
    writeRawEvent("editor", 1, "editor.save", { path: "foo.ts" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentFile).toBe("foo.ts");
    expect(state.recentFiles).toEqual(["foo.ts"]);
  });
});

// ── Part 2: clearable task/project (three-way semantics) ──────────────────────

describe("buildState — clearable task (Part 2)", () => {
  const DIR = "/tmp/executive-test-clear-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("empty task clears: task set then cleared → null", () => {
    writeRawEvent("system", 1, "system.task", { task: "fix login" });
    writeRawEvent("system", 2, "system.task", { task: "" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentTask).toBeNull();
  });

  it("absent task key leaves task unchanged: set task, then set project only", () => {
    writeRawEvent("system", 1, "system.task", { task: "fix login" });
    writeRawEvent("system", 2, "system.task", { project: "myshi" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentTask).toBe("fix login");
    expect(state.currentProject).toBe("myshi");
  });

  it("clear then branch fallback: feat/dark-mode branch, clear explicit task → branch-derived", () => {
    writeRawEvent("git", 1, "git.branch_switch", { to: "feat/dark-mode" });
    writeRawEvent("system", 2, "system.task", { task: "old" });
    writeRawEvent("system", 3, "system.task", { task: "" });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentTask).toBe("dark mode");
  });

  it("whitespace-only clears: task set then whitespace-only → null", () => {
    writeRawEvent("system", 1, "system.task", { task: "fix login" });
    writeRawEvent("system", 2, "system.task", { task: "   " });

    const { state } = buildState(new Date("2026-07-17T00:00:00.000Z"));

    expect(state.currentTask).toBeNull();
  });
});

// ── Phase 32: clearable deadline (same three-way semantics as task) ──────────

describe("buildState — clearable deadline", () => {
  const DIR = "/tmp/executive-test-clear-deadline-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  it("empty deadline clears: set then cleared → null", () => {
    writeRawEvent("system", 1, "system.task", { deadline: "2026-07-20" });
    writeRawEvent("system", 2, "system.task", { deadline: "" });

    const { state } = buildState(new Date("2026-07-22T00:00:00.000Z"));

    expect(state.deadline).toBeNull();
  });

  it("whitespace-only clears", () => {
    writeRawEvent("system", 1, "system.task", { deadline: "2026-07-20" });
    writeRawEvent("system", 2, "system.task", { deadline: "  " });

    const { state } = buildState(new Date("2026-07-22T00:00:00.000Z"));

    expect(state.deadline).toBeNull();
  });

  it("absent deadline key leaves the deadline unchanged", () => {
    writeRawEvent("system", 1, "system.task", { deadline: "2026-07-20" });
    writeRawEvent("system", 2, "system.task", { task: "something else" });

    const { state } = buildState(new Date("2026-07-22T00:00:00.000Z"));

    expect(state.deadline).toBe("2026-07-20");
  });

  it("a later non-empty deadline still overwrites", () => {
    writeRawEvent("system", 1, "system.task", { deadline: "2026-07-20" });
    writeRawEvent("system", 2, "system.task", { deadline: "2026-08-01" });

    const { state } = buildState(new Date("2026-07-22T00:00:00.000Z"));

    expect(state.deadline).toBe("2026-08-01");
  });
});

// ── Phase 39: state decay / TTL — stale manual signals age out ───────────────

describe("buildState — decay (Phase 39)", () => {
  const DIR = "/tmp/executive-test-decay-" + randomUUID();
  beforeEach(() => setExecutiveHome(DIR));
  afterEach(() => cleanup(DIR));

  const NOW = new Date("2026-07-20T12:00:00.000Z");
  const nowMs = NOW.getTime();
  const hoursAgo = (h: number) => new Date(nowMs - h * 3_600_000).toISOString();

  // --- blocked ---

  it("1. a fresh block stays blocked", () => {
    writeRawEventAt("system", 1, "system.blocked", { reason: "waiting on X" }, hoursAgo(1));
    const { state } = buildState(NOW);
    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toBe("waiting on X");
  });

  it("2. a block older than 24h decays to not-blocked", () => {
    writeRawEventAt("system", 1, "system.blocked", { reason: "stale blocker" }, hoursAgo(25));
    const { state } = buildState(NOW);
    expect(state.blocked).toBe(false);
    expect(state.blockedReason).toBeNull();
  });

  it("3. a stale block followed by a fresh block stays blocked (winning event is fresh)", () => {
    writeRawEventAt("system", 1, "system.blocked", { reason: "old" }, hoursAgo(40));
    writeRawEventAt("system", 2, "system.blocked", { reason: "new" }, hoursAgo(1));
    const { state } = buildState(NOW);
    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toBe("new");
  });

  it("4. an unparseable ts is kept (uncertain → do not drop)", () => {
    writeRawEventAt("system", 1, "system.blocked", { reason: "x" }, "not-a-real-date");
    const { state } = buildState(NOW);
    expect(state.blocked).toBe(true);
  });

  // --- task / project ---

  it("5. a stale manual task decays and falls back to the branch-derived task", () => {
    writeRawEventAt("git", 1, "git.branch_switch", { to: "feat/dark-mode" }, hoursAgo(2));
    writeRawEventAt("system", 2, "system.task", { task: "old thing" }, hoursAgo(96)); // 4 days
    const { state } = buildState(NOW);
    expect(state.currentTask).toBe("dark mode");
  });

  it("6. a fresh manual task is kept", () => {
    writeRawEventAt("git", 1, "git.branch_switch", { to: "feat/dark-mode" }, hoursAgo(2));
    writeRawEventAt("system", 2, "system.task", { task: "still working on this" }, hoursAgo(1));
    const { state } = buildState(NOW);
    expect(state.currentTask).toBe("still working on this");
  });

  it("7. a stale manual project decays and falls back to the active repo", () => {
    writeRawEventAt("git", 1, "git.commit",
      { repo: "myshi", branch: "main", sha: "abc123", subject: "wip" }, hoursAgo(2));
    writeRawEventAt("system", 2, "system.task", { project: "old-proj" }, hoursAgo(96)); // 4 days
    const { state } = buildState(NOW);
    expect(state.currentProject).toBe("myshi");
  });

  // --- exact boundaries (isStale uses strict >, so exactly-TTL is KEPT) ---

  it("8. a block at exactly 24h is kept; just over decays", () => {
    // exactly at the TTL → kept
    writeRawEventAt("system", 1, "system.blocked", { reason: "edge" },
      new Date(nowMs - BLOCKED_TTL_MS).toISOString());
    expect(buildState(NOW).state.blocked).toBe(true);
    // 1 ms over the TTL → decays
    cleanup(DIR); setExecutiveHome(DIR);
    writeRawEventAt("system", 1, "system.blocked", { reason: "edge" },
      new Date(nowMs - BLOCKED_TTL_MS - 1).toISOString());
    expect(buildState(NOW).state.blocked).toBe(false);
  });

  it("9. a manual task at exactly 72h is kept; just over decays to branch inference", () => {
    writeRawEventAt("git", 1, "git.branch_switch", { to: "feat/dark-mode" }, hoursAgo(1));
    writeRawEventAt("system", 2, "system.task", { task: "edge task" },
      new Date(nowMs - MANUAL_TASK_TTL_MS).toISOString());
    expect(buildState(NOW).state.currentTask).toBe("edge task");
    cleanup(DIR); setExecutiveHome(DIR);
    writeRawEventAt("git", 1, "git.branch_switch", { to: "feat/dark-mode" }, hoursAgo(1));
    writeRawEventAt("system", 2, "system.task", { task: "edge task" },
      new Date(nowMs - MANUAL_TASK_TTL_MS - 1).toISOString());
    expect(buildState(NOW).state.currentTask).toBe("dark mode");
  });

  // --- deadline: decay is OPT-IN, DEFAULT OFF (a commitment, not transient state) ---

  it("10. a deadline does NOT decay by default, however overdue (toggle off)", () => {
    // 19 days overdue. With no config (loadConfig unavailable here) decay is off, so
    // Phase 32's overdue nag keeps firing until the owner closes it out.
    writeRawEventAt("system", 1, "system.task", { deadline: "2026-07-01" }, hoursAgo(2));
    const { state } = buildState(NOW); // NOW = 2026-07-20
    expect(state.deadline).toBe("2026-07-01");
  });
});

// ── Phase 39: OPT-IN deadline decay (config.state.deadlineDecayDays) ─────────

describe("buildState — deadline decay (opt-in)", () => {
  const DIR = "/tmp/executive-test-dldecay-" + randomUUID();
  const NOW = new Date("2026-07-20T12:00:00.000Z");
  beforeEach(() => { setExecutiveHome(DIR); bootstrap(); });
  afterEach(() => cleanup(DIR));

  it("when ENABLED, a deadline >7 days past due retires to null", () => {
    updateAutonomyConfig({ deadlineDecayEnabled: true }); // writes deadlineDecayDays = 7
    writeRawEventAt("system", 1, "system.task", { deadline: "2026-07-01" }, "2026-07-20T10:00:00.000Z");
    const { state } = buildState(NOW); // 19 days overdue
    expect(state.deadline).toBeNull();
  });

  it("when ENABLED, a freshly-overdue deadline (<=7 days) is kept (Phase 32 still nags it)", () => {
    updateAutonomyConfig({ deadlineDecayEnabled: true });
    writeRawEventAt("system", 1, "system.task", { deadline: "2026-07-18" }, "2026-07-20T10:00:00.000Z");
    const { state } = buildState(NOW); // 2 days overdue
    expect(state.deadline).toBe("2026-07-18");
  });

  it("when DISABLED (default), even a long-overdue deadline is kept", () => {
    writeRawEventAt("system", 1, "system.task", { deadline: "2026-07-01" }, "2026-07-20T10:00:00.000Z");
    const { state } = buildState(NOW);
    expect(state.deadline).toBe("2026-07-01");
  });

  it("a non-date deadline never decays even when enabled", () => {
    updateAutonomyConfig({ deadlineDecayEnabled: true });
    writeRawEventAt("system", 1, "system.task", { deadline: "end of sprint" }, "2026-07-20T10:00:00.000Z");
    const { state } = buildState(NOW);
    expect(state.deadline).toBe("end of sprint");
  });
});
