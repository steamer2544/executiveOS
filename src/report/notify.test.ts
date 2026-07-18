import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { diffNeedsYou, appendNotifications, readNotifications } from "./notify.js";
import { execRoot } from "../paths.js";
import type { NeedsYouItem } from "./types.js";

// Helper: create a temp EXECUTIVE_HOME and clean it up after.
function withTempHome(fn: (home: string) => void): void {
  const base = import.meta.dir + "/.tmp-notify-test";
  const home = base + "/exec-" + Math.random().toString(36).slice(2);
  process.env.EXECUTIVE_HOME = home;
  try {
    if (existsSync(home)) rmSync(home, { recursive: true });
    mkdirSync(home, { recursive: true });
    fn(home);
  } finally {
    delete process.env.EXECUTIVE_HOME;
    if (existsSync(home)) rmSync(home, { recursive: true });
  }
}

describe("diffNeedsYou", () => {
  it("empty → items", () => {
    const a: NeedsYouItem = { source: "plan", summary: "S1" };
    const b: NeedsYouItem = { source: "plan", summary: "S2" };
    const result = diffNeedsYou([], [a, b]);
    expect(result.added.length).toBe(2);
    expect(result.removed.length).toBe(0);
  });

  it("items → empty", () => {
    const a: NeedsYouItem = { source: "plan", summary: "S1" };
    const b: NeedsYouItem = { source: "plan", summary: "S2" };
    const result = diffNeedsYou([a, b], []);
    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(2);
  });

  it("partial change", () => {
    const a: NeedsYouItem = { source: "plan", summary: "A" };
    const b: NeedsYouItem = { source: "plan", summary: "B" };
    const c: NeedsYouItem = { source: "plan", summary: "C" };
    const result = diffNeedsYou([a, b], [b, c]);
    expect(result.added.length).toBe(1);
    expect(result.added[0]!.summary).toBe("C");
    expect(result.removed.length).toBe(1);
    expect(result.removed[0]!.summary).toBe("A");
  });

  it("ignores detail", () => {
    const prev: NeedsYouItem = { source: "plan", summary: "S", detail: "x" };
    const curr: NeedsYouItem = { source: "plan", summary: "S", detail: "y" };
    const result = diffNeedsYou([prev], [curr]);
    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(0);
  });

  it("distinguishes source", () => {
    const a: NeedsYouItem = { source: "plan", summary: "S" };
    const b: NeedsYouItem = { source: "autopilot", summary: "S" };
    const result = diffNeedsYou([a], [b]);
    expect(result.added.length).toBe(1);
    expect(result.removed.length).toBe(1);
  });
});

describe("appendNotifications / readNotifications", () => {
  it("round-trip + append semantics", () => {
    withTempHome(() => {
      const a: NeedsYouItem = { source: "plan", summary: "A" };
      const b: NeedsYouItem = { source: "executor", summary: "B" };
      appendNotifications([{ ts: "2026-01-01T00:00:00.000Z", event: "added", source: a.source, summary: a.summary }]);
      appendNotifications([{ ts: "2026-01-01T00:00:01.000Z", event: "added", source: b.source, summary: b.summary }]);
      const all = readNotifications();
      expect(all.length).toBe(2);
      expect(all[0]!.summary).toBe("A");
      expect(all[1]!.summary).toBe("B");
    });
  });

  it("missing file → []", () => {
    withTempHome(() => {
      const all = readNotifications();
      expect(all.length).toBe(0);
    });
  });

  it("corrupt line skipped", () => {
    withTempHome(() => {
      appendNotifications([{ ts: "2026-01-01T00:00:00.000Z", event: "added", source: "plan", summary: "A" }]);
      // Inject corrupt line
      const path = execRoot() + "/notifications.jsonl";
      writeFileSync(path, readFileSync(path, "utf-8") + "{ broken\n" + JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", event: "resolved", source: "plan", summary: "B" }) + "\n");
      const all = readNotifications();
      expect(all.length).toBe(2);
      expect(all[0]!.summary).toBe("A");
      expect(all[1]!.summary).toBe("B");
    });
  });

  it("empty records is a no-op", () => {
    withTempHome(() => {
      appendNotifications([]);
      const all = readNotifications();
      expect(all.length).toBe(0);
    });
  });
});
