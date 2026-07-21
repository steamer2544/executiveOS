// Unit tests for ScreenWatcher — offline, inject `read` to feed scripted windows.
// No real PowerShell, no screenshot, no network.
//
// The watcher polls on a real setInterval, so each test uses a tiny pollMs and
// awaits a comfortable window (several poll cycles) before asserting. The `it`
// callbacks are async and RETURN their promise, so bun waits for the assertions
// to run — unlike a bare `setTimeout` whose assertions fire after the test has
// already been marked passed.

import { describe, it, expect } from "bun:test";
import type { ForegroundWindow } from "../screen/capture.js";
import type { EventBus } from "../bus.js";
import { createScreenWatcher } from "./screen.js";

const POLL_MS = 5;
const SETTLE_MS = 80; // ~16 poll cycles at POLL_MS — plenty, well clear of timer jitter

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type SpyEvent = { source: string; type: string; data: Record<string, unknown> };

/** Minimal EventBus mock that records published events. */
function makeSpyBus(): { bus: EventBus; events: SpyEvent[] } {
  const events: SpyEvent[] = [];
  const bus = {
    publish: (e: SpyEvent) => {
      events.push(e);
    },
  } as unknown as EventBus;
  return { bus, events };
}

// ─── 1. Baseline no-emit ────────────────────────────────────────────────────

describe("ScreenWatcher — baseline no-emit", () => {
  it("first observed window (unchanged across polls) never emits", async () => {
    const { bus, events } = makeSpyBus();
    const watcher = createScreenWatcher({
      pollMs: POLL_MS,
      read: () => ({ title: "Chrome", app: "chrome" }),
    });

    watcher.start(bus);
    expect(events.length).toBe(0); // nothing at start

    await delay(SETTLE_MS);
    watcher.stop();

    // Baseline == every poll → still zero emits.
    expect(events.length).toBe(0);
  });
});

// ─── 2. Emit on change ──────────────────────────────────────────────────────

describe("ScreenWatcher — emit on change", () => {
  it("baseline A then window B → exactly one screen.window for B", async () => {
    const { bus, events } = makeSpyBus();
    let calls = 0;
    const watcher = createScreenWatcher({
      pollMs: POLL_MS,
      // call #1 = baseline (A); every poll after = B
      read: () => {
        calls++;
        return calls === 1
          ? { title: "Chrome", app: "chrome" }
          : { title: "VS Code", app: "code" };
      },
    });

    watcher.start(bus);
    await delay(SETTLE_MS);
    watcher.stop();

    const windowEvents = events.filter((e) => e.type === "screen.window");
    expect(windowEvents.length).toBe(1); // B once, then deduped
    expect(windowEvents[0]!.source).toBe("screen");
    expect(windowEvents[0]!.data).toEqual({ title: "VS Code", app: "code" });
  });
});

// ─── 3. Dedup ───────────────────────────────────────────────────────────────

describe("ScreenWatcher — dedup", () => {
  it("A, A, A after baseline A → no emit", async () => {
    const { bus, events } = makeSpyBus();
    const watcher = createScreenWatcher({
      pollMs: POLL_MS,
      read: () => ({ title: "Chrome", app: "chrome" }),
    });

    watcher.start(bus);
    await delay(SETTLE_MS);
    watcher.stop();

    expect(events.filter((e) => e.type === "screen.window").length).toBe(0);
  });

  it("repeated B after a change emits only once", async () => {
    const { bus, events } = makeSpyBus();
    let calls = 0;
    const watcher = createScreenWatcher({
      pollMs: POLL_MS,
      read: () => {
        calls++;
        return calls === 1
          ? { title: "A", app: "a" }
          : { title: "B", app: "b" }; // change once, then stays B forever
      },
    });

    watcher.start(bus);
    await delay(SETTLE_MS);
    watcher.stop();

    expect(events.filter((e) => e.type === "screen.window").length).toBe(1);
  });
});

// ─── 4. Unavailable ─────────────────────────────────────────────────────────

describe("ScreenWatcher — unavailable", () => {
  it("read returns null → no emit, no throw, warns at most once", async () => {
    const { bus, events } = makeSpyBus();

    // Capture stderr to count warnings.
    const orig = process.stderr.write.bind(process.stderr);
    const warnings: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      const s = typeof chunk === "string" ? chunk : String(chunk);
      if (s.includes("unavailable")) warnings.push(s);
      return true;
    };

    try {
      const watcher = createScreenWatcher({ pollMs: POLL_MS, read: () => null });
      expect(() => watcher.start(bus)).not.toThrow();
      await delay(SETTLE_MS);
      watcher.stop();

      expect(events.length).toBe(0);
      // Many polls, but warned at most once (deduped by the `warned` flag).
      expect(warnings.length).toBeLessThanOrEqual(1);
    } finally {
      (process.stderr as any).write = orig;
    }
  });
});

// ─── 5. Stop is idempotent ──────────────────────────────────────────────────

describe("ScreenWatcher — stop is idempotent", () => {
  it("stop() twice does not throw; no emit after stop", async () => {
    const { bus, events } = makeSpyBus();
    let calls = 0;
    const watcher = createScreenWatcher({
      pollMs: POLL_MS,
      read: () => {
        calls++;
        return calls === 1
          ? { title: "A", app: "a" }
          : { title: "B", app: "b" }; // would emit on the first poll if the interval kept running
      },
    });

    watcher.start(bus);
    watcher.stop(); // stop immediately — interval cleared before any poll
    expect(() => watcher.stop()).not.toThrow();

    await delay(SETTLE_MS);
    // No poll ever ran after stop → no emit.
    expect(events.filter((e) => e.type === "screen.window").length).toBe(0);
  });
});
