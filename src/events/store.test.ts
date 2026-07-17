// Unit tests for Phase 2: seq, append with seq, tail ordering, read legacy,
// EventBus, StoreSink, WatcherManager, GitWatcher integration.
// Uses EXECUTIVE_HOME to isolate tests in a temp directory.

import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrap } from "../bootstrap.js";
import { append, read, tail } from "./store.js";
import { nextSeq, currentSeq } from "./seq.js";
import { eventLogPath, execRoot, configPath } from "../paths.js";
import type { EventSource } from "./types.js";
import { EventBus, type EventInput } from "../bus.js";
import { attachStoreSink } from "../sink.js";
import { WatcherManager } from "../watchers/index.js";
import type { Watcher } from "../watchers/index.js";

// Use a unique temp dir per test run.
const TEST_DIR = "/tmp/executive-test-" + randomUUID();

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

// ─── seq ────────────────────────────────────────────────────────────────────

describe("nextSeq()", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns strictly increasing ints starting at 1", () => {
    const values = [nextSeq(), nextSeq(), nextSeq()];
    expect(values).toEqual([1, 2, 3]);
  });

  it("persists across calls (reads back from meta.json)", () => {
    nextSeq();
    nextSeq();
    expect(currentSeq()).toBe(2);
  });

  it("starts at 1 after cleanup", () => {
    cleanup(TEST_DIR);
    setExecutiveHome(TEST_DIR);
    expect(nextSeq()).toBe(1);
  });
});

describe("bootstrap() creates meta.json", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("creates meta.json with lastSeq:0", async () => {
    await bootstrap();
    const metaPath = execRoot() + "/meta.json";
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.lastSeq).toBe(0);
  });

  it("is idempotent — does not clobber existing meta.json", async () => {
    await bootstrap();
    // Manually bump the seq
    writeFileSync(execRoot() + "/meta.json", JSON.stringify({ lastSeq: 99 }) + "\n");
    await bootstrap();
    const meta = JSON.parse(readFileSync(execRoot() + "/meta.json", "utf-8"));
    expect(meta.lastSeq).toBe(99);
  });
});

// ─── append assigns seq ─────────────────────────────────────────────────────

describe("append assigns seq", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("two appends across different sources get seq 1 then 2", async () => {
    await bootstrap();
    const e1 = await append({ source: "git", type: "git.commit", data: { sha: "aaa" } });
    const e2 = await append({ source: "editor", type: "editor.save", data: { file: "x.ts" } });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  it("stored events contain the seq field", async () => {
    await bootstrap();
    await append({ source: "system", type: "system.note", data: { msg: "hello" } });
    const events = await read("system");
    expect(events.length).toBe(1);
    expect(events[0]!.seq).toBe(1);
  });
});

// ─── tail orders by seq ─────────────────────────────────────────────────────

describe("tail orders by seq", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns events in append order by seq, not just ts", async () => {
    await bootstrap();

    // Add events to different sources rapidly (same ms possible).
    await append({ source: "git", type: "git.commit", data: { sha: "aaa" } });
    await append({ source: "editor", type: "editor.save", data: { file: "x.ts" } });
    await append({ source: "system", type: "system.note", data: { msg: "z" } });

    const events = await tail(3);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["git.commit", "editor.save", "system.note"]);
  });
});

// ─── read tolerates legacy line without seq ─────────────────────────────────

describe("read tolerates legacy line without seq", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns both events, legacy one has seq === 0, no throw", async () => {
    await bootstrap();
    const path = eventLogPath("terminal");

    // Write a legacy line without seq, then a normal append.
    writeFileSync(
      path,
      JSON.stringify({
        id: "legacy-1",
        ts: "2026-01-01T00:00:00.000Z",
        source: "terminal",
        type: "terminal.command",
        data: { cmd: "ls" },
      }) + "\n"
    );
    await append({ source: "terminal", type: "terminal.command", data: { cmd: "pwd" } });

    const events = await read("terminal");
    expect(events.length).toBe(2);
    expect(events[0]!.seq).toBe(0);
    expect(events[1]!.seq).toBe(1);
  });
});

// ─── EventBus ───────────────────────────────────────────────────────────────

describe("EventBus", () => {
  it("publish reaches all subscribers in order", () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.subscribe(() => {
      order.push(1);
    });
    bus.subscribe(() => {
      order.push(2);
    });
    bus.subscribe(() => {
      order.push(3);
    });

    bus.publish({ source: "system", type: "system.note", data: {} });
    expect(order).toEqual([1, 2, 3]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let called = false;
    const unsub = bus.subscribe(() => {
      called = true;
    });
    unsub();
    bus.publish({ source: "system", type: "system.note", data: {} });
    expect(called).toBe(false);
  });

  it("a throwing handler does not prevent later handlers from running", () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => {
      order.push(2);
    });

    // Should not throw; the error is caught and logged to stderr.
    bus.publish({ source: "system", type: "system.note", data: {} });
    expect(order).toEqual([2]);
  });
});

// ─── StoreSink ──────────────────────────────────────────────────────────────

describe("StoreSink", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("publishing an EventInput to a bus with an attached sink results in exactly one persisted event", async () => {
    await bootstrap();

    const bus = new EventBus();
    attachStoreSink(bus);

    bus.publish({ source: "editor", type: "editor.save", data: { file: "test.ts" } });

    const events = await read("editor");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("editor.save");
    expect(events[0]!.seq).toBe(1);
  });

  it("unsubscribe stops the sink", async () => {
    await bootstrap();

    const bus = new EventBus();
    const unsub = attachStoreSink(bus);
    unsub();

    bus.publish({ source: "system", type: "system.note", data: {} });

    const events = await read("system");
    expect(events.length).toBe(0);
  });
});

// ─── WatcherManager ─────────────────────────────────────────────────────────

describe("WatcherManager", () => {
  it("a fake in-memory watcher's start/stop are invoked by startAll/stopAll", async () => {
    const bus = new EventBus();
    let started = false;
    let stopped = false;

    const fakeWatcher: Watcher = {
      name: "fake",
      start: async () => {
        started = true;
      },
      stop: async () => {
        stopped = true;
      },
    };

    const manager = new WatcherManager(bus, [fakeWatcher]);
    await manager.startAll();
    expect(started).toBe(true);
    expect(stopped).toBe(false);

    await manager.stopAll();
    expect(stopped).toBe(true);
  });

  it("stopAll is safe to call even if startAll was not called", async () => {
    const bus = new EventBus();
    const fakeWatcher: Watcher = {
      name: "fake",
      start: async () => {},
      stop: async () => {},
    };
    const manager = new WatcherManager(bus, [fakeWatcher]);
    // Should not throw.
    await manager.stopAll();
  });
});

// ─── GitWatcher (integration, temp git repo) ────────────────────────────────

describe("GitWatcher (integration)", () => {
  // Use a dedicated temp dir for the git repo.
  const GIT_REPO_DIR = "/tmp/executive-test-git-" + randomUUID();
  const EXEC_DIR = "/tmp/executive-test-git-exec-" + randomUUID();

  beforeEach(async () => {
    setExecutiveHome(EXEC_DIR);
    mkdirSync(GIT_REPO_DIR, { recursive: true });
    // Initialize a real git repo.
    await Bun.$`git init ${GIT_REPO_DIR}`;
    await Bun.$`git -C ${GIT_REPO_DIR} config user.email "test@test.com"`;
    await Bun.$`git -C ${GIT_REPO_DIR} config user.name "Test"`;
  });

  afterEach(() => {
    cleanup(EXEC_DIR);
    try {
      rmSync(GIT_REPO_DIR, { recursive: true, force: true });
    } catch {
      // Ignore.
    }
    delete process.env.EXECUTIVE_HOME;
  });

  it("detects a new commit and emits git.commit", async () => {
    await bootstrap();

    const bus = new EventBus();
    const publishedEvents: EventInput[] = [];
    bus.subscribe((e: EventInput) => {
      publishedEvents.push(e);
    });
    attachStoreSink(bus);

    // Create the git watcher with a short poll interval.
    const { createGitWatcher } = await import("../watchers/git.js");
    const watcher = createGitWatcher({ repoPath: GIT_REPO_DIR, pollMs: 500 });
    await watcher.start(bus);

    // Make a commit.
    const testFile = GIT_REPO_DIR + "/test.txt";
    writeFileSync(testFile, "hello\n");
    await Bun.$`git -C ${GIT_REPO_DIR} add test.txt`;
    await Bun.$`git -C ${GIT_REPO_DIR} commit -m "initial commit"`;

    // Wait for at least one poll cycle.
    await new Promise<void>((r) => setTimeout(r, 2000));

    watcher.stop();

    // Assert a git.commit event was published with the new sha.
    const commitEvents = publishedEvents.filter((e) => e.type === "git.commit");
    expect(commitEvents.length).toBeGreaterThan(0);
    const first = commitEvents[0]!;
    expect(first.source).toBe("git" as EventSource);
    const d = first.data ?? {};
    expect(typeof d.sha).toBe("string");
    expect(d.subject).toBe("initial commit");
  });

  it("detects a branch switch and emits git.branch_switch", async () => {
    await bootstrap();

    const bus = new EventBus();
    const publishedEvents: EventInput[] = [];
    bus.subscribe((e: EventInput) => {
      publishedEvents.push(e);
    });
    attachStoreSink(bus);

    // Create initial commit so branch exists.
    const testFile = GIT_REPO_DIR + "/test.txt";
    writeFileSync(testFile, "hello\n");
    await Bun.$`git -C ${GIT_REPO_DIR} add test.txt`;
    await Bun.$`git -C ${GIT_REPO_DIR} commit -m "initial"`;

    const { createGitWatcher } = await import("../watchers/git.js");
    const watcher = createGitWatcher({ repoPath: GIT_REPO_DIR, pollMs: 500 });
    await watcher.start(bus);

    // Switch branch.
    await Bun.$`git -C ${GIT_REPO_DIR} checkout -b feature`;

    // Wait for at least one poll cycle.
    await new Promise<void>((r) => setTimeout(r, 2000));

    watcher.stop();

    // Assert a git.branch_switch event was published.
    const branchEvents = publishedEvents.filter((e) => e.type === "git.branch_switch");
    expect(branchEvents.length).toBeGreaterThan(0);
    const first = branchEvents[0]!;
    expect(first.source).toBe("git" as EventSource);
    const d = first.data ?? {};
    expect(d.to).toBe("feature");
  });
});
