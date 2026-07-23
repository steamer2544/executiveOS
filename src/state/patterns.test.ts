// Tests for the behavioural pattern metrics (Phase 33, Job 2).
// Pure functions, no I/O — no temp home needed.

import { describe, expect, it } from "bun:test";
import { computePatterns, emptyPatterns, SESSION_BREAK_MS, type PatternEvent } from "./patterns.js";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Build an event at `msAgo` before NOW. */
function ev(msAgo: number, type: string, data: Record<string, unknown> = {}, seq = 0): PatternEvent {
  return { seq, ts: new Date(NOW - msAgo).toISOString(), type, data };
}

/** Sort by ts ascending and assign seq, as buildState hands them over. */
function seq(events: PatternEvent[]): PatternEvent[] {
  return events
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .map((e, i) => ({ ...e, seq: i + 1 }));
}

describe("computePatterns — empty and degenerate input", () => {
  it("returns all-empty for no events and never throws", () => {
    expect(computePatterns([], NOW, null)).toEqual(emptyPatterns());
  });

  it("skips events with an unparseable timestamp instead of crashing", () => {
    const events: PatternEvent[] = [
      { seq: 1, ts: "not-a-date", type: "git.commit", data: {} },
      { seq: 2, ts: "", type: "editor.save", data: { path: "a.ts" } },
    ];
    const p = computePatterns(events, NOW, "a.ts");
    expect(p.msSinceLastCommit).toBeNull();
    expect(p.sameFileSaves30m).toBe(0);
  });
});

describe("computePatterns — uncommitted work", () => {
  it("counts only edits newer than the last commit", () => {
    const events = seq([
      ev(6 * HOUR, "editor.save", { path: "a.ts" }), // before the commit — not counted
      ev(4 * HOUR, "git.commit", { sha: "abc" }),
      ev(3 * HOUR, "editor.save", { path: "a.ts" }),
      ev(2 * HOUR, "editor.save", { path: "b.ts" }),
    ]);
    const p = computePatterns(events, NOW, "b.ts");
    expect(p.msSinceLastCommit).toBe(4 * HOUR);
    expect(p.editsSinceLastCommit).toBe(2);
  });

  it("uses the NEWEST commit, not the first", () => {
    const events = seq([
      ev(10 * HOUR, "git.commit", { sha: "old" }),
      ev(5 * HOUR, "editor.save", { path: "a.ts" }),
      ev(1 * HOUR, "git.commit", { sha: "new" }),
      ev(30 * MIN, "editor.save", { path: "a.ts" }),
    ]);
    const p = computePatterns(events, NOW, "a.ts");
    expect(p.msSinceLastCommit).toBe(1 * HOUR);
    expect(p.editsSinceLastCommit).toBe(1);
  });

  it("reports null / 0 when there has never been a commit", () => {
    const events = seq([ev(1 * HOUR, "editor.save", { path: "a.ts" })]);
    const p = computePatterns(events, NOW, "a.ts");
    expect(p.msSinceLastCommit).toBeNull();
    expect(p.editsSinceLastCommit).toBe(0);
  });
});

describe("computePatterns — same-file saves in the last 30 min", () => {
  it("counts only the current file, only within the window", () => {
    const events = seq([
      ev(45 * MIN, "editor.save", { path: "a.ts" }), // outside the window
      ev(20 * MIN, "editor.save", { path: "a.ts" }),
      ev(10 * MIN, "editor.save", { path: "a.ts" }),
      ev(5 * MIN, "editor.save", { path: "b.ts" }),  // different file
    ]);
    expect(computePatterns(events, NOW, "a.ts").sameFileSaves30m).toBe(2);
  });

  it("is 0 when currentFile is null", () => {
    const events = seq([ev(5 * MIN, "editor.save", { path: "a.ts" })]);
    expect(computePatterns(events, NOW, null).sameFileSaves30m).toBe(0);
  });
});

describe("computePatterns — session length", () => {
  it("measures the run back to the last break", () => {
    const events = seq([
      ev(5 * HOUR, "editor.save", { path: "a.ts" }), // an older session
      // a >15 min gap here ends it; everything below is one unbroken run
      ev(40 * MIN, "editor.save", { path: "a.ts" }),
      ev(30 * MIN, "editor.save", { path: "a.ts" }),
      ev(20 * MIN, "editor.save", { path: "a.ts" }),
      ev(10 * MIN, "editor.save", { path: "a.ts" }),
      ev(1 * MIN, "editor.save", { path: "a.ts" }),
    ]);
    expect(computePatterns(events, NOW, "a.ts").sessionMs).toBe(40 * MIN - 1 * MIN);
  });

  it("a gap at or over the threshold splits the run, a shorter one does not", () => {
    const under = seq([
      ev(24 * MIN, "editor.save", { path: "a.ts" }),
      ev(10 * MIN, "editor.save", { path: "a.ts" }), // 14 min gap — under 15, joins
      ev(1 * MIN, "editor.save", { path: "a.ts" }),  //  9 min gap — joins
    ]);
    expect(computePatterns(under, NOW, "a.ts").sessionMs).toBe(24 * MIN - 1 * MIN);

    const over = seq([
      ev(26 * MIN, "editor.save", { path: "a.ts" }),
      ev(10 * MIN, "editor.save", { path: "a.ts" }), // 16 min gap — splits here
      ev(1 * MIN, "editor.save", { path: "a.ts" }),
    ]);
    expect(computePatterns(over, NOW, "a.ts").sessionMs).toBe(10 * MIN - 1 * MIN);
  });

  it("a gap of exactly the threshold splits the run (the boundary is inclusive)", () => {
    const events = seq([
      ev(SESSION_BREAK_MS + 10 * MIN, "editor.save", { path: "a.ts" }),
      ev(10 * MIN, "editor.save", { path: "a.ts" }), // gap === SESSION_BREAK_MS exactly
      ev(1 * MIN, "editor.save", { path: "a.ts" }),
    ]);
    expect(computePatterns(events, NOW, "a.ts").sessionMs).toBe(10 * MIN - 1 * MIN);
  });

  it("reports null once the owner has been away longer than a break", () => {
    const events = seq([
      ev(2 * HOUR, "editor.save", { path: "a.ts" }),
      ev(SESSION_BREAK_MS + MIN, "editor.save", { path: "a.ts" }),
    ]);
    expect(computePatterns(events, NOW, "a.ts").sessionMs).toBeNull();
  });
});

describe("computePatterns — repo switches (observability only)", () => {
  it("counts changes of repo within the last hour", () => {
    const events = seq([
      ev(50 * MIN, "editor.save", { path: "a.ts", repo: "alpha" }),
      ev(40 * MIN, "editor.save", { path: "b.ts", repo: "alpha" }), // same repo, no switch
      ev(30 * MIN, "editor.save", { path: "c.ts", repo: "beta" }),  // switch 1
      ev(10 * MIN, "editor.save", { path: "d.ts", repo: "alpha" }), // switch 2
    ]);
    expect(computePatterns(events, NOW, "d.ts").repoSwitches1h).toBe(2);
  });

  it("ignores untagged events and anything older than an hour", () => {
    const events = seq([
      ev(3 * HOUR, "editor.save", { path: "a.ts", repo: "alpha" }),
      ev(2 * HOUR, "editor.save", { path: "b.ts", repo: "beta" }),
      ev(5 * MIN, "editor.save", { path: "c.ts" }), // untagged
    ]);
    expect(computePatterns(events, NOW, "c.ts").repoSwitches1h).toBe(0);
  });
});
