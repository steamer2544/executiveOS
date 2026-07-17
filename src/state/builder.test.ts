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
import { buildState, writeState } from "./builder.js";
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
