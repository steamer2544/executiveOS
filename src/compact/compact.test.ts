// Tests for historical log compaction (Phase 32.1).
// Offline: a temp EXECUTIVE_HOME, no git, no network.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eventLogPath, advisorPath, eventsDir, execRoot } from "../paths.js";
import {
  compactScreenEvents,
  compactNoteEvents,
  compactAdvisorStore,
  runCompaction,
} from "./compact.js";
import type { ExecEvent } from "../events/types.js";
import type { AdvisorStore, Proposal } from "../advisor/types.js";

const ev = (seq: number, type: string, data: Record<string, unknown>): ExecEvent =>
  ({ seq, id: "id-" + seq, ts: "2026-07-22T00:00:0" + (seq % 10) + ".000Z", source: "screen", type, data }) as ExecEvent;

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("compactScreenEvents", () => {
  it("collapses spinner frames of one window into a single event", () => {
    const events = [
      ev(1, "screen.window", { title: "⠂ Recover code", app: "WindowsTerminal" }),
      ev(2, "screen.window", { title: "⠐ Recover code", app: "WindowsTerminal" }),
      ev(3, "screen.window", { title: "✳ Recover code", app: "WindowsTerminal" }),
      ev(4, "screen.window", { title: "Sprint Board | Trello", app: "chrome" }),
    ];
    const { kept, dropped } = compactScreenEvents(events);
    expect(kept.length).toBe(2);
    expect(dropped.length).toBe(2);
    expect(kept[0]!.data.title).toBe("Recover code"); // rewritten to the normalized form
    expect(kept[1]!.data.app).toBe("chrome");
  });

  it("collapses a browser unread count that only changes value", () => {
    const events = [
      ev(1, "screen.window", { title: "(81) Inbox - Gmail", app: "chrome" }),
      ev(2, "screen.window", { title: "(92) Inbox - Gmail", app: "chrome" }),
    ];
    expect(compactScreenEvents(events).kept.length).toBe(1);
  });

  it("keeps a window the owner returns to later", () => {
    const events = [
      ev(1, "screen.window", { title: "⠂ A", app: "term" }),
      ev(2, "screen.window", { title: "B", app: "term" }),
      ev(3, "screen.window", { title: "⠐ A", app: "term" }),
    ];
    expect(compactScreenEvents(events).kept.length).toBe(3);
  });

  it("never touches non-screen events, and preserves seq order", () => {
    const events = [
      ev(1, "screen.window", { title: "⠂ A", app: "term" }),
      ev(2, "editor.save", { path: "src/x.ts" }),
      ev(3, "screen.window", { title: "⠐ A", app: "term" }),
      ev(4, "editor.save", { path: "src/y.ts" }),
    ];
    const { kept } = compactScreenEvents(events);
    // Events from other sources are always kept, in order. The repeat of window A is
    // still dropped: an interleaved save does not mean the owner switched windows, and
    // the live watcher would emit nothing there either.
    expect(kept.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(kept.filter((e) => e.type === "editor.save").length).toBe(2);
  });
});

describe("compactNoteEvents", () => {
  it("drops junk voice notes and keeps real ones", () => {
    const events = [
      ev(1, "system.note", { msg: "1 2 3 1 2 3 4", via: "voice" }),
      ev(2, "system.note", { msg: "ทำ unit test ให้ opm backend", via: "voice" }),
      ev(3, "system.note", { msg: "12312 เนี่ย", via: "voice" }),
    ];
    const { kept, dropped } = compactNoteEvents(events);
    expect(kept.length).toBe(1);
    expect(dropped.length).toBe(2);
    expect(kept[0]!.seq).toBe(2);
  });

  it("never drops a typed capture, however short", () => {
    const events = [ev(1, "system.note", { msg: "ok", via: "text" })];
    expect(compactNoteEvents(events).kept.length).toBe(1);
  });

  it("never drops a non-note event", () => {
    const events = [ev(1, "system.blocked", { reason: "x" })];
    expect(compactNoteEvents(events).kept.length).toBe(1);
  });
});

describe("compactAdvisorStore", () => {
  const p = (title: string, status: Proposal["status"] = "pending"): Proposal =>
    ({ id: randomUUID(), createdAt: "t", category: "general", title, detail: "", action: "", status, backend: "mock", executable: false }) as Proposal;

  it("rejects pending duplicates and keeps the first", () => {
    const store: AdvisorStore = {
      items: [p("Take a 10-minute screen break"), p("Stretch neck and shoulders"), p("Draft OPM backend test skeleton")],
    };
    const { droppedTitles } = compactAdvisorStore(store);
    expect(droppedTitles).toEqual(["Stretch neck and shoulders"]);
    expect(store.items.filter((i) => i.status === "pending").length).toBe(2);
    expect(store.items[1]!.note).toContain("auto-merged");
  });

  it("leaves already-decided items alone", () => {
    const store: AdvisorStore = { items: [p("Take a break", "approved"), p("Go for a walk", "pending")] };
    compactAdvisorStore(store);
    expect(store.items[0]!.status).toBe("approved");
    expect(store.items[1]!.status).toBe("pending"); // decided items are not comparison anchors
  });
});

// ─── runCompaction (disk) ────────────────────────────────────────────────────

describe("runCompaction", () => {
  const DIR = "/tmp/executive-test-compact-" + randomUUID();

  const writeLog = (source: "screen" | "system", events: ExecEvent[]) => {
    mkdirSync(eventsDir(), { recursive: true });
    writeFileSync(eventLogPath(source), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };

  beforeEach(() => {
    process.env.EXECUTIVE_HOME = DIR;
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("dry-run reports the change but writes nothing", () => {
    writeLog("screen", [
      ev(1, "screen.window", { title: "⠂ A", app: "term" }),
      ev(2, "screen.window", { title: "⠐ A", app: "term" }),
    ]);
    const before = readFileSync(eventLogPath("screen"), "utf-8");

    const report = runCompaction();

    expect(report.mode).toBe("dry-run");
    expect(report.screen.before).toBe(2);
    expect(report.screen.after).toBe(1);
    expect(report.backupDir).toBeNull();
    expect(readFileSync(eventLogPath("screen"), "utf-8")).toBe(before); // untouched
  });

  it("--apply rewrites the logs and backs the originals up", () => {
    writeLog("screen", [
      ev(1, "screen.window", { title: "⠂ A", app: "term" }),
      ev(2, "screen.window", { title: "⠐ A", app: "term" }),
    ]);
    writeLog("system", [
      ev(3, "system.note", { msg: "1 2 3 1 2 3 4", via: "voice" }),
      ev(4, "system.note", { msg: "จดไว้ว่าต้องแก้ dedup", via: "voice" }),
    ]);

    const report = runCompaction({ apply: true });

    expect(report.mode).toBe("apply");
    expect(report.backupDir).not.toBeNull();

    const screenLines = readFileSync(eventLogPath("screen"), "utf-8").trim().split("\n");
    expect(screenLines.length).toBe(1);
    expect(JSON.parse(screenLines[0]!).data.title).toBe("A");

    const systemLines = readFileSync(eventLogPath("system"), "utf-8").trim().split("\n");
    expect(systemLines.length).toBe(1);
    expect(JSON.parse(systemLines[0]!).seq).toBe(4);

    // The originals survive, so the operation is reversible.
    const backedUp = readFileSync(join(report.backupDir!, "screen.jsonl"), "utf-8").trim().split("\n");
    expect(backedUp.length).toBe(2);
  });

  it("surviving events keep their original seq (no renumbering)", () => {
    writeLog("screen", [
      ev(10, "screen.window", { title: "⠂ A", app: "term" }),
      ev(11, "screen.window", { title: "⠐ A", app: "term" }),
      ev(12, "screen.window", { title: "B", app: "term" }),
    ]);
    runCompaction({ apply: true });
    const seqs = readFileSync(eventLogPath("screen"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual([10, 12]);
  });

  it("is idempotent — a second run removes nothing", () => {
    writeLog("screen", [
      ev(1, "screen.window", { title: "⠂ A", app: "term" }),
      ev(2, "screen.window", { title: "⠐ A", app: "term" }),
    ]);
    runCompaction({ apply: true });
    const second = runCompaction({ apply: true });
    expect(second.screen.before).toBe(second.screen.after);
  });

  it("handles missing logs and a missing advisor queue without throwing", () => {
    expect(existsSync(eventLogPath("screen"))).toBe(false);
    const report = runCompaction();
    expect(report.screen.before).toBe(0);
    expect(report.advisor.before).toBe(0);
  });

  it("skips corrupt JSONL lines instead of crashing", () => {
    mkdirSync(eventsDir(), { recursive: true });
    writeFileSync(eventLogPath("screen"), '{"broken\n' + JSON.stringify(ev(2, "screen.window", { title: "A", app: "t" })) + "\n");
    const report = runCompaction();
    expect(report.screen.before).toBe(1);
  });

  it("rewrites the advisor queue too", () => {
    mkdirSync(execRoot(), { recursive: true });
    const store: AdvisorStore = {
      items: [
        { id: "1", createdAt: "t", category: "health", title: "Take a 10-minute screen break", detail: "", action: "", status: "pending", backend: "mock", executable: false },
        { id: "2", createdAt: "t", category: "health", title: "Stretch neck and shoulders", detail: "", action: "", status: "pending", backend: "mock", executable: false },
      ] as Proposal[],
    };
    writeFileSync(advisorPath(), JSON.stringify(store, null, 2));

    const report = runCompaction({ apply: true });

    expect(report.advisor.before).toBe(2);
    expect(report.advisor.after).toBe(1);
    const after = JSON.parse(readFileSync(advisorPath(), "utf-8")) as AdvisorStore;
    expect(after.items.filter((i) => i.status === "pending").length).toBe(1);
  });
});
